import { describe, expect, it } from "vitest";
import { MIN_DEAD_WEIGHT_SAMPLE, buildQueriesReport } from "./queries.js";
import type { QueryLogRecord } from "../search/queryLog.js";

function rec(over: Partial<QueryLogRecord>): QueryLogRecord {
  return {
    ts: "2026-08-13T10:00:00.000Z",
    source: "cli",
    query: "q",
    type: "all",
    method: "embedding",
    degraded: false,
    degradedReason: null,
    provider: { name: "ollama", model: "nomic-embed-text", dim: 768 },
    candidates: 3,
    excludedModel: 0,
    latencyMs: 10,
    hits: [],
    ...over,
  };
}

function h(slug: string, rank: number): QueryLogRecord["hits"][number] {
  return { slug, rank, score: 0.5, verified: false };
}

describe("buildQueriesReport", () => {
  const records = [
    rec({ hits: [h("patterns/a-11111111", 1), h("gotchas/b-22222222", 2)] }),
    rec({ hits: [h("patterns/a-11111111", 1)] }),
    rec({
      method: "tfidf",
      degraded: true,
      degradedReason: "Ollama down",
      provider: null,
      hits: [h("patterns/a-11111111", 1)],
    }),
    rec({ method: "tfidf", hits: [] }),
  ];
  const allSlugs = [
    "patterns/a-11111111",
    "gotchas/b-22222222",
    "decisions/c-33333333",
  ];

  it("counts totals, method split, and degraded rate", () => {
    const r = buildQueriesReport(records, allSlugs);
    expect(r.total).toBe(4);
    expect(r.byMethod).toEqual({ embedding: 2, tfidf: 2 });
    expect(r.degraded).toBe(1);
    expect(r.degradedRate).toBeCloseTo(0.25);
  });

  it("ranks the most-surfaced notes with count and mean rank", () => {
    const r = buildQueriesReport(records, allSlugs);
    expect(r.topNotes[0]).toEqual({
      slug: "patterns/a-11111111",
      count: 3,
      avgRank: 1,
    });
    expect(r.topNotes[1]).toEqual({
      slug: "gotchas/b-22222222",
      count: 1,
      avgRank: 2,
    });
  });

  it("suppresses dead weight below the minimum sample — 4 queries is noise, not signal", () => {
    const r = buildQueriesReport(records, allSlugs);
    expect(records.length).toBeLessThan(MIN_DEAD_WEIGHT_SAMPLE);
    expect(r.deadWeight).toBeNull();
  });

  it("lists never-surfaced notes as dead weight once the sample is large enough", () => {
    const many = Array.from({ length: MIN_DEAD_WEIGHT_SAMPLE }, () =>
      rec({ hits: [h("patterns/a-11111111", 1)] }),
    );
    const r = buildQueriesReport(many, allSlugs);
    expect(r.deadWeight).toEqual([
      "gotchas/b-22222222",
      "decisions/c-33333333",
    ]);
  });

  it("handles an empty log without dividing by zero", () => {
    const r = buildQueriesReport([], allSlugs);
    expect(r.total).toBe(0);
    expect(r.degradedRate).toBe(0);
    expect(r.topNotes).toEqual([]);
    // Zero queries prove nothing about any note — suppressed, not "all dead".
    expect(r.deadWeight).toBeNull();
  });

  it("caps topNotes at the requested size", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      rec({ hits: [h(`patterns/n-${i}`, 1)] }),
    );
    const r = buildQueriesReport(many, [], 5);
    expect(r.topNotes).toHaveLength(5);
  });
});
