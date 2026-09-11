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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../config.js";
import { LockHeldError } from "../pipeline/lock.js";
import { StateDb } from "../state/db.js";
import { applyPrunePlan, buildPrunePlan, restorePruned } from "./prune.js";

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

// One distilled row + its note file on disk.
function seed(opts: {
  sessionId: string;
  sub?: string;
  entrypoint?: string | null;
  topic: string;
  body?: string;
}): string {
  const dir = opts.sub
    ? join(projects, "-h-app", opts.sub)
    : join(projects, "-h-app");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${opts.sessionId}.jsonl`);
  db.record({
    path,
    hash: `h-${opts.sessionId}`,
    skipped: false,
    notePaths: [],
    content: opts.body ?? `body of ${opts.topic}`,
    category: "pattern",
    topic: opts.topic,
    project: "demo",
    confidence: 0.9,
    startedAt: "2026-05-01T00:00:00.000Z",
    entrypoint: opts.entrypoint ?? null,
  });
  db.storeEmbedding(opts.sessionId, [1, 0, 0], PROV);
  const slug = `${opts.topic.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${opts.sessionId.slice(0, 8)}`;
  const note = join(vault, "vir", "patterns", `${slug}.md`);
  mkdirSync(join(vault, "vir", "patterns"), { recursive: true });
  writeFileSync(
    note,
    `---\ntopic: "${opts.topic}"\ncategory: pattern\nsession_id: ${opts.sessionId}\n---\n\n${opts.body ?? "body"}\n`,
  );
  return note;
}

describe("vir prune", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "vir-prune-"));
    vault = join(root, "vault");
    projects = join(root, "projects");
    lockPath = join(root, "vir.lock");
    mkdirSync(vault, { recursive: true });
    mkdirSync(projects, { recursive: true });
    db = new StateDb(join(root, "vir.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("dry-run writes nothing: no DB change, no file moved", () => {
    const note = seed({ sessionId: "aaaa1111", sub: "subagents", topic: "agent thing" });
    const before = readFileSync(note, "utf8");

    const plan = buildPrunePlan(db, cfg());

    expect(plan.prune).toHaveLength(1);
    expect(existsSync(note)).toBe(true);
    expect(readFileSync(note, "utf8")).toBe(before);
    expect(db.getByPath(plan.prune[0]!.path)?.pruned_at ?? null).toBeNull();
    expect(db.listDistilled()).toHaveLength(1);
  });

  it("reports counts per reason and the unclassifiable bucket", () => {
    seed({ sessionId: "aaaa1111", sub: "subagents", topic: "side one" });
    seed({ sessionId: "bbbb2222", sub: join("subagents", "wf_9"), topic: "wf one" });
    seed({ sessionId: "cccc3333", entrypoint: "sdk-py", topic: "sdk one" });
    seed({ sessionId: "dddd4444", topic: "mystery" });
    seed({ sessionId: "eeee5555", entrypoint: "cli", topic: "human one" });

    const plan = buildPrunePlan(db, cfg());

    expect(plan.byReason).toEqual({
      "sidechain-transcript": 1,
      "workflow-transcript": 1,
      "agent-transcript": 1,
    });
    expect(plan.byKeepReason.unclassifiable).toBe(1);
    expect(plan.byKeepReason["human-entrypoint"]).toBe(1);
  });

  it("apply moves the note, stamps frontmatter, sets prune state, leaves skipped alone", () => {
    const note = seed({ sessionId: "aaaa1111", sub: "subagents", topic: "agent thing" });
    const plan = buildPrunePlan(db, cfg());

    applyPrunePlan(db, cfg(), plan, { lockPath });

    expect(existsSync(note)).toBe(false);
    const moved = join(vault, "vir", ".rejected", "agent-thing-aaaa1111.md");
    expect(existsSync(moved)).toBe(true);
    expect(readFileSync(moved, "utf8")).toContain("pruned_at:");
    expect(readFileSync(moved, "utf8")).toContain("prune_reason: sidechain-transcript");

    const row = db.getByPath(plan.prune[0]!.path);
    expect(row?.pruned_at).toBeTruthy();
    expect(row?.skipped).toBe(0);
    expect(row?.skip_reason ?? null).toBeNull();
  });

  it("a pruned note is gone from every DB-backed read path", () => {
    seed({ sessionId: "aaaa1111", sub: "subagents", topic: "agent thing" });
    applyPrunePlan(db, cfg(), buildPrunePlan(db, cfg()), { lockPath });

    expect(db.listDistilled()).toHaveLength(0);
    expect(db.getStats().total).toBe(0);
    expect(db.getEmbeddings(join(vault, "vir"))).toHaveLength(0);
    expect(db.listEmbeddingTargets()).toHaveLength(0);
    expect(db.listReconcileTargets()).toHaveLength(0);
  });

  it("no resurrection: the session stays processed and is not a reconcile target", () => {
    seed({ sessionId: "aaaa1111", sub: "subagents", topic: "agent thing" });
    const plan = buildPrunePlan(db, cfg());
    applyPrunePlan(db, cfg(), plan, { lockPath });

    expect(db.isProcessed(plan.prune[0]!.path, "h-aaaa1111")).toBe(true);
    expect(db.listReconcileTargets()).toHaveLength(0);
  });

  it("never prunes an unclassifiable row", () => {
    seed({ sessionId: "dddd4444", topic: "mystery" });
    const plan = buildPrunePlan(db, cfg());
    expect(plan.prune).toHaveLength(0);
    expect(plan.keep.map((k) => k.decision.reason)).toContain("unclassifiable");
  });

  it("never prunes a merge winner, and reports it", () => {
    const note = seed({ sessionId: "aaaa1111", sub: "subagents", topic: "agent thing" });
    writeFileSync(note, `${readFileSync(note, "utf8")}\n## Archived Duplicates\n- [[x]]\n`);

    const plan = buildPrunePlan(db, cfg());

    expect(plan.prune).toHaveLength(0);
    expect(plan.byKeepReason["merge-winner"]).toBe(1);
  });

  it("restore is a byte-exact round trip, DB row and embedding included", () => {
    const note = seed({ sessionId: "aaaa1111", sub: "subagents", topic: "agent thing" });
    const bytesBefore = readFileSync(note, "utf8");
    const rowBefore = db.getByPath(join(projects, "-h-app", "subagents", "aaaa1111.jsonl"));
    const embBefore = db.getEmbeddings(join(vault, "vir")).length;

    applyPrunePlan(db, cfg(), buildPrunePlan(db, cfg()), { lockPath });
    const res = restorePruned(db, cfg(), { lockPath });

    expect(res.restored).toBe(1);
    expect(readFileSync(note, "utf8")).toBe(bytesBefore);
    const rowAfter = db.getByPath(join(projects, "-h-app", "subagents", "aaaa1111.jsonl"));
    expect(rowAfter?.content).toBe(rowBefore?.content);
    expect(rowAfter?.hash).toBe(rowBefore?.hash);
    expect(rowAfter?.pruned_at ?? null).toBeNull();
    expect(db.getEmbeddings(join(vault, "vir")).length).toBe(embBefore);
  });

  it("apply and restore acquire the lock", () => {
    seed({ sessionId: "aaaa1111", sub: "subagents", topic: "agent thing" });
    writeFileSync(lockPath, String(process.pid));

    expect(() =>
      applyPrunePlan(db, cfg(), buildPrunePlan(db, cfg()), { lockPath }),
    ).toThrow(LockHeldError);
    expect(() => restorePruned(db, cfg(), { lockPath })).toThrow(LockHeldError);
  });

  it("never edits a kept note, and reports dangling links instead of fixing them", () => {
    seed({ sessionId: "aaaa1111", sub: "subagents", topic: "agent thing" });
    const keeper = seed({ sessionId: "eeee5555", entrypoint: "cli", topic: "human one" });
    writeFileSync(
      keeper,
      `${readFileSync(keeper, "utf8")}\n## Related\n- [[agent-thing-aaaa1111]]\n`,
    );
    const keeperBefore = readFileSync(keeper, "utf8");

    const plan = buildPrunePlan(db, cfg());
    expect(plan.danglingLinks).toBe(1);

    applyPrunePlan(db, cfg(), plan, { lockPath });
    expect(readFileSync(keeper, "utf8")).toBe(keeperBefore);
  });
});
