import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import { runPipeline } from "./run.js";

// The load-bearing constraint of project filtering: an excluded or undecided
// project's session must NEVER reach the paid boundary (classify is a paid
// Haiku call). The spy sits on Distiller.run — zero calls = zero classify.
// The daemon path must be prompt-free by construction: with no
// onUndecidedProjects callback the run completes, records project-pending
// rows, and never touches stdin.

const spies = vi.hoisted(() => ({
  distill: vi.fn(async () => null),
  record: vi.fn(),
  probe: vi.fn(async () => {}),
  notify: vi.fn(),
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

const skipRowsFor = (reason: string): unknown[] =>
  spies.record.mock.calls.filter(
    (c) => (c[0] as { skipReason?: string }).skipReason === reason,
  );

describe("runPipeline — project filtering at the scan phase", () => {
  beforeEach(() => {
    spies.distill.mockClear();
    spies.record.mockClear();
    spies.probe.mockClear();
    spies.getByPath.mockReset();
    spies.getByPath.mockReturnValue(undefined);
  });

  it("an excluded project's session never reaches the paid boundary", async () => {
    await runPipeline(cfg({ demo: "exclude", scratch: "exclude" }), {
      quiet: true,
    });
    expect(spies.distill).not.toHaveBeenCalled();
    expect(spies.probe).not.toHaveBeenCalled();
    expect(skipRowsFor("project-excluded")).toHaveLength(2);
  });

  it("daemon path with undecided projects: no prompt, pending rows recorded, run completes", async () => {
    const summary = await runPipeline(cfg({}), { quiet: true });
    expect(spies.distill).not.toHaveBeenCalled();
    expect(skipRowsFor("project-pending")).toHaveLength(2);
    expect(summary.projectPending).toBe(2);
  });

  it("interactive path: onUndecidedProjects is asked once and its answers apply", async () => {
    const onUndecidedProjects = vi.fn(
      async (): Promise<Record<string, "include" | "exclude">> => ({
        demo: "include",
        scratch: "exclude",
      }),
    );
    await runPipeline(cfg({}), { quiet: true, onUndecidedProjects });
    expect(onUndecidedProjects).toHaveBeenCalledTimes(1);
    const asked = onUndecidedProjects.mock.calls[0]?.[0] as Array<{
      name: string;
      sessionCount: number;
      estCost: number;
    }>;
    expect(asked.map((p) => p.name).sort()).toEqual(["demo", "scratch"]);
    expect(spies.distill).toHaveBeenCalledTimes(1);
    expect(skipRowsFor("project-excluded")).toHaveLength(1);
    expect(skipRowsFor("project-pending")).toHaveLength(0);
  });

  it("--only restricts the run without recording rows for out-of-scope projects", async () => {
    await runPipeline(cfg({ demo: "include", scratch: "include" }), {
      quiet: true,
      onlyProjects: ["demo"],
    });
    expect(spies.distill).toHaveBeenCalledTimes(1);
    expect(spies.record.mock.calls.every((c) => !(c[0] as { skipReason?: string }).skipReason)).toBe(true);
  });

  it("excluding a project never overwrites its already-distilled rows — notes stay retrievable", async () => {
    spies.getByPath.mockImplementation((path: unknown) =>
      String(path).includes("demo/s1")
        ? {
            path,
            hash: "h1",
            skipped: 0,
            skip_reason: null,
            error: null,
            content: "## Summary\ndistilled note body",
          }
        : undefined,
    );
    await runPipeline(cfg({ demo: "exclude", scratch: "exclude" }), {
      quiet: true,
    });
    expect(spies.distill).not.toHaveBeenCalled();
    // scratch/s2 gets its skip row; demo/s1 (distilled) must be left alone
    expect(skipRowsFor("project-excluded")).toHaveLength(1);
    expect(
      spies.record.mock.calls.filter((c) =>
        String((c[0] as { path: string }).path).includes("demo/s1"),
      ),
    ).toHaveLength(0);
  });

  it("--exclude-project skips for this run only — no DB row, decision untouched", async () => {
    const conf = cfg({ demo: "include", scratch: "include" });
    await runPipeline(conf, {
      quiet: true,
      excludeProjects: ["scratch"],
    });
    expect(spies.distill).toHaveBeenCalledTimes(1);
    expect(skipRowsFor("project-excluded")).toHaveLength(0);
    expect(conf.projects).toEqual({ demo: "include", scratch: "include" });
  });
});
