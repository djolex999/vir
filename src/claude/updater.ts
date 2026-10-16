import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.js";
import { extractLessonTexts, normalizeLesson } from "../connect/extract.js";
import { ruleText } from "../connect/text.js";
import type { InsightRow } from "../connect/types.js";
import type { DistilledRow, StateDb } from "../state/db.js";
import { kebab } from "../pipeline/writer.js";

export const VIR_START = "<!-- VIR:START -->";
export const VIR_END = "<!-- VIR:END -->";
// CLAUDE.md is loaded into every session, so the block carries only what an
// agent can't find on its own: a few project gotchas, each as its lesson. The
// global file points at vir_query for everything else.
const TOP_GOTCHAS = 5;
const MAX_LESSON_CHARS = 200;
const POINTER =
  'Search notes from past sessions (patterns, decisions, gotchas) with the `vir_query` MCP tool, or `vir query "<topic>"`.';

export interface Entry {
  lesson: string;
}

// A connect-pass rule the owner promoted into this CLAUDE.md. Kept apart from
// note Entries so a block with no rules renders byte-identically to before.
export interface RuleEntry {
  id: string;
  rule: string;
}

export interface DiffResult {
  added: Entry[];
  removed: Entry[];
  unchanged: Entry[];
  rulesAdded: RuleEntry[];
  rulesRemoved: RuleEntry[];
}

export interface RuleCandidate {
  target: string;
  insight: InsightRow;
}

export interface PlanItem {
  target: string;
  exists: boolean;
  hasBlock: boolean;
  lastUpdated: string | null;
  newBlock: string;
  diff: DiffResult;
  scope: "global" | { project: string };
}

// The instruction file a plan targets. AGENTS.md (Codex and other agents) gets
// the same VIR block as CLAUDE.md, but only where the file already exists.
export type InstructionFile = "CLAUDE.md" | "AGENTS.md";

type PlanOptions = { project?: string; globalOnly?: boolean; file?: InstructionFile };

// Which CLAUDE.md a rule's scope lands in, limited to the targets planUpdates
// builds this run (a project with no distilled notes has no plan).
function ruleTarget(scope: string, options: PlanOptions, projectSlugs: Set<string>): string | null {
  const file = options.file ?? "CLAUDE.md";
  if (scope === "global") return options.project ? null : globalInstructionPath(file);
  if (!scope.startsWith("project:") || options.globalOnly) return null;
  const slug = scope.slice("project:".length);
  if (options.project && slug !== options.project) return null;
  return projectSlugs.has(slug) ? projectInstructionPath(slug, file) : null;
}

function projectSlugsOf(rows: DistilledRow[]): Set<string> {
  return new Set(rows.map((r) => kebab(r.project)).filter((s) => s.length > 0));
}

// Accepted rules not yet promoted or declined, one per target — each becomes
// its own y/n hunk in sync-claude. Never includes proposed or rejected rules.
export function planRules(db: StateDb, options: PlanOptions = {}): RuleCandidate[] {
  const slugs = projectSlugsOf(db.listDistilled());
  const out: RuleCandidate[] = [];
  for (const insight of db.listInsights()) {
    if (insight.status !== "accepted" || insight.promotion !== "none") continue;
    const target = ruleTarget(insight.scope, options, slugs);
    if (target !== null) out.push({ target, insight });
  }
  return out;
}

export function renderRuleHunk(c: RuleCandidate): string {
  const sources = c.insight.evidence
    .map((e) => `[[${e.citeSlug}]] (${e.project || "-"}, ${e.date.slice(0, 10)}${e.merged ? ", merged" : ""})`)
    .join(", ");
  return [`+ - rule: ${ruleText(c.insight.rule)}`, `  why: ${ruleText(c.insight.why)}`, `  sources: ${sources}`].join("\n");
}

