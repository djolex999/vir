import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import { StateDb } from "../state/db.js";
import { runReconcile } from "./reconcile.js";

// Reconcile retries a note whose re-distill failed (error set, last good
// content kept). If the retry is skipped by the filter or by low confidence,
// the last good note must be restored, not flipped to skipped=1.

const spies = vi.hoisted(() => ({
  passes: { value: true },
  distill: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock("../pipeline/parser.js", () => ({
  parseSession: (path: string, hash: string) => ({
    path,
    hash,
    sessionId: "sess-rec",
    projectSlug: "t",
    startedAt: null,
    endedAt: null,
    lineCount: 10,
    toolCallCount: 0,
    filesTouched: [],
    assistantText: "a",
    userText: "u",
    rawSummary: "s",
    transcriptText: "t",
  }),
}));

vi.mock("../pipeline/filter.js", () => ({
  scoreSession: () => ({ passes: spies.passes.value, score: 0 }),
}));

vi.mock("../pipeline/distiller.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../pipeline/distiller.js")>();
  return {
    ...real,
    Distiller: class {
      run = spies.distill;
    },
  };
});

vi.mock("../pipeline/writer.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../pipeline/writer.js")>();
  return {
    ...real,
    VaultWriter: class {
      write = vi.fn(async (): Promise<string[]> => []);
    },
  };
});

const cfg = {
  vaultPath: "/tmp/vir-test-vault",
  outputDir: "Vir",
  claudeProjectsDir: "/tmp/vir-test-projects",
  provider: "anthropic",
  anthropicApiKey: "sk-ant-test",
  filterThreshold: 1,
  models: { classify: "claude-haiku-4-5-20251001", distill: "claude-sonnet-5" },
} as unknown as Config;

function withDb<T>(fn: (db: StateDb) => T): T {
  const db = new StateDb();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vir-reconcile-"));
  path = join(dir, "sess-rec.jsonl");
  writeFileSync(path, "{}\n");
  withDb((db) => db.reset());
  spies.passes.value = true;
  spies.distill.mockReset();
  spies.distill.mockResolvedValue(null);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
});

function seedFailedRedistill(): void {
  withDb((db) => {
    db.record({
      path,
      hash: "h-old",
      skipped: false,
      notePaths: [],
      content: "## Summary\nthe last good note",
      category: "pattern",
      topic: "Last Good",
      project: "t",
      confidence: 0.9,
      startedAt: "2026-09-01T00:00:00.000Z",
    });
    db.recordError(path, "h-new", "kie 500");
  });
}

function served(): boolean {
  return withDb((db) => db.listDistilled().some((r) => r.path === path));
}

describe("runReconcile — a skipped retry restores the last good note", () => {
  it("filter skip", async () => {
    seedFailedRedistill();
    spies.passes.value = false;

    await runReconcile(cfg, { yes: true });

    expect(withDb((db) => db.getByPath(path))).toMatchObject({ skipped: 0, error: null });
    expect(served()).toBe(true);
  });

  it("low-confidence skip", async () => {
    seedFailedRedistill();

    await runReconcile(cfg, { yes: true });

    expect(spies.distill).toHaveBeenCalledTimes(1);
    expect(withDb((db) => db.getByPath(path))).toMatchObject({ skipped: 0, error: null });
    expect(served()).toBe(true);
  });

  it("a retry with no prior note is still recorded as skipped (unchanged)", async () => {
    withDb((db) => db.recordError(path, "h-new", "kie 500"));
    spies.passes.value = false;

    await runReconcile(cfg, { yes: true });

    expect(withDb((db) => db.getByPath(path))).toMatchObject({ skipped: 1 });
    expect(served()).toBe(false);
  });
});
