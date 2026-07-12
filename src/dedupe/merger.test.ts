import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../config.js";
import type { DistilledRow, StateDb } from "../state/db.js";
import { StateDb as StateDbImpl } from "../state/db.js";
import type { DistilledNote, ParsedSession } from "../pipeline/types.js";
import { VaultWriter, makeSlug } from "../pipeline/writer.js";
import { mergeNotes } from "./merger.js";

const LONG_TOPIC_A =
  "Prompt Injection Is Self Inflicted In User Scoped Endpoints Everywhere";
const LONG_TOPIC_B =
  "Prompt Injection Vulnerabilities Arise From User Scoped Endpoint Design";

function makeCfg(vaultPath: string): Config {
  return {
    vaultPath,
    outputDir: "vir",
    topicsDir: "topics",
    claudeProjectsDir: "/tmp/claude-projects",
    cadenceHours: 3,
    provider: "anthropic",
    anthropicApiKey: "sk-ant-test",
    kieTopUpTier: "standard",
    filterThreshold: 0.4,
    distillArticles: true,
    distillPdfs: true,
    filterToolCalls: "moderate",
    retrievalDiversity: 0.3,
    models: {
      classify: "claude-haiku-4-5-20251001",
      distill: "claude-sonnet-4-6",
    },
  };
}

function makeSession(sessionId: string): ParsedSession {
  return {
    path: `/proj/${sessionId}.jsonl`,
    hash: "",
    sessionId,
    projectSlug: "demo",
    startedAt: "2026-05-01T10:00:00.000Z",
    endedAt: null,
    lineCount: 0,
    toolCallCount: 0,
    filesTouched: [],
    assistantText: "",
    userText: "",
    rawSummary: "",
    transcriptText: "",
  };
}

function makeNote(topic: string): DistilledNote {
  return {
    classification: {
      category: "pattern",
      topic,
      project: "demo",
      confidence: 0.9,
      themes: [],
    },
    markdown: "## Summary\n\nbody",
  };
}

function rowFor(sessionId: string, topic: string): DistilledRow {
  return {
    path: `/proj/${sessionId}.jsonl`,
    sessionId,
    startedAt: "2026-05-01T10:00:00.000Z",
    category: "pattern",
    topic,
    project: "demo",
    confidence: 0.9,
    content: "## Summary\n\nbody",
  };
}

describe("mergeNotes path resolution", () => {
  let vault: string;
  let db: StateDb;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "vir-merge-"));
    db = new StateDbImpl(join(vault, "vir.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(vault, { recursive: true, force: true });
  });

  it("keep-A archives the real loser file for >50-char topics", async () => {
    const cfg = makeCfg(vault);
    const writer = new VaultWriter(cfg, null);
    await writer.write(makeSession("aaaa1111"), makeNote(LONG_TOPIC_A));
    await writer.write(makeSession("bbbb2222"), makeNote(LONG_TOPIC_B));
    db.record({
      path: "/proj/aaaa1111.jsonl", hash: "h1", skipped: false,
      notePaths: [], content: "x", category: "pattern",
      topic: LONG_TOPIC_A, project: "demo", confidence: 0.9,
    });
    db.record({
      path: "/proj/bbbb2222.jsonl", hash: "h2", skipped: false,
      notePaths: [], content: "x", category: "pattern",
      topic: LONG_TOPIC_B, project: "demo", confidence: 0.9,
    });

    const root = join(vault, "vir");
    const loserFile = join(
      root, "patterns", `${makeSlug(LONG_TOPIC_B, "bbbb2222")}.md`,
    );
    expect(existsSync(loserFile)).toBe(true);

    await mergeNotes(
      cfg, db, rowFor("aaaa1111", LONG_TOPIC_A), rowFor("bbbb2222", LONG_TOPIC_B), "A",
    );

    // The loser's REAL file must be gone from its category dir (moved to
    // archived/) — not left behind because the merger computed a phantom path.
    expect(existsSync(loserFile)).toBe(false);
  });
});
