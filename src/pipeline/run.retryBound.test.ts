import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import { runPipeline } from "./run.js";

// After MAX_DISTILL_ATTEMPTS consecutive failures a session must stop
// triggering paid calls from `vir run` — only `vir reconcile --force` may
// retry it. The spy sits on Distiller.run (the paid-call boundary).

const spies = vi.hoisted(() => ({
  distill: vi.fn(async () => null),
  exhausted: vi.fn(() => false),
  recordError: vi.fn(),
}));

vi.mock("../state/db.js", () => ({
  StateDb: class {
    isProcessed = vi.fn(() => false);
    retryExhausted = spies.exhausted;
    record = vi.fn();
    recordError = spies.recordError;
    listDistilled = vi.fn(() => []);
    listEmbeddingTargets = vi.fn(() => []);
    listTopicEmbeddingTargets = vi.fn(() => []);
    listArticleEmbeddingTargets = vi.fn(() => []);
    listPdfEmbeddingTargets = vi.fn(() => []);
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
  scanSessions: () => [{ path: "/t/sess.jsonl", hash: "h-new" }],
}));

vi.mock("./parser.js", () => ({
  parseSession: () => ({
    path: "/t/sess.jsonl",
    hash: "h-new",
    sessionId: "sess",
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
    Distiller: class {
      run = spies.distill;
    },
  };
});

vi.mock("./embeddingSweep.js", () => ({
  sweepEmbeddings: async () => ({ ran: false, embedded: 0, errors: 0, pending: 0 }),
}));

function cfg(): Config {
  return {
    vaultPath: "/tmp/vir-test-vault",
    outputDir: "Vir",
    claudeProjectsDir: "/tmp/vir-test-projects",
    provider: "kie",
    filterThreshold: 1,
    models: { classify: "claude-haiku-4-5", distill: "claude-sonnet-4-6" },
  } as unknown as Config;
}

describe("runPipeline — retry bound on repeated distill failures", () => {
  beforeEach(() => {
    spies.distill.mockClear();
    spies.exhausted.mockReset();
    spies.recordError.mockClear();
  });

  it("an exhausted session (attempts >= max) never reaches the paid call", async () => {
    spies.exhausted.mockReturnValue(true);
    await runPipeline(cfg(), { quiet: true });
    expect(spies.distill).not.toHaveBeenCalled();
  });

  it("a non-exhausted session still distills (gate is scoped)", async () => {
    spies.exhausted.mockReturnValue(false);
    await runPipeline(cfg(), { quiet: true });
    expect(spies.distill).toHaveBeenCalledTimes(1);
  });
});
