import { describe, expect, it } from "vitest";
import type { QueryLogRecord } from "./queryLog.js";
import { buildNoteUsage, isSelfHit } from "./noteUsage.js";

const rec = (ts: string, query: string, hits: Array<[string, number]>): QueryLogRecord => ({
  ts,
  source: "mcp",
  query,
  type: "all",
  method: "embedding",
  degraded: false,
  degradedReason: null,
  provider: null,
  candidates: 10,
  excludedModel: 0,
  latencyMs: 1,
  hits: hits.map(([slug, rank]) => ({ slug, rank, score: 0.5, verified: false })),
});

describe("isSelfHit", () => {
  it("matches a query that is the note's own slug and body", () => {
    const hit = { slug: "gotchas/worktree-branch-diagnostics-319b0000", rank: 1, score: 0.9, verified: false };
    expect(isSelfHit("worktree-branch-diagnostics-319b0000\n\nProject: [[popis]]\n…", hit)).toBe(true);
    expect(isSelfHit("  worktree-branch-diagnostics-319b0000", hit)).toBe(true);
  });

  it("does not match an ordinary question or a different note", () => {
    const hit = { slug: "gotchas/worktree-branch-diagnostics-319b0000", rank: 1, score: 0.9, verified: false };
    expect(isSelfHit("worktree branch diagnostics", hit)).toBe(false);
    expect(isSelfHit("safe-to-delete-e7285414\n\nbody", hit)).toBe(false);
    expect(isSelfHit("", hit)).toBe(false);
  });
});

describe("buildNoteUsage", () => {
  it("counts surfaces, top-3 surfaces and the latest time, skipping self-hits", () => {
    const usage = buildNoteUsage([
      rec("2026-10-01T00:00:00.000Z", "launchd plist", [["patterns/a-11111111", 1], ["patterns/b-22222222", 5]]),
      rec("2026-10-20T00:00:00.000Z", "daemon restart", [["patterns/a-11111111", 4]]),
      rec("2026-10-05T00:00:00.000Z", "b-22222222\n\nbody", [["patterns/b-22222222", 1], ["patterns/a-11111111", 2]]),
    ]);
    expect(usage.get("patterns/a-11111111")).toEqual({
      surfaced: 3,
      top3: 2,
      lastSurfacedAt: "2026-10-20T00:00:00.000Z",
    });
    // b's rank-1 hit came from looking b itself up: only the rank-5 hit counts.
    expect(usage.get("patterns/b-22222222")).toEqual({
      surfaced: 1,
      top3: 0,
      lastSurfacedAt: "2026-10-01T00:00:00.000Z",
    });
  });
});
