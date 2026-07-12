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
