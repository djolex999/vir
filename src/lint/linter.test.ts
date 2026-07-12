import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../config.js";
import type { DistilledNote, ParsedSession } from "../pipeline/types.js";
import { VaultWriter } from "../pipeline/writer.js";
import { orphanCheck } from "./linter.js";

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
    path: `/x/${sessionId}.jsonl`,
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

function makeNote(topic: string, markdown: string): DistilledNote {
  return {
    classification: {
      category: "pattern",
      topic,
      project: "demo",
      confidence: 0.9,
      themes: [],
    },
    markdown,
  };
}

describe("orphanCheck wikilink resolution", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "vir-lint-"));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("resolves a writer-emitted related-link to the existing target note", async () => {
    const cfg = makeCfg(vault);
    const writer = new VaultWriter(cfg, null);

    await writer.write(
      makeSession("aaaa1111"),
      makeNote("Retry Backoff Strategy", "## Summary\n\ntarget note"),
    );
    await writer.write(
      makeSession("bbbb2222"),
      makeNote(
        "Kie Timeout Handling",
        "## Summary\n\nsource note\n\n## Related\n- Retry Backoff Strategy",
      ),
    );

    const { orphans } = orphanCheck(cfg);

    // B's Related bullet names A's topic; the emitted wikilink must resolve
    // to A's note, so neither side is an orphan.
    expect(orphans).not.toContain("patterns/retry-backoff-strategy-aaaa1111");
    expect(orphans).not.toContain("patterns/kie-timeout-handling-bbbb2222");
  });
});

describe("stalenessCheck note references", () => {
  it("prints the writer's exact note path for a >50-char topic", async () => {
    const { StateDb } = await import("../state/db.js");
    const { makeSlug } = await import("../pipeline/writer.js");
    const { stalenessCheck } = await import("./linter.js");
    const vault = mkdtempSync(join(tmpdir(), "vir-stale-"));
    const db = new StateDb(join(vault, "vir.db"));
    try {
      const topic =
        "Prompt Injection Is Self Inflicted In User Scoped Endpoints Everywhere";
      db.record({
        path: "/proj/aaaa1111.jsonl", hash: "h1", skipped: false,
        notePaths: [], content: "x", category: "pattern",
        topic, project: "demo", confidence: 0.9,
        startedAt: "2025-01-01T00:00:00.000Z",
      });
      // Staleness requires a recent same-project+category note to exist.
      db.record({
        path: "/proj/cccc3333.jsonl", hash: "h2", skipped: false,
        notePaths: [], content: "y", category: "pattern",
        topic: "Recent Note", project: "demo", confidence: 0.9,
        startedAt: new Date().toISOString(),
      });

      const entries = stalenessCheck(makeCfg(vault), db);

      expect(entries).toHaveLength(1);
      expect(entries[0]?.relPath).toBe(
        `patterns/${makeSlug(topic, "aaaa1111")}`,
      );
    } finally {
      db.close();
      rmSync(vault, { recursive: true, force: true });
    }
  });
});
