import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Config } from "../config.js";
import type { DistilledRow, StateDb } from "../state/db.js";
import {
  buildAnthropicClient,
  callLLM,
  normalizeModelName,
  withRateLimitRetry,
} from "../pipeline/distiller.js";
import { kebab } from "../pipeline/writer.js";

const SKIP_BASENAMES = new Set(["index.md", "log.md"]);
const SKIP_DIRS = new Set(["projects"]);
const CATEGORY_DIRS = ["patterns", "gotchas", "decisions", "tools"];
const STALE_AGE_DAYS = 90;
const RECENT_AGE_DAYS = 30;
const MAX_CONTRADICTION_PAIRS = 20;

export interface OrphanResult {
  orphans: string[];
}

export interface StaleEntry {
  relPath: string;
  project: string;
  ageDays: number;
  newerSameProjectCount: number;
  startedAt: string;
}

export interface ContradictionEntry {
  a: string;
  b: string;
  reason: string;
}

export interface ContradictionResult {
  checked: number;
  contradictions: ContradictionEntry[];
}

interface NoteFile {
  relPath: string;
  noteRef: string;
  id: string;
  raw: string;
}

export function orphanCheck(cfg: Config): OrphanResult {
  const notes = loadVaultNotes(cfg);
  const idSet = new Set(notes.map((n) => n.id));

  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();

  for (const n of notes) {
    const targets = new Set<string>();
    const linkRe = /\[\[([^\]\n]+?)\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(n.raw)) !== null) {
      const inner = (m[1] ?? "").trim();
      if (inner.length === 0) continue;
      const target = inner.split("|")[0]?.trim() ?? inner;
      const tail = target.includes("/")
        ? (target.split("/").pop() ?? target)
        : target;
      // Only count links that resolve to actual note files; Project/Category
      // virtual nodes (e.g. [[growthq]], [[pattern]]) don't count.
      if (idSet.has(tail) && tail !== n.id) {
        targets.add(tail);
        if (!incoming.has(tail)) incoming.set(tail, new Set());
        incoming.get(tail)!.add(n.id);
      }
    }
    outgoing.set(n.id, targets);
  }

  const orphans: string[] = [];
  for (const n of notes) {
    const out = outgoing.get(n.id) ?? new Set();
    const inc = incoming.get(n.id) ?? new Set();
    if (out.size === 0 && inc.size === 0) orphans.push(n.noteRef);
  }
  orphans.sort();
  return { orphans };
}

export function stalenessCheck(_cfg: Config, db: StateDb): StaleEntry[] {
  const rows = db.listDistilled();
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  const parsed = rows
    .map((r) => ({ r, t: r.startedAt ? Date.parse(r.startedAt) : NaN }))
    .filter((x) => Number.isFinite(x.t));

  const stale: StaleEntry[] = [];
  for (const { r, t } of parsed) {
    const ageDays = Math.floor((now - t) / day);
    if (ageDays < STALE_AGE_DAYS) continue;
    const projectSlug = kebab(r.project);

    const hasRecentSameCat = parsed.some(
      (x) =>
        kebab(x.r.project) === projectSlug &&
        x.r.category === r.category &&
        x.t > t &&
        (now - x.t) / day <= RECENT_AGE_DAYS,
    );
    if (!hasRecentSameCat) continue;

    const newerSameProj = parsed.filter(
      (x) => kebab(x.r.project) === projectSlug && x.t > t,
    ).length;

    stale.push({
      relPath: noteRef(r),
      project: projectSlug,
      ageDays,
      newerSameProjectCount: newerSameProj,
      startedAt: r.startedAt ?? "",
    });
  }

  stale.sort((a, b) => b.ageDays - a.ageDays);
  return stale;
}

interface CandidatePair {
  a: DistilledRow;
  b: DistilledRow;
  score: number;
}

