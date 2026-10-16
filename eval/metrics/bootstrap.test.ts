import { describe, expect, it } from "vitest";
import { makeRng } from "../rng.js";
import { mean, pairedBootstrapCI, percentile } from "./bootstrap.js";

describe("percentile (nearest-rank on a sorted array)", () => {
  it("hand-computed on [1,2,3,4,5]", () => {
    const s = [1, 2, 3, 4, 5];
    expect(percentile(s, 0)).toBe(1);
    expect(percentile(s, 1)).toBe(5);
    expect(percentile(s, 0.5)).toBe(3);
    // 0.025 * (5-1) = 0.1 → floor 0 → 1 ; 0.975 * 4 = 3.9 → floor 3 → 4
    expect(percentile(s, 0.025)).toBe(1);
    expect(percentile(s, 0.975)).toBe(4);
  });
});

describe("pairedBootstrapCI", () => {
  it("all differences equal → CI collapses to that value", () => {
    const ci = pairedBootstrapCI([0.5, 0.5, 0.5, 0.5], 500, makeRng(1));
    expect(ci.meanDiff).toBeCloseTo(0.5, 10);
    expect(ci.lo).toBeCloseTo(0.5, 10);
    expect(ci.hi).toBeCloseTo(0.5, 10);
    expect(ci.crossesZero).toBe(false);
  });

  it("[+1, -1]: resampled means are -1, 0 or +1 → CI [-1, 1], crosses zero", () => {
    const ci = pairedBootstrapCI([1, -1], 2000, makeRng(2));
    expect(ci.meanDiff).toBe(0);
    expect(ci.lo).toBe(-1);
    expect(ci.hi).toBe(1);
    expect(ci.crossesZero).toBe(true);
  });

  it("consistently positive differences → CI above zero", () => {
    const ci = pairedBootstrapCI([0.1, 0.2, 0.15, 0.3, 0.05, 0.25], 2000, makeRng(3));
    expect(ci.lo).toBeGreaterThan(0);
    expect(ci.crossesZero).toBe(false);
  });

  it("deterministic per seed; n < 2 yields a degenerate interval", () => {
    const a = pairedBootstrapCI([0.1, -0.2, 0.3], 300, makeRng(9));
    const b = pairedBootstrapCI([0.1, -0.2, 0.3], 300, makeRng(9));
    expect(a).toEqual(b);
    const one = pairedBootstrapCI([0.4], 300, makeRng(9));
    expect(one.lo).toBe(0.4);
    expect(one.hi).toBe(0.4);
    expect(pairedBootstrapCI([], 300, makeRng(9)).n).toBe(0);
  });

  it("n = 1 is never a detectable difference, however large the single diff", () => {
    // One query cannot be resampled into an interval; lo = hi = meanDiff is a
    // point, not evidence, so the verdict must stay "no detectable difference".
    expect(pairedBootstrapCI([0.4], 300, makeRng(9)).crossesZero).toBe(true);
    expect(pairedBootstrapCI([-0.9], 300, makeRng(9)).crossesZero).toBe(true);
    expect(pairedBootstrapCI([0], 300, makeRng(9)).crossesZero).toBe(true);
  });
});

describe("mean", () => {
  it("ignores nulls and returns null when nothing remains", () => {
    expect(mean([1, null, 3])).toBe(2);
    expect(mean([null])).toBeNull();
    expect(mean([])).toBeNull();
  });
});
