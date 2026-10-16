import type { Grade } from "./labels/judge.js";

export type QueryClass = "real" | "identifier" | "conceptual" | "garbage";

export interface EvalQuery {
  id: string;
  class: QueryClass;
  text: string;
  // The note the query was generated from (identifier / conceptual). Never a
  // label — the pooled judge decides relevance — but recorded so a generator
  // bug is diagnosable.
  sourceSlug: string | null;
}

export interface QuerySet {
  version: 1;
  seed: number;
  createdAt: string;
  // Real queries logged at or after this instant are excluded (the harness
  // session's own vir_query calls).
  realCutoff: string;
  queries: EvalQuery[];
}

export interface ArmHit {
  slug: string;
  score: number;
}

export interface ArmQueryResult {
  queryId: string;
  method: "embedding" | "tfidf";
  degraded: boolean;
  embedError: string | null;
  noProvider: boolean;
  candidates: number;
  excludedMismatched: number;
  provider: { name: string; model: string; dim: number } | null;
  latencyMs: number;
  hits: ArmHit[];
}

// What a child worker reports. `home`/`dbPath`/`configPath`/`embedderDir` are
// the child's own view of its path constants — the parent asserts they sit
// inside the arm home before trusting a single hit.
export interface ArmRunOutput {
  armId: string;
  limit: number;
  // TF-IDF's corpus is the file walk; embedding's is the DB rows, per model.
  corpus: { walkedFiles: number; embeddingRows: Record<string, number> };
  home: string;
  dbPath: string;
  configPath: string;
  embedderDir: string;
  results: ArmQueryResult[];
}

export interface LabelRecord {
  queryId: string;
  // sha256(query text)[:12]. Absent on labels written before it existed;
  // labels/current.ts decides whether those still apply.
  queryHash?: string;
  slug: string;
  contentHash: string;
  grade: Grade;
  model: string;
  rubricHash: string;
  ts: string;
}

export interface LabelStore {
  version: 1;
  // key: `${queryId}#${queryHash}|${slug}@${contentHash}` (older entries: `${queryId}|${slug}@${contentHash}`)
  labels: Record<string, LabelRecord>;
}

export interface SpotcheckPair {
  queryId: string;
  queryHash?: string;
  slug: string;
  contentHash: string;
  human: Grade;
  model: Grade;
  ts: string;
}

export interface SpotcheckStore {
  version: 1;
  seed: number;
  pairs: SpotcheckPair[];
}

export function labelStoreKey(queryId: string, queryHash: string, slug: string, contentHash: string): string {
  return `${queryId}#${queryHash}|${slug}@${contentHash}`;
}
