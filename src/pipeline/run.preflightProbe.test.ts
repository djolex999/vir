import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import {
  clearPreflightFailure,
  readPreflightFailure,
  recordPreflightFailure,
} from "../diagnostics/preflightFailure.js";
import { notify } from "../ui/notify.js";
import { runPipeline } from "./run.js";

// One cheap provider probe before the distill loop: if the provider is
// unreachable, bail with a single clear error instead of entering the loop
// and generating N individual failures (each burning retry backoffs and
// attempt-counter increments).

const spies = vi.hoisted(() => ({
  distill: vi.fn(async () => null),
  probe: vi.fn(async () => {}),
  recordError: vi.fn(),
}));

vi.mock("../state/db.js", () => ({
  StateDb: class {
    isProcessed = vi.fn(() => false);
    retryExhausted = vi.fn(() => false);
    isPruned = vi.fn(() => false);
    liveCopyOf = vi.fn(() => null);
    record = vi.fn();
    recordError = spies.recordError;
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

function cfg(overrides: Partial<Config> = {}): Config {
  return {
    vaultPath: "/tmp/vir-test-vault",
    outputDir: "Vir",
    claudeProjectsDir: "/tmp/vir-test-projects",
    provider: "anthropic",
    anthropicApiKey: "sk-ant-test",
    filterThreshold: 1,
    projects: { t: "include" },
    models: { classify: "claude-haiku-4-5", distill: "claude-sonnet-5" },
    ...overrides,
  } as unknown as Config;
}

describe("runPipeline — provider preflight probe", () => {
  beforeEach(() => {
    spies.distill.mockClear();
    spies.probe.mockReset();
    spies.recordError.mockClear();
    vi.mocked(notify).mockClear();
    clearPreflightFailure();
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

  // The daemon incident (2026-09-23): every run died on an expired claude-cli
  // OAuth session, the stack trace went to daemon.log, and nothing reached the
  // user. notify is the vitest.setup.ts stub and the marker's default path is
  // under the sandboxed $HOME, so none of this touches the real ~/.vir.
  const AUTH_MSG =
    "claude-cli exited 1: Failed to authenticate: OAuth session expired and could not be refreshed";

  it("daemon run: a failed preflight fires one notification naming the provider and the fix", async () => {
    spies.probe.mockRejectedValue(new Error(AUTH_MSG));
    await expect(
      runPipeline(cfg({ provider: "claude-cli" }), { quiet: true }),
    ).rejects.toThrow(/preflight/);
    expect(notify).toHaveBeenCalledTimes(1);
    const [title, message] = vi.mocked(notify).mock.calls[0] ?? [];
    expect(title).toMatch(/claude-cli/);
    expect(message).toMatch(/\/login/);
  });

  it("daemon run: notifications: false suppresses the notification", async () => {
    spies.probe.mockRejectedValue(new Error("fetch failed"));
    await expect(
      runPipeline(cfg({ notifications: false }), { quiet: true }),
    ).rejects.toThrow(/preflight/);
    expect(notify).not.toHaveBeenCalled();
  });

  it("interactive run: the terminal already shows the error, so no notification", async () => {
    spies.probe.mockRejectedValue(new Error("fetch failed"));
    await expect(runPipeline(cfg(), { quiet: false })).rejects.toThrow(
      /preflight/,
    );
    expect(notify).not.toHaveBeenCalled();
  });

  it("a failed preflight is persisted for doctor, even with notifications off", async () => {
    spies.probe.mockRejectedValue(new Error(AUTH_MSG));
    await expect(
      runPipeline(cfg({ provider: "claude-cli", notifications: false }), {
        quiet: true,
      }),
    ).rejects.toThrow(/preflight/);
    const f = readPreflightFailure();
    expect(f?.provider).toBe("claude-cli");
    expect(f?.message).toBe(AUTH_MSG);
    expect(Number.isNaN(Date.parse(f?.at ?? ""))).toBe(false);
  });

  it("a failed preflight is one environmental fact: no per-session error rows", async () => {
    spies.probe.mockRejectedValue(new Error(AUTH_MSG));
    await expect(runPipeline(cfg(), { quiet: true })).rejects.toThrow(
      /preflight/,
    );
    expect(spies.recordError).not.toHaveBeenCalled();
  });

  it("the next successful preflight clears the recorded failure", async () => {
    recordPreflightFailure({
      at: "2026-09-23T08:00:00.000Z",
      provider: "claude-cli",
      message: AUTH_MSG,
    });
    await runPipeline(cfg(), { quiet: true });
    expect(readPreflightFailure()).toBeNull();
  });
});
