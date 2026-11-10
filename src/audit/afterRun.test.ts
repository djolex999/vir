import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCliLimitError } from "../pipeline/claudeCli.js";
import { StateDb } from "../state/db.js";
import { checkTranscriptsAfterRun } from "./afterRun.js";

const sid = (n: number): string => `abc1234${n}-0000-4000-8000-000000000001`;
const pathOf = (n: number): string => `/p/-home-u-vir/${sid(n)}.jsonl`;

describe("checkTranscriptsAfterRun", () => {
  let dir: string;
  let db: StateDb;
  let logs: string[];

  const seed = (n: number, startedAt: string): void => {
    db.record({
      path: pathOf(n),
      hash: `h${n}`,
      skipped: false,
      notePaths: [],
      content: `body ${n}`,
      category: "gotcha",
      topic: `topic ${n}`,
      project: "vir",
      confidence: 0.9,
      startedAt,
    });
  };
  const base = {
    isVerified: (): boolean => false,
    evidence: (p: string): string => `transcript of ${p}`,
    transcriptExists: (): boolean => true,
    log: (m: string): void => {
      logs.push(m);
    },
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vir-after-run-"));
    db = new StateDb(join(dir, "vir.db"));
    logs = [];
    seed(1, "2026-10-20T00:00:00.000Z");
    seed(2, "2026-10-01T00:00:00.000Z");
    seed(3, "2026-10-10T00:00:00.000Z");
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("does nothing when the config flag is off", async () => {
    let called = false;
    const out = await checkTranscriptsAfterRun(
      { checkTranscripts: false, checkTranscriptsPerRun: 20 },
      db,
      { ...base, llm: async () => ((called = true), '{"findings":[]}') },
    );
    expect(out).toEqual({ kind: "off" });
    expect(called).toBe(false);
    // Absent from config.json = off.
    expect(await checkTranscriptsAfterRun({}, db, { ...base, llm: async () => '{"findings":[]}' })).toEqual({ kind: "off" });
  });

  it("checks at most the per-pass cap, oldest transcripts first, and logs a line", async () => {
    const prompts: string[] = [];
    const out = await checkTranscriptsAfterRun(
      { checkTranscripts: true, checkTranscriptsPerRun: 2 },
      db,
      {
        ...base,
        llm: async (p) => {
          prompts.push(p);
          return '{"findings":[]}';
        },
      },
    );
    expect(out.kind).toBe("checked");
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain(`transcript of ${pathOf(2)}`);
    expect(prompts[1]).toContain(`transcript of ${pathOf(3)}`);
    expect(logs).toEqual(["transcript check: 2 checked, 0 contradicted (0 sent to review), 0 unbacked, 0 failed"]);
  });

  it("logs and stops on a subscription limit instead of throwing", async () => {
    const out = await checkTranscriptsAfterRun(
      { checkTranscripts: true, checkTranscriptsPerRun: 20 },
      db,
      {
        ...base,
        llm: async () => {
          throw new ClaudeCliLimitError("session", null);
        },
      },
    );
    expect(out.kind).toBe("stopped");
    expect(logs[0]).toMatch(/^transcript check stopped: subscription limit/);
  });

  it("stays quiet when there is nothing to check", async () => {
    const out = await checkTranscriptsAfterRun(
      { checkTranscripts: true, checkTranscriptsPerRun: 20 },
      db,
      { ...base, transcriptExists: () => false, llm: async () => '{"findings":[]}' },
    );
    expect(out.kind).toBe("checked");
    expect(logs).toEqual([]);
  });
});
