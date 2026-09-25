import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contentHash } from "../audit/types.js";
import { StateDb } from "./db.js";

const SID = "abc12345-0000-4000-8000-000000000001";
const PATH = `/p/-home-u-app/${SID}.jsonl`;

describe("audit verdicts on the sessions row", () => {
  let dir: string;
  let db: StateDb;

  const seed = (content = "note body"): void => {
    db.record({
      path: PATH,
      hash: "h1",
      skipped: false,
      notePaths: [],
      content,
      category: "pattern",
      topic: "x",
      project: "demo",
      confidence: 0.9,
      startedAt: "2026-05-01T00:00:00.000Z",
    });
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vir-audit-db-"));
    db = new StateDb(join(dir, "vir.db"));
    seed();
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores a verdict and reads it back as fresh", () => {
    expect(
      db.recordAudit(PATH, {
        verdict: "reject",
        reason: "generic advice",
        mergeInto: null,
        contentHash: contentHash("note body"),
      }, "2026-09-25T00:00:00.000Z"),
    ).toBe(1);

    expect(db.listAudits()).toEqual([
      {
        path: PATH,
        sessionId: SID,
        verdict: "reject",
        reason: "generic advice",
        mergeInto: null,
        auditedAt: "2026-09-25T00:00:00.000Z",
        fresh: true,
      },
    ]);
  });

  // A re-distill rewrites `content`; the verdict judged the old text.
  it("marks a verdict stale once the content changes", () => {
    db.recordAudit(PATH, {
      verdict: "keep",
      reason: "specific",
      mergeInto: null,
      contentHash: contentHash("note body"),
    });
    db.record({ path: PATH, hash: "h2", skipped: false, notePaths: [], content: "new body" });

    expect(db.listAudits()[0]?.fresh).toBe(false);
  });

  // An audit is a suggestion. It must never gate a read path the way
  // pruned_at / rejected_at do.
  it("never hides the row from listDistilled or getStats", () => {
    db.recordAudit(PATH, {
      verdict: "reject",
      reason: "x",
      mergeInto: null,
      contentHash: contentHash("note body"),
    });

    expect(db.listDistilled()).toHaveLength(1);
    expect(db.getStats().total).toBe(1);
  });

  it("does not list verdicts for rejected or pruned rows", () => {
    db.recordAudit(PATH, {
      verdict: "reject",
      reason: "x",
      mergeInto: null,
      contentHash: contentHash("note body"),
    });
    db.markRejected(SID);

    expect(db.listAudits()).toEqual([]);
  });
});
