import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { STATE_PATH, loadConfig } from "../../src/config.js";
import { loadIndex, vaultRoot, type IndexedDoc } from "../../src/search/retriever.js";
import { readQueryLog } from "../../src/search/queryLog.js";
import { StateDb } from "../../src/state/db.js";
import { callJudge } from "../llm.js";
import { EVAL_DIR, EVAL_QUERIES_PATH } from "../paths.js";
import { makeRng, sample } from "../rng.js";
import type { EvalQuery, QuerySet } from "../types.js";
import {
  buildConceptualPrompt,
  parseQueryCandidates,
  rareTitleTokens,
  sharesRareTitleToken,
} from "./conceptual.js";
import { GARBAGE_QUERIES } from "./garbage.js";
import { extractIdentifiers, pickIdentifierQuery } from "./identifier.js";
import { selectRealQueries } from "./real.js";

// Real queries logged at or after this instant belong to the harness session
// itself (its own vir_query lookups) and are excluded by timestamp.
export const REAL_CUTOFF = "2026-09-11T20:00:00Z";
export const NEAR_DUP_THRESHOLD = 0.6;
export const RARE_TITLE_RATIO = 0.05;
export const DEFAULT_IDENTIFIER_COUNT = 12;
export const DEFAULT_CONCEPTUAL_COUNT = 12;
const CANDIDATES_PER_NOTE = 3;
const CATEGORY_DIRS = ["decisions/", "gotchas/", "patterns/", "tools/"];

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

function noteBody(raw: string, maxChars: number): string {
  return raw.replace(/^---\n[\s\S]*?\n---\n?/, "").trim().slice(0, maxChars);
}

export interface BuildOpts {
  seed: number;
  dryRun: boolean;
  identifierCount?: number;
  conceptualCount?: number;
}

// One seeded stream per class, so a change to one generator never reshuffles
// another's sample. Conceptual is sampled first because its queries cost an
// LLM call each; identifier takes from what is left.
const SALT_CONCEPTUAL = 0xc0ffee;
const SALT_IDENTIFIER = 0x1d1d1d;

