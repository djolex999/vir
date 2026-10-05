import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import { StateDb } from "../state/db.js";
import { runPipeline } from "./run.js";

// A session that already holds a distilled note can come back through the
// pipeline (resumed transcript → new hash, or --full). If that pass is
// skipped by the heuristic filter or by low classify confidence, the existing
// note must stay served and the new hash must be recorded — not flipped to
// skipped=1, which hid the note from every DB-backed reader.
//
// StateDb is the real class over a SQLite file in the sandboxed $HOME.

const PATH = "/t/sess-keep.jsonl";

const spies = vi.hoisted(() => ({
  scan: vi.fn((): Array<{ path: string; hash: string }> => []),
  parse: vi.fn(),
  passes: { value: true },
  distill: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock("./writer.js", () => ({
  kebab: (s: string) => s,
  VaultWriter: class {
    write = vi.fn(async (): Promise<string[]> => ["/vault/vir/patterns/new.md"]);
    regenerateIndex = vi.fn();
  },
}));

vi.mock("./scanner.js", () => ({
  scanSessions: () => spies.scan(),
}));

vi.mock("./parser.js", () => ({
  parseSession: (path: string, hash: string) => {
    spies.parse(path);
    return {
      path,
      hash,
      sessionId: "sess-keep",
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
    };
  },
}));

vi.mock("./filter.js", () => ({
  scoreSession: () => ({ passes: spies.passes.value, score: 0 }),
}));

vi.mock("./distiller.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./distiller.js")>();
  return {
    ...real,
    probeProvider: vi.fn(async () => {}),
    Distiller: class {
      run = spies.distill;
    },
  };
});

vi.mock("./embeddingSweep.js", () => ({
  sweepEmbeddings: async () => ({ ran: false, embedded: 0, errors: 0, pending: 0 }),
}));

vi.mock("./summarizer.js", () => ({
  summarizeProject: vi.fn(async () => null),
}));

const cfg = {
  vaultPath: "/tmp/vir-test-vault",
  outputDir: "Vir",
  claudeProjectsDir: "/tmp/vir-test-projects",
  provider: "anthropic",
  anthropicApiKey: "sk-ant-test",
  filterThreshold: 1,
  projects: { t: "include" },
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

function seedDistilled(): void {
  withDb((db) =>
    db.record({
      path: PATH,
      hash: "h-old",
      skipped: false,
      notePaths: ["/vault/vir/patterns/old.md"],
      content: "## Summary\nthe original note",
      category: "pattern",
      topic: "Original",
      project: "t",
      confidence: 0.9,
      startedAt: "2026-09-01T00:00:00.000Z",
    }),
  );
}

function served(): boolean {
  return withDb((db) => db.listDistilled().some((r) => r.path === PATH));
}

beforeEach(() => {
  withDb((db) => db.reset());
  spies.scan.mockReset();
  spies.scan.mockReturnValue([{ path: PATH, hash: "h-new" }]);
  spies.parse.mockClear();
  spies.passes.value = true;
  spies.distill.mockReset();
  spies.distill.mockResolvedValue(null);
});

describe("runPipeline — a skip never hides an existing note", () => {
  it("filter skip on a changed transcript keeps the note served and records the new hash", async () => {
    seedDistilled();
    spies.passes.value = false;

    await runPipeline(cfg, { quiet: true });

    const row = withDb((db) => db.getByPath(PATH));
    expect(row).toMatchObject({ hash: "h-new", skipped: 0, error: null });
    expect(row?.content).toContain("the original note");
    expect(served()).toBe(true);

    // The new bytes are processed: the next run does not parse them again.
    await runPipeline(cfg, { quiet: true });
    expect(spies.parse).toHaveBeenCalledTimes(1);
  });

  it("low-confidence skip keeps the note served, and the next run does not re-classify", async () => {
    seedDistilled();

    await runPipeline(cfg, { quiet: true });

    expect(withDb((db) => db.getByPath(PATH))).toMatchObject({ hash: "h-new", skipped: 0 });
    expect(served()).toBe(true);

    await runPipeline(cfg, { quiet: true });
    expect(spies.distill).toHaveBeenCalledTimes(1);
  });

  it("a note hidden by a failed re-distill (error set, content kept) is restored by a later skip", async () => {
    seedDistilled();
    // recordError keeps the old hash and content but hides the note.
    withDb((db) => db.recordError(PATH, "h-mid", "kie 500"));
    expect(served()).toBe(false);
    spies.passes.value = false;

    await runPipeline(cfg, { quiet: true });

    expect(withDb((db) => db.getByPath(PATH))).toMatchObject({
      hash: "h-new",
      skipped: 0,
      error: null,
    });
    expect(served()).toBe(true);
  });

  it("a session with no prior note is still recorded as skipped (unchanged)", async () => {
    spies.passes.value = false;

    await runPipeline(cfg, { quiet: true });

    expect(withDb((db) => db.getByPath(PATH))).toMatchObject({ hash: "h-new", skipped: 1 });
    expect(served()).toBe(false);
  });
});

describe("runPipeline — the cost prompt gets a real estimate", () => {
  it("passes the new-session count and a dollar estimate from transcript sizes", async () => {
    spies.scan.mockReturnValue([{ path: PATH, hash: "h-new", size: 1_300_000 } as never]);
    const onConfirm = vi.fn(async () => false);

    await runPipeline(cfg, { quiet: true, onConfirm });

    expect(onConfirm).toHaveBeenCalledTimes(1);
    const [count, usd] = onConfirm.mock.calls[0] as unknown as [number, number | null];
    expect(count).toBe(1);
    expect(usd).toBeGreaterThan(0);
  });

  it("passes null on the subscription path (quota, not dollars)", async () => {
    spies.scan.mockReturnValue([{ path: PATH, hash: "h-new", size: 1_300_000 } as never]);
    const onConfirm = vi.fn(async () => false);

    await runPipeline({ ...cfg, provider: "claude-cli" } as Config, { quiet: true, onConfirm });

    expect((onConfirm.mock.calls[0] as unknown as [number, number | null])[1]).toBeNull();
  });
});
