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

describe("StateDb project skip reasons", () => {
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

  it("record stores a skip reason and getByPath returns it", () => {
    db.record({
      path: "/p/a.jsonl",
      hash: "h1",
      skipped: true,
      notePaths: [],
      skipReason: "project-excluded",
    });
    expect(db.getByPath("/p/a.jsonl")?.skip_reason).toBe("project-excluded");
  });

  it("a project-excluded row is NOT processed — flipping to include re-distills it", () => {
    db.record({
      path: "/p/a.jsonl",
      hash: "h1",
      skipped: true,
      notePaths: [],
      skipReason: "project-excluded",
    });
    expect(db.isProcessed("/p/a.jsonl", "h1")).toBe(false);
  });

  it("a project-pending row is NOT processed — deciding later re-distills it", () => {
    db.record({
      path: "/p/b.jsonl",
      hash: "h1",
      skipped: true,
      notePaths: [],
      skipReason: "project-pending",
    });
    expect(db.isProcessed("/p/b.jsonl", "h1")).toBe(false);
  });

  it("a successful distill clears a stale project skip reason", () => {
    db.record({
      path: "/p/c.jsonl",
      hash: "h1",
      skipped: true,
      notePaths: [],
      skipReason: "project-pending",
    });
    db.record({
      path: "/p/c.jsonl",
      hash: "h1",
      skipped: false,
      notePaths: ["/vault/n.md"],
      content: "body",
      category: "pattern",
      topic: "t",
      project: "vir",
    });
    const row = db.getByPath("/p/c.jsonl");
    expect(row?.skip_reason).toBeNull();
    expect(db.isProcessed("/p/c.jsonl", "h1")).toBe(true);
  });

  it("a heuristic-filter skip (no reason) still counts as processed", () => {
    db.record({
      path: "/p/d.jsonl",
      hash: "h1",
      skipped: true,
      notePaths: [],
    });
    expect(db.isProcessed("/p/d.jsonl", "h1")).toBe(true);
  });

  it("countBySkipReason groups project-filtered rows", () => {
    db.record({ path: "/p/e1.jsonl", hash: "h", skipped: true, notePaths: [], skipReason: "project-pending" });
    db.record({ path: "/p/e2.jsonl", hash: "h", skipped: true, notePaths: [], skipReason: "project-pending" });
    db.record({ path: "/p/e3.jsonl", hash: "h", skipped: true, notePaths: [], skipReason: "project-excluded" });
    expect(db.countBySkipReason()).toEqual({
      "project-pending": 2,
      "project-excluded": 1,
    });
  });
});

describe("StateDb.listSessionMeta", () => {
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

  it("returns per-session status rows for aggregation", () => {
    db.record({
      path: "/p/demo/a.jsonl",
      hash: "h1",
      skipped: false,
      notePaths: ["/v/n.md"],
      content: "body",
      category: "pattern",
      topic: "t",
      project: "demo",
    });
    db.record({
      path: "/p/demo/b.jsonl",
      hash: "h2",
      skipped: true,
      notePaths: [],
      skipReason: "project-pending",
    });
    const rows = db.listSessionMeta();
    expect(rows).toHaveLength(2);
    const a = rows.find((r) => r.path === "/p/demo/a.jsonl");
    const b = rows.find((r) => r.path === "/p/demo/b.jsonl");
    expect(a).toMatchObject({ hash: "h1", skipped: 0, skipReason: null, hasContent: 1 });
    expect(b).toMatchObject({ hash: "h2", skipped: 1, skipReason: "project-pending", hasContent: 0 });
  });
});

describe("StateDb transcript-category skip reasons are reversible", () => {
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

  it("workflow-transcript and sidechain-transcript rows are NOT processed — flipping the knob re-enters them", () => {
    db.record({
      path: "/p/s/subagents/workflows/wf_1/a.jsonl",
      hash: "h1",
      skipped: true,
      notePaths: [],
      skipReason: "workflow-transcript",
    });
    db.record({
      path: "/p/s/subagents/b.jsonl",
      hash: "h2",
      skipped: true,
      notePaths: [],
      skipReason: "sidechain-transcript",
    });
    expect(db.isProcessed("/p/s/subagents/workflows/wf_1/a.jsonl", "h1")).toBe(false);
    expect(db.isProcessed("/p/s/subagents/b.jsonl", "h2")).toBe(false);
    expect(db.countBySkipReason()).toEqual({
      "workflow-transcript": 1,
      "sidechain-transcript": 1,
    });
  });
});

describe("StateDb agent-transcript rows", () => {
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

  it("persists the detected entrypoint and keeps the row re-enterable", () => {
    db.record({
      path: "/p/x/agent1.jsonl",
      hash: "h1",
      skipped: true,
      notePaths: [],
      skipReason: "agent-transcript",
      entrypoint: "sdk-py",
    });
    const row = db.getByPath("/p/x/agent1.jsonl");
    expect(row?.skip_reason).toBe("agent-transcript");
    expect(row?.entrypoint).toBe("sdk-py");
    expect(db.isProcessed("/p/x/agent1.jsonl", "h1")).toBe(false);
  });

  it("counts skipped agent transcripts grouped by entrypoint", () => {
    db.record({ path: "/p/a.jsonl", hash: "h", skipped: true, notePaths: [], skipReason: "agent-transcript", entrypoint: "sdk-py" });
    db.record({ path: "/p/b.jsonl", hash: "h", skipped: true, notePaths: [], skipReason: "agent-transcript", entrypoint: "sdk-py" });
    db.record({ path: "/p/c.jsonl", hash: "h", skipped: true, notePaths: [], skipReason: "agent-transcript", entrypoint: "sdk-ts" });
    expect(db.countAgentEntrypoints()).toEqual({ "sdk-py": 2, "sdk-ts": 1 });
  });

  it("a later record without entrypoint preserves the stored one", () => {
    db.record({ path: "/p/d.jsonl", hash: "h1", skipped: true, notePaths: [], skipReason: "agent-transcript", entrypoint: "sdk-py" });
    db.record({ path: "/p/d.jsonl", hash: "h2", skipped: true, notePaths: [], skipReason: "agent-transcript" });
    expect(db.getByPath("/p/d.jsonl")?.entrypoint).toBe("sdk-py");
  });
});

// updateContent is the dedupe merger's write path: the merged body replaces the
// stored content, so the old vector no longer describes the row. Leaving it in
// place is the 0.8.2-class blind spot on the UPDATE path — the NULL-only sweep
// can never heal a stale (non-NULL) embedding, so the reset must happen here.
describe("StateDb.updateContent embedding reset", () => {
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

  it("nulls the embedding so the sweep re-fills it", () => {
    const sessionId = "cccc3333-dddd-eeee";
    db.record({
      path: `/proj/${sessionId}.jsonl`,
      hash: "h1",
      skipped: false,
      notePaths: ["/vault/vir/gotchas/x.md"],
      content: "original body",
      category: "gotcha",
      topic: "some topic",
      project: "demo",
      confidence: 0.9,
      startedAt: "2026-05-01T10:00:00.000Z",
    });
    db.storeEmbedding(sessionId, [0.1, 0.2, 0.3]);
    expect(db.listEmbeddingTargets()).toHaveLength(0);

    db.updateContent(`/proj/${sessionId}.jsonl`, "merged body");

    const targets = db.listEmbeddingTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0]?.content).toBe("merged body");
  });
});
