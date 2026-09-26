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

  // 35 tiny notes stay well under the char budget but must still split — a
  // batch of 55+ verdicts doesn't fit in maxTokens 4000 at ~70 tokens each.
  it("caps rows per batch even when the char budget has room to spare", () => {
    const rows = Array.from({ length: 35 }, (_, i) => row(`n${i}`, "vir", "tiny"));
    const b = batchByProject(rows);
    expect(b.map((x) => x.rows.length)).toEqual([30, 5]);
  });
});
