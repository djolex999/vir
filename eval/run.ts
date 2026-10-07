import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { STATE_PATH, loadConfig } from "../src/config.js";
import { vaultRoot } from "../src/search/retriever.js";
import { ARMS, type ArmSpec } from "./arms.js";
import { agreement } from "./labels/agreement.js";
import { rubricHash, type Grade } from "./labels/judge.js";
import { readLabelStore, readQuerySet, readRubric } from "./labels/run.js";
import { mean, pairedBootstrapCI, type BootstrapCI } from "./metrics/bootstrap.js";
import { contaminationAtK, isAgentDerived } from "./metrics/contamination.js";
import { garbageRates, type GarbageRates } from "./metrics/garbage.js";
import { mrr, ndcgAtK, recallAtK, unjudgedAtK, type Grades } from "./metrics/rank.js";
import { EVAL_LABELS_PATH, EVAL_QUERIES_PATH, EVAL_RUNS_DIR, EVAL_SPOTCHECK_PATH } from "./paths.js";
import { REPO_ROOT } from "./repo.js";
import { makeRng } from "./rng.js";
import { armHome, runArm } from "./runArm.js";
import type { ArmRunOutput, QueryClass, SpotcheckStore } from "./types.js";

// `vir query` default limit; every rank metric is @K.
export const K = 8;
export const BOOTSTRAP_ROUNDS = 2000;
// Production's own configuration (Ollama detected, retrievalDiversity 0.3)
// is the reference every other arm is compared against.
export const BASELINE_ARM = "nomic-mmr";
const RANKED_CLASSES: QueryClass[] = ["real", "identifier", "conceptual"];
const METRICS = ["ndcg", "recall", "mrr"] as const;
type Metric = (typeof METRICS)[number];

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