export function planUpdates(
  _cfg: Config,
  db: StateDb,
  options: PlanOptions = {},
  // Rules approved interactively THIS run; rendered alongside promoted ones.
  approvedRuleIds: Set<string> = new Set(),
): PlanItem[] {
  const rows = db.listDistilled();
  const plans: PlanItem[] = [];
  const slugs = projectSlugsOf(rows);
  const rulesByTarget = new Map<string, RuleEntry[]>();
  for (const ins of db.listInsights()) {
    if (ins.status !== "accepted") continue;
    if (ins.promotion !== "promoted" && !(ins.promotion === "none" && approvedRuleIds.has(ins.id))) continue;
    const target = ruleTarget(ins.scope, options, slugs);
    if (target === null) continue;
    const list = rulesByTarget.get(target) ?? [];
    list.push({ id: ins.id, rule: ins.rule });
    rulesByTarget.set(target, list);
  }

  const file = options.file ?? "CLAUDE.md";
  if (!options.project) {
    const target = globalInstructionPath(file);
    // Notes are project-scoped: the global file gets the pointer and global
    // rules, never every project's gotchas.
    plans.push(buildPlan(target, [], { scope: "global" }, rulesByTarget.get(target) ?? []));
  }
  if (options.globalOnly) return file === "AGENTS.md" ? plans.filter((p) => p.exists) : plans;

  const byProject = new Map<string, DistilledRow[]>();
  for (const r of rows) {
    const slug = kebab(r.project);
    if (slug.length === 0) continue;
    if (options.project && slug !== options.project) continue;
    let arr = byProject.get(slug);
    if (!arr) {
      arr = [];
      byProject.set(slug, arr);
    }
    arr.push(r);
  }

  for (const [slug, projectRows] of byProject) {
    const target = projectInstructionPath(slug, file);
    plans.push(
      buildPlan(target, projectRows, { scope: { project: slug } }, rulesByTarget.get(target) ?? []),
    );
  }

  // A missing CLAUDE.md is reported ("would be skipped"); most projects have
  // no AGENTS.md, so those are left out instead of listed.
  return file === "AGENTS.md" ? plans.filter((p) => p.exists) : plans;
}

function buildPlan(
  target: string,
  rows: DistilledRow[],
  meta: { scope: "global" | { project: string } },
  rules: RuleEntry[] = [],
): PlanItem {
  const entries = selectTopEntries(rows);
  const newBlock = renderBlock(entries, rules, meta.scope === "global" ? "global" : "project");
  const existsAtPath = existsSync(target);

  let existingBlock = "";
  let lastUpdated: string | null = null;
  if (existsAtPath) {
    try {
      const raw = readFileSync(target, "utf8");
      existingBlock = extractBlock(raw);
      lastUpdated = extractLastUpdated(existingBlock);
    } catch {
      // ignore
    }
  }

  const oldEntries = parseEntries(existingBlock);
  const oldRules = parseRules(existingBlock);
  const oldIds = new Set(oldRules.map((r) => r.id));
  const newIds = new Set(rules.map((r) => r.id));
  const diff: DiffResult = {
    ...computeDiff(oldEntries, entries),
    rulesAdded: rules.filter((r) => !oldIds.has(r.id)),
    rulesRemoved: oldRules.filter((r) => !newIds.has(r.id)),
  };

  return {
    target,
    exists: existsAtPath,
    hasBlock: existingBlock.length > 0,
    lastUpdated,
    newBlock,
    diff,
    scope: meta.scope,
  };
}

