import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import { StateDb } from "../state/db.js";
import {
  applyDuplicatePlan,
  buildDuplicatePlan,
  pickDuplicateWinner,
  sessionKey,
  type DuplicateCandidate,
} from "./duplicates.js";
import { restorePruned } from "./prune.js";

// The same Claude Code session can be distilled twice: once from the main
// checkout's project folder and once from a `--claude-worktrees-<name>` folder
// the transcript was copied into. Both rows serve a note, so search and
// `vir dream` see the session twice.

const SID = "2f7c4a42-90b4-4dcb-b73f-79e1df107eca";
const PROV = { model: "nomic-embed-text", dim: 3 };

let root: string;
let vault: string;
let projects: string;
let db: StateDb;
let lockPath: string;

function cfg(): Config {
  return {
    vaultPath: vault,
    outputDir: "vir",
    topicsDir: "topics",
    claudeProjectsDir: projects,
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

function slugOf(topic: string, sessionId: string): string {
  return `${topic.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${sessionId.slice(0, 8)}`;
}

// One distilled copy of a session under `folder`, plus its note on disk.
function seed(opts: {
  folder: string;
  sessionId?: string;
  topic: string;
  at: string;
  sub?: string;
}): { path: string; note: string } {
  const sessionId = opts.sessionId ?? SID;
  const dir = opts.sub ? join(projects, opts.folder, opts.sub) : join(projects, opts.folder);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  vi.setSystemTime(new Date(opts.at));
  db.record({
    path,
    hash: `h-${opts.folder}`,
    skipped: false,
    notePaths: [],
    content: `body of ${opts.topic}`,
    category: "pattern",
    topic: opts.topic,
    project: "demo",
    confidence: 0.8,
    startedAt: "2026-09-01T00:00:00.000Z",
    entrypoint: "cli",
  });
  vi.useRealTimers();
  db.storeEmbedding(sessionId, [1, 0, 0], PROV);
  const note = join(vault, "vir", "patterns", `${slugOf(opts.topic, sessionId)}.md`);
  mkdirSync(join(vault, "vir", "patterns"), { recursive: true });
  writeFileSync(
    note,
    `---\ntopic: "${opts.topic}"\ncategory: pattern\nsession_id: ${sessionId}\n---\n\nbody\n`,
  );
  return { path, note };
}

const MAIN = "-h-app";
const WT = "-h-app--claude-worktrees-brave-tesla-1a2b3c";

describe("sessionKey", () => {
  it("keys a UUID or agent-<hex> transcript by its file name", () => {
    expect(sessionKey(`/p/${MAIN}/${SID}.jsonl`)).toBe(SID);
    expect(sessionKey(`/p/${WT}/${SID}.jsonl`)).toBe(SID);
    expect(sessionKey("/p/x/abc/subagents/agent-a48789171f2de396f.jsonl")).toBe(
      "agent-a48789171f2de396f",
    );
  });

  it("never keys a generic file name: every workflow journal is its own run", () => {
    expect(sessionKey("/p/x/s1/subagents/workflows/wf_1/journal.jsonl")).toBeNull();
    expect(sessionKey("/p/x/notes.jsonl")).toBeNull();
  });
});

describe("pickDuplicateWinner", () => {
  const base: DuplicateCandidate = {
    path: "/a",
    processedAt: "2026-11-01T00:00:00.000Z",
    contentLength: 100,
    hasAuditVerdict: false,
    hasGroundVerdict: false,
    hasLesson: false,
  };

  it("prefers the copy with an audit or transcript verdict over a newer one", () => {
    const checked = { ...base, path: "/old", hasGroundVerdict: true };
    const newer = { ...base, path: "/new", processedAt: "2026-11-09T00:00:00.000Z" };
    expect(pickDuplicateWinner([newer, checked]).path).toBe("/old");
  });

  it("without verdicts, prefers the newest distill", () => {
    const a = { ...base, path: "/a", processedAt: "2026-11-01T00:00:00.000Z" };
    const b = { ...base, path: "/b", processedAt: "2026-11-05T00:00:00.000Z" };
    expect(pickDuplicateWinner([a, b]).path).toBe("/b");
  });

  it("is order-independent on a full tie", () => {
    const a = { ...base, path: "/a" };
    const b = { ...base, path: "/b" };
    expect(pickDuplicateWinner([a, b]).path).toBe(pickDuplicateWinner([b, a]).path);
  });
});

describe("duplicate-session plan", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "vir-dupes-"));
    vault = join(root, "vault");
    projects = join(root, "projects");
    lockPath = join(root, "vir.lock");
    mkdirSync(vault, { recursive: true });
    mkdirSync(projects, { recursive: true });
    db = new StateDb(join(root, "vir.db"));
  });
  afterEach(() => {
    vi.useRealTimers();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("dry run: plans the loser, changes nothing", () => {
    const a = seed({ folder: MAIN, topic: "old take", at: "2026-11-01T00:00:00Z" });
    const b = seed({ folder: WT, topic: "new take", at: "2026-11-05T00:00:00Z" });

    const plan = buildDuplicatePlan(db, cfg());

    expect(plan.groups).toBe(1);
    expect(plan.prune.map((p) => p.path)).toEqual([a.path]);
    expect(plan.winners.get(a.path)).toBe(b.path);
    expect(existsSync(a.note)).toBe(true);
    expect(db.listDistilled()).toHaveLength(2);
  });

  it("keeps the copy with a verdict, so a flagged session is not unflagged", () => {
    const a = seed({ folder: MAIN, topic: "checked", at: "2026-11-01T00:00:00Z" });
    seed({ folder: WT, topic: "unchecked", at: "2026-11-05T00:00:00Z" });
    db.recordGround(a.path, { verdict: "contradicted", reason: "r", contentHash: "c" });

    const plan = buildDuplicatePlan(db, cfg());

    expect(plan.prune.map((p) => p.path)).toEqual([join(projects, WT, `${SID}.jsonl`)]);
  });

  it("ignores groups with only one live copy: skipped, pruned and rejected copies serve nothing", () => {
    seed({ folder: MAIN, topic: "live", at: "2026-11-01T00:00:00Z" });
    db.record({
      path: join(projects, WT, `${SID}.jsonl`),
      hash: "h",
      skipped: true,
      notePaths: [],
      skipReason: "project-pending",
    });
    const other = "11111111-2222-3333-4444-555555555555";
    seed({ folder: MAIN, sessionId: other, topic: "p one", at: "2026-11-01T00:00:00Z" });
    const p2 = seed({ folder: WT, sessionId: other, topic: "p two", at: "2026-11-02T00:00:00Z" });
    db.markPruned(p2.path, "sidechain-transcript");

    const plan = buildDuplicatePlan(db, cfg());

    expect(plan.groups).toBe(0);
    expect(plan.prune).toHaveLength(0);
  });

  it("never groups workflow journals that only share the file name", () => {
    seed({ folder: MAIN, sessionId: "journal", sub: "s1/subagents/workflows/wf_1", topic: "one", at: "2026-11-01T00:00:00Z" });
    seed({ folder: MAIN, sessionId: "journal", sub: "s2/subagents/workflows/wf_2", topic: "two", at: "2026-11-02T00:00:00Z" });

    expect(buildDuplicatePlan(db, cfg()).prune).toHaveLength(0);
  });

  it("apply demotes the loser's note and row; restore brings it back", () => {
    const a = seed({ folder: MAIN, topic: "old take", at: "2026-11-01T00:00:00Z" });
    const b = seed({ folder: WT, topic: "new take", at: "2026-11-05T00:00:00Z" });
    const bytes = readFileSync(a.note, "utf8");

    const res = applyDuplicatePlan(db, cfg(), buildDuplicatePlan(db, cfg()), { lockPath });

    expect(res.marked).toBe(1);
    expect(existsSync(a.note)).toBe(false);
    expect(existsSync(b.note)).toBe(true);
    const moved = join(vault, "vir", ".rejected", `${slugOf("old take", SID)}.md`);
    expect(readFileSync(moved, "utf8")).toContain("prune_reason: duplicate-session");
    expect(db.getByPath(a.path)?.prune_reason).toBe("duplicate-session");
    expect(db.listDistilled().map((r) => r.path)).toEqual([b.path]);
    // Pruned rows never reach the paid boundary again, even under --full.
    expect(db.isPruned(a.path)).toBe(true);

    restorePruned(db, cfg(), { lockPath });
    expect(readFileSync(a.note, "utf8")).toBe(bytes);
    expect(db.listDistilled()).toHaveLength(2);
  });

  it("leaves a note file both copies share in place and only marks the loser row", () => {
    // Same topic + category + session id = same slug = the same file on disk.
    seed({ folder: MAIN, topic: "same take", at: "2026-11-01T00:00:00Z" });
    const b = seed({ folder: WT, topic: "same take", at: "2026-11-05T00:00:00Z" });

    const plan = buildDuplicatePlan(db, cfg());
    const res = applyDuplicatePlan(db, cfg(), plan, { lockPath });

    expect(res.moved).toBe(0);
    expect(res.stateOnly).toBe(1);
    expect(existsSync(b.note)).toBe(true);
    expect(db.listDistilled().map((r) => r.path)).toEqual([b.path]);
  });
});

