import { describe, expect, it } from "vitest";
import { sampleBandPairs } from "./calibrate.js";
import type { Lesson } from "./types.js";

function lesson(i: number): Lesson {
  return {
    id: `n${i}#0`, noteSlug: `n${i}`, citeSlug: `n${i}`, sessionId: `s${i}`, noteDate: "2026-01-01",
    project: "p", category: "gotcha", itemIndex: 0, text: `t${i}`, contentHash: `h${i}`, archivedVia: null,
  };
}

// Unit vectors at given angles (degrees): cos(a-b) is the pair similarity.
function setup(angles: number[]) {
  const lessons = angles.map((_, i) => lesson(i));
  const vectors = new Map(
    angles.map((deg, i) => [`h${i}`, [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)]]),
  );
  return { lessons, vectors };
}

describe("sampleBandPairs", () => {
  const { lessons, vectors } = setup([0, 10, 20, 35, 50, 70, 89]);
  const bands: Array<[number, number]> = [[0.55, 0.65], [0.65, 0.75], [0.75, 0.85], [0.85, 1.0001]];

  it("puts every pair in the band its cosine falls in, capped per band", () => {
    const pairs = sampleBandPairs(lessons, vectors, bands, 2, 42);
    for (const p of pairs) {
      const [lo, hi] = bands.find(([l, h]) => `${l}-${h}` === p.band) ?? [NaN, NaN];
      expect(p.sim).toBeGreaterThanOrEqual(lo);
      expect(p.sim).toBeLessThan(hi);
    }
    for (const [lo, hi] of bands) {
      expect(pairs.filter((p) => p.band === `${lo}-${hi}`).length).toBeLessThanOrEqual(2);
    }
    expect(pairs.length).toBeGreaterThan(0);
  });

  it("is deterministic for a seed", () => {
    const a = sampleBandPairs(lessons, vectors, bands, 2, 7).map((p) => `${p.a.id}|${p.b.id}`);
    const b = sampleBandPairs(lessons, vectors, bands, 2, 7).map((p) => `${p.a.id}|${p.b.id}`);
    expect(a).toEqual(b);
  });

  it("never pairs two lessons from the same session", () => {
    const same = setup([0, 1, 2]);
    same.lessons.forEach((l) => (l.sessionId = "one"));
    expect(sampleBandPairs(same.lessons, same.vectors, bands, 5, 1)).toEqual([]);
  });
});
