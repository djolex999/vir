import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import { runPipeline } from "./run.js";

// One cheap provider probe before the distill loop: if the provider is
// unreachable, bail with a single clear error instead of entering the loop
// and generating N individual failures (each burning retry backoffs and
// attempt-counter increments).

const spies = vi.hoisted(() => ({
  distill: vi.fn(async () => null),
  probe: vi.fn(async () => {}),
}));

vi.mock("../state/db.js", () => ({
  StateDb: class {
    isProcessed = vi.fn(() => false);
    retryExhausted = vi.fn(() => false);
    record = vi.fn();
    recordError = vi.fn();
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
  scanSessions: () => [{ path: "/t/sess.jsonl", hash: "h1" }],
}));

vi.mock("./parser.js", () => ({
  parseSession: () => ({
    path: "/t/sess.jsonl",
    hash: "h1",
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
    probeProvider: spies.probe,
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
    provider: "anthropic",
    anthropicApiKey: "sk-ant-test",
    filterThreshold: 1,
    projects: { t: "include" },
    models: { classify: "claude-haiku-4-5", distill: "claude-sonnet-5" },
  } as unknown as Config;
}

describe("runPipeline — provider preflight probe", () => {
  beforeEach(() => {
    spies.distill.mockClear();
    spies.probe.mockReset();
  });

  it("provider unreachable → bails with one error, never enters the loop", async () => {
    spies.probe.mockRejectedValue(new Error("fetch failed"));
    await expect(runPipeline(cfg(), { quiet: true })).rejects.toThrow(
      /provider|unreachable|preflight/i,
    );
    expect(spies.distill).not.toHaveBeenCalled();
  });

  it("provider reachable → probe runs once, loop proceeds", async () => {
    await runPipeline(cfg(), { quiet: true });
    expect(spies.probe).toHaveBeenCalledTimes(1);
    expect(spies.distill).toHaveBeenCalledTimes(1);
  });
});
