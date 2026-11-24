import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import { runPipeline } from "./run.js";

// The same session copied under a second project folder (main checkout and a
// `--claude-worktrees-<name>` folder) must not be distilled a second time: the
// copy would be a duplicate note in search and `vir dream`, and a paid call.

const spies = vi.hoisted(() => ({
  distill: vi.fn(async () => null),
  record: vi.fn(),
  probe: vi.fn(async () => {}),
  notify: vi.fn(),
  getByPath: vi.fn((..._args: unknown[]): unknown => undefined),
  isPruned: vi.fn((..._args: unknown[]): boolean => false),
  liveCopyOf: vi.fn((..._args: unknown[]): string | null => null),
}));

vi.mock("../state/db.js", () => ({
  StateDb: class {
    isProcessed = vi.fn(() => false);
    retryExhausted = vi.fn(() => false);
    isPruned = spies.isPruned;
    liveCopyOf = spies.liveCopyOf;
    record = spies.record;
    recordError = vi.fn();
    getByPath = spies.getByPath;
    listDistilled = vi.fn(() => []);
    listEmbeddingTargets = vi.fn(() => []);
    listTopicEmbeddingTargets = vi.fn(() => []);
    listArticleEmbeddingTargets = vi.fn(() => []);
    listPdfEmbeddingTargets = vi.fn(() => []);
    listMeetingEmbeddingTargets = vi.fn(() => []);
    close = vi.fn();
  },
}));

vi.mock("./writer.js", () => ({
  kebab: (s: string) => s,
  VaultWriter: class {
    write = vi.fn(async (): Promise<string[]> => []);
    regenerateIndex = vi.fn();
  },
}));

vi.mock("./scanner.js", () => ({
  scanSessions: () => [
    { path: "/t/projects/demo/s1.jsonl", hash: "h1", size: 1000 },
    { path: "/t/projects/scratch/s2.jsonl", hash: "h2", size: 2000 },
  ],
}));

vi.mock("./parser.js", () => ({
  parseSession: (path: string, hash: string) => ({
    path,
    hash,
    sessionId: path.split("/").pop()?.replace(".jsonl", "") ?? "s",
    projectSlug: "demo",
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

vi.mock("./filter.js", () => ({
  scoreSession: () => ({ passes: true, score: 10 }),
}));

vi.mock("./distiller.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./distiller.js")>();
  return {
    ...real,
    probeProvider: spies.probe,
    Distiller: class {
      run = spies.distill;
    },
  };
});

vi.mock("./embeddingSweep.js", () => ({
  sweepEmbeddings: async () => ({
    ran: false,
    embedded: 0,
    errors: 0,
    pending: 0,
  }),
}));

function cfg(projects: Record<string, "include" | "exclude">): Config {
  return {
    vaultPath: "/tmp/vir-test-vault",
    outputDir: "Vir",
    claudeProjectsDir: "/t/projects",
    provider: "kie",
    filterThreshold: 1,
    projects,
    notifications: false,
    models: { classify: "claude-haiku-4-5", distill: "claude-sonnet-4-6" },
  } as unknown as Config;
}


describe("runPipeline — session already distilled under another folder", () => {
  beforeEach(() => {
    spies.distill.mockClear();
    spies.record.mockClear();
    spies.liveCopyOf.mockReset();
    spies.liveCopyOf.mockReturnValue(null);
  });

  it("does not distill a copy whose session already serves a note, even under --full", async () => {
    spies.liveCopyOf.mockReturnValue("/t/projects/main/s1.jsonl");

    await runPipeline(cfg({ demo: "include", scratch: "include" }), {
      quiet: true,
      full: true,
    });

    expect(spies.distill).not.toHaveBeenCalled();
    // Nothing recorded: the row must stay re-checkable if the other copy is
    // pruned or restored later.
    expect(spies.record).not.toHaveBeenCalled();
  });

  it("distills a session with no live copy elsewhere", async () => {
    await runPipeline(cfg({ demo: "include", scratch: "include" }), {
      quiet: true,
      full: true,
    });

    expect(spies.distill).toHaveBeenCalled();
  });
});
