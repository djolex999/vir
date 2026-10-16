import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/config.js";
import { vaultRoot } from "../../src/search/retriever.js";
import { ARMS } from "../arms.js";
import { callJudge, EVAL_MODEL, mapLimit } from "../llm.js";
import { EVAL_DIR, EVAL_LABELS_PATH, EVAL_POOL_PATH, EVAL_QUERIES_PATH } from "../paths.js";
import { REPO_ROOT } from "../repo.js";
import { makeRng } from "../rng.js";
import { runArm } from "../runArm.js";
import { labelStoreKey, type ArmRunOutput, type LabelRecord, type LabelStore, type QuerySet } from "../types.js";
import {
  buildJudgePrompt,
  chunkCandidates,
  contentHash,
  estimateTokens,
  noteExcerpt,
  parseJudgeResponse,
  queryHash,
  rubricHash,
} from "./judge.js";
import { assertPoolMatchesSet, currentLabels } from "./current.js";
import { buildPool, type PoolEntry } from "./pool.js";

export const POOL_K = 20;
// Judged depth. The pool is built at POOL_K so a deeper top-up later judges
// only new pairs; nDCG@8 / recall@8 / MRR need labels for each arm's top 8,
// and two ranks of slack cover pool-depth honesty at a third of the calls.
export const JUDGE_K = 10;
export const MAX_CANDIDATES_PER_CALL = 10;
export const EXCERPT_CHARS = 1200;
export const JUDGE_CONCURRENCY = 5;
export const RUBRIC_PATH = join(REPO_ROOT, "eval", "labels", "rubric.md");

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

export function readQuerySet(): QuerySet {
  if (!existsSync(EVAL_QUERIES_PATH)) {
    throw new Error(`no query set at ${EVAL_QUERIES_PATH} — run \`npm run eval -- queries\``);
  }
  return JSON.parse(readFileSync(EVAL_QUERIES_PATH, "utf8")) as QuerySet;
}

export function readLabelStore(): LabelStore {
  if (!existsSync(EVAL_LABELS_PATH)) return { version: 1, labels: {} };
  return JSON.parse(readFileSync(EVAL_LABELS_PATH, "utf8")) as LabelStore;
}

function writeLabelStore(store: LabelStore): void {
  if (!existsSync(EVAL_DIR)) mkdirSync(EVAL_DIR, { recursive: true });
  writeFileSync(EVAL_LABELS_PATH, JSON.stringify(store, null, 2), "utf8");
}

export function readRubric(): string {
  return readFileSync(RUBRIC_PATH, "utf8");
}

// Runs every arm at top-20 against the query set and writes the pooled
// candidate lists. Arms run sequentially: Ollama and fastembed both hold a
// model in memory and two at once buys nothing on one machine.
export async function buildAndWritePool(): Promise<PoolEntry[]> {
  const set = readQuerySet();
  const runs: Array<{ armId: string; results: ArmRunOutput["results"] }> = [];
  const raw: ArmRunOutput[] = [];
  for (const arm of ARMS) {
    log(`pooling: ${arm.id} at k=${POOL_K}`);
    const out = await runArm(arm, POOL_K);
    const methods = out.results.reduce<Record<string, number>>((acc, r) => {
      acc[r.method] = (acc[r.method] ?? 0) + 1;
      return acc;
    }, {});
    log(`  ${out.results.length} queries, method split ${JSON.stringify(methods)}, home ${out.home}`);
    runs.push({ armId: arm.id, results: out.results });
    raw.push(out);
  }
  const pool = buildPool(runs, POOL_K);
  const total = pool.reduce((n, p) => n + p.candidates.length, 0);
  log(`pool: ${pool.length} queries, ${total} (query, note) pairs, ${(total / Math.max(1, pool.length)).toFixed(1)} per query`);
  // Raw arm outputs ride along: the pool is derived from them, and Phase 2's
  // garbage / contamination numbers need the per-query method and provider.
  writeFileSync(
    EVAL_POOL_PATH,
    JSON.stringify({ version: 1, k: POOL_K, setCreatedAt: set.createdAt, pool, arms: raw }, null, 2),
    "utf8",
  );
  return pool;
}

export function readPool(set: QuerySet): PoolEntry[] {
  if (!existsSync(EVAL_POOL_PATH)) {
    throw new Error(`no pool at ${EVAL_POOL_PATH} — run \`npm run eval -- pool\``);
  }
  const file = JSON.parse(readFileSync(EVAL_POOL_PATH, "utf8")) as { setCreatedAt?: string; pool: PoolEntry[] };
  assertPoolMatchesSet(file, set);
  return file.pool;
}

interface JudgeCall {
  queryId: string;
  queryText: string;
  prompt: string;
  candidates: Array<{ slug: string; hash: string }>;
}

