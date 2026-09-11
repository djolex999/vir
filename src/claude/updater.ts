import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.js";
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

export interface DiffResult {
  added: Entry[];
  removed: { slug: string }[];
  upgraded: Array<{ slug: string; oldConf: number; newConf: number }>;
  unchanged: Entry[];
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

export function planUpdates(
  _cfg: Config,
  db: StateDb,
  options: { project?: string; globalOnly?: boolean } = {},
): PlanItem[] {
  const rows = db.listDistilled();
  const plans: PlanItem[] = [];

  if (!options.project) {
    plans.push(buildPlan(globalClaudePath(), rows, { scope: "global" }));
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
    plans.push(buildPlan(target, projectRows, { scope: { project: slug } }));
  }

  return plans;
}

function buildPlan(
  target: string,
  rows: DistilledRow[],
  meta: { scope: "global" | { project: string } },
): PlanItem {
  const entries = selectTopEntries(rows);
  const newBlock = renderBlock(entries);
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
  const diff = computeDiff(oldEntries, entries);

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

function renderBlock(entries: Entry[]): string {
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
  lines.push(VIR_END);
  return lines.join("\n");
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

function computeDiff(old: Entry[], next: Entry[]): DiffResult {
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

  try {
    writeFileSync(plan.target, updated);
    return { ok: true };
  } catch {
    return { ok: false, reason: "could not write file" };
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
