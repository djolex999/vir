import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import type { EmbeddingProvider } from "../search/provider.js";
import type { DistilledRow, StateDb } from "../state/db.js";
import { StateDb as StateDbImpl } from "../state/db.js";
import type { DistilledNote, ParsedSession } from "../pipeline/types.js";
import { VaultWriter, makeSlug } from "../pipeline/writer.js";
import { buildMergePrompt, mergeNotes } from "./merger.js";

const llm = vi.hoisted(() => ({ reply: "" }));
vi.mock("../pipeline/distiller.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pipeline/distiller.js")>();
  return { ...actual, callLLM: vi.fn(async () => llm.reply) };
});

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
    projects: {},
    notifications: false,
    workflowTranscripts: "exclude",
    agentTranscripts: "exclude",
    logQueries: false,
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
    branches: [],
    isSidechain: false,
    entrypoint: null,
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

// Same vector for every note, so each note is every other note's neighbour and
// Related is decided purely by what is in the embedding pool.
function stubProvider(): EmbeddingProvider {
  return {
    name: "ollama",
    modelName: "nomic-embed-text",
    dimensions: 3,
    maxInputChars: 100_000,
    available: async () => true,
    embedDoc: async () => ({ embedding: [1, 0, 0], truncated: false, sentChars: 0 }),
    embedQuery: async () => [1, 0, 0],
    provenance: () => ({ model: "nomic-embed-text", dim: 3 }),
  } as unknown as EmbeddingProvider;
}

// What the model sent back on 2026-09-25: a preamble, and a Related section
// holding real claims rather than links.
const MERGE_REPLY = `Here is the merged note.

## Summary

Onboarding reveals settings one step at a time. The billing step moved last.

## What Was Learned

- Show one decision per screen; the wizard in OnboardingFlow.tsx dropped from 9 fields to 3 per step.
- Defer billing until after the first project exists.

## Related

- Step order matters: users who saw billing first abandoned 40% more often.
- [[progressive-disclosure]]

## Context

The onboarding wizard was refactored after drop-off reports.`;

const WINNER = { id: "2582c2e0aaaa", topic: "Progressive Disclosure Onboarding" };
const LOSER = { id: "417d5f4bbbbb", topic: "Onboarding Flow Refactor" };
const NEIGHBOR = { id: "99990000cccc", topic: "Wizard Step Validation" };

function recordNote(
  db: StateDb,
  n: { id: string; topic: string },
  confidence: number,
  startedAt: string,
): void {
  db.record({
    path: `/proj/${n.id}.jsonl`, hash: `h-${n.id}`, skipped: false,
    notePaths: [], content: `## Summary\n\nbody for ${n.topic}\n\n## Related\n\n- stale link`,
    category: "pattern", topic: n.topic, project: "demo", confidence, startedAt,
  });
}

function rowOf(db: StateDb, id: string): DistilledRow {
  const row = db.listDistilled().find((r) => r.sessionId === id);
  if (!row) throw new Error(`no row for ${id}`);
  return row;
}

// Everything between the wikilink header and the generated Related section.
function bodyOf(file: string): string {
  const text = readFileSync(file, "utf8");
  const start = text.indexOf("## Summary");
  const end = text.indexOf("## Related");
  return text.slice(start, end === -1 ? undefined : end).trim();
}

