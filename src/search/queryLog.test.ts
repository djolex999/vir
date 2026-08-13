import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendQueryLog,
  formatQueryRecord,
  readQueryLog,
  recordQueryEvent,
  type QueryLogRecord,
} from "./queryLog.js";
import type { SearchHit } from "./retriever.js";

const VERIFIED_NOTE = `---
topic: Kie 200 errors
verified: true
---
Body of a verified note.`;

const UNVERIFIED_NOTE = `---
topic: Plain note
---
Body.`;

function hit(title: string, score: number, content: string): SearchHit {
  return { filePath: `/vault/${title}.md`, title, content, score, method: "embedding" };
}

const NOW = new Date("2026-08-13T10:00:00.000Z");

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "vir-querylog-"));
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("formatQueryRecord", () => {
  it("builds a full record from an embedding search", () => {
    const rec = formatQueryRecord({
      source: "cli",
      query: "kie error handling",
      type: "all",
      hits: [
        hit("gotchas/kie-200-errors-abcd1234", 0.82, VERIFIED_NOTE),
        hit("patterns/retry-backoff-ef567890", 0.61, UNVERIFIED_NOTE),
      ],
      search: {
        method: "embedding",
        degraded: false,
        embedError: null,
        excludedMismatched: 2,
        candidates: 7,
        provider: { name: "ollama", model: "nomic-embed-text", dim: 768 },
      },
      latencyMs: 143,
      now: NOW,
    });

    expect(rec).toEqual({
      ts: "2026-08-13T10:00:00.000Z",
      source: "cli",
      query: "kie error handling",
      type: "all",
      method: "embedding",
      degraded: false,
      degradedReason: null,
      provider: { name: "ollama", model: "nomic-embed-text", dim: 768 },
      candidates: 7,
      excludedModel: 2,
      latencyMs: 143,
      hits: [
        { slug: "gotchas/kie-200-errors-abcd1234", rank: 1, score: 0.82, verified: true },
        { slug: "patterns/retry-backoff-ef567890", rank: 2, score: 0.61, verified: false },
      ],
    } satisfies QueryLogRecord);
  });

  it("carries the degraded reason and a null provider on the tfidf fallback", () => {
    const rec = formatQueryRecord({
      source: "mcp",
      query: "q",
      type: "session",
      hits: [],
      search: {
        method: "tfidf",
        degraded: true,
        embedError: "HTTP 500 from Ollama",
        excludedMismatched: 0,
        candidates: 0,
        provider: null,
      },
      latencyMs: 12,
      now: NOW,
    });
    expect(rec.method).toBe("tfidf");
    expect(rec.degraded).toBe(true);
    expect(rec.degradedReason).toBe("HTTP 500 from Ollama");
    expect(rec.provider).toBeNull();
    expect(rec.hits).toEqual([]);
  });
});

function sampleRecord(query = "q"): QueryLogRecord {
  return formatQueryRecord({
    source: "cli",
    query,
    type: "all",
    hits: [hit("patterns/x-11111111", 0.5, UNVERIFIED_NOTE)],
    search: {
      method: "embedding",
      degraded: false,
      embedError: null,
      excludedMismatched: 0,
      candidates: 1,
      provider: { name: "ollama", model: "nomic-embed-text", dim: 768 },
    },
    latencyMs: 5,
    now: NOW,
  });
}

describe("recordQueryEvent — the call-site chokepoint", () => {
  const event = {
    query: "kie errors",
    source: "mcp" as const,
    type: "all" as const,
    hits: [hit("gotchas/kie-200-errors-abcd1234", 0.82, VERIFIED_NOTE)],
    search: {
      method: "embedding" as const,
      degraded: false,
      embedError: null,
      excludedMismatched: 0,
      candidates: 3,
      provider: { name: "ollama", model: "nomic-embed-text", dim: 768 },
    },
    latencyMs: 99,
  };

  it("does nothing when logQueries is false", () => {
    const appended: QueryLogRecord[] = [];
    recordQueryEvent({ ...event, logQueries: false }, (r) => appended.push(r));
    expect(appended).toEqual([]);
  });

  it("appends one well-formed record when logQueries is true", () => {
    const appended: QueryLogRecord[] = [];
    recordQueryEvent({ ...event, logQueries: true }, (r) => appended.push(r));
    expect(appended).toHaveLength(1);
    const rec = appended[0]!;
    expect(rec.source).toBe("mcp");
    expect(rec.query).toBe("kie errors");
    expect(rec.latencyMs).toBe(99);
    expect(rec.hits).toEqual([
      { slug: "gotchas/kie-200-errors-abcd1234", rank: 1, score: 0.82, verified: true },
    ]);
    expect(Number.isNaN(Date.parse(rec.ts))).toBe(false);
  });

  it("never throws into the query path, even if the appender itself throws", () => {
    expect(() =>
      recordQueryEvent({ ...event, logQueries: true }, () => {
        throw new Error("disk exploded");
      }),
    ).not.toThrow();
  });
});

