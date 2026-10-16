import { pairedBootstrapCI, type BootstrapCI } from "../metrics/bootstrap.js";
import { makeRng } from "../rng.js";

// Golden numbers from the TS implementations, for the Python port in
// eval/analysis/src to match bit for bit. Synthetic inputs only: this file
// and its fixture are committed, so nothing here may come from ~/.vir/eval.

export const GOLDEN_SEED = 20260911;
export const GOLDEN_ROUNDS = 2000;
const RNG_SEEDS = [0, 1, 7, GOLDEN_SEED, 0x7fffffff, 0xffffffff];
const RNG_DRAWS = 25;

// Deterministic, irregular values in [-1, 1] without using the RNG under test.
function wave(n: number, phase: number): number[] {
  return Array.from({ length: n }, (_, i) => Math.sin(i * 1.7 + phase) * Math.cos(i * 0.31 + phase * 2));
}

export const GOLDEN_DIFF_SETS: number[][] = [
  [],
  [0.3],
  [0, 0, 0],
  [0.5, -0.5],
  [1, 0, 0, 0.5, -0.25, 0, 1],
  wave(7, 0.1),
  wave(10, 1.3),
  wave(41, 2.9),
  wave(13, 0.7).map((v) => v * 1e-9),
  [0.1, 0.2, 0.3, 0.1, 0.2, 0.3, 0.1, 0.2],
];

export interface Golden {
  rng: Array<{ seed: number; draws: number[] }>;
  // One RNG shared across every set in order, the way runBaseline shares one
  // across its comparisons: parity here also proves draw-order parity.
  bootstrap: { seed: number; rounds: number; cases: Array<{ diffs: number[]; ci: BootstrapCI }> };
}

export function buildGolden(): Golden {
  const rng = RNG_SEEDS.map((seed) => {
    const next = makeRng(seed);
    return { seed, draws: Array.from({ length: RNG_DRAWS }, () => next()) };
  });
  const shared = makeRng(GOLDEN_SEED);
  const cases = GOLDEN_DIFF_SETS.map((diffs) => ({ diffs, ci: pairedBootstrapCI(diffs, GOLDEN_ROUNDS, shared) }));
  return { rng, bootstrap: { seed: GOLDEN_SEED, rounds: GOLDEN_ROUNDS, cases } };
}
