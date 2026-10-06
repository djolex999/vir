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
import type { InsightRow } from "../connect/types.js";
import type { DistilledRow, StateDb } from "../state/db.js";
import { kebab } from "../pipeline/writer.js";

export const VIR_START = "<!-- VIR:START -->";
export const VIR_END = "<!-- VIR:END -->";
const TOP_N_PER_CATEGORY = 5;

export interface Entry {
  slug: string;
  topic: string;
  category: string;
  confidence: number;
  startedAt: string | null;
}

// A connect-pass rule the owner promoted into this CLAUDE.md. Kept apart from
// note Entries so a block with no rules renders byte-identically to before.
export interface RuleEntry {
  id: string;
  rule: string;
}

export interface DiffResult {
  added: Entry[];
  removed: { slug: string }[];
  upgraded: Array<{ slug: string; oldConf: number; newConf: number }>;
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

type PlanOptions = { project?: string; globalOnly?: boolean };

// Which CLAUDE.md a rule's scope lands in, limited to the targets planUpdates
// builds this run (a project with no distilled notes has no plan).
function ruleTarget(scope: string, options: PlanOptions, projectSlugs: Set<string>): string | null {
  if (scope === "global") return options.project ? null : globalClaudePath();
  if (!scope.startsWith("project:") || options.globalOnly) return null;
  const slug = scope.slice("project:".length);
  if (options.project && slug !== options.project) return null;
  return projectSlugs.has(slug) ? projectClaudePath(slug) : null;
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

// Rule text is model-written and owner-editable, and CLAUDE.md is read as
// instructions: it must stay ONE inert line — no newlines (no injected
// headings), no HTML-comment syntax (no fake VIR markers or rule ids).
export function ruleText(rule: string): string {
  return rule
    .replace(/<!--|-->/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function renderRuleHunk(c: RuleCandidate): string {
  const sources = c.insight.evidence
    .map((e) => `[[${e.citeSlug}]] (${e.project || "-"}, ${e.date.slice(0, 10)})`)
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

  if (!options.project) {
    const target = globalClaudePath();
    plans.push(buildPlan(target, rows, { scope: "global" }, rulesByTarget.get(target) ?? []));
  }
  if (options.globalOnly) return plans;

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
    const target = projectClaudePath(slug);
    plans.push(
      buildPlan(target, projectRows, { scope: { project: slug } }, rulesByTarget.get(target) ?? []),
    );
  }

  return plans;
}

function buildPlan(
  target: string,
  rows: DistilledRow[],
  meta: { scope: "global" | { project: string } },
  rules: RuleEntry[] = [],
): PlanItem {
  const entries = selectTopEntries(rows);
  const newBlock = renderBlock(entries, rules);
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
  const byCategory: Record<string, DistilledRow[]> = {
    pattern: [],
    gotcha: [],
    decision: [],
    tool: [],
  };
  for (const r of rows) {
    const bucket = byCategory[r.category];
    if (bucket) bucket.push(r);
  }
  const out: Entry[] = [];
  for (const cat of Object.keys(byCategory)) {
    const sorted = (byCategory[cat] ?? [])
      .slice()
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, TOP_N_PER_CATEGORY);
    for (const r of sorted) {
      out.push({
        slug: `${cat}/${kebab(r.topic)}`,
        topic: r.topic,
        category: cat,
        confidence: r.confidence,
        startedAt: r.startedAt,
      });
    }
  }
  return out;
}

export function renderBlock(entries: Entry[], rules: RuleEntry[] = []): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push(VIR_START);
  lines.push(`<!-- vir-last-updated: ${today} -->`);
  lines.push("");
  lines.push("## Distilled Knowledge (from Vir)");
  lines.push("");
  const byCat: Record<string, Entry[]> = {
    pattern: [],
    gotcha: [],
    decision: [],
    tool: [],
  };
  for (const e of entries) {
    const cat = byCat[e.category];
    if (cat) cat.push(e);
  }
  const order: Array<[string, string]> = [
    ["pattern", "Patterns"],
    ["gotcha", "Gotchas"],
    ["decision", "Decisions"],
    ["tool", "Tools"],
  ];
  for (const [key, label] of order) {
    const list = byCat[key] ?? [];
    if (list.length === 0) continue;
    lines.push(`### ${label}`);
    for (const e of list) {
      lines.push(
        `- ${e.slug} (conf ${e.confidence.toFixed(2)}) — ${e.topic}`,
      );
    }
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

function parseEntries(block: string): Entry[] {
  if (block.length === 0) return [];
  const out: Entry[] = [];
  const lines = block.split("\n");
  for (const line of lines) {
    // - pattern/topic (conf 0.84) — display topic
    const m = line.match(
      /^- ([a-z]+\/[a-z0-9-]+) \(conf ([\d.]+)\)\s*—\s*(.+)$/i,
    );
    if (!m) continue;
    const slug = m[1] ?? "";
    const conf = Number(m[2] ?? 0);
    const topic = m[3] ?? "";
    const category = slug.split("/")[0] ?? "";
    out.push({
      slug,
      topic,
      category,
      confidence: Number.isFinite(conf) ? conf : 0,
      startedAt: null,
    });
  }
  return out;
}

function computeDiff(
  old: Entry[],
  next: Entry[],
): Omit<DiffResult, "rulesAdded" | "rulesRemoved"> {
  const oldBySlug = new Map(old.map((e) => [e.slug, e]));
  const newBySlug = new Map(next.map((e) => [e.slug, e]));
  const added: Entry[] = [];
  const removed: { slug: string }[] = [];
  const upgraded: Array<{ slug: string; oldConf: number; newConf: number }> = [];
  const unchanged: Entry[] = [];

  for (const e of next) {
    const prev = oldBySlug.get(e.slug);
    if (!prev) {
      added.push(e);
    } else if (Math.abs(prev.confidence - e.confidence) > 0.05) {
      upgraded.push({
        slug: e.slug,
        oldConf: prev.confidence,
        newConf: e.confidence,
      });
    } else {
      unchanged.push(e);
    }
  }
  for (const e of old) {
    if (!newBySlug.has(e.slug)) removed.push({ slug: e.slug });
  }
  return { added, removed, upgraded, unchanged };
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

// Resolve a project's CLAUDE.md across the layouts people actually use.
// Checks candidates in priority order and returns the first that EXISTS:
//   1. ~/projects/<slug>/CLAUDE.md
//   2. ~/projects/<slug>-*/CLAUDE.md   (suffixed dirs, e.g. "<slug>-web")
//   3. ~/code/<slug>/CLAUDE.md
//   4. ~/dev/<slug>/CLAUDE.md
// If none exist, falls back to the canonical (#1) location so the plan
// reports exists=false there. The returned path flows into PlanItem.target,
// which the dry-run output prints as each plan's heading — so the matched
// path is always visible.
export function projectClaudePath(projectSlug: string): string {
  const home = homedir();
  const candidates: string[] = [];

  const canonical = join(home, "projects", projectSlug, "CLAUDE.md");
  candidates.push(canonical);

  // Glob ~/projects/<slug>-*  (sorted for deterministic first-match).
  const projectsDir = join(home, "projects");
  try {
    for (const name of readdirSync(projectsDir).sort()) {
      if (name !== projectSlug && name.startsWith(`${projectSlug}-`)) {
        candidates.push(join(projectsDir, name, "CLAUDE.md"));
      }
    }
  } catch {
    // ~/projects may not exist — skip the glob, keep the other candidates.
  }

  candidates.push(join(home, "code", projectSlug, "CLAUDE.md"));
  candidates.push(join(home, "dev", projectSlug, "CLAUDE.md"));

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return canonical;
}
