import type { LabelRecord, LabelStore, QuerySet } from "../types.js";
import { queryHash } from "./judge.js";

// Query ids are positional (identifier-3), so a rebuilt set reuses an id for
// different text. Every reader of the label store goes through this filter,
// which keeps only labels judged for the query text the set carries now,
// under the current rubric.
//
// Labels written before queryHash existed carry none. They are trusted only
// if written after the set was created: buildQuerySet rewrites the whole set
// with a fresh createdAt, so a later label was judged against this text.
export function currentLabels(store: LabelStore, set: QuerySet, rubricHash: string): LabelRecord[] {
  const hashOf = new Map(set.queries.map((q) => [q.id, queryHash(q.text)] as const));
  return Object.values(store.labels).filter((l) => {
    const qh = hashOf.get(l.queryId);
    if (qh === undefined || l.rubricHash !== rubricHash) return false;
    return l.queryHash !== undefined ? l.queryHash === qh : l.ts >= set.createdAt;
  });
}

// The pool lists candidates per query id; a pool from an older set pairs
// those candidates with whatever text the ids carry now.
export function assertPoolMatchesSet(pool: { setCreatedAt?: string }, set: QuerySet): void {
  if (pool.setCreatedAt !== set.createdAt) {
    throw new Error(
      `pool was built for the query set created ${pool.setCreatedAt ?? "(unknown)"}, but queries.json is from ${set.createdAt} — run \`npm run eval -- pool\``,
    );
  }
}
