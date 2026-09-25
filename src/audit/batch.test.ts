import { describe, expect, it } from "vitest";
import type { DistilledRow } from "../state/db.js";
import { batchByProject } from "./batch.js";

const row = (sessionId: string, project: string, content: string, startedAt = "2026-05-01"): DistilledRow => ({
  path: `/p/x/${sessionId}.jsonl`,
  sessionId,
  startedAt,
  category: "pattern",
  topic: `t-${sessionId}`,
  project,
  confidence: 0.9,
  content,
});

describe("batchByProject", () => {
  // Siblings must share a batch, or the auditor cannot see duplicates.
  it("never mixes projects in one batch", () => {
    const b = batchByProject([row("a", "vir", "x"), row("b", "growthq", "y"), row("c", "vir", "z")]);
    expect(b.map((x) => [x.project, x.rows.map((r) => r.sessionId)])).toEqual([
      ["growthq", ["b"]],
      ["vir", ["a", "c"]],
    ]);
  });

  it("splits a project that exceeds the size budget, oldest first", () => {
    const rows = [
      row("new", "vir", "x".repeat(30), "2026-09-01"),
      row("old", "vir", "x".repeat(30), "2026-01-01"),
    ];
    const b = batchByProject(rows, 50);
    expect(b.map((x) => x.rows.map((r) => r.sessionId))).toEqual([["old"], ["new"]]);
  });

  it("gives an oversized note a batch of its own instead of dropping it", () => {
    const b = batchByProject([row("big", "vir", "x".repeat(500))], 50);
    expect(b).toHaveLength(1);
    expect(b[0]?.rows).toHaveLength(1);
  });
});
