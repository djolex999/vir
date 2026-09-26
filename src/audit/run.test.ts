import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCliLimitError } from "../pipeline/claudeCli.js";
import type { DistilledRow } from "../state/db.js";
import { StateDb } from "../state/db.js";
import { noteIsVerified, parseLimitOption, runAudit } from "./run.js";

const sid = (n: number): string => `abc1234${n}-0000-4000-8000-000000000001`;

describe("runAudit", () => {
  let dir: string;
  let db: StateDb;

  const seed = (n: number, project: string, content: string): void => {
    db.record({
      path: `/p/-home-u-${project}/${sid(n)}.jsonl`,
      hash: `h${n}`,
      skipped: false,
      notePaths: [],
      content,
      category: "gotcha",
      topic: `topic ${n}`,
      project,
      confidence: 0.9,
      startedAt: `2026-05-0${n}T00:00:00.000Z`,
    });
  };
  const reply = (entries: object[]): (() => Promise<string>) => async () => JSON.stringify(entries);
  const notVerified = (): boolean => false;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vir-audit-run-"));
    db = new StateDb(join(dir, "vir.db"));
    seed(1, "vir", "body one");
    seed(2, "vir", "body two");
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("records one verdict per note and resolves merge labels to session ids", async () => {
    const s = await runAudit(db, {}, {
      llm: reply([
        { id: "n1", verdict: "keep", reason: "specific" },
        { id: "n2", verdict: "merge", reason: "dup of n1", merge_into: "n1" },
      ]),
      isVerified: notVerified,
    });

    expect(s.audited).toBe(2);
    expect(s.byVerdict).toEqual({ keep: 1, verify: 0, merge: 1, reject: 0 });
    const merge = db.listAudits().find((a) => a.verdict === "merge");
    expect(merge?.mergeInto).toBe(sid(1));
  });

  it("skips notes with a fresh verdict unless --all", async () => {
    const llm = reply([
      { id: "n1", verdict: "keep", reason: "x" },
      { id: "n2", verdict: "keep", reason: "x" },
    ]);
    await runAudit(db, {}, { llm, isVerified: notVerified });

    const again = await runAudit(db, {}, { llm, isVerified: notVerified });
    expect(again.audited).toBe(0);
    expect(again.skippedFresh).toBe(2);

    const forced = await runAudit(db, { all: true }, { llm, isVerified: notVerified });
    expect(forced.audited).toBe(2);
  });

  // A human verdict outranks a model one; auditing it only spends tokens.
  it("never audits a human-verified note", async () => {
    const s = await runAudit(db, {}, {
      llm: reply([{ id: "n1", verdict: "keep", reason: "x" }]),
      isVerified: (r) => r.sessionId === sid(2),
    });
    expect(s.skippedVerified).toBe(1);
    expect(s.audited).toBe(1);
  });

  it("counts a note the model left out as unanswered, not as keep", async () => {
    const s = await runAudit(db, {}, {
      llm: reply([{ id: "n1", verdict: "reject", reason: "generic" }]),
      isVerified: notVerified,
    });
    expect(s.audited).toBe(1);
    expect(s.unanswered).toBe(1);
    expect(db.listAudits()).toHaveLength(1);
  });

  it("records nothing for a batch whose reply cannot be parsed, and carries on", async () => {
    seed(3, "growthq", "body three");
    let call = 0;
    const s = await runAudit(db, {}, {
      llm: async () => (call++ === 0 ? JSON.stringify([{ id: "n1", verdict: "keep", reason: "x" }]) : "no json"),
      isVerified: notVerified,
    });
    expect(s.failedBatches).toBe(1);
    expect(s.audited).toBe(1);
  });

  // A limit is a wall the command must stop on, not N failed batches.
  it("lets a subscription limit through", async () => {
    await expect(
      runAudit(db, {}, {
        llm: async () => {
          throw new ClaudeCliLimitError("session", null);
        },
        isVerified: notVerified,
      }),
    ).rejects.toThrow(ClaudeCliLimitError);
  });

  it("honours --project and --limit", async () => {
    seed(3, "growthq", "body three");
    const s = await runAudit(db, { project: "growthq", limit: 5 }, {
      llm: reply([{ id: "n1", verdict: "keep", reason: "x" }]),
      isVerified: notVerified,
    });
    expect(s.audited).toBe(1);
    expect(db.listAudits()[0]?.sessionId).toBe(sid(3));
  });
});

describe("noteIsVerified", () => {
  const row = (topic: string, sessionId: string): DistilledRow => ({
    path: `/p/x/${sessionId}.jsonl`,
    sessionId,
    startedAt: "2026-05-01",
    category: "gotcha",
    topic,
    project: "vir",
    confidence: 0.9,
    content: "body",
  });

  it("is true when the note's frontmatter has verified: true", () => {
    const dir = mkdtempSync(join(tmpdir(), "vir-note-verified-"));
    try {
      mkdirSync(join(dir, "gotchas"), { recursive: true });
      const r = row("topic one", sid(1));
      const file = join(dir, "gotchas", `topic-one-${sid(1).slice(0, 8)}.md`);
      writeFileSync(file, `---\ntopic: "topic one"\nverified: true\n---\n\nbody\n`);
      expect(noteIsVerified(dir, r)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is false when the note file does not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "vir-note-verified-"));
    try {
      expect(noteIsVerified(dir, row("gone", sid(2)))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is false for garbled or missing frontmatter", () => {
    const dir = mkdtempSync(join(tmpdir(), "vir-note-verified-"));
    try {
      mkdirSync(join(dir, "gotchas"), { recursive: true });
      const r = row("topic three", sid(3));
      const file = join(dir, "gotchas", `topic-three-${sid(3).slice(0, 8)}.md`);
      writeFileSync(file, "not even frontmatter\n");
      expect(noteIsVerified(dir, r)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("parseLimitOption", () => {
  it("returns undefined when the flag was omitted", () => {
    expect(parseLimitOption(undefined)).toBeUndefined();
  });

  it("returns the parsed integer for a positive value", () => {
    expect(parseLimitOption("5")).toBe(5);
  });

  it.each(["abc", "0", "-1", "3.5"])("returns null for an invalid value %s", (raw) => {
    expect(parseLimitOption(raw)).toBeNull();
  });
});