function selectTopEntries(rows: DistilledRow[]): Entry[] {
  const seen = new Set<string>();
  const out: Entry[] = [];
  const sorted = rows
    .filter((r) => r.category === "gotcha")
    .sort((a, b) => b.confidence - a.confidence || (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
  for (const r of sorted) {
    if (out.length >= TOP_GOTCHAS) break;
    const lesson = extractLesson(r.content, r.topic);
    if (lesson.length === 0 || seen.has(lesson)) continue;
    seen.add(lesson);
    out.push({ lesson });
  }
  return out;
}

// Words that mark a point as a gotcha rather than background ("Codebase
// structure: 304 files…"). Among a note's first few points, the first that has
// one wins; otherwise the first point.
const GOTCHA_CUE =
  /\b(?:must|never|only|cannot|can't|doesn't|don't|isn't|won't|requires?|breaks?|fails?|silently|instead|always)\b/i;
const ABBREV = /\b(?:e\.g|i\.e|etc|vs|cf)\.$/i;

function firstSentence(text: string): string {
  for (const m of text.matchAll(/[.!?][)*`"']*(?=\s+[A-Z`*("']|\s*$)/g)) {
    const end = (m.index ?? 0) + m[0].length;
    if (!ABBREV.test(text.slice(0, end))) return text.slice(0, end);
  }
  return text;
}

function clip(text: string): string {
  if (text.length <= MAX_LESSON_CHARS) return text;
  const cut = text.slice(0, MAX_LESSON_CHARS);
  const space = cut.lastIndexOf(" ");
  let out = (space > MAX_LESSON_CHARS / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:(—–-]+$/, "");
  // An odd backtick would swallow the rest of the line as code.
  if ((out.match(/`/g) ?? []).length % 2 === 1) out += "`";
  return `${out}…`;
}

// "Order State Machine Pattern": most words capitalized reads as a heading.
function isTitle(text: string): boolean {
  const words = text.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w));
  return words.length > 0 && words.filter((w) => /^[A-Z]/.test(w)).length / words.length > 0.6;
}

// One learned point (from extractLessonTexts) as one sentence. A bold lead that
// reads as a claim is the lesson; one that reads as a label ("**Gate-field
// mismatch**:", "**MIME Validation**") keeps the sentence after it; bold that
// starts a running sentence ("**Never** trust…") is read straight through.
function lessonFromPoint(point: string): string {
  const [head = "", ...body] = point.split("\n");
  const line = head.trim().replace(/^(?:[-*]|\d+[.)])\s+/, "");
  const m = line.match(/^(?:\*\*|__)(.+?)(?:\*\*|__)(:?)\s*(.*)$/);
  if (!m) return firstSentence(normalizeLesson(line));
  const raw = (m[1] ?? "").trim().replace(/^\d+[.)]\s+/, "");
  const lead = raw.replace(/:$/, "").trim();
  const sameLine = (m[3] ?? "").replace(/^[:—–-]+\s*/, "");
  const colon = raw.endsWith(":") || m[2] === ":";
  if (!colon && sameLine.length > 0 && !/^[A-Z]/.test(sameLine) && !/[.!?]$/.test(lead)) {
    return firstSentence(normalizeLesson(line));
  }
  // Sub-bullets under a label are separate points: take the first, not all.
  const rest = sameLine || normalizeLesson(body.find((l) => l.trim().length > 0) ?? "");
  const isClaim = /[.!?]$/.test(lead) || (!colon && sameLine.length === 0 && !isTitle(lead));
  return isClaim || rest.length === 0 ? lead : `${lead}: ${firstSentence(normalizeLesson(rest))}`;
}

function plainSection(content: string, heading: string): string[] {
  const lines = content.split("\n");
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading.toLowerCase()}`);
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return end === -1 ? rest : rest.slice(0, end);
}

// A note's lesson as one line. Points come from the connect pass's parser
// (bold-led items under What Was Learned, else the Summary); a section of plain
// bullets, or an article's Key Points, falls back to its first line.
export function extractLesson(content: string, topic: string): string {
  const points = extractLessonTexts(content);
  let lesson: string | undefined;
  if (points.length > 0 && /^##\s+What Was Learned\s*$/m.test(content)) {
    const lessons = points.slice(0, 3).map(lessonFromPoint);
    lesson = lessons.find((l) => GOTCHA_CUE.test(l)) ?? lessons[0];
  } else {
    const fallback = [...plainSection(content, "What Was Learned"), ...plainSection(content, "Key Points")]
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("```"));
    const summary = points[0];
    if (fallback !== undefined) lesson = lessonFromPoint(fallback);
    else if (summary !== undefined) lesson = firstSentence(normalizeLesson(summary));
  }
  const text = ruleText((lesson ?? topic).replace(/\*\*|__/g, ""));
  return clip(text.length > 0 ? text : ruleText(topic));
}

export function renderBlock(
  entries: Entry[],
  rules: RuleEntry[] = [],
  scope: "global" | "project" = "project",
): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push(VIR_START);
  lines.push(`<!-- vir-last-updated: ${today} -->`);
  lines.push("");
  if (scope === "global") {
    lines.push("## Past sessions (from vir)");
    lines.push("");
    lines.push(POINTER);
    lines.push("");
  }
  if (entries.length > 0) {
    lines.push("## Gotchas (from vir)");
    lines.push("");
    for (const e of entries) lines.push(`- ${e.lesson}`);
    lines.push("");
  }
  if (rules.length > 0) {
    lines.push("## Rules (from vir)");
    lines.push("");
    for (const r of rules) lines.push(`- rule: ${ruleText(r.rule)} <!-- vir-rule:${r.id} -->`);
    lines.push("");
  }
  lines.push(VIR_END);
  return lines.join("\n");
}

function parseRules(block: string): RuleEntry[] {
  const out: RuleEntry[] = [];
  for (const line of block.split("\n")) {
    const m = line.match(/^- rule: (.+) <!-- vir-rule:([A-Za-z0-9-]+) -->$/);
    if (m?.[1] !== undefined && m[2] !== undefined) out.push({ id: m[2], rule: m[1] });
  }
  return out;
}

function extractBlock(raw: string): string {
  const start = raw.indexOf(VIR_START);
  const end = raw.indexOf(VIR_END);
  if (start === -1 || end === -1 || end < start) return "";
  return raw.slice(start, end + VIR_END.length);
}

function extractLastUpdated(block: string): string | null {
  const m = block.match(/vir-last-updated:\s*(\d{4}-\d{2}-\d{2})/);
  return m ? (m[1] ?? null) : null;
}

// Lesson lines under the block's Gotchas heading, plus old-format lines
// ("- gotcha/topic (conf 0.84) — topic") so the first sync after upgrading
// shows them leaving.
function parseEntries(block: string): Entry[] {
  const out: Entry[] = [];
  let inGotchas = false;
  for (const line of block.split("\n")) {
    if (line.startsWith("## ")) inGotchas = line === "## Gotchas (from vir)";
    const legacy = line.match(/^- ([a-z]+\/[a-z0-9-]+) \(conf [\d.]+\)\s*—\s*(.+)$/i);
    if (legacy?.[1] !== undefined) out.push({ lesson: line.slice(2) });
    else if (inGotchas && line.startsWith("- ")) out.push({ lesson: line.slice(2) });
  }
  return out;
}

function computeDiff(old: Entry[], next: Entry[]): Omit<DiffResult, "rulesAdded" | "rulesRemoved"> {
  const oldSet = new Set(old.map((e) => e.lesson));
  const newSet = new Set(next.map((e) => e.lesson));
  return {
    added: next.filter((e) => !oldSet.has(e.lesson)),
    removed: old.filter((e) => !newSet.has(e.lesson)),
    unchanged: next.filter((e) => oldSet.has(e.lesson)),
  };
}

export interface ApplyResult {
  ok: boolean;
  reason?: string;
}

// Marker offsets that are REAL — i.e. not inside a fenced code block. A
// CLAUDE.md may legitimately document vir's own markers (this repo's docs do),
// and editing the file at an example would corrupt it.
function markerOffsets(raw: string): { starts: number[]; ends: number[] } {
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  let fenced = false;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (t.startsWith("```") || t.startsWith("~~~")) {
      fenced = !fenced;
    } else if (!fenced) {
      if (t === VIR_START) starts.push(offset);
      else if (t === VIR_END) ends.push(offset);
    }
    offset += line.length + 1;
  }
  return { starts, ends };
}

