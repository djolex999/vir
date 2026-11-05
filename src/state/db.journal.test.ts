import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateDb } from "./db.js";

const sid = (n: number): string => `abc12345-0000-4000-8000-00000000000${n}`;
const path = (n: number): string => `/p/-home-u-app/${sid(n)}.jsonl`;

describe("listJournalDecisions", () => {
  let dir: string;
  let db: StateDb;

  const seed = (n: number, category: "decision" | "pattern", topic: string): void => {
    db.record({
      path: path(n),
      hash: `h${n}`,
      skipped: false,
      notePaths: [],
      content: "body",
      category,
      topic,
      project: "demo",
      confidence: 0.9,
      startedAt: "2026-11-04T10:00:00.000Z",
    });
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vir-journal-db-"));
    db = new StateDb(join(dir, "vir.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists live decision notes only, never a review-rejected one", () => {
    seed(1, "decision", "Use SQLite");
    seed(2, "decision", "Rejected call");
    seed(3, "pattern", "Not a decision");
    expect(db.markRejected(sid(2))).toBe(1);

    expect(db.listJournalDecisions()).toEqual([{ path: path(1), topic: "Use SQLite" }]);
  });
});
