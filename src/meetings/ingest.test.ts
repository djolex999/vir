import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hitMeta } from "../mcp/server.js";
import type { EmbeddingProvider } from "../search/provider.js";
import { StateDb } from "../state/db.js";
import { ingestMeeting, parseMeetingNote } from "./ingest.js";

// A note exactly as Muninn writes it (notes.rs, contract `muninn: 1`).
function muninnNote(opts: { project?: string; summary?: string } = {}): string {
  return [
    "---",
    "muninn: 1",
    "source: muninn",
    "kind: meeting",
    "id: 2026-11-23-1724-otp-refunds",
    "date: 2026-11-23T17:24:43+01:00",
    'title: "OTP refunds"',
    "duration_min: 31",
    'people: ["Ja", "Oni"]',
    `project: ${opts.project ?? "null"}`,
    "language: sr",
    "---",
    "",
    "# OTP refunds",
    "",
    "## Sažetak",
    opts.summary ?? "Refund ide D+1 preko back officea.",
    "",
    "> [!note]- Transkript",
    "> [00:00] Ja: tajna rečenica iz transkripta",
    "",
  ].join("\n");
}

function fakeProvider(calls: string[]): EmbeddingProvider {
  return {
    name: "ollama",
    modelName: "nomic-embed-text",
    dimensions: 3,
    maxInputChars: 8192,
    available: async () => true,
    embedDoc: async (text: string) => {
      calls.push(text);
      return { embedding: [0.1, 0.2, 0.3], truncated: false, sentChars: text.length };
    },
    embedQuery: async () => [0.1, 0.2, 0.3],
    provenance: () => ({ model: "nomic-embed-text", dim: 3 }),
  };
}

describe("parseMeetingNote", () => {
  it("reads the shared core and leaves the transcript out of the embed text", () => {
    const r = parseMeetingNote(muninnNote({ project: "pripremi.rs" }), "muninn");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.meeting.title).toBe("OTP refunds");
    expect(r.meeting.project).toBe("pripremi-rs");
    expect(r.meeting.date).toBe("2026-11-23T17:24:43+01:00");
    expect(r.meeting.embedText).toContain("Refund ide D+1");
    expect(r.meeting.embedText).not.toContain("tajna rečenica");
  });

  it("treats project: null as no project", () => {
    const r = parseMeetingNote(muninnNote(), "muninn");
    expect(r.ok && r.meeting.project).toBeNull();
  });

  it("refuses a note from another source, another kind, or without frontmatter", () => {
    expect(parseMeetingNote(muninnNote(), "otter").ok).toBe(false);
    expect(parseMeetingNote(muninnNote().replace("kind: meeting", "kind: memo"), "muninn").ok).toBe(false);
    expect(parseMeetingNote("# just text", "muninn").ok).toBe(false);
  });
});

describe("ingestMeeting", () => {
  let dir: string;
  let db: StateDb;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vir-ingest-"));
    db = new StateDb(join(dir, "vir.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("indexes and embeds a note, then serves it as a meeting row", async () => {
    const calls: string[] = [];
    const path = join(dir, "2026-11-23 1724 OTP refunds.md");
    const out = await ingestMeeting(db, path, muninnNote({ project: "pripremi-rs" }), "muninn", fakeProvider(calls));
    expect(out).toEqual({ status: "indexed", title: "OTP refunds", embedded: true });
    const rows = db.getMeetingEmbeddings();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ filePath: path, category: "meeting", project: "pripremi-rs" });
    expect(calls[0]).not.toContain("tajna rečenica");
  });

  it("is a no-op for the same bytes, and re-embeds when the note changes", async () => {
    const calls: string[] = [];
    const path = join(dir, "n.md");
    await ingestMeeting(db, path, muninnNote(), "muninn", fakeProvider(calls));
    const again = await ingestMeeting(db, path, muninnNote(), "muninn", fakeProvider(calls));
    expect(again.status).toBe("unchanged");
    expect(calls).toHaveLength(1);
    await ingestMeeting(db, path, muninnNote({ summary: "Novo." }), "muninn", fakeProvider(calls));
    expect(calls).toHaveLength(2);
    expect(db.getMeetingEmbeddings()).toHaveLength(1);
  });

  it("without a provider stores the row with no vector, which the sweep then picks up", async () => {
    const path = join(dir, "n.md");
    const out = await ingestMeeting(db, path, muninnNote(), "muninn", null);
    expect(out).toEqual({ status: "indexed", title: "OTP refunds", embedded: false });
    expect(db.getMeetingEmbeddings()).toHaveLength(0);
    expect(db.listMeetingEmbeddingTargets().map((t) => t.path)).toEqual([path]);
  });

  it("a changed note drops its old vector until it is re-embedded", async () => {
    const path = join(dir, "n.md");
    await ingestMeeting(db, path, muninnNote(), "muninn", fakeProvider([]));
    await ingestMeeting(db, path, muninnNote({ summary: "Novo." }), "muninn", null);
    expect(db.getMeetingEmbeddings()).toHaveLength(0);
    expect(db.listMeetingEmbeddingTargets()).toHaveLength(1);
  });
});

describe("hitMeta for an ingested meeting", () => {
  it("types it as a meeting with its title and project", () => {
    const meta = hitMeta({
      filePath: "/x/n.md",
      title: "/x/n",
      content: muninnNote({ project: "pripremi-rs" }),
      score: 0.8,
      method: "embedding",
    });
    expect(meta).toMatchObject({ type: "meeting", topic: "OTP refunds", project: "pripremi-rs", category: "meeting" });
  });

  it("maps project: null to no project", () => {
    const meta = hitMeta({ filePath: "/x/n.md", title: "/x/n", content: muninnNote(), score: 0.8, method: "embedding" });
    expect(meta.project).toBe("");
  });
});