// Plans the calls first so a dry run can report count and token estimate
// with nothing spent. Already-labeled pairs (same note content, same rubric)
// are skipped, so re-running after a note edit re-judges only what changed.
export function planJudgeCalls(
  set: QuerySet,
  pool: PoolEntry[],
  store: LabelStore,
  rubric: string,
  root: string,
  seed: number,
): { calls: JudgeCall[]; skipped: number; missingNotes: string[] } {
  const rh = rubricHash(rubric);
  const byId = new Map(set.queries.map((q) => [q.id, q] as const));
  const judged = new Set(currentLabels(store, set, rh).map((l) => `${l.queryId}|${l.slug}@${l.contentHash}`));
  const calls: JudgeCall[] = [];
  let skipped = 0;
  const missingNotes: string[] = [];
  const noteCache = new Map<string, { raw: string; hash: string } | null>();
  const readNote = (slug: string): { raw: string; hash: string } | null => {
    let v = noteCache.get(slug);
    if (v === undefined) {
      const p = join(root, `${slug}.md`);
      if (existsSync(p)) {
        const raw = readFileSync(p, "utf8");
        v = { raw, hash: contentHash(raw) };
      } else {
        v = null;
      }
      noteCache.set(slug, v);
    }
    return v;
  };

  for (const entry of pool) {
    const q = byId.get(entry.queryId);
    if (!q) continue;
    const pending: Array<{ slug: string; hash: string; excerpt: string }> = [];
    for (const c of entry.candidates) {
      if (!c.seenIn.some((s) => s.rank <= JUDGE_K)) continue;
      const note = readNote(c.slug);
      if (!note) {
        missingNotes.push(c.slug);
        continue;
      }
      if (judged.has(`${q.id}|${c.slug}@${note.hash}`)) {
        skipped += 1;
        continue;
      }
      pending.push({ slug: c.slug, hash: note.hash, excerpt: noteExcerpt(note.raw, EXCERPT_CHARS) });
    }
    if (pending.length === 0) continue;
    // Per-query seed so adding a query never reshuffles another's chunks.
    const rng = makeRng(seed ^ hashSeed(q.id));
    const bySlug = new Map(pending.map((p) => [p.slug, p] as const));
    for (const chunk of chunkCandidates(pending.map((p) => p.slug), MAX_CANDIDATES_PER_CALL, rng)) {
      const cands = chunk.map((s) => bySlug.get(s)!);
      calls.push({
        queryId: q.id,
        queryText: q.text,
        prompt: buildJudgePrompt({ rubric, query: q.text, candidates: cands }),
        candidates: cands.map((c) => ({ slug: c.slug, hash: c.hash })),
      });
    }
  }
  return { calls, skipped, missingNotes };
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export async function labelPool(opts: { seed: number; dryRun: boolean }): Promise<void> {
  const cfg = loadConfig();
  const root = vaultRoot(cfg);
  const set = readQuerySet();
  const pool = readPool(set);
  const store = readLabelStore();
  const rubric = readRubric();
  const rh = rubricHash(rubric);
  const { calls, skipped, missingNotes } = planJudgeCalls(set, pool, store, rubric, root, opts.seed);

  const byClass = new Map<string, { calls: number; tokens: number }>();
  const classOf = new Map(set.queries.map((q) => [q.id, q.class] as const));
  let totalTokens = 0;
  for (const c of calls) {
    const cls = classOf.get(c.queryId) ?? "?";
    const t = estimateTokens(c.prompt);
    totalTokens += t;
    const agg = byClass.get(cls) ?? { calls: 0, tokens: 0 };
    agg.calls += 1;
    agg.tokens += t;
    byClass.set(cls, agg);
  }
  log(`judge plan: model ${EVAL_MODEL}, rubric ${rh}, judged depth k=${JUDGE_K} of pool k=${POOL_K}, max ${MAX_CANDIDATES_PER_CALL} candidates/call, excerpt ${EXCERPT_CHARS} chars`);
  log(`  ${calls.length} calls, ~${totalTokens.toLocaleString()} input tokens (chars/4), ${skipped} pairs already labeled`);
  for (const [cls, agg] of byClass) log(`  ${cls}: ${agg.calls} calls, ~${agg.tokens.toLocaleString()} tokens`);
  if (missingNotes.length > 0) log(`  ${missingNotes.length} pooled slugs have no file (skipped): ${[...new Set(missingNotes)].join(", ")}`);
  if (opts.dryRun || calls.length === 0) return;

  let done = 0;
  await mapLimit(calls, JUDGE_CONCURRENCY, async (call) => {
    const res = await callJudge("eval-label", call.prompt, call.queryId);
    const grades = parseJudgeResponse(res.text, call.candidates.map((c) => c.slug));
    const ts = new Date().toISOString();
    const qh = queryHash(call.queryText);
    for (const c of call.candidates) {
      const rec: LabelRecord = {
        queryId: call.queryId,
        queryHash: qh,
        slug: c.slug,
        contentHash: c.hash,
        grade: grades[c.slug]!,
        model: EVAL_MODEL,
        rubricHash: rh,
        ts,
      };
      store.labels[labelStoreKey(call.queryId, qh, c.slug, c.hash)] = rec;
    }
    done += 1;
    // Persist after every call: a limit wall mid-run must not lose the labels
    // already paid for.
    writeLabelStore(store);
    log(`  [${done}/${calls.length}] ${call.queryId} (${call.candidates.length} notes, ${res.inputTokens} in / ${res.outputTokens} out)`);
  });
  log(`labels: ${Object.keys(store.labels).length} total → ${EVAL_LABELS_PATH}`);
}
