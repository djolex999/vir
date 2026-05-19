import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

export function applyPlan(plan: PlanItem): boolean {
  if (!plan.exists) return false;
  let raw: string;
  try {
    raw = readFileSync(plan.target, "utf8");
  } catch {
    return false;
  }

  let updated: string;
  if (raw.includes(VIR_START) && raw.includes(VIR_END)) {
    const start = raw.indexOf(VIR_START);
    const end = raw.indexOf(VIR_END) + VIR_END.length;
    updated = raw.slice(0, start) + plan.newBlock + raw.slice(end);
  } else {
    const sep = raw.endsWith("\n") ? "\n" : "\n\n";
    updated = raw + sep + plan.newBlock + "\n";
  }

  try {
    writeFileSync(plan.target, updated);
    return true;
  } catch {
    return false;
  }
}

export function globalClaudePath(): string {
  return join(homedir(), ".claude", "CLAUDE.md");
}

export function projectClaudePath(projectSlug: string): string {
  return join(homedir(), "projects", projectSlug, "CLAUDE.md");
}
