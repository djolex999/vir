import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../config.js";
import { LockHeldError } from "../pipeline/lock.js";
import type { EmbeddingProvider } from "../search/provider.js";
import { StateDb } from "../state/db.js";
import { runConnect, VERIFY_MAX_TOKENS, type ConnectDeps } from "./run.js";

let dir: string;
let vault: string;
let db: StateDb;
let cfg: Config;

function note(slug: string, session: string, date: string, lesson: string, project = "growthq"): void {
  writeFileSync(
    join(vault, "vir", "gotchas", `${slug}.md`),
    `---\ncategory: gotcha\nproject: "${project}"\nsession_id: ${session}\ndate: ${date}\n---\n## What Was Learned\n\n**${lesson}**\n`,
  );
}

function provider(): EmbeddingProvider {
  const vec = (t: string) => (t.includes("proxy") ? [1, 0] : t.includes("zod") ? [0, 1] : [0.6, -0.8]);
  return {
    name: "ollama", modelName: "fake-model", dimensions: 2, maxInputChars: 10_000,
    available: async () => true,
    embedDoc: async (t: string) => ({ embedding: vec(t), sentChars: t.length, truncated: false }),
    embedQuery: async (t: string) => vec(t),
    provenance: () => ({ model: "fake-model", dim: 2 }),
  };
}

// Echoes back every listed lesson as the same lesson, quoting its first word.
function echoLlm(calls: string[]): ConnectDeps["llm"] {
  return async (prompt: string) => {
    calls.push(prompt);
    const ids = [...prompt.matchAll(/^\[(L\d+)\] \([^)]*\) (\S+)/gm)].map((m) => ({ id: m[1] ?? "", word: m[2] ?? "" }));
    const topic = prompt.includes("proxy") ? "Use proxy.ts in Next 16" : "Parse env with zod";
    return JSON.stringify({
      same_lesson: ids.map((x) => x.id), rule: topic, why: "It broke three times.",
      evidence: ids.map((x) => ({ id: x.id, quote: x.word })),
    });
  };
}

