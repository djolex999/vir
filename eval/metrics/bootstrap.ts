import type { Rng } from "../rng.js";

// Nearest-rank percentile on an already-sorted array.
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const idx = Math.floor(p * (sorted.length - 1));
  return sorted[Math.min(sorted.length - 1, Math.max(0, idx))]!;
}

export function mean(values: ReadonlyArray<number | null>): number | null {
  const xs = values.filter((v): v is number => v !== null);
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export interface BootstrapCI {
  n: number;
  meanDiff: number;
  lo: number;
  hi: number;
  // The honest verdict at small N: when true, report "no detectable
  // difference" and do not rank the arms on this metric.
  crossesZero: boolean;
}

// Paired bootstrap over per-query differences (arm A minus arm B on the same
// queries). Resamples queries with replacement B times, takes the 2.5 / 97.5
// percentiles of the resampled mean difference.
export function pairedBootstrapCI(diffs: readonly number[], rounds: number, rng: Rng): BootstrapCI {
  const n = diffs.length;
  if (n === 0) return { n: 0, meanDiff: Number.NaN, lo: Number.NaN, hi: Number.NaN, crossesZero: true };
  const meanDiff = diffs.reduce((a, b) => a + b, 0) / n;
  // One query has no spread to resample: the interval is a point, not
  // evidence, so it never counts as a detectable difference.
  if (n === 1) return { n, meanDiff, lo: meanDiff, hi: meanDiff, crossesZero: true };
  const means: number[] = [];
  for (let r = 0; r < rounds; r += 1) {
    let sum = 0;
    for (let i = 0; i < n; i += 1) sum += diffs[Math.floor(rng() * n)]!;
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  const lo = percentile(means, 0.025);
  const hi = percentile(means, 0.975);
  return { n, meanDiff, lo, hi, crossesZero: lo <= 0 && hi >= 0 };
}
