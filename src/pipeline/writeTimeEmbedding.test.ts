import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import type { DistilledNote, ParsedSession } from "./types.js";

// The writer computes a note's vector before the DB row exists. It must reach
// the row once the caller records it (one embedding per new note), and the
// self-heal sweep must embed the same text the writer would have.

const embedded = vi.hoisted(() => ({ texts: [] as string[] }));

vi.mock("../search/provider.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../search/provider.js")>();
  const fakeProvider = {
    name: "ollama" as const,
    modelName: "nomic-embed-text",
    dimensions: 768,
    maxInputChars: 8192,
    available: async () => true,
    embedDoc: async (text: string) => ({ embedding: [0.5, 0.5], sentChars: text.length, truncated: false }),
    embedQuery: async () => [0.5, 0.5],
    provenance: () => ({ model: "nomic-embed-text", dim: 768 }),
  };
  return {
    ...actual,
    resolveEmbeddingProvider: vi.fn(async () => fakeProvider),
    embedNoteWithProvider: vi.fn(async (_p: unknown, text: string) => {
      embedded.texts.push(text);
      return text.includes("Neighbour") ? [1, 0] : [0.9, 0.1];
    }),
  };
});

import { resolveEmbeddingProvider } from "../search/provider.js";
import { StateDb } from "../state/db.js";
import { sweepEmbeddings } from "./embeddingSweep.js";
import { VaultWriter } from "./writer.js";

function makeCfg(vaultPath: string): Config {
  return {
    vaultPath,
    outputDir: "vir",
    topicsDir: "topics",
    claudeProjectsDir: "/tmp/claude-projects",
    cadenceHours: 3,
    provider: "anthropic",
    connectMaxCandidates: 10,
    anthropicApiKey: "sk-ant-test",
    kieTopUpTier: "standard",
    filterThreshold: 0.4,
    distillArticles: true,
    distillPdfs: true,
    filterToolCalls: "moderate",
    retrievalDiversity: 0.3,
    projects: {},
    notifications: false,
    workflowTranscripts: "exclude",
    agentTranscripts: "exclude",
    logQueries: false,
    models: { classify: "claude-haiku-4-5-20251001", distill: "claude-sonnet-4-6" },
  };
}

function session(sessionId: string): ParsedSession {
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
    branches: [],
    isSidechain: false,
    entrypoint: null,
  };
}

function note(topic: string): DistilledNote {
  return {
    classification: { category: "pattern", topic, project: "demo", confidence: 0.9, themes: [] },
    markdown: `## Summary\n${topic} body text.\n\n## Related\n- something the LLM guessed`,
  };
}

function record(db: StateDb, sessionId: string, topic: string, content: string): void {
  db.record({
    path: `/proj/${sessionId}.jsonl`,
    hash: "h",
    skipped: false,
    notePaths: [],
    content,
    category: "pattern",
    topic,
    project: "demo",
    confidence: 0.9,
    startedAt: "2026-05-01T10:00:00.000Z",
  });
}

// A distilled row that is not an embedding target has its vector.
function isEmbedded(db: StateDb, sessionId: string): boolean {
  return !db.listEmbeddingTargets().some((t) => t.path === `/proj/${sessionId}.jsonl`);
}

let dir: string;
let db: StateDb;
let writer: VaultWriter;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vir-wte-"));
  db = new StateDb(join(dir, "vir.db"));
  writer = new VaultWriter(makeCfg(join(dir, "vault")), db);
  embedded.texts = [];
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("write-time embedding reaches a row recorded after the write", () => {
  it("a new session note is embedded once, and the sweep finds nothing left", async () => {
    await writer.write(session("aaaa1111"), note("Fresh Note"));
    record(db, "aaaa1111", "Fresh Note", "body");
    writer.flushPendingEmbeddings();

    expect(isEmbedded(db, "aaaa1111")).toBe(true);
    const sweep = await sweepEmbeddings(db, undefined, await resolveEmbeddingProvider(undefined));
    expect(sweep.embedded).toBe(0);
    expect(embedded.texts).toHaveLength(1);
  });

  it("an existing row (rewrite) is stored immediately, nothing pending", async () => {
    record(db, "bbbb2222", "Old Note", "body");
    await writer.write(session("bbbb2222"), note("Old Note"));
    expect(isEmbedded(db, "bbbb2222")).toBe(true);
  });

  it("a new article and a new topic reach their rows after the caller records them", async () => {
    await writer.writeArticle(
      { filePath: "/clips/a.md", hash: "ha", title: "Clip", tags: [], body: "b", wordCount: 1 },
      { classification: { category: "concept", confidence: 0.8 }, markdown: "## Summary\nclip" },
    );
    db.recordArticle({ path: "/clips/a.md", hash: "ha", skipped: false, notePath: "/n/a.md", content: "clip" });
    await writer.writeTopic({
      slug: "retries", title: "Retries", topicQuery: "retries", content: "## Summary\ntopic",
      confidence: 0.8, model: "m", sources: [], createdAt: "2026-10-05T00:00:00Z", updatedAt: "2026-10-05T00:00:00Z",
    });
    db.recordTopic({
      id: "retries", topicText: "retries", title: "Retries", content: "topic", sourceNoteIds: [],
      model: "m", createdAt: "2026-10-05T00:00:00Z", updatedAt: "2026-10-05T00:00:00Z",
    });
    writer.flushPendingEmbeddings();

    expect(db.listArticleEmbeddingTargets()).toEqual([]);
    expect(db.listTopicEmbeddingTargets()).toEqual([]);
  });
});

describe("the sweep embeds the same text as the writer", () => {
  it("session note: file minus Related and Archived sections equals the write-time text", async () => {
    // A neighbour so the new note's file gets a real Related section.
    record(db, "cccc3333", "Neighbour", "body");
    await writer.write(session("cccc3333"), note("Neighbour"));

    embedded.texts = [];
    await writer.write(session("dddd4444"), note("Lost Note"));
    const writeTimeText = embedded.texts[0];
    // The row lands but the vector is never flushed: the sweep must recover it.
    record(db, "dddd4444", "Lost Note", "## Summary\nLost Note body text.");
    const file = join(dir, "vault", "vir");
    const { readdirSync } = await import("node:fs");
    const patterns = join(file, "patterns");
    const name = readdirSync(patterns).find((f) => f.includes("dddd4444"))!;
    appendFileSync(join(patterns, name), "\n## Archived Duplicates\n- [[old-dup]]\n");

    embedded.texts = [];
    const sweep = await sweepEmbeddings(db, undefined, await resolveEmbeddingProvider(undefined), writer.embeddingText);
    expect(sweep.embedded).toBe(1);
    expect(embedded.texts).toEqual([writeTimeText]);
  });

  it("falls back to stored content when the note file is gone", async () => {
    record(db, "eeee5555", "No File", "stored body");
    const sweep = await sweepEmbeddings(db, undefined, await resolveEmbeddingProvider(undefined), writer.embeddingText);
    expect(sweep.embedded).toBe(1);
    expect(embedded.texts).toEqual(["stored body"]);
  });
});
