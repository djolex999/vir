import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../config.js";
import { buildQueryResults } from "../output/json.js";
import { hitMeta } from "../mcp/server.js";
import { sweepEmbeddings } from "../pipeline/embeddingSweep.js";
import { VaultWriter } from "../pipeline/writer.js";
import type { EmbeddingProvider } from "../search/provider.js";
import { searchWithOutcome } from "../search/retriever.js";
import { StateDb } from "../state/db.js";
import { ingestNote } from "./ingest.js";

// `vir ingest` against a real SQLite file and a temp vault: the properties
// Muninn depends on (re-ingest and rename keep one note; the transcript stays
// out; the note is findable) are about state, so they are tested on state.

const FIXTURE = join(import.meta.dirname, "..", "ingest", "fixtures", "muninn-meeting.md");

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
    embeddingProvider: "none",
    models: { classify: "claude-haiku-4-5-20251001", distill: "claude-sonnet-4-6" },
  };
}

function fakeProvider(texts: string[], fail = false): EmbeddingProvider {
  return {
    name: "ollama",
    modelName: "nomic-embed-text",
    dimensions: 2,
    maxInputChars: 8192,
    available: async () => true,
    embedDoc: async (text: string) => {
      if (fail) throw new Error("connection refused");
      texts.push(text);
      return { embedding: [0.6, 0.8], sentChars: text.length, truncated: false };
    },
    embedQuery: async () => [0.6, 0.8],
    provenance: () => ({ model: "nomic-embed-text", dim: 2 }),
  };
}

let dir: string;
let src: string;
let cfg: Config;
let db: StateDb;
let embedded: string[];
let writer: VaultWriter;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vir-ingest-"));
  src = join(dir, "Meetings", "2026-11-20 0930 Launch sync.md");
  mkdirSync(join(dir, "Meetings"));
  copyFileSync(FIXTURE, src);
  cfg = makeCfg(join(dir, "vault"));
  db = new StateDb(join(dir, "vir.db"));
  embedded = [];
  writer = new VaultWriter(cfg, db, fakeProvider(embedded));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const meetingsDir = (): string => join(cfg.vaultPath, "vir", "meetings");

