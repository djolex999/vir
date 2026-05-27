import type { CostRecord } from "./log.js";

export interface SessionCost {
  session: string;
  project: string | null;
  cost: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface CostReport {
  total: number;
  recordCount: number;
  sessionCount: number;
  median: number;
  p90: number;
  bySession: SessionCost[];
}

export function buildReport(records: CostRecord[]): CostReport {
  if (records.length === 0) {
    return { total: 0, recordCount: 0, sessionCount: 0, median: 0, p90: 0, bySession: [] };
  }

  const groups = new Map<string, SessionCost>();

  for (const rec of records) {
    const key = rec.session ?? rec.stage;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        session: key,
        project: rec.project,
        cost: rec.estimated_cost_usd,
        calls: 1,
        inputTokens: rec.input_tokens,
        outputTokens: rec.output_tokens,
      });
    } else {
      existing.cost         += rec.estimated_cost_usd;
      existing.calls        += 1;
      existing.inputTokens  += rec.input_tokens;
      existing.outputTokens += rec.output_tokens;
      // carry the first non-null project seen
      if (existing.project === null && rec.project !== null) {
        existing.project = rec.project;
      }
    }
  }

  const bySession = Array.from(groups.values()).sort((a, b) => b.cost - a.cost);
  const total     = records.reduce((acc, r) => acc + r.estimated_cost_usd, 0);

  const sums = bySession.map((s) => s.cost).sort((a, b) => a - b);
  const n    = sums.length;

  const median = computeMedian(sums, n);
  const p90    = computeP90(sums, n);

  return {
    total,
    recordCount: records.length,
    sessionCount: n,
    median,
    p90,
    bySession,
  };
}

function computeMedian(sortedAsc: number[], n: number): number {
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sortedAsc[mid]!;
  return (sortedAsc[mid - 1]! + sortedAsc[mid]!) / 2;
}

function computeP90(sortedAsc: number[], n: number): number {
  if (n === 0) return 0;
  // nearest-rank: idx = ceil(0.9 * n) - 1, clamped to [0, n-1]
  const idx = Math.max(0, Math.ceil(0.9 * n) - 1);
  return sortedAsc[idx]!;
}
