import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import { runPipeline } from "./run.js";

// Transcript-category filter: nested workflow (wf_*) and sidechain (Agent
// tool) transcripts are agent-internal execution — with the default
// workflowTranscripts: "exclude" they must never reach the paid boundary,
// each recorded with its OWN skip reason so the two stay separately
// countable. The parser backstop catches a sidechain transcript that
// structural detection missed (future layout change), still pre-distill.

const spies = vi.hoisted(() => ({
  distill: vi.fn(async () => null),
  record: vi.fn(),
  probe: vi.fn(async () => {}),
  getByPath: vi.fn((..._args: unknown[]): unknown => undefined),
}));

vi.mock("../state/db.js", () => ({
  StateDb: class {
    isProcessed = vi.fn(() => false);
    retryExhausted = vi.fn(() => false);
    record = spies.record;
    recordError = vi.fn();
    getByPath = spies.getByPath;
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
  scanSessions: () => [
    { path: "/t/projects/demo/s1.jsonl", hash: "h1", size: 1000 },
    {
      path: "/t/projects/demo/s1/subagents/workflows/wf_abc/agent-a1.jsonl",
      hash: "h2",
      size: 2000,
    },
    {
      path: "/t/projects/demo/s1/subagents/agent-b2.jsonl",
      hash: "h3",
      size: 3000,
    },
    // Structurally a plain session, but its CONTENT is a sidechain — the
    // parser backstop must catch it.
    { path: "/t/projects/demo/stealth-sidechain.jsonl", hash: "h4", size: 500 },
    // Top-level SDK-launched review agent — caught by the scan-time sniff.
    { path: "/t/projects/demo/agent-sdk.jsonl", hash: "h5", size: 800 },
    // SDK-launched but the head sniff misses it — the parser backstop catches
    // it via parsed.entrypoint.
    { path: "/t/projects/demo/stealth-agent.jsonl", hash: "h6", size: 900 },
  ],
}));

vi.mock("./projects.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./projects.js")>();
  return {
    ...real,
    readTranscriptHead: (path: string): string =>
      path.includes("agent-sdk")
        ? JSON.stringify({ type: "user", entrypoint: "sdk-py" })
        : path.includes("stealth-agent")
          ? "" // truncated head — sniff must miss, backstop must catch
          : JSON.stringify({ type: "user", entrypoint: "cli" }),
  };
});

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
    isSidechain: path.includes("stealth-sidechain"),
    entrypoint: path.includes("stealth-agent") ? "sdk-py" : null,
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

function cfg(
  workflowTranscripts: "exclude" | "include",
  agentTranscripts: "exclude" | "include" = "exclude",
): Config {
  return {
    vaultPath: "/tmp/vir-test-vault",
    outputDir: "Vir",
    claudeProjectsDir: "/t/projects",
    provider: "kie",
    filterThreshold: 1,
    projects: { demo: "include" },
    notifications: false,
    workflowTranscripts,
    agentTranscripts,
    models: { classify: "claude-haiku-4-5", distill: "claude-sonnet-4-6" },
  } as unknown as Config;
}

const rowsFor = (reason: string): unknown[] =>
  spies.record.mock.calls.filter(
    (c) => (c[0] as { skipReason?: string }).skipReason === reason,
  );

describe("runPipeline — transcript-category filter", () => {
  beforeEach(() => {
    spies.distill.mockClear();
    spies.record.mockClear();
    spies.probe.mockClear();
    spies.getByPath.mockReset();
    spies.getByPath.mockReturnValue(undefined);
  });

  it("default exclude: workflow and sidechain transcripts never reach the paid boundary, with distinct reasons", async () => {
    const summary = await runPipeline(cfg("exclude"), { quiet: true });
    // only s1.jsonl distills; wf + sidechain + stealth are all filtered
    expect(spies.distill).toHaveBeenCalledTimes(1);
    expect(rowsFor("workflow-transcript")).toHaveLength(1);
    // structural sidechain + parser-backstop stealth
    expect(rowsFor("sidechain-transcript")).toHaveLength(2);
    expect(summary.workflowSkipped).toBe(1);
    expect(summary.sidechainSkipped).toBe(2);
  });

  it("include mode distills nested transcripts like any session", async () => {
    await runPipeline(cfg("include", "include"), { quiet: true });
    expect(spies.distill).toHaveBeenCalledTimes(6);
    expect(rowsFor("workflow-transcript")).toHaveLength(0);
    expect(rowsFor("sidechain-transcript")).toHaveLength(0);
    expect(rowsFor("agent-transcript")).toHaveLength(0);
  });

  it("SDK-launched agent transcripts never reach the paid boundary, entrypoint persisted", async () => {
    const summary = await runPipeline(cfg("exclude"), { quiet: true });
    const agentRows = spies.record.mock.calls
      .map((c) => c[0] as { path: string; skipReason?: string; entrypoint?: string })
      .filter((r) => r.skipReason === "agent-transcript");
    // scan-time sniff catches agent-sdk; parser backstop catches stealth-agent
    expect(agentRows.map((r) => r.path).sort()).toEqual([
      "/t/projects/demo/agent-sdk.jsonl",
      "/t/projects/demo/stealth-agent.jsonl",
    ]);
    expect(agentRows.every((r) => r.entrypoint === "sdk-py")).toBe(true);
    expect(summary.agentSkipped).toBe(2);
    expect(spies.distill).toHaveBeenCalledTimes(1);
  });

  it("agentTranscripts include distills SDK transcripts while the workflow knob stays exclude", async () => {
    await runPipeline(cfg("exclude", "include"), { quiet: true });
    // s1 + agent-sdk + stealth-agent; wf/sidechain/stealth-sidechain stay out
    expect(spies.distill).toHaveBeenCalledTimes(3);
    expect(rowsFor("agent-transcript")).toHaveLength(0);
  });

  it("dry-run counts filtered transcripts but records no rows", async () => {
    await runPipeline(cfg("exclude"), { quiet: true, dryRun: true });
    expect(spies.distill).not.toHaveBeenCalled();
    expect(spies.record).not.toHaveBeenCalled();
  });

  it("never overwrites an already-distilled row — its note must stay retrievable", async () => {
    // The wf transcript was distilled before the filter existed. Recording a
    // skip row would flip skipped=1 and silently hide the note from
    // listDistilled/embeddings — the exact silent semi-prune we promised not
    // to do. Filtering is forward-looking only.
    spies.getByPath.mockImplementation((path: unknown) =>
      String(path).includes("wf_abc")
        ? {
            path,
            hash: "h2",
            skipped: 0,
            skip_reason: null,
            error: null,
            content: "## Summary\ndistilled note body",
          }
        : undefined,
    );
    await runPipeline(cfg("exclude"), { quiet: true });
    expect(
      spies.record.mock.calls.filter((c) =>
        String((c[0] as { path: string }).path).includes("wf_abc"),
      ),
    ).toHaveLength(0);
  });
});
