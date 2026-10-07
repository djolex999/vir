import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { partitionBySince, transcriptMtimeMs } from "./since.js";

const DAY = 86_400_000;

describe("partitionBySince", () => {
  const now = Date.UTC(2026, 9, 7);
  const mtimes: Record<string, number | null> = {
    "/a.jsonl": now - 2 * DAY,
    "/b.jsonl": now - 40 * DAY,
    "/c.jsonl": now - 14 * DAY,
    "/gone.jsonl": null,
  };
  const sessions = Object.keys(mtimes).map((path) => ({ path, hash: "h", size: 1 }));
  const mtimeOf = (p: string): number | null => mtimes[p] ?? null;

  it("keeps sessions at or after the cutoff and defers the rest", () => {
    const { recent, deferred } = partitionBySince(sessions, now - 14 * DAY, mtimeOf);
    expect(recent.map((s) => s.path)).toEqual(["/a.jsonl", "/c.jsonl"]);
    expect(deferred).toBe(2);
  });

  it("defers a file whose mtime can't be read", () => {
    const { recent } = partitionBySince(sessions, 0, mtimeOf);
    expect(recent.map((s) => s.path)).not.toContain("/gone.jsonl");
  });
});

describe("transcriptMtimeMs", () => {
  it("reads a real file's mtime and returns null for a missing one", () => {
    const file = join(mkdtempSync(join(tmpdir(), "vir-since-")), "s.jsonl");
    writeFileSync(file, "{}\n");
    const when = new Date(Date.UTC(2026, 0, 1));
    utimesSync(file, when, when);
    expect(transcriptMtimeMs(file)).toBe(when.getTime());
    expect(transcriptMtimeMs(`${file}.missing`)).toBeNull();
  });
});
