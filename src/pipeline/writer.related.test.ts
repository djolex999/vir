import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../config.js";
import type { EmbeddingProvider } from "../search/provider.js";
import { StateDb } from "../state/db.js";
import type { DistilledNote, ParsedSession } from "./types.js";
import { VaultWriter } from "./writer.js";

const MODEL = "nomic-embed-text";

// Returns the same vector for everything, so every note is every other note's
// neighbour and Related is driven purely by what is in the embedding pool.
function stubProvider(): EmbeddingProvider {
  return {
    name: "ollama",
    modelName: MODEL,
    dimensions: 3,
    maxInputChars: 100_000,
    available: async () => true,
    embedDoc: async () => ({ embedding: [1, 0, 0], truncated: false, sentChars: 0 }),
    embedQuery: async () => [1, 0, 0],
    provenance: () => ({ model: MODEL, dim: 3 }),
  } as unknown as EmbeddingProvider;
}

let root: string;
let vault: string;
let db: StateDb;

function cfg(): Config {
  return {
    vaultPath: vault,
    outputDir: "vir",
    topicsDir: "topics",
    claudeProjectsDir: "/t/projects",
    cadenceHours: 3,
    provider: "anthropic",
    anthropicApiKey: "sk-ant-test",
    kieTopUpTier: "standard",
    filterThreshold: 0.4,
    distillArticles: true,
    distillPdfs: true,
    filterToolCalls: "moderate",
    retrievalDiversity: 0.3,
    models: { classify: "claude-haiku-4-5-20251001", distill: "claude-sonnet-4-6" },
  } as Config;
}

function session(id: string): ParsedSession {
  return {
    path: `/t/projects/demo/${id}.jsonl`,
    hash: "",
    sessionId: id,
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
  } as unknown as ParsedSession;
}

function note(topic: string): DistilledNote {
  return {
    classification: {
      category: "pattern",
      topic,
      project: "demo",
      confidence: 0.9,
      themes: [],
    },
    markdown: `## Summary\n\nbody for ${topic}`,
  };
}

// Seed a DB row so the note is a real embedding-pool member.
function record(id: string, topic: string): void {
  db.record({
    path: `/t/projects/demo/${id}.jsonl`,
    hash: `h-${id}`,
    skipped: false,
    notePaths: [],
    content: `body for ${topic}`,
    category: "pattern",
    topic,
    project: "demo",
    confidence: 0.9,
    startedAt: "2026-05-01T10:00:00.000Z",
  });
}

describe("Related links are regenerated, not hand-maintained", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "vir-related-"));
    vault = join(root, "vault");
    db = new StateDb(join(root, "vir.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("a rewrite drops a link to a note that has left the embedding pool", async () => {
    const w = new VaultWriter(cfg(), db, stubProvider());
    record("aaaa1111", "first topic");
    record("bbbb2222", "second topic");
    await w.write(session("aaaa1111"), note("first topic"));
    const [keeper] = await w.write(session("bbbb2222"), note("second topic"));

    expect(readFileSync(keeper!, "utf8")).toContain("first-topic-aaaa1111");

    // Pruning removes the neighbour from getEmbeddings — the same gate the
    // prune command sets.
    db.markPruned("/t/projects/demo/aaaa1111.jsonl", "sidechain-transcript");

    const w2 = new VaultWriter(cfg(), db, stubProvider());
    const [rewritten] = await w2.write(
      session("bbbb2222"),
      note("second topic"),
      "rewrite",
    );

    expect(readFileSync(rewritten!, "utf8")).not.toContain("first-topic-aaaa1111");
  });

  // A rewrite with no embedding provider has no vector, so it computes ZERO
  // neighbours — which is indistinguishable from "this note has no relatives".
  // Emitting that wipes every Related section in the vault, silently, in one
  // pass. The existing section is the better answer until a provider can
  // produce a new one.
  it("a rewrite with no embedding provider preserves the existing Related section", async () => {
    const w = new VaultWriter(cfg(), db, stubProvider());
    record("aaaa1111", "first topic");
    record("bbbb2222", "second topic");
    await w.write(session("aaaa1111"), note("first topic"));
    const [keeper] = await w.write(session("bbbb2222"), note("second topic"));
    const before = readFileSync(keeper!, "utf8");
    expect(before).toContain("## Related");

    // No provider override, and no Ollama in the test environment.
    const offline = new VaultWriter(cfg(), db);
    const [rewritten] = await offline.write(
      session("bbbb2222"),
      note("second topic"),
      "rewrite",
    );

    expect(readFileSync(rewritten!, "utf8")).toContain("## Related");
    expect(readFileSync(rewritten!, "utf8")).toContain("first-topic-aaaa1111");
  });
});