describe("appendQueryLog / readQueryLog", () => {
  it("appends one JSONL line that readQueryLog round-trips", () => {
    const dir = tmpDir();
    dirs.push(dir);
    const logPath = join(dir, "queries.jsonl");
    appendQueryLog(sampleRecord("first"), { logPath });
    appendQueryLog(sampleRecord("second"), { logPath });

    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);

    const records = readQueryLog(logPath);
    expect(records.map((r) => r.query)).toEqual(["first", "second"]);
  });

  it("never throws on a write failure, emits one stderr line, never touches stdout", () => {
    const dir = tmpDir();
    dirs.push(dir);
    const stderrLines: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write");
    const failMarkerPath = join(dir, "queries.failed");

    expect(() =>
      appendQueryLog(sampleRecord(), {
        // A path whose parent is a FILE, so mkdir + append both fail.
        logPath: join(dir, "not-a-dir"),
        failMarkerPath,
        stderr: (s) => stderrLines.push(s),
      }),
    ).not.toThrow();
    // Make the parent a file first so the append genuinely fails.
    writeFileSync(join(dir, "blocker"), "");
    expect(() =>
      appendQueryLog(sampleRecord(), {
        logPath: join(dir, "blocker", "queries.jsonl"),
        failMarkerPath,
        stderr: (s) => stderrLines.push(s),
      }),
    ).not.toThrow();

    expect(stderrLines.length).toBeGreaterThanOrEqual(1);
    expect(stderrLines.some((l) => l.includes("query log"))).toBe(true);
    expect(stdoutSpy).not.toHaveBeenCalled();
    // The failure leaves a marker doctor can see.
    expect(existsSync(failMarkerPath)).toBe(true);
    stdoutSpy.mockRestore();
  });

  it("rotates to .1 at the size cap and keeps exactly one generation", () => {
    const dir = tmpDir();
    dirs.push(dir);
    const logPath = join(dir, "queries.jsonl");
    const opts = { logPath, maxBytes: 200 };

    // Grow past the cap, forcing at least two rotations.
    for (let i = 0; i < 20; i++) appendQueryLog(sampleRecord(`q${i}`), opts);

    expect(existsSync(logPath)).toBe(true);
    expect(existsSync(logPath + ".1")).toBe(true);
    expect(existsSync(logPath + ".2")).toBe(false);

    // readQueryLog reads the rotated generation first, then the live file,
    // preserving chronological order across the boundary.
    const records = readQueryLog(logPath);
    expect(records.length).toBeGreaterThan(0);
    const nums = records.map((r) => Number(r.query.slice(1)));
    expect([...nums].sort((a, b) => a - b)).toEqual(nums);
    // The oldest records fell off — only one rotated generation survives.
    expect(records.length).toBeLessThan(20);
  });

  it("readQueryLog skips malformed lines and missing files", () => {
    const dir = tmpDir();
    dirs.push(dir);
    const logPath = join(dir, "queries.jsonl");
    expect(readQueryLog(logPath)).toEqual([]);

    appendQueryLog(sampleRecord("good"), { logPath });
    writeFileSync(logPath, readFileSync(logPath, "utf8") + "{not json\n", "utf8");
    appendQueryLog(sampleRecord("also-good"), { logPath });

    expect(readQueryLog(logPath).map((r) => r.query)).toEqual(["good", "also-good"]);
  });
});