// Pair markers into complete blocks, walking forward: a START claims the first
// END after it. Returns null when anything is left unmatched — an orphan START
// from a hand-edit, or an END before any START.
function pairBlocks(
  starts: number[],
  ends: number[],
): Array<{ from: number; to: number }> | null {
  const blocks: Array<{ from: number; to: number }> = [];
  let ei = 0;
  for (const start of starts) {
    while (ei < ends.length && ends[ei]! < start) return null; // END before START
    if (ei >= ends.length) return null; // START with no END after it
    blocks.push({ from: start, to: ends[ei]! + VIR_END.length });
    ei += 1;
  }
  if (ei !== ends.length) return null; // trailing unmatched END
  return blocks;
}

export function applyPlan(plan: PlanItem): ApplyResult {
  if (!plan.exists) return { ok: false, reason: "file does not exist" };
  let raw: string;
  try {
    raw = readFileSync(plan.target, "utf8");
  } catch {
    return { ok: false, reason: "could not read file" };
  }

  const { starts, ends } = markerOffsets(raw);
  let updated: string;

  if (starts.length === 0 && ends.length === 0) {
    const sep = raw.endsWith("\n") ? "\n" : "\n\n";
    updated = raw + sep + plan.newBlock + "\n";
  } else {
    const blocks = pairBlocks(starts, ends);
    // Unbalanced markers mean a hand-edit went wrong. Appending here is what
    // made this destructive: the NEXT sync would slice from the orphan marker
    // to the appended block's END and delete everything the user wrote in
    // between. Refuse, say so, and let them fix their own file.
    if (blocks === null || blocks.length === 0) {
      return {
        ok: false,
        reason: `unbalanced ${VIR_START} / ${VIR_END} markers — fix them by hand, nothing was written`,
      };
    }
    // Replace the first block; drop any later ones. Splice back-to-front so
    // earlier offsets stay valid. Later blocks are entirely vir-owned, so
    // removing them takes none of the user's content.
    updated = raw;
    for (let i = blocks.length - 1; i >= 1; i -= 1) {
      const b = blocks[i]!;
      updated = updated.slice(0, b.from) + updated.slice(b.to);
    }
    const first = blocks[0]!;
    updated =
      updated.slice(0, first.from) + plan.newBlock + updated.slice(first.to);
  }

  return writeAtomically(plan.target, updated)
    ? { ok: true }
    : { ok: false, reason: "could not write file" };
}

