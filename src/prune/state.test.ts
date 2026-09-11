import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateDb } from "../state/db.js";

const PROV = { model: "nomic-embed-text", dim: 3 };

describe("prune state on the sessions row", () => {
  let dir: string;
  let db: StateDb;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vir-prune-db-"));
    db = new StateDb(join(dir, "vir.db"));
    db.record({
      path: "/p/subagents/abc12345.jsonl",
      hash: "h1",
      skipped: false,
      notePaths: ["/v/patterns/x-abc12345.md"],
      content: "note body",
      category: "pattern",
      topic: "x",
      project: "demo",
      confidence: 0.9,
      startedAt: "2026-05-01T00:00:00.000Z",
    });
    db.storeEmbedding("abc12345", [1, 0, 0], PROV);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is absent before pruning (the row is a normal distilled row)", () => {
    expect(db.listDistilled()).toHaveLength(1);
    expect(db.getStats().total).toBe(1);
    expect(db.getEmbeddings("/v")).toHaveLength(1);
  });

  it("markPruned hides the row from every DB-backed read path", () => {
    db.markPruned("/p/subagents/abc12345.jsonl", "sidechain-transcript");

    expect(db.listDistilled()).toHaveLength(0);
    expect(db.getStats().total).toBe(0);
    expect(db.getEmbeddings("/v")).toHaveLength(0);
    expect(db.listReconcileTargets()).toHaveLength(0);
  });

  // The 0.14.0 semi-prune flipped skipped=1 on already-distilled rows and
  // called it a filter. Pruning gets its own state; `skipped` is not it.
  it("never touches skipped, and the session stays processed", () => {
    db.markPruned("/p/subagents/abc12345.jsonl", "sidechain-transcript");

    const row = db.getByPath("/p/subagents/abc12345.jsonl");
    expect(row?.skipped).toBe(0);
    expect(row?.skip_reason ?? null).toBeNull();
    // Still processed: a plain run must not re-distill (and re-bill) it.
    expect(db.isProcessed("/p/subagents/abc12345.jsonl", "h1")).toBe(true);
  });

  it("preserves content and the embedding so a restore is exact", () => {
    db.markPruned("/p/subagents/abc12345.jsonl", "sidechain-transcript");

    const row = db.getByPath("/p/subagents/abc12345.jsonl");
    expect(row?.content).toBe("note body");
    expect(row?.embedding).not.toBeNull();
    // And the sweep must not treat it as needing an embedding.
    expect(db.listEmbeddingTargets()).toHaveLength(0);
  });

  it("clearPruned restores the row to every read path", () => {
    db.markPruned("/p/subagents/abc12345.jsonl", "sidechain-transcript");
    db.clearPruned("/p/subagents/abc12345.jsonl");

    expect(db.listDistilled()).toHaveLength(1);
    expect(db.getStats().total).toBe(1);
    expect(db.getEmbeddings("/v")).toHaveLength(1);
    const row = db.getByPath("/p/subagents/abc12345.jsonl");
    expect(row?.pruned_at ?? null).toBeNull();
    expect(row?.prune_reason ?? null).toBeNull();
  });

  it("counts pruned rows by reason for doctor", () => {
    db.markPruned("/p/subagents/abc12345.jsonl", "sidechain-transcript");
    expect(db.countPrunedByReason()).toEqual({ "sidechain-transcript": 1 });
  });
});