describe("mergeNotes LLM merge", () => {
  let vault: string;
  let db: StateDb;
  let cfg: Config;
  let writer: VaultWriter;

  beforeEach(async () => {
    vault = mkdtempSync(join(tmpdir(), "vir-merge-llm-"));
    db = new StateDbImpl(join(vault, "vir.db"));
    cfg = makeCfg(vault);
    writer = new VaultWriter(cfg, db, stubProvider());
    llm.reply = MERGE_REPLY;
    recordNote(db, WINNER, 0.9, "2026-09-20T10:00:00.000Z");
    recordNote(db, LOSER, 0.7, "2026-08-01T10:00:00.000Z");
    recordNote(db, NEIGHBOR, 0.8, "2026-09-01T10:00:00.000Z");
    for (const n of [WINNER, LOSER, NEIGHBOR]) {
      await writer.rewriteRow(rowOf(db, n.id));
    }
  });
  afterEach(() => {
    db.close();
    rmSync(vault, { recursive: true, force: true });
  });

  async function merge(): Promise<string> {
    const outcome = await mergeNotes(
      cfg, db, rowOf(db, WINNER.id), rowOf(db, LOSER.id), "merge", { writer },
    );
    return outcome.winnerPath;
  }

  it("renders the merged file with the writer's wikilink header", async () => {
    const file = await merge();
    const text = readFileSync(file, "utf8");
    expect(text).toMatch(/\n---\nProject: \[\[demo\]\]\nCategory: \[\[pattern\]\]\n\n## Summary/);
    // Related is rebuilt from neighbours: the neighbour, never the archived loser.
    expect(text).toContain(`[[${makeSlug(NEIGHBOR.topic, NEIGHBOR.id)}|${NEIGHBOR.topic}]]`);
    expect(text).not.toContain(makeSlug(LOSER.topic, LOSER.id) + "|");
    expect(text).not.toContain("Here is the merged note");
    expect(text).toContain(
      `## Archived Duplicates\n- [[${makeSlug(LOSER.topic, LOSER.id)}]]`,
    );
  });

  it("stores content with no Related section", async () => {
    await merge();
    const stored = rowOf(db, WINNER.id).content;
    expect(stored).not.toMatch(/^##\s+related/im);
    expect(stored).not.toContain("abandoned 40% more often");
    expect(stored.startsWith("## Summary")).toBe(true);
    expect(stored).toContain("Defer billing until after the first project exists.");
  });

  it("keeps all body content and the archive section through a rewrite", async () => {
    const file = await merge();
    const before = bodyOf(file);
    expect(before).toContain("Defer billing");

    await new VaultWriter(cfg, db, stubProvider()).rewriteRow(rowOf(db, WINNER.id));

    const after = readFileSync(file, "utf8");
    expect(bodyOf(file)).toBe(before);
    expect(after).toContain("## Archived Duplicates");
    expect(after).toContain("Project: [[demo]]");
  });

  it("leaves both notes untouched when the reply has no Summary", async () => {
    llm.reply = "I can't merge these.";
    const loserFile = join(vault, "vir", "patterns", `${makeSlug(LOSER.topic, LOSER.id)}.md`);
    const winnerFile = join(vault, "vir", "patterns", `${makeSlug(WINNER.topic, WINNER.id)}.md`);
    const winnerBefore = readFileSync(winnerFile, "utf8");

    await expect(merge()).rejects.toThrow(/no '## Summary'/);
    expect(existsSync(loserFile)).toBe(true);
    expect(readFileSync(winnerFile, "utf8")).toBe(winnerBefore);
    expect(db.listDistilled().some((r) => r.sessionId === LOSER.id)).toBe(true);
  });
});

describe("buildMergePrompt", () => {
  const winner = { ...rowFor("aaaa1111", "A"), startedAt: "2026-01-01T00:00:00.000Z", content: "## Summary\n\nold\n\n## Related\n\n- x" };
  const loser = { ...rowFor("bbbb2222", "B"), startedAt: "2026-06-01T00:00:00.000Z", content: "## Summary\n\nnew" };

  it("labels the newer note as the one that wins conflicts", () => {
    const prompt = buildMergePrompt(winner, loser);
    expect(prompt.indexOf("new")).toBeLessThan(prompt.indexOf("old"));
    expect(prompt).toContain("Note 1 (newer, 2026-06-01");
  });

  it("carries the distill prompt's output contract and hides input Related", () => {
    const prompt = buildMergePrompt(winner, loser);
    expect(prompt).toContain("start with '## Summary'");
    expect(prompt).toContain("Do not repeat the project, category, or date.");
    expect(prompt).not.toContain("- x");
  });
});
