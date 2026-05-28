import { describe, expect, it } from "vitest";
import { selectReconcileTargets } from "./reconcile.js";
import type { SessionRow } from "../state/db.js";

function row(overrides: Partial<SessionRow>): SessionRow {
  return {
    path: "/tmp/session-x.jsonl",
    hash: "abc",
    processed_at: "2026-01-01T00:00:00Z",
    skipped: 0,
    note_paths: "[]",
    error: null,
    content: "real distilled content",
    category: "pattern",
    topic: "topic",
    project: "proj",
    confidence: 0.8,
    started_at: null,
    ...overrides,
  };
}

describe("selectReconcileTargets", () => {
  it("includes a session with skipped=0 and content=null (errored retry shape)", () => {
    const rows = [row({ path: "/a.jsonl", content: null })];
    expect(selectReconcileTargets(rows).map((r) => r.path)).toEqual([
      "/a.jsonl",
    ]);
  });

  it("includes a session with skipped=0 and content='' (Kie-200 silent-failure shape)", () => {
    const rows = [row({ path: "/b.jsonl", content: "" })];
    expect(selectReconcileTargets(rows).map((r) => r.path)).toEqual([
      "/b.jsonl",
    ]);
  });

  it("excludes a healthy session with real content", () => {
    const rows = [row({ path: "/c.jsonl", content: "real markdown" })];
    expect(selectReconcileTargets(rows)).toEqual([]);
  });

  it("excludes filter-skipped sessions (skipped=1) even if content is null", () => {
    // skipped=1 means the heuristic filter (not the LLM) rejected it; there
    // was never any content to recover, so reconcile must leave them alone.
    const rows = [row({ path: "/d.jsonl", skipped: 1, content: null })];
    expect(selectReconcileTargets(rows)).toEqual([]);
  });

  it("returns the two recoverable rows from the canonical 3-row fixture", () => {
    const rows = [
      row({ path: "/healthy.jsonl", content: "real" }),
      row({ path: "/null.jsonl", content: null }),
      row({ path: "/empty.jsonl", content: "" }),
    ];
    expect(selectReconcileTargets(rows).map((r) => r.path).sort()).toEqual([
      "/empty.jsonl",
      "/null.jsonl",
    ]);
  });
});
