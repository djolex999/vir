import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateDb } from "./db.js";

let dir: string;
let db: StateDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vir-db-connect-"));
  db = new StateDb(join(dir, "vir.db"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("lesson embedding cache", () => {
  it("round-trips a vector for its model only", () => {
    db.storeLessonEmbedding("h1", "nomic-embed-text", [0.5, -1, 2]);
    expect(db.getLessonEmbeddings(["h1", "h2"], "nomic-embed-text")).toEqual(
      new Map([["h1", [0.5, -1, 2]]]),
    );
    expect(db.getLessonEmbeddings(["h1"], "bge-small-en-v1.5").size).toBe(0);
  });

  it("upserts on (hash, model)", () => {
    db.storeLessonEmbedding("h1", "m", [1]);
    db.storeLessonEmbedding("h1", "m", [2]);
    expect(db.getLessonEmbeddings(["h1"], "m").get("h1")).toEqual([2]);
  });

  it("handles more hashes than one IN() chunk", () => {
    const hashes = Array.from({ length: 1200 }, (_, i) => `h${i}`);
    for (const h of hashes) db.storeLessonEmbedding(h, "m", [1]);
    expect(db.getLessonEmbeddings(hashes, "m").size).toBe(1200);
  });
});