export async function contradictionCheck(
  cfg: Config,
  db: StateDb,
): Promise<ContradictionResult> {
  const rows = db.listDistilled();
  const pairs = rankCandidatePairs(rows).slice(0, MAX_CONTRADICTION_PAIRS);

  if (pairs.length === 0) {
    return { checked: 0, contradictions: [] };
  }

  const client = buildAnthropicClient(cfg);
  const model = normalizeModelName(cfg.models.classify, cfg.provider);
  const contradictions: ContradictionEntry[] = [];

  for (const pair of pairs) {
    const prompt = `Do these two knowledge notes contradict each other?
Answer JSON only: { "contradicts": boolean, "reason": "string (max 20 words)" }

Note A (topic: ${pair.a.topic}):
${excerpt(pair.a.content)}

Note B (topic: ${pair.b.topic}):
${excerpt(pair.b.content)}`;

    try {
      const text = await withRateLimitRetry(() =>
        callLLM(cfg, client, { prompt, model, maxTokens: 200 }),
      );
      const parsed = parseContradictionResponse(text);
      if (parsed.contradicts) {
        contradictions.push({
          a: noteRef(pair.a),
          b: noteRef(pair.b),
          reason: parsed.reason,
        });
      }
    } catch {
      // ignore individual pair failures — don't abort the whole check
    }
  }

  return { checked: pairs.length, contradictions };
}

function rankCandidatePairs(rows: DistilledRow[]): CandidatePair[] {
  const pairs: CandidatePair[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const a = rows[i];
    if (!a) continue;
    for (let j = i + 1; j < rows.length; j += 1) {
      const b = rows[j];
      if (!b) continue;
      const sameProjCat =
        kebab(a.project) === kebab(b.project) && a.category === b.category;
      const sharedTokens = countSharedTokens(a.topic, b.topic);
      if (!sameProjCat && sharedTokens < 2) continue;
      const score = (sameProjCat ? 2 : 0) + sharedTokens;
      pairs.push({ a, b, score });
    }
  }
  pairs.sort((x, y) => y.score - x.score);
  return pairs;
}

function countSharedTokens(a: string, b: string): number {
  const at = new Set(kebab(a).split("-").filter((t) => t.length >= 3));
  let n = 0;
  for (const t of kebab(b).split("-")) {
    if (t.length >= 3 && at.has(t)) n += 1;
  }
  return n;
}

function parseContradictionResponse(text: string): {
  contradicts: boolean;
  reason: string;
} {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { contradicts: false, reason: "" };
  try {
    const obj = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      contradicts: obj.contradicts === true,
      reason: typeof obj.reason === "string" ? obj.reason : "",
    };
  } catch {
    return { contradicts: false, reason: "" };
  }
}

function excerpt(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 300);
}

function loadVaultNotes(cfg: Config): NoteFile[] {
  const root = join(cfg.vaultPath, cfg.outputDir);
  const files: string[] = [];
  walkVault(root, files);

  const notes: NoteFile[] = [];
  for (const full of files) {
    const rel = relative(root, full);
    const parts = rel.split("/");
    const base = parts[parts.length - 1] ?? "";
    if (SKIP_BASENAMES.has(base)) continue;
    const firstDir = parts[0] ?? "";
    if (SKIP_DIRS.has(firstDir)) continue;
    if (!CATEGORY_DIRS.includes(firstDir)) continue;
    let raw: string;
    try {
      raw = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    notes.push({
      relPath: rel,
      noteRef: rel.replace(/\.md$/, ""),
      id: base.replace(/\.md$/, ""),
      raw,
    });
  }
  return notes;
}

function walkVault(dir: string, acc: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkVault(full, acc);
    else if (st.isFile() && name.endsWith(".md")) acc.push(full);
  }
}

function noteRef(r: DistilledRow): string {
  const dir = `${r.category}s`;
  const slug = kebab(r.topic);
  const suffix = r.sessionId.slice(0, 8);
  return `${dir}/${slug}-${suffix}`;
}