describe("ingestNote", () => {
  it("creates one vault note with the summary, no transcript, and embeds it", async () => {
    const r = await ingestNote(src, "muninn", {}, { db, writer });
    expect(r).toMatchObject({
      id: "2026-11-20-0930-launch-sync",
      relPath: "meetings/2026-11-20-0930-launch-sync.md",
      status: "created",
      embedding: "embedded",
    });
    const note = readFileSync(r.notePath, "utf8");
    expect(note).toContain("type: meeting");
    expect(note).toContain(`source_path: ${JSON.stringify(src)}`);
    expect(note).toContain("## Odluke");
    expect(note).not.toContain("transkriptreč");
    expect(embedded).toEqual([note]);
    const row = db.getMeeting(r.id);
    expect(row?.hasEmbedding).toBe(true);
    expect(row?.content).toBe(note);
    expect(readFileSync(join(cfg.vaultPath, "vir", "index.md"), "utf8")).toContain(
      "[[meetings/2026-11-20-0930-launch-sync|Launch sync]]",
    );
  });

  it("running twice leaves one note, one row, one index line, and keeps the vector", async () => {
    await ingestNote(src, "muninn", {}, { db, writer });
    const again = await ingestNote(src, "muninn", {}, { db, writer });
    expect(again.status).toBe("unchanged");
    expect(again.embedding).toBe("kept");
    expect(readdirSync(meetingsDir())).toEqual(["2026-11-20-0930-launch-sync.md"]);
    expect(db.listMeetings()).toHaveLength(1);
    expect(embedded).toHaveLength(1);
    const index = readFileSync(join(cfg.vaultPath, "vir", "index.md"), "utf8");
    expect(index.match(/launch-sync\|Launch sync/g)).toHaveLength(1);
  });

  it("a renamed source updates the same note and re-embeds the new text", async () => {
    await ingestNote(src, "muninn", {}, { db, writer });
    const moved = join(dir, "Meetings", "Launch sync (renamed).md");
    renameSync(src, moved);
    const r = await ingestNote(moved, "muninn", {}, { db, writer });
    expect(r.status).toBe("updated");
    expect(r.embedding).toBe("embedded");
    expect(readdirSync(meetingsDir())).toHaveLength(1);
    expect(db.getMeeting(r.id)?.sourcePath).toBe(moved);
    expect(readFileSync(r.notePath, "utf8")).toContain("Launch%20sync%20(renamed).md");
    expect(embedded).toHaveLength(2);
  });

  it("an edit NULLs the old vector even when re-embedding fails, and the sweep heals it", async () => {
    await ingestNote(src, "muninn", {}, { db, writer });
    writeFileSync(src, readFileSync(src, "utf8").replace("utorak", "sredu"));
    const failing = new VaultWriter(cfg, db, fakeProvider([], true));
    const r = await ingestNote(src, "muninn", {}, { db, writer: failing });
    expect(r).toMatchObject({ status: "updated", embedding: "failed" });
    expect(db.getMeeting(r.id)?.hasEmbedding).toBe(false);
    expect(db.listMeetingEmbeddingTargets().map((t) => t.id)).toEqual([r.id]);

    const healed: string[] = [];
    const sweep = await sweepEmbeddings(db, undefined, fakeProvider(healed), writer.embeddingText);
    expect(sweep.embedded).toBe(1);
    expect(healed[0]).toContain("sredu");
    expect(db.getMeeting(r.id)?.hasEmbedding).toBe(true);
  });

  it("--with-transcript keeps the transcript in the vault copy", async () => {
    const r = await ingestNote(src, "muninn", { withTranscript: true }, { db, writer });
    expect(readFileSync(r.notePath, "utf8")).toContain("transkriptreč");
  });

  it("refuses non-Markdown, missing and non-Muninn files without writing anything", async () => {
    const txt = join(dir, "note.txt");
    writeFileSync(txt, readFileSync(FIXTURE, "utf8"));
    await expect(ingestNote(txt, "muninn", {}, { db, writer })).rejects.toThrow(/not a Markdown file/);
    await expect(ingestNote(join(dir, "nope.md"), "muninn", {}, { db, writer })).rejects.toThrow(
      /cannot read .*ENOENT/,
    );
    const plain = join(dir, "plain.md");
    writeFileSync(plain, "---\ntitle: x\n---\nhello\n");
    await expect(ingestNote(plain, "muninn", {}, { db, writer })).rejects.toThrow(/muninn: 1/);
    await expect(ingestNote(join(dir, "Meetings"), "muninn", {}, { db, writer })).rejects.toThrow();
    expect(db.listMeetings()).toHaveLength(0);
    expect(existsSync(meetingsDir())).toBe(false);
  });
});

describe("an ingested meeting in retrieval", () => {
  it("is found by TF-IDF search and served as category/type meeting", async () => {
    await ingestNote(src, "muninn", {}, { db, writer });
    const { hits, method } = await searchWithOutcome(cfg, db, "lansiranje Lumen", 5);
    expect(method).toBe("tfidf");
    const hit = hits.find((h) => h.filePath.includes("/meetings/"));
    expect(hit).toBeDefined();
    if (!hit) return;
    expect(buildQueryResults([hit], join(cfg.vaultPath, "vir"))[0]?.category).toBe("meeting");
    expect(hitMeta(hit)).toMatchObject({ type: "meeting", category: "meeting", topic: "Launch sync" });
  });

  it("joins the embedding pool as a meeting row", async () => {
    await ingestNote(src, "muninn", {}, { db, writer });
    const rows = db.getMeetingEmbeddings();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ category: "meeting", topic: "Launch sync", embeddingModel: "nomic-embed-text" });
  });
});
