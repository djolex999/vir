import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeSlug } from "../pipeline/writer.js";
import { StateDb } from "./db.js";

const LONG_TOPIC =
  "Prompt Injection Is Self Inflicted In User Scoped Endpoints Everywhere";

describe("StateDb.getEmbeddings path reconstruction", () => {
  let dir: string;
  let db: StateDb;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vir-db-"));
    db = new StateDb(join(dir, "vir.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reconstructs the writer's exact note path for a >50-char topic", () => {
    const sessionId = "aaaa1111-bbbb-cccc";
    db.record({
      path: `/proj/${sessionId}.jsonl`,
      hash: "h1",
      skipped: false,
      notePaths: ["/vault/vir/patterns/x.md"],
      content: "note body",
      category: "pattern",
      topic: LONG_TOPIC,
      project: "demo",
      confidence: 0.9,
      startedAt: "2026-05-01T10:00:00.000Z",
    });
    db.storeEmbedding(sessionId, [0.1, 0.2, 0.3]);

    const rows = db.getEmbeddings("/vault/vir");

    expect(rows).toHaveLength(1);
    expect(rows[0]?.filePath).toBe(
      `/vault/vir/patterns/${makeSlug(LONG_TOPIC, sessionId)}.md`,
    );
  });
});

describe("StateDb.record error lifecycle", () => {
  let dir: string;
  let db: StateDb;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vir-db-"));
    db = new StateDb(join(dir, "vir.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a successful distill clears a previously recorded error", () => {
    const path = "/proj/sess.jsonl";
    db.record({ path, hash: "h1", skipped: false, notePaths: [], error: "fetch failed" });
    expect(db.listDistilled().find((r) => r.path === path)).toBeUndefined();

    db.record({
      path,
      hash: "h2",
      skipped: false,
      notePaths: ["/vault/vir/patterns/x.md"],
      content: "## Summary\nrecovered",
      category: "pattern",
      topic: "Recovered",
      project: "demo",
      confidence: 0.9,
      startedAt: "2026-07-01T00:00:00.000Z",
    });
    // error must be gone: listDistilled filters `error IS NULL`, so a stale
    // error would make a good note invisible to rewrites and summaries.
    expect(db.listDistilled().find((r) => r.path === path)?.content).toContain("recovered");
  });
});

describe("StateDb.recordError — hash records on success, never on attempt", () => {
  let dir: string;
  let db: StateDb;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vir-db-"));
    db = new StateDb(join(dir, "vir.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const success = (path: string, hash: string) =>
    db.record({
      path,
      hash,
      skipped: false,
      notePaths: ["/vault/vir/patterns/x.md"],
      content: "## Summary\ngood note",
      category: "pattern",
      topic: "T",
      project: "demo",
      confidence: 0.9,
      startedAt: "2026-07-01T00:00:00.000Z",
    });

  it("a failed re-distill preserves the last successful hash — the session stays eligible for vir run", () => {
    const path = "/proj/sess.jsonl";
    success(path, "h1");
    db.recordError(path, "h2", "fetch failed");
    // The changed transcript (h2) must NOT read as processed, or run skips it forever.
    expect(db.isProcessed(path, "h2")).toBe(false);
    const r = db.getByPath(path);
    expect(r?.content).toBe("## Summary\ngood note");
    expect(r?.error).toBe("fetch failed");
  });

  it("a first-attempt failure inserts the row with the error (content null → reconcile-eligible)", () => {
    db.recordError("/proj/new.jsonl", "h1", "boom");
    const r = db.getByPath("/proj/new.jsonl");
    expect(r?.error).toBe("boom");
    expect(r?.content).toBeNull();
  });

  it("clearError resurfaces surviving content in listDistilled (source-gone rescue)", () => {
    const path = "/proj/gone.jsonl";
    success(path, "h1");
    db.recordError(path, "h2", "fetch failed");
    expect(db.listDistilled().find((r) => r.path === path)).toBeUndefined();
    db.clearError(path);
    expect(db.listDistilled().find((r) => r.path === path)?.content).toContain("good note");
  });
});

describe("StateDb attempts counter — retry bound", () => {
  let dir: string;
  let db: StateDb;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vir-db-"));
    db = new StateDb(join(dir, "vir.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("recordError increments attempts; retryExhausted flips at MAX_DISTILL_ATTEMPTS", () => {
    const path = "/proj/flaky.jsonl";
    expect(db.retryExhausted(path)).toBe(false);
    db.recordError(path, "h1", "boom 1");
    db.recordError(path, "h1", "boom 2");
    expect(db.retryExhausted(path)).toBe(false);
    db.recordError(path, "h1", "boom 3");
    expect(db.retryExhausted(path)).toBe(true);
  });

  it("a successful distill resets attempts to zero", () => {
    const path = "/proj/flaky.jsonl";
    db.recordError(path, "h1", "boom 1");
    db.recordError(path, "h1", "boom 2");
    db.recordError(path, "h1", "boom 3");
    db.record({
      path,
      hash: "h2",
      skipped: false,
      notePaths: ["/vault/vir/patterns/x.md"],
      content: "## Summary\nrecovered",
      category: "pattern",
      topic: "T",
      project: "demo",
      confidence: 0.9,
      startedAt: "2026-07-01T00:00:00.000Z",
    });
    expect(db.retryExhausted(path)).toBe(false);
  });
});
