import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import { runPipeline } from "./run.js";

// --rewrite-only --dry-run must suppress every write (rewriteOne → writer.write,
// and writer.regenerateIndex) while still reporting how many notes it WOULD
// rewrite. rewriteOne is module-private and its only side effect is
// writer.write, so the spies sit on the VaultWriter boundary.

const spies = vi.hoisted(() => {
  const write = vi.fn(async (): Promise<string[]> => []);
  const regenerateIndex = vi.fn();
  const uiSummary = vi.fn();
  const uiLine = vi.fn();
  const rows = [
    row("a", "topic-a"),
    row("b", "topic-b"),
    row("c", "topic-c"),
  ];
  function row(id: string, topic: string) {
    return {
      path: `/tmp/${id}.jsonl`,
      sessionId: id,
      project: "vir",
      startedAt: "2026-07-01T00:00:00.000Z",
      category: "pattern",
      topic,
      confidence: 0.9,
      content: "## Summary\nbody",
    };
  }
  return { write, regenerateIndex, uiSummary, uiLine, rows };
});

vi.mock("./writer.js", () => ({
  kebab: (s: string) => s,
  VaultWriter: class {
    write = spies.write;
    regenerateIndex = spies.regenerateIndex;
  },
}));

vi.mock("../state/db.js", () => ({
  StateDb: class {
    listDistilled = vi.fn(() => spies.rows);
    close = vi.fn();
  },
}));

vi.mock("../ui/display.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../ui/display.js")>();
  const noop = vi.fn();
  const spinner = () => {
    const sp = {
      start: () => sp,
      succeed: noop,
      fail: noop,
    };
    return sp;
  };
  return {
    ...real,
    header: noop,
    blank: noop,
    divider: noop,
    line: spies.uiLine,
    summary: spies.uiSummary,
    spinner,
  };
});

function cfg(): Config {
  return {
    vaultPath: "/tmp/vir-test-vault",
    outputDir: "Vir",
    provider: "kie",
    models: { classify: "claude-haiku-4-5", distill: "claude-sonnet-4-6" },
  } as unknown as Config;
}

describe("runPipeline --rewrite-only --dry-run", () => {
  beforeEach(() => {
    spies.write.mockClear();
    spies.regenerateIndex.mockClear();
    spies.uiSummary.mockClear();
    spies.uiLine.mockClear();
  });

  it("performs zero writes", async () => {
    await runPipeline(cfg(), { rewriteOnly: true, dryRun: true });
    expect(spies.write).not.toHaveBeenCalled();
    expect(spies.regenerateIndex).not.toHaveBeenCalled();
  });

  it("still reports the count of notes it would rewrite", async () => {
    const summary = await runPipeline(cfg(), {
      rewriteOnly: true,
      dryRun: true,
    });
    expect(summary.rewritten).toBe(0);
    const printed = [
      ...spies.uiSummary.mock.calls.map((c) => JSON.stringify(c[0])),
      ...spies.uiLine.mock.calls.map((c) => String(c[0])),
    ].join(" ");
    expect(printed).toContain("3");
  });

  it("without --dry-run, --rewrite-only still writes (guard is scoped)", async () => {
    await runPipeline(cfg(), { rewriteOnly: true });
    expect(spies.write).toHaveBeenCalledTimes(3);
    expect(spies.regenerateIndex).toHaveBeenCalledTimes(1);
  });
});