function sha12(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

interface PerQuery {
  queryId: string;
  class: QueryClass;
  ndcg: number | null;
  recall: number | null;
  mrr: number | null;
  unjudged: number;
  contamination: number;
}

export interface ClassAggregate {
  n: number;
  ndcg: number | null;
  recall: number | null;
  mrr: number | null;
  unjudged: number;
  contamination: number;
}

export interface ArmReport {
  id: string;
  label: string;
  provider: ArmRunOutput["results"][number]["provider"];
  corpus: ArmRunOutput["corpus"];
  methodSplit: Record<string, number>;
  excludedMismatched: number;
  byClass: Record<string, ClassAggregate>;
  garbage: GarbageRates;
  perQuery: PerQuery[];
}

export interface Comparison {
  a: string;
  b: string;
  class: string;
  metric: Metric;
  ci: BootstrapCI;
}

export interface RunRecord {
  version: 1;
  ts: string;
  git: { sha: string; dirty: boolean; branch: string };
  k: number;
  seed: number;
  bootstrapRounds: number;
  baselineArm: string;
  inputs: { queriesHash: string; labelsHash: string; rubricHash: string; queryCount: number; labelCount: number };
  spotcheck: { n: number; exact: number; within1: number; binary: number; kappa: number } | { reported: string };
  arms: ArmReport[];
  comparisons: Comparison[];
  armConfigs: Record<string, unknown>;
}

// Slug → agent-derived? Built once from the REAL vir.db (read-only) and the
// live note files: entrypoint + transcript path from the row, merge-winner
// status from the note body. Slugs with no session row (topics, pdfs,
// projects/, strays) are clean by definition — they never came from a transcript.
function buildAgentClassifier(): (slug: string) => boolean {
  const cfg = loadConfig();
  const root = vaultRoot(cfg);
  const claudeDir = cfg.claudeProjectsDir;
  if (claudeDir === undefined) throw new Error("the retrieval eval reads Claude Code transcripts: set claudeProjectsDir in ~/.vir/config.json");
  // Row identity only (path, entrypoint, note_paths); no StateDb accessor
  // exposes that triple for every row and adding one to src/ for the harness
  // would be scope creep. Read-only connection, plain SELECT.
  const db = new Database(STATE_PATH, { readonly: true, fileMustExist: true });
  const bySlug = new Map<string, { path: string; entrypoint: string | null }>();
  try {
    const rows = db
      .prepare("SELECT path, entrypoint, note_paths FROM sessions")
      .all() as Array<{ path: string; entrypoint: string | null; note_paths: string }>;
    for (const r of rows) {
      let notePaths: string[] = [];
      try {
        notePaths = JSON.parse(r.note_paths) as string[];
      } catch {
        notePaths = [];
      }
      for (const np of notePaths) {
        const base = np.slice(np.lastIndexOf("/") + 1).replace(/\.md$/, "");
        bySlug.set(base, { path: r.path, entrypoint: r.entrypoint });
      }
    }
  } finally {
    db.close();
  }
  const cache = new Map<string, boolean>();
  return (slug: string): boolean => {
    let v = cache.get(slug);
    if (v !== undefined) return v;
    const base = slug.slice(slug.lastIndexOf("/") + 1);
    const row = bySlug.get(base);
    if (!row) {
      v = false;
    } else {
      const file = join(root, `${slug}.md`);
      const isMergeWinner = existsSync(file) && readFileSync(file, "utf8").includes("## Archived Duplicates");
      v = isAgentDerived({ path: row.path, entrypoint: row.entrypoint, isMergeWinner }, claudeDir);
    }
    cache.set(slug, v);
    return v;
  };
}

// `n` is the number of queries that COUNTED for the rank metrics (a query
// with no relevant judged note is undefined and excluded); garbage rows have
// no rank metrics, so there n is the row count.
function aggregate(rows: PerQuery[]): ClassAggregate {
  const defined = rows.filter((r) => r.ndcg !== null).length;
  return {
    n: rows.length > 0 && rows.every((r) => r.class === "garbage") ? rows.length : defined,
    ndcg: mean(rows.map((r) => r.ndcg)),
    recall: mean(rows.map((r) => r.recall)),
    mrr: mean(rows.map((r) => r.mrr)),
    unjudged: mean(rows.map((r) => r.unjudged)) ?? 0,
    contamination: mean(rows.map((r) => r.contamination)) ?? 0,
  };
}

export async function runBaseline(opts: { seed: number; arms?: readonly ArmSpec[] }): Promise<RunRecord> {
  const set = readQuerySet();
  const store = readLabelStore();
  const rubric = readRubric();
  const classOf = new Map(set.queries.map((q) => [q.id, q.class] as const));

  // grades[queryId] = slug → grade, over every judged pair for that query.
  const grades = new Map<string, Map<string, Grade>>();
  for (const l of Object.values(store.labels)) {
    let m = grades.get(l.queryId);
    if (!m) {
      m = new Map();
      grades.set(l.queryId, m);
    }
    m.set(l.slug, l.grade);
  }
  const isAgent = buildAgentClassifier();

  const arms = opts.arms ?? ARMS;
  const reports: ArmReport[] = [];
  const outputs = new Map<string, ArmRunOutput>();
  for (const arm of arms) {
    log(`running ${arm.id} at k=${K}`);
    const out = await runArm(arm, K);
    outputs.set(arm.id, out);
    const perQuery: PerQuery[] = [];
    const methodSplit: Record<string, number> = {};
    let excluded = 0;
    for (const r of out.results) {
      methodSplit[r.method] = (methodSplit[r.method] ?? 0) + 1;
      excluded = Math.max(excluded, r.excludedMismatched);
      const cls = classOf.get(r.queryId);
      if (!cls) continue;
      const ranked = r.hits.map((h) => h.slug);
      const g: Grades = grades.get(r.queryId) ?? new Map();
      perQuery.push({
        queryId: r.queryId,
        class: cls,
        ndcg: cls === "garbage" ? null : ndcgAtK(ranked, g, K),
        recall: cls === "garbage" ? null : recallAtK(ranked, g, K),
        mrr: cls === "garbage" ? null : mrr(ranked, g, K),
        unjudged: unjudgedAtK(ranked, g, K),
        contamination: contaminationAtK(ranked, isAgent, K),
      });
    }
    const byClass: Record<string, ClassAggregate> = {};
    for (const cls of ["real", "identifier", "conceptual", "garbage"] as const) {
      byClass[cls] = aggregate(perQuery.filter((p) => p.class === cls));
    }
    byClass["all-ranked"] = aggregate(perQuery.filter((p) => p.class !== "garbage"));
    const garbage = garbageRates(
      out.results
        .filter((r) => classOf.get(r.queryId) === "garbage")
        .map((r) => ({ method: r.method, hits: r.hits.length })),
    );
    reports.push({
      id: arm.id,
      label: arm.label,
      provider: out.results.find((r) => r.provider)?.provider ?? null,
      corpus: out.corpus,
      methodSplit,
      excludedMismatched: excluded,
      byClass,
      garbage,
      perQuery,
    });
  }

  // Paired comparisons: every arm against the baseline, plus the MMR pairs
  // and the two embedding models head to head (MMR off).
  const pairs: Array<[string, string]> = [];
  for (const a of arms) if (a.id !== BASELINE_ARM) pairs.push([a.id, BASELINE_ARM]);
  const extra: Array<[string, string]> = [["nomic-mmr", "nomic"], ["bge-mmr", "bge"], ["bge", "nomic"]];
  for (const p of extra) {
    if (arms.some((a) => a.id === p[0]) && arms.some((a) => a.id === p[1]) && p[1] !== BASELINE_ARM) pairs.push(p);
  }
  const comparisons: Comparison[] = [];
  const rng = makeRng(opts.seed);
  const byArm = new Map(reports.map((r) => [r.id, r] as const));
  for (const [a, b] of pairs) {
    const ra = byArm.get(a);
    const rb = byArm.get(b);
    if (!ra || !rb) continue;
    for (const cls of [...RANKED_CLASSES, "all-ranked"]) {
      for (const metric of METRICS) {
        const diffs: number[] = [];
        for (const pa of ra.perQuery) {
          if (cls !== "all-ranked" && pa.class !== cls) continue;
          if (pa.class === "garbage") continue;
          const pb = rb.perQuery.find((x) => x.queryId === pa.queryId);
          const va = pa[metric];
          const vb = pb?.[metric] ?? null;
          if (va === null || vb === null) continue;
          diffs.push(va - vb);
        }
        comparisons.push({ a, b, class: cls, metric, ci: pairedBootstrapCI(diffs, BOOTSTRAP_ROUNDS, rng) });
      }
    }
  }

  const armConfigs: Record<string, unknown> = {};
  for (const arm of arms) {
    armConfigs[arm.id] = JSON.parse(readFileSync(join(armHome(arm), ".vir", "config.json"), "utf8"));
  }
  const spot = readSpotcheck();
  const record: RunRecord = {
    version: 1,
    ts: new Date().toISOString(),
    git: { sha: git(["rev-parse", "HEAD"]), dirty: git(["status", "--porcelain"]).length > 0, branch: git(["rev-parse", "--abbrev-ref", "HEAD"]) },
    k: K,
    seed: opts.seed,
    bootstrapRounds: BOOTSTRAP_ROUNDS,
    baselineArm: BASELINE_ARM,
    inputs: {
      queriesHash: sha12(readFileSync(EVAL_QUERIES_PATH, "utf8")),
      labelsHash: sha12(readFileSync(EVAL_LABELS_PATH, "utf8")),
      rubricHash: rubricHash(rubric),
      queryCount: set.queries.length,
      labelCount: Object.keys(store.labels).length,
    },
    spotcheck: spot,
    arms: reports,
    comparisons,
    armConfigs,
  };
  mkdirSync(EVAL_RUNS_DIR, { recursive: true });
  const outPath = join(EVAL_RUNS_DIR, `${record.ts.replace(/[:.]/g, "-")}.json`);
  writeFileSync(outPath, JSON.stringify(record, null, 2), "utf8");
  log("");
  log(renderRecord(record));
  log(`run record → ${outPath}`);
  return record;
}

function readSpotcheck(): RunRecord["spotcheck"] {
  if (!existsSync(EVAL_SPOTCHECK_PATH)) {
    return { reported: "no spotcheck.json on disk; Djole reported 80% within ±1 on 2026-09-12" };
  }
  const s = JSON.parse(readFileSync(EVAL_SPOTCHECK_PATH, "utf8")) as SpotcheckStore;
  const a = agreement(s.pairs);
  return { n: a.n, exact: a.exact, within1: a.within1, binary: a.binary, kappa: a.kappa };
}

function fmt(v: number | null, digits = 3): string {
  return v === null ? "   —  " : v.toFixed(digits).padStart(6);
}

export function renderRecord(r: RunRecord): string {
  const lines: string[] = [];
  lines.push(`baseline run ${r.ts}  git ${r.git.sha.slice(0, 7)}${r.git.dirty ? "+dirty" : ""}  k=${r.k}  queries ${r.inputs.queryCount}  labels ${r.inputs.labelCount}`);
  for (const arm of r.arms) {
    const prov = arm.provider ? `${arm.provider.model}/${arm.provider.dim}d` : "tfidf";
    lines.push(`  ${arm.id.padEnd(10)} ${prov.padEnd(24)} corpus walked ${arm.corpus.walkedFiles}, rows ${JSON.stringify(arm.corpus.embeddingRows)}, excludedMismatched ${arm.excludedMismatched}`);
  }
  lines.push("");
  for (const cls of ["real", "identifier", "conceptual", "all-ranked"]) {
    lines.push(`## ${cls}`);
    lines.push(`  arm         n   nDCG@8  recall@8   MRR   unjudged@8  contam@8`);
    for (const arm of r.arms) {
      const c = arm.byClass[cls]!;
      lines.push(`  ${arm.id.padEnd(10)} ${String(c.n).padStart(2)}  ${fmt(c.ndcg)}   ${fmt(c.recall)}  ${fmt(c.mrr)}   ${fmt(c.unjudged, 2)}     ${fmt(c.contamination, 2)}`);
    }
    lines.push("");
  }
  lines.push(`## garbage (n=${r.arms[0]?.garbage.n ?? 0})`);
  lines.push(`  arm         any-hit  via-embedding-floor  via-tfidf-fallback  contam@8`);
  for (const arm of r.arms) {
    const g = arm.garbage;
    lines.push(`  ${arm.id.padEnd(10)}  ${fmt(g.anyHit, 2)}      ${fmt(g.viaEmbedding, 2)}            ${fmt(g.viaFallback, 2)}         ${fmt(arm.byClass["garbage"]!.contamination, 2)}`);
  }
  lines.push("");
  lines.push(`## paired bootstrap 95% CI on differences (${r.bootstrapRounds} rounds; "—" = no detectable difference)`);
  lines.push(`  pair                    class        metric   mean diff   CI`);
  for (const c of r.comparisons) {
    const verdict = c.ci.crossesZero ? "—" : c.ci.meanDiff > 0 ? "A better" : "B better";
    lines.push(`  ${`${c.a} vs ${c.b}`.padEnd(23)} ${c.class.padEnd(12)} ${c.metric.padEnd(8)} ${fmt(c.ci.meanDiff)}   [${fmt(c.ci.lo)}, ${fmt(c.ci.hi)}]  n=${c.ci.n}  ${verdict}`);
  }
  return lines.join("\n");
}