function deps(calls: string[], over: Partial<ConnectDeps> = {}): ConnectDeps {
  return {
    provider: provider(), llm: echoLlm(calls), model: "test-model",
    estimateCostUsd: () => 0.01, now: () => new Date("2026-10-06T00:00:00Z"),
    lockPath: join(dir, "vir.lock"), ...over,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vir-connect-run-"));
  vault = join(dir, "vault");
  mkdirSync(join(vault, "vir", "gotchas"), { recursive: true });
  db = new StateDb(join(dir, "vir.db"));
  cfg = { vaultPath: vault, outputDir: "vir", connectMaxCandidates: 10, provider: "anthropic" } as unknown as Config;
  note("a", "s1", "2026-06-01", "proxy.ts replaces middleware in Next 16");
  note("b", "s2", "2026-06-05", "proxy.ts is the Next 16 name for middleware");
  note("c", "s3", "2026-06-20", "proxy.ts again: middleware.ts is deprecated");
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const ruleFiles = () => {
  const d = join(vault, "vir", "insights", "rules");
  return existsSync(d) ? readdirSync(d) : [];
};

describe("runConnect", () => {
  it("refuses without an embedding provider", async () => {
    await expect(runConnect(cfg, db, { dryRun: false }, deps([], { provider: null }))).rejects.toThrow(
      "clustering needs an embedding provider — run vir embed setup",
    );
  });

  it("dry run counts candidates and writes nothing", async () => {
    const calls: string[] = [];
    const s = await runConnect(cfg, db, { dryRun: true }, deps(calls));
    expect(s.candidates).toBe(1);
    expect(s.llmCalls).toBe(0);
    expect(calls).toHaveLength(0);
    expect(s.estCostUsd).toBeCloseTo(0.01);
    expect(ruleFiles()).toEqual([]);
    expect(db.listInsights()).toEqual([]);
  });

  it("estimates cost with the same output cap the real call uses", async () => {
    const seen: number[] = [];
    await runConnect(cfg, db, { dryRun: true }, deps([], { estimateCostUsd: (_i, out) => { seen.push(out); return 0; } }));
    expect(seen).toEqual([VERIFY_MAX_TOKENS]);
  });

  it("dry run writes nothing, not even the embedding cache", async () => {
    await runConnect(cfg, db, { dryRun: true }, deps([]));
    const rows = (db as unknown as { db: { prepare: (s: string) => { get: () => { n: number } } } }).db
      .prepare("SELECT COUNT(*) AS n FROM lesson_embeddings").get();
    expect(rows.n).toBe(0);
  });

  it("proposes one cited rule from a recurring lesson", async () => {
    const calls: string[] = [];
    const s = await runConnect(cfg, db, { dryRun: false }, deps(calls));
    expect(s).toMatchObject({ proposed: 1, llmCalls: 1 });
    const [row] = db.listInsights();
    expect(row).toMatchObject({ status: "proposed", promotion: "none", scope: "project:growthq", sessions: 3 });
    expect(row?.memberSessionIds.sort()).toEqual(["s1", "s2", "s3"]);
    expect(ruleFiles()).toEqual([`${row?.slug}.md`]);
    expect(readFileSync(join(vault, "vir", "insights", "rules", `${row?.slug}.md`), "utf8")).toContain("**Rule:** Use proxy.ts in Next 16");
  });

  it("flags evidence that came from a merged duplicate", async () => {
    mkdirSync(join(vault, "vir", "archived"), { recursive: true });
    writeFileSync(
      join(vault, "vir", "archived", "c-old.md"),
      "---\ncategory: gotcha\nproject: \"growthq\"\nsession_id: s0\ndate: 2026-05-20\n---\n## What Was Learned\n\n**proxy.ts before the merge**\n",
    );
    const c = join(vault, "vir", "gotchas", "c.md");
    writeFileSync(c, readFileSync(c, "utf8") + "\n## Archived Duplicates\n- [[c-old]]\n");
    await runConnect(cfg, db, { dryRun: false }, deps([]));
    const ev = db.listInsights()[0]?.evidence ?? [];
    expect(ev.find((e) => e.sessionId === "s0")).toMatchObject({ citeSlug: "c", merged: true });
    expect(ev.find((e) => e.sessionId === "s1")?.merged).toBeFalsy();
  });

  it("re-running over unchanged notes makes no paid call", async () => {
    await runConnect(cfg, db, { dryRun: false }, deps([]));
    const calls: string[] = [];
    const s = await runConnect(cfg, db, { dryRun: false }, deps(calls));
    expect(calls).toHaveLength(0);
    expect(s.unchanged).toBe(1);
    expect(ruleFiles()).toHaveLength(1);
  });

  it("updates a proposed rule's evidence when a new session joins, keeping its text", async () => {
    await runConnect(cfg, db, { dryRun: false }, deps([]));
    const before = db.listInsights()[0];
    if (before) db.upsertInsight({ ...before, rule: "Owner-edited rule" });
    note("d", "s4", "2026-07-01", "proxy.ts once more in Next 16");
    const s = await runConnect(cfg, db, { dryRun: false }, deps([]));
    expect(s.updated).toBe(1);
    const after = db.listInsights()[0];
    expect(after?.rule).toBe("Owner-edited rule");
    expect(after?.sessions).toBe(4);
  });

  it("flags new evidence on an accepted rule once, then makes no further paid call", async () => {
    await runConnect(cfg, db, { dryRun: false }, deps([]));
    const row = db.listInsights()[0];
    if (row) db.upsertInsight({ ...row, status: "accepted" });
    note("d", "s4", "2026-07-01", "proxy.ts once more in Next 16");
    const first = await runConnect(cfg, db, { dryRun: false }, deps([]));
    expect(first.additionsFlagged).toBe(1);
    const calls: string[] = [];
    const second = await runConnect(cfg, db, { dryRun: false }, deps(calls));
    expect(calls).toHaveLength(0);
    expect(second.unchanged).toBe(1);
  });

  it("keeps a rejection after every member note is rewritten", async () => {
    await runConnect(cfg, db, { dryRun: false }, deps([]));
    const row = db.listInsights()[0];
    if (row) db.upsertInsight({ ...row, status: "rejected" });
    note("a", "s1", "2026-06-01", "proxy.ts: rewritten wording one");
    note("b", "s2", "2026-06-05", "proxy.ts: rewritten wording two");
    note("c", "s3", "2026-06-20", "proxy.ts: rewritten wording three");
    const calls: string[] = [];
    const s = await runConnect(cfg, db, { dryRun: false }, deps(calls));
    expect(s.skippedRejected).toBe(1);
    expect(calls).toHaveLength(0);
    expect(db.listInsights()).toHaveLength(1);
  });

  it("defers candidates beyond connectMaxCandidates", async () => {
    note("z1", "t1", "2026-06-01", "zod parses env vars", "vir");
    note("z2", "t2", "2026-06-09", "zod env parsing again", "vir");
    note("z3", "t3", "2026-06-30", "zod for env, third time", "vir");
    cfg = { ...cfg, connectMaxCandidates: 1 } as Config;
    const s = await runConnect(cfg, db, { dryRun: false }, deps([]));
    expect(s).toMatchObject({ candidates: 2, deferred: 1, llmCalls: 1, proposed: 1 });
  });

  it("skips a candidate whose LLM call fails and keeps going", async () => {
    const s = await runConnect(cfg, db, { dryRun: false }, deps([], { llm: async () => { throw new Error("529 overloaded"); } }));
    expect(s).toMatchObject({ llmFailures: 1, proposed: 0 });
    expect(ruleFiles()).toEqual([]);
  });

  it("writes nothing for an unverifiable verdict", async () => {
    const s = await runConnect(cfg, db, { dryRun: false }, deps([], { llm: async () => '{"same_lesson":[],"rule":"","why":"","evidence":[]}' }));
    expect(s).toMatchObject({ unverified: 1, proposed: 0 });
  });

  it("writes no rule when the embedding provider dies mid-run", async () => {
    const p = provider();
    let n = 0;
    const real = p.embedDoc;
    p.embedDoc = async (t: string) => { n += 1; if (n > 2) throw new Error("down"); return real(t); };
    await expect(runConnect(cfg, db, { dryRun: false }, deps([], { provider: p }))).rejects.toThrow("nothing written");
    expect(ruleFiles()).toEqual([]);
    expect(db.listInsights()).toEqual([]);
  });

  it("holds the vault lock for the whole run", async () => {
    const first = runConnect(cfg, db, { dryRun: true }, deps([]));
    await expect(runConnect(cfg, db, { dryRun: true }, deps([]))).rejects.toBeInstanceOf(LockHeldError);
    await first;
  });

  it("reconsider resets a rejected rule to proposed without clustering", async () => {
    await runConnect(cfg, db, { dryRun: false }, deps([]));
    const row = db.listInsights()[0];
    if (row) db.upsertInsight({ ...row, status: "rejected", promotion: "declined" });
    const s = await runConnect(cfg, db, { dryRun: false, reconsider: row?.slug ?? "" }, deps([], { provider: null }));
    expect(s.llmCalls).toBe(0);
    expect(db.listInsights()[0]).toMatchObject({ status: "proposed", promotion: "none" });
    expect(readFileSync(join(vault, "vir", "insights", "rules", `${row?.slug}.md`), "utf8")).toContain("status: proposed");
  });

  it("reconsider refuses an accepted, promoted rule", async () => {
    await runConnect(cfg, db, { dryRun: false }, deps([]));
    const row = db.listInsights()[0];
    if (row) db.upsertInsight({ ...row, status: "accepted", promotion: "promoted" });
    await expect(runConnect(cfg, db, { dryRun: false, reconsider: row?.slug ?? "" }, deps([]))).rejects.toThrow(
      "only a rejected or declined rule can be reconsidered",
    );
    expect(db.listInsights()[0]).toMatchObject({ status: "accepted", promotion: "promoted" });
  });

  it("reconsider clears pending additions", async () => {
    await runConnect(cfg, db, { dryRun: false }, deps([]));
    const row = db.listInsights()[0];
    const pending = [{ sessionId: "s9", citeSlug: "z", project: "", date: "2026-08-01", quote: "q" }];
    if (row) db.upsertInsight({ ...row, status: "rejected", evidenceChanged: true, pending });
    await runConnect(cfg, db, { dryRun: false, reconsider: row?.slug ?? "" }, deps([]));
    expect(db.listInsights()[0]).toMatchObject({ status: "proposed", evidenceChanged: false, pending: null });
  });

  it("reconsider of an unknown slug throws", async () => {
    await expect(runConnect(cfg, db, { dryRun: false, reconsider: "nope" }, deps([]))).rejects.toThrow("no rule with slug nope");
  });
});
