import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadConfig } from "../../src/config.js";
import { vaultRoot } from "../../src/search/retriever.js";
import { EVAL_SPOTCHECK_PATH } from "../paths.js";
import { makeRng, sample } from "../rng.js";
import type { LabelRecord, QueryClass, SpotcheckStore } from "../types.js";
import { agreement } from "./agreement.js";
import { currentLabels } from "./current.js";
import { contentHash, noteExcerpt, queryHash, rubricHash, type Grade } from "./judge.js";
import { readLabelStore, readQuerySet, readRubric } from "./run.js";

export const SPOTCHECK_N = 20;
const PER_CLASS = 5;

function log(line: string): void {
  stdout.write(`${line}\n`);
}

function readStore(): SpotcheckStore {
  if (!existsSync(EVAL_SPOTCHECK_PATH)) return { version: 1, seed: 0, pairs: [] };
  return JSON.parse(readFileSync(EVAL_SPOTCHECK_PATH, "utf8")) as SpotcheckStore;
}

// Stratified: PER_CLASS pairs per query class, seeded, from labels whose note
// content still matches (an edited note is dropped, never shown stale).
export function pickPairs(
  labels: readonly LabelRecord[],
  classOf: (queryId: string) => QueryClass | undefined,
  already: ReadonlySet<string>,
  seed: number,
  keyOf: (l: LabelRecord) => string = (l) => `${l.queryId}|${l.slug}`,
): LabelRecord[] {
  const rng = makeRng(seed);
  const out: LabelRecord[] = [];
  for (const cls of ["real", "identifier", "conceptual", "garbage"] as const) {
    const eligible = labels.filter(
      (l) => classOf(l.queryId) === cls && !already.has(keyOf(l)),
    );
    out.push(...sample(eligible, PER_CLASS, rng));
  }
  return out;
}

export async function runSpotcheck(opts: { seed: number }): Promise<void> {
  const cfg = loadConfig();
  const root = vaultRoot(cfg);
  const set = readQuerySet();
  const labels = currentLabels(readLabelStore(), set, rubricHash(readRubric()));
  const store = readStore();
  const classOf = new Map(set.queries.map((q) => [q.id, q.class] as const));
  const textOf = new Map(set.queries.map((q) => [q.id, q.text] as const));
  const hashOf = new Map(set.queries.map((q) => [q.id, queryHash(q.text)] as const));
  // Ids are positional: a pair is "already graded" only for the same query
  // text. Pairs saved before queryHash existed count for this set only if
  // graded after it was created (same rule as labels/current.ts).
  const pairKey = (queryId: string, qh: string | undefined, slug: string): string => `${queryId}#${qh ?? "?"}|${slug}`;
  const already = new Set(
    store.pairs.map((p) => pairKey(p.queryId, p.queryHash ?? (p.ts >= set.createdAt ? hashOf.get(p.queryId) : undefined), p.slug)),
  );

  const picked = pickPairs(labels, (id) => classOf.get(id), already, opts.seed, (l) => pairKey(l.queryId, hashOf.get(l.queryId), l.slug));
  if (picked.length === 0) {
    log("nothing left to spot-check (all pairs graded or no labels yet)");
    report(store);
    return;
  }
  log(readRubric().trim());
  log("");
  log(`${picked.length} pairs. Grade 0 / 1 / 2, "s" to skip, "q" to stop. Model labels are hidden.`);
  log("");

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    for (let i = 0; i < picked.length; i += 1) {
      const l = picked[i]!;
      const p = join(root, `${l.slug}.md`);
      if (!existsSync(p)) continue;
      const raw = readFileSync(p, "utf8");
      if (contentHash(raw) !== l.contentHash) continue;
      log(`---- ${i + 1}/${picked.length} ----`);
      log(`QUERY: ${textOf.get(l.queryId) ?? l.queryId}`);
      log(`NOTE:  ${l.slug}`);
      log("");
      log(noteExcerpt(raw, 1500));
      log("");
      let human: Grade | null = null;
      for (;;) {
        const ans = (await rl.question("grade [0/1/2/s/q]: ")).trim().toLowerCase();
        if (ans === "q") {
          report(store);
          return;
        }
        if (ans === "s") break;
        if (ans === "0" || ans === "1" || ans === "2") {
          human = Number(ans) as Grade;
          break;
        }
      }
      if (human === null) continue;
      store.seed = opts.seed;
      store.pairs.push({
        queryId: l.queryId,
        queryHash: hashOf.get(l.queryId),
        slug: l.slug,
        contentHash: l.contentHash,
        human,
        model: l.grade,
        ts: new Date().toISOString(),
      });
      writeFileSync(EVAL_SPOTCHECK_PATH, JSON.stringify(store, null, 2), "utf8");
      log("");
    }
  } finally {
    rl.close();
  }
  report(store);
}

export function report(store: SpotcheckStore): void {
  const a = agreement(store.pairs);
  log("");
  log(`spot-check agreement over ${a.n} pairs (human vs ${store.pairs[0] ? "model" : "—"}):`);
  if (a.n === 0) return;
  log(`  exact      ${(a.exact * 100).toFixed(0)}%`);
  log(`  within ±1  ${(a.within1 * 100).toFixed(0)}%`);
  log(`  relevant/not agree  ${(a.binary * 100).toFixed(0)}%`);
  log(`  Cohen's kappa       ${a.kappa.toFixed(2)}`);
  const conf = [0, 1, 2].map(() => [0, 0, 0]);
  for (const p of store.pairs) {
    const row = conf[p.human]!;
    row[p.model] = (row[p.model] ?? 0) + 1;
  }
  log("  confusion (rows human 0/1/2, cols model 0/1/2):");
  for (const row of conf) log(`    ${row.join("  ")}`);
}