describe("liveCopyOf (distill-time guard)", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "vir-dupes-"));
    vault = join(root, "vault");
    projects = join(root, "projects");
    mkdirSync(vault, { recursive: true });
    db = new StateDb(join(root, "vir.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("names the live copy of a session distilled under another folder", () => {
    const a = seed({ folder: MAIN, topic: "live", at: "2026-11-01T00:00:00Z" });
    expect(db.liveCopyOf(join(projects, WT, `${SID}.jsonl`))).toBe(a.path);
  });

  it("is null for the live row itself, for an unkeyed name, and when the other copy is pruned", () => {
    const a = seed({ folder: MAIN, topic: "live", at: "2026-11-01T00:00:00Z" });
    expect(db.liveCopyOf(a.path)).toBeNull();
    expect(db.liveCopyOf(join(projects, WT, "s9", "journal.jsonl"))).toBeNull();
    db.markPruned(a.path, "duplicate-session");
    expect(db.liveCopyOf(join(projects, WT, `${SID}.jsonl`))).toBeNull();
  });

  it("is null when this path already serves its own note (a re-distill adds no copy)", () => {
    seed({ folder: MAIN, topic: "a", at: "2026-11-01T00:00:00Z" });
    const b = seed({ folder: WT, topic: "b", at: "2026-11-02T00:00:00Z" });
    expect(db.liveCopyOf(b.path)).toBeNull();
  });
});
