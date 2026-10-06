import { describe, expect, it } from "vitest";
import { clusterLessons } from "./cluster.js";
import type { Lesson } from "./types.js";

function lesson(i: number, date = "2026-01-01"): Lesson {
  return {
    id: `n${String(i).padStart(2, "0")}#0`, noteSlug: `n${i}`, citeSlug: `n${i}`, sessionId: `s${i}`,
    noteDate: date, project: "p", category: "gotcha", itemIndex: 0, text: `t${i}`,
    contentHash: `h${i}`, archivedVia: null,
  };
}
const at = (deg: number) => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];
const cos = (deg: number) => Math.cos((deg * Math.PI) / 180);

describe("clusterLessons", () => {
  it("groups close lessons and leaves distant ones out", () => {
    const ls = [0, 1, 2, 3].map((i) => lesson(i));
    const v = new Map([["h0", at(0)], ["h1", at(5)], ["h2", at(10)], ["h3", at(90)]]);
    const out = clusterLessons(ls, v, cos(15), cos(15));
    expect(out.map((c) => c.map((l) => l.id))).toEqual([["n00#0", "n01#0", "n02#0"]]);
  });

  it("drops chain ends far from the centroid, then the too-small cluster", () => {
    const ls = [0, 1, 2].map((i) => lesson(i));
    const v = new Map([["h0", at(0)], ["h1", at(14)], ["h2", at(28)]]);
    // Pairwise links 0–1 and 1–2 pass at 15°, but 0 and 2 sit 14° off a centroid we demand within 5°.
    expect(clusterLessons(ls, v, cos(15), cos(5))).toEqual([]);
  });

  it("caps a cluster at 20, keeping the newest on ties", () => {
    const ls = Array.from({ length: 25 }, (_, i) => lesson(i, `2026-01-${String(i + 1).padStart(2, "0")}`));
    const v = new Map(ls.map((l) => [l.contentHash, at(0)]));
    const out = clusterLessons(ls, v, 0.9, 0.9);
    expect(out).toHaveLength(1);
    expect(out[0]).toHaveLength(20);
    expect(out[0]?.some((l) => l.noteDate === "2026-01-01")).toBe(false);
    expect(out[0]?.some((l) => l.noteDate === "2026-01-25")).toBe(true);
  });

  it("ignores lessons without a vector", () => {
    const ls = [0, 1, 2, 3].map((i) => lesson(i));
    const v = new Map([["h0", at(0)], ["h1", at(1)], ["h2", at(2)]]);
    expect(clusterLessons(ls, v, cos(15), cos(15))[0]).toHaveLength(3);
  });

  it("is deterministic", () => {
    const ls = [0, 1, 2, 3, 4, 5].map((i) => lesson(i));
    const v = new Map([["h0", at(0)], ["h1", at(1)], ["h2", at(2)], ["h3", at(60)], ["h4", at(61)], ["h5", at(62)]]);
    const a = clusterLessons(ls, v, cos(10), cos(10));
    const b = clusterLessons([...ls].reverse(), v, cos(10), cos(10));
    expect(a.map((c) => c.map((l) => l.id))).toEqual(b.map((c) => c.map((l) => l.id)));
    expect(a).toHaveLength(2);
  });
});