// CLAUDE.md belongs to the user: a crash or full disk mid-write must leave the
// old file, never a truncated one. Write a sibling temp file and rename it over
// the real path (resolving a dotfiles symlink so the link survives), keeping
// the file's mode.
function writeAtomically(target: string, content: string): boolean {
  let real: string;
  try {
    real = realpathSync(target);
  } catch {
    return false;
  }
  const tmp = `${real}.vir-${process.pid}.tmp`;
  try {
    writeFileSync(tmp, content, { mode: statSync(real).mode & 0o777 });
    chmodSync(tmp, statSync(real).mode & 0o777);
    renameSync(tmp, real);
    return true;
  } catch {
    rmSync(tmp, { force: true });
    return false;
  }
}

export function globalClaudePath(): string {
  return join(homedir(), ".claude", "CLAUDE.md");
}

// Global AGENTS.md is Codex's (~/.codex/AGENTS.md).
export function globalInstructionPath(file: InstructionFile): string {
  return file === "CLAUDE.md" ? globalClaudePath() : join(homedir(), ".codex", "AGENTS.md");
}

// Resolve a project's CLAUDE.md across the layouts people actually use.
// Checks candidates in priority order and returns the first that EXISTS:
//   1. ~/projects/<slug>/CLAUDE.md
//   2. ~/projects/<slug>-*/CLAUDE.md   (suffixed dirs, e.g. "<slug>-web")
//   3. ~/code/<slug>/CLAUDE.md
//   4. ~/dev/<slug>/CLAUDE.md
//   5. a folder under ~/projects, ~/code or ~/dev whose kebab-cased name is
//      the slug ("pripremi.rs" → "pripremi-rs")
// If none exist, falls back to the canonical (#1) location so the plan
// reports exists=false there. The returned path flows into PlanItem.target,
// which the dry-run output prints as each plan's heading — so the matched
// path is always visible.
export function projectClaudePath(projectSlug: string): string {
  return projectInstructionPath(projectSlug, "CLAUDE.md");
}

export function projectInstructionPath(projectSlug: string, file: InstructionFile): string {
  const home = homedir();
  const candidates: string[] = [];

  const canonical = join(home, "projects", projectSlug, file);
  candidates.push(canonical);

  // Glob ~/projects/<slug>-*  (sorted for deterministic first-match).
  const projectsDir = join(home, "projects");
  try {
    for (const name of readdirSync(projectsDir).sort()) {
      if (name !== projectSlug && name.startsWith(`${projectSlug}-`)) {
        candidates.push(join(projectsDir, name, file));
      }
    }
  } catch {
    // ~/projects may not exist — skip the glob, keep the other candidates.
  }

  candidates.push(join(home, "code", projectSlug, file));
  candidates.push(join(home, "dev", projectSlug, file));

  // Project slugs are kebab-cased, so a folder named "pripremi.rs" or "My App"
  // never matched its own slug ("pripremi-rs", "my-app") and its CLAUDE.md was
  // silently skipped. Last resort, after every exact candidate: any folder
  // under the same roots whose kebab-cased name equals the slug.
  for (const root of ["projects", "code", "dev"]) {
    try {
      for (const name of readdirSync(join(home, root)).sort()) {
        if (name !== projectSlug && kebab(name) === projectSlug) {
          candidates.push(join(home, root, name, file));
        }
      }
    } catch {
      // root missing — nothing to match there
    }
  }

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return canonical;
}