export async function buildQuerySet(opts: BuildOpts): Promise<QuerySet> {
  const cfg = loadConfig();
  const previous = readPrevious();
  const IDENTIFIER_COUNT = opts.identifierCount ?? DEFAULT_IDENTIFIER_COUNT;
  const CONCEPTUAL_COUNT = opts.conceptualCount ?? DEFAULT_CONCEPTUAL_COUNT;

  // ---- real -------------------------------------------------------------
  const real = selectRealQueries(readQueryLog(), REAL_CUTOFF, NEAR_DUP_THRESHOLD);
  log(`real: ${real.length} queries before ${REAL_CUTOFF} after near-dup collapse`);
  const exemplars = real.map((r) => r.text);

  // ---- source notes: live, embedded, in a category dir ------------------
  // Sources come from notes every arm can reach (a DB row exists), so a stale
  // sibling that only TF-IDF walks can never be the note a query is built from.
  const docs = loadIndex(cfg);
  const root = vaultRoot(cfg);
  const db = new StateDb(STATE_PATH, { readonly: true });
  let liveSlugs: Set<string>;
  try {
    liveSlugs = new Set(
      db.getEmbeddings(root).map((r) => r.filePath.slice(root.length + 1).replace(/\.md$/, "")),
    );
  } finally {
    db.close();
  }
  const sources = docs.filter(
    (d) => CATEGORY_DIRS.some((p) => d.relPath.startsWith(p)) && liveSlugs.has(d.title),
  );
  log(`corpus: ${docs.length} files walked, ${sources.length} live category notes eligible as sources`);
  const nDocs = docs.length;
  const dfCache = new Map<string, number>();
  const df = (t: string): number => {
    let v = dfCache.get(t);
    if (v === undefined) {
      v = docs.reduce((n, d) => n + (d.tf.has(t) ? 1 : 0), 0);
      dfCache.set(t, v);
    }
    return v;
  };

  // ---- conceptual (sampled first; cached by source slug) ----------------
  const conceptualRng = makeRng(opts.seed ^ SALT_CONCEPTUAL);
  const conceptualSources = sample(sources, sources.length, conceptualRng);
  const conceptual: EvalQuery[] = [];
  const conceptualUsed = new Set<string>();
  let generatorCalls = 0;
  let attempts = 0;
  for (const d of conceptualSources) {
    if (conceptual.length >= CONCEPTUAL_COUNT) break;
    if (attempts >= CONCEPTUAL_COUNT * 2) break;
    attempts += 1;
    const cached = previous.get(d.title);
    let q: string | null;
    if (cached) {
      q = cached;
    } else if (opts.dryRun) {
      q = `<would generate for ${d.title}>`;
      generatorCalls += 1;
    } else {
      generatorCalls += 1;
      q = await generateConceptual(d, exemplars, df, nDocs);
      if (!q) {
        log(`conceptual: ${d.title} — no candidate passed the title-leak check, resampling`);
        continue;
      }
    }
    conceptualUsed.add(d.title);
    conceptual.push({ id: `conceptual-${conceptual.length + 1}`, class: "conceptual", text: q, sourceSlug: d.title });
  }
  log(`conceptual: ${conceptual.length} queries, ${generatorCalls} generator calls${opts.dryRun ? " (dry run)" : ""}, ${conceptual.length - generatorCalls} from cache`);

  // ---- identifier (rare-token gated, never the same identifier twice) ----
  const identifierRng = makeRng(opts.seed ^ SALT_IDENTIFIER);
  const identifier: EvalQuery[] = [];
  const usedIdents = new Set<string>();
  for (const d of sample(sources.filter((s) => !conceptualUsed.has(s.title)), sources.length, identifierRng)) {
    if (identifier.length >= IDENTIFIER_COUNT) break;
    const q = pickIdentifierQuery(extractIdentifiers(d.raw), df, nDocs, RARE_TITLE_RATIO, usedIdents, identifierRng);
    if (!q) continue;
    for (const part of q.split(" ")) usedIdents.add(part);
    identifier.push({ id: `identifier-${identifier.length + 1}`, class: "identifier", text: q, sourceSlug: d.title });
  }
  log(`identifier: ${identifier.length} queries`);

  // ---- garbage ----------------------------------------------------------
  const garbage: EvalQuery[] = GARBAGE_QUERIES.map((text, i) => ({
    id: `garbage-${i + 1}`,
    class: "garbage",
    text,
    sourceSlug: null,
  }));

  const set: QuerySet = {
    version: 1,
    seed: opts.seed,
    createdAt: new Date().toISOString(),
    realCutoff: REAL_CUTOFF,
    queries: [
      ...real.map((r, i) => ({ id: `real-${i + 1}`, class: "real" as const, text: r.text, sourceSlug: null })),
      ...identifier,
      ...conceptual,
      ...garbage,
    ],
  };
  if (!opts.dryRun) {
    if (!existsSync(EVAL_DIR)) mkdirSync(EVAL_DIR, { recursive: true });
    writeFileSync(EVAL_QUERIES_PATH, JSON.stringify(set, null, 2), "utf8");
    log(`wrote ${set.queries.length} queries → ${EVAL_QUERIES_PATH}`);
  }
  return set;
}

// Conceptual queries already generated for a source note are reused, so a
// regeneration after a sampler change only pays for genuinely new notes.
function readPrevious(): Map<string, string> {
  if (!existsSync(EVAL_QUERIES_PATH)) return new Map();
  try {
    const prev = JSON.parse(readFileSync(EVAL_QUERIES_PATH, "utf8")) as QuerySet;
    return new Map(
      prev.queries
        .filter((q) => q.class === "conceptual" && q.sourceSlug)
        .map((q) => [q.sourceSlug!, q.text] as const),
    );
  } catch {
    return new Map();
  }
}

async function generateConceptual(
  d: IndexedDoc,
  exemplars: readonly string[],
  df: (t: string) => number,
  nDocs: number,
): Promise<string | null> {
  const forbidden = rareTitleTokens(d.title, df, nDocs, RARE_TITLE_RATIO);
  const prompt = buildConceptualPrompt({
    title: d.title.slice(d.title.lastIndexOf("/") + 1),
    body: noteBody(d.raw, 3000),
    exemplars,
    forbidden,
    count: CANDIDATES_PER_NOTE,
  });
  const res = await callJudge("eval-query-gen", prompt, d.title);
  let candidates: string[];
  try {
    candidates = parseQueryCandidates(res.text);
  } catch (err) {
    log(`conceptual: ${d.title} — ${(err as Error).message}`);
    return null;
  }
  return candidates.find((c) => !sharesRareTitleToken(c, d.title, df, nDocs, RARE_TITLE_RATIO)) ?? null;
}
