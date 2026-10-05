import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import { StateDb } from "../state/db.js";
import { distillOneSession, MAX_DISTILL_INPUT_CHARS } from "./distillSession.js";
import type { ParsedSession } from "./types.js";

let dir: string;
let db: StateDb;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vir-distill-"));
  db = new StateDb(join(dir, "vir.db"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function parsed(transcriptText: string): ParsedSession {
  return {
    path: "/p/s.jsonl", hash: "h", sessionId: "s", projectSlug: "p",
    startedAt: null, endedAt: null, lineCount: 100, toolCallCount: 10,
    filesTouched: ["a", "b", "c"], assistantText: "a", userText: "u",
    rawSummary: "summary", transcriptText, branches: [], isSidechain: false, entrypoint: null,
  };
}

describe("distillOneSession — oversized transcripts are trimmed to fit", () => {
  it("keeps the start and the end, marks the cut, and logs it", async () => {
    const seen: string[] = [];
    const logs: string[] = [];
    const big = "START " + "x".repeat(MAX_DISTILL_INPUT_CHARS * 2) + " END";
    await distillOneSession(parsed(big), { path: "/p/s.jsonl", hash: "h" }, {
      cfg: { filterThreshold: 0, filterToolCalls: "off" } as unknown as Config,
      db,
      distiller: { run: vi.fn(async (_p, _s, content: string) => { seen.push(content); return null; }) },
      writer: { write: vi.fn(async () => []), flushPendingEmbeddings: vi.fn() },
      log: (m) => logs.push(m),
    });
    const sent = seen[0]!;
    expect(sent.length).toBeLessThanOrEqual(MAX_DISTILL_INPUT_CHARS + 200);
    expect(sent.startsWith("START")).toBe(true);
    expect(sent.endsWith("END")).toBe(true);
    expect(sent).toMatch(/characters of this transcript omitted/);
    expect(logs.some((l) => l.includes("trimmed"))).toBe(true);
  });

  it("leaves a transcript within the limit untouched", async () => {
    const seen: string[] = [];
    await distillOneSession(parsed("short transcript"), { path: "/p/s.jsonl", hash: "h" }, {
      cfg: { filterThreshold: 0, filterToolCalls: "off" } as unknown as Config,
      db,
      distiller: { run: vi.fn(async (_p, _s, content: string) => { seen.push(content); return null; }) },
      writer: { write: vi.fn(async () => []), flushPendingEmbeddings: vi.fn() },
    });
    expect(seen[0]).toBe("short transcript");
  });
});
