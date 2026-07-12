import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import type { DistilledNote, ParsedSession } from "./types.js";

vi.mock("../search/embedder.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../search/embedder.js")>();
  return {
    ...actual,
    isOllamaAvailableCached: vi.fn(async () => true),
    embeddingForNote: vi.fn(async (text: string) => {
      if (text.includes("Alpha Backoff Tuning")) return [0.95, 0.05];
      if (text.includes("Alpha Retry Strategy")) return [1, 0];
      if (text.includes("Beta Frontmatter Parsing")) return [0, 1];
      return [0.5, 0.5];
    }),
  };
});

import { StateDb } from "../state/db.js";
import { VaultWriter, makeSlug } from "./writer.js";

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

function recordRow(db: StateDb, sessionId: string, topic: string): void {
  db.record({
    path: `/proj/${sessionId}.jsonl`,
    hash: "h",
    skipped: false,
    notePaths: [],
    content: "x",
    category: "pattern",
    topic,
    project: "demo",
    confidence: 0.9,
  });
}

describe("write() Related section from embedding neighbors", () => {
  let vault: string;
  let db: StateDb;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "vir-rel-"));
    db = new StateDb(join(vault, "vir.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(vault, { recursive: true, force: true });
  });

  it("links to real embedding-neighbor notes, not LLM-guessed topics", async () => {
    const cfg = makeCfg(vault);
    const writer = new VaultWriter(cfg, db);

    recordRow(db, "aaaa1111", "Alpha Retry Strategy");
    await writer.write(
      makeSession("aaaa1111"),
      makeNote("Alpha Retry Strategy", "## Summary\n\nabout alpha retries"),
    );
    recordRow(db, "bbbb2222", "Beta Frontmatter Parsing");
    await writer.write(
      makeSession("bbbb2222"),
      makeNote("Beta Frontmatter Parsing", "## Summary\n\nabout beta parsing"),
    );

    recordRow(db, "cccc3333", "Alpha Backoff Tuning");
    await writer.write(
      makeSession("cccc3333"),
      makeNote(
        "Alpha Backoff Tuning",
        "## Summary\n\nabout alpha backoff\n\n## Related\n- Made Up Topic That Does Not Exist",
      ),
    );

    const written = readFileSync(
      join(vault, "vir", "patterns", `${makeSlug("Alpha Backoff Tuning", "cccc3333")}.md`),
      "utf8",
    );

    // >0 Related links resolve: the near neighbor (Alpha Retry Strategy,
    // cos ≈ 0.999) must be linked by its real id-suffixed filename.
    expect(written).toContain(`[[${makeSlug("Alpha Retry Strategy", "aaaa1111")}`);

    // The far note (Beta, cos ≈ 0.05 < floor) must NOT be linked.
    expect(written).not.toContain(makeSlug("Beta Frontmatter Parsing", "bbbb2222"));

    // Every emitted Related link points at an existing note file — the
    // LLM-guessed dead link must be gone.
    const related = written.split(/^## Related$/m)[1] ?? "";
    const targets = [...related.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].map(
      (m) => m[1] ?? "",
    );
    expect(targets.length).toBeGreaterThan(0);
    for (const t of targets) {
      expect(
        existsSync(join(vault, "vir", "patterns", `${t}.md`)),
        `dead link: ${t}`,
      ).toBe(true);
    }
  });
});
