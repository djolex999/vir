import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateDb } from "../../src/state/db.js";
import { applyAblation } from "./homes.js";

const sid = (n: number): string => `abc1234${n}-0000-4000-8000-000000000001`;

describe("applyAblation", () => {
  let dir: string;
  let dbPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vir-uhome-"));
    dbPath = join(dir, "vir.db");
    const db = new StateDb(dbPath);
    for (const n of [1, 2]) {
      db.record({
        path: `/p/-home-u-app/${sid(n)}.jsonl`, hash: `h${n}`, skipped: false, notePaths: [], content: `b${n}`,
        category: "gotcha", topic: `t${n}`, project: "app", confidence: 0.9, startedAt: "2026-05-01T00:00:00.000Z",
      });
    }
    db.close();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // The ablated arm must hide rejects through the production serving gate.
  it("marks the listed sessions rejected in that DB copy only", () => {
    expect(applyAblation(dbPath, [sid(1)])).toBe(1);
    const db = new StateDb(dbPath, { readonly: true });
    try {
      expect(db.listDistilled().map((r) => r.sessionId)).toEqual([sid(2)]);
    } finally {
      db.close();
    }
  });
});
