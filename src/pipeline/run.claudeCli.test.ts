import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import { CLAUDE_CLI_SESSION_CAP, runPipeline } from "./run.js";
import { ClaudeCliLimitError } from "./claudeCli.js";

// Two claude-cli-specific run-loop behaviors:
// 1. A subscription limit is ONE environmental fact — halt the loop, burn no
//    attempt counters (the preflight-probe lesson).
// 2. Batch cap: quota has no meter, so a run through the subscription is
//    bounded; the remainder is deferred to the next cycle.

const spies = vi.hoisted(() => ({
  distill: vi.fn(async () => null),
  recordError: vi.fn(),
  scan: vi.fn((): Array<{ path: string; hash: string }> => []),
}));

vi.mock("../state/db.js", () => ({
  StateDb: class {
    isProcessed = vi.fn(() => false);
    retryExhausted = vi.fn(() => false);
    record = vi.fn();
    recordError = spies.recordError;
    getByPath = vi.fn(() => undefined);
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
  scanSessions: () => spies.scan(),
}));

vi.mock("./parser.js", () => ({
  parseSession: (path: string) => ({
    path,
    hash: "h-new",
    sessionId: path,
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
    probeProvider: vi.fn(async () => {}),
    Distiller: class {
      run = spies.distill;
    },
  };
});

vi.mock("./embeddingSweep.js", () => ({
  sweepEmbeddings: async () => ({ ran: false, embedded: 0, errors: 0, pending: 0 }),
}));

function sessions(n: number): Array<{ path: string; hash: string }> {
  return Array.from({ length: n }, (_, i) => ({
    path: `/t/sess-${i}.jsonl`,
    hash: `h-${i}`,
  }));
}

function cfg(provider: "anthropic" | "claude-cli"): Config {
  return {
    vaultPath: "/tmp/vir-test-vault",
    outputDir: "Vir",
    claudeProjectsDir: "/tmp/vir-test-projects",
    provider,
    anthropicApiKey: "sk-ant-test",
    filterThreshold: 1,
    projects: { t: "include" },
    models: { classify: "claude-haiku-4-5-20251001", distill: "claude-sonnet-5" },
  } as unknown as Config;
}

beforeEach(() => {
  spies.distill.mockReset();
  spies.distill.mockResolvedValue(null);
  spies.recordError.mockClear();
  spies.scan.mockReset();
});

describe("runPipeline — subscription limit halts the run", () => {
  it("stops after the first ClaudeCliLimitError, burns NO attempt counters, reports the halt", async () => {
    spies.scan.mockReturnValue(sessions(3));
    spies.distill.mockRejectedValue(
      new ClaudeCliLimitError("session", "3:45pm"),
    );

    const summary = await runPipeline(cfg("claude-cli"), { quiet: true });

    // One environmental fact, not three individual failures.
    expect(spies.distill).toHaveBeenCalledTimes(1);
    // The wall must not increment the 3-strike park counter.
    expect(spies.recordError).not.toHaveBeenCalled();
    expect(summary.limitHalted).toContain("3:45pm");
    expect(summary.errored).toBe(0);
  });

  it("an ordinary distill error still records per-session and continues (halt is limit-only)", async () => {
    spies.scan.mockReturnValue(sessions(2));
    spies.distill.mockRejectedValue(new Error("plain failure"));

    const summary = await runPipeline(cfg("claude-cli"), { quiet: true });

    expect(spies.distill).toHaveBeenCalledTimes(2);
    expect(spies.recordError).toHaveBeenCalledTimes(2);
    expect(summary.limitHalted).toBeNull();
  });
});

describe("runPipeline — claude-cli batch cap", () => {
  it("caps distills per run and reports the deferred remainder", async () => {
    spies.scan.mockReturnValue(sessions(CLAUDE_CLI_SESSION_CAP + 4));

    const summary = await runPipeline(cfg("claude-cli"), { quiet: true });

    expect(spies.distill).toHaveBeenCalledTimes(CLAUDE_CLI_SESSION_CAP);
    expect(summary.capDeferred).toBe(4);
  });

  it("does not cap the API path", async () => {
    spies.scan.mockReturnValue(sessions(CLAUDE_CLI_SESSION_CAP + 4));

    const summary = await runPipeline(cfg("anthropic"), { quiet: true });

    expect(spies.distill).toHaveBeenCalledTimes(CLAUDE_CLI_SESSION_CAP + 4);
    expect(summary.capDeferred).toBe(0);
  });
});
