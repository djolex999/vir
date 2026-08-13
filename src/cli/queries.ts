import type { QueryLogRecord } from "../search/queryLog.js";

// Below this many logged queries, "never surfaced" is dominated by "never
// asked about" — a handful of queries can only touch a handful of notes, so
// presenting the rest as dead weight is noise dressed as signal. 20 queries
// at topK 5–8 give every genuinely useful note ~100+ chances to surface.
export const MIN_DEAD_WEIGHT_SAMPLE = 20;

export interface QueriesReport {
  total: number;
  byMethod: { embedding: number; tfidf: number };
  degraded: number;
  degradedRate: number;
  topNotes: Array<{ slug: string; count: number; avgRank: number }>;
  // Notes that never surfaced in ANY logged query — the prune target. null
  // (not []) below MIN_DEAD_WEIGHT_SAMPLE: "insufficient sample" must never
  // read as "no dead weight".
  deadWeight: string[] | null;
}

export function buildQueriesReport(
  records: QueryLogRecord[],
  allSlugs: string[],
  topN = 10,
): QueriesReport {
  const surfaced = new Map<string, { count: number; rankSum: number }>();
  let embedding = 0;
  let tfidf = 0;
  let degraded = 0;
  for (const r of records) {
    if (r.method === "embedding") embedding += 1;
    else tfidf += 1;
    if (r.degraded) degraded += 1;
    for (const h of r.hits) {
      const s = surfaced.get(h.slug) ?? { count: 0, rankSum: 0 };
      s.count += 1;
      s.rankSum += h.rank;
      surfaced.set(h.slug, s);
    }
  }

  const topNotes = [...surfaced.entries()]
    .map(([slug, s]) => ({
      slug,
      count: s.count,
      avgRank: Math.round((s.rankSum / s.count) * 100) / 100,
    }))
    .sort((a, b) => b.count - a.count || a.avgRank - b.avgRank)
    .slice(0, topN);

  return {
    total: records.length,
    byMethod: { embedding, tfidf },
    degraded,
    degradedRate: records.length === 0 ? 0 : degraded / records.length,
    topNotes,
    deadWeight:
      records.length < MIN_DEAD_WEIGHT_SAMPLE
        ? null
        : allSlugs.filter((s) => !surfaced.has(s)),
  };
}
