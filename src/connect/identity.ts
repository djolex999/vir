import type { InsightRow } from "./types.js";

export function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

export const MATCH_JACCARD = 0.5;

export type MatchOutcome =
  | { kind: "new" }
  | { kind: "skip-rejected"; insight: InsightRow }
  | { kind: "update-proposed"; insight: InsightRow }
  | { kind: "accepted-unchanged"; insight: InsightRow }
  | { kind: "accepted-additions"; insight: InsightRow; addedSessions: string[] };

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

// Identity is the member SESSION set: session ids survive note rewrites
// (reconcile, run --full, dedupe winners, review edits); content hashes don't.
// Hash overlap only breaks ties. A rejected rule is also matched by its rule
// embedding, so a reworded re-discovery from new sessions stays rejected.
export function matchCandidate(
  candidate: { sessionIds: string[]; hashes: string[]; ruleVector: number[] | null },
  insights: InsightRow[],
  rejectedVectors: Map<string, number[]>,
  coreSim: number,
): MatchOutcome {
  let best: InsightRow | null = null;
  let bestJ = -1;
  let bestH = -1;
  for (const ins of insights) {
    const j = jaccard(candidate.sessionIds, ins.memberSessionIds);
    if (j < MATCH_JACCARD) continue;
    const h = jaccard(candidate.hashes, ins.memberHashes);
    if (j > bestJ || (j === bestJ && h > bestH)) {
      best = ins;
      bestJ = j;
      bestH = h;
    }
  }
  if (best === null && candidate.ruleVector !== null) {
    for (const ins of insights) {
      if (ins.status !== "rejected") continue;
      const v = rejectedVectors.get(ins.id);
      if (v && cosine(candidate.ruleVector, v) >= coreSim) return { kind: "skip-rejected", insight: ins };
    }
  }
  if (best === null) return { kind: "new" };
  if (best.status === "rejected") return { kind: "skip-rejected", insight: best };
  if (best.status === "proposed") return { kind: "update-proposed", insight: best };
  const known = new Set(best.memberSessionIds);
  const added = [...new Set(candidate.sessionIds)].filter((s) => !known.has(s));
  return added.length === 0
    ? { kind: "accepted-unchanged", insight: best }
    : { kind: "accepted-additions", insight: best, addedSessions: added };
}
