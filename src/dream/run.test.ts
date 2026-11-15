import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contentHash } from "../audit/types.js";
import { StateDb } from "../state/db.js";
import { dreamProject, projectPagePath, type DreamDeps } from "./run.js";

const sid = (n: number): string => `abc1234${n}-0000-4000-8000-000000000001`;
const pathOf = (n: number): string => `/p/-home-u-vir/${sid(n)}.jsonl`;

describe("dreamProject", () => {
  let dir: string;
  let db: StateDb;
  let cfg: { vaultPath: string; outputDir: string };
  let prompts: string[];

  const seed = (n: number, content: string): void => {
    db.record({
      path: pathOf(n),
      hash: `h${n}`,
      skipped: false,
      notePaths: [],
      content,
      category: "gotcha",
      topic: `topic ${n}`,
      project: "vir",
      confidence: 0.9,
      startedAt: `2026-10-0${n}T00:00:00.000Z`,
    });
  };
  // Notes are numbered newest first, so [1] is note 5.
  const good = '{"overview":"o","sections":[{"heading":"H","entries":[{"claim":"c","source":1,"quote":"body five","kind":"rule"}]}]}';
  const deps = (reply = good): DreamDeps => ({
    llm: async (p) => {
      prompts.push(p);
      return reply;
    },
    isVerified: () => false,
    usage: new Map(),
    now: () => "2026-11-16T10:00:00.000Z",
  });
  const opts = { model: "claude-sonnet-5", minNotes: 5 };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vir-dream-"));
    db = new StateDb(join(dir, "vir.db"));
    cfg = { vaultPath: dir, outputDir: "vir" };
    prompts = [];
    // Realistic size: the page may be at most 0.35x its sources.
    const pad = " filler".repeat(150);
    for (let n = 1; n <= 5; n += 1) seed(n, `body ${["one", "two", "three", "four", "five"][n - 1]}${pad}`);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the page and reports stats", async () => {
    const out = await dreamProject(cfg, db, "vir", deps(), opts);
    expect(out).toMatchObject({ kind: "written" });
    const page = readFileSync(projectPagePath(cfg, "vir"), "utf8");
    expect(page).toContain("kind: dream");
    expect(page).toContain("[[gotchas/topic-5-abc12345]]");
    if (out.kind === "written") expect(out.stats.kept).toBe(1);
  });

  it("skips without calling the model when the input is unchanged", async () => {
    await dreamProject(cfg, db, "vir", deps(), opts);
    const again = await dreamProject(cfg, db, "vir", deps(), opts);
    expect(again.kind).toBe("unchanged");
    expect(prompts).toHaveLength(1);
  });

  it("--force reruns", async () => {
    await dreamProject(cfg, db, "vir", deps(), opts);
    const again = await dreamProject(cfg, db, "vir", deps(), { ...opts, force: true });
    expect(again.kind).toBe("written");
    expect(prompts).toHaveLength(2);
  });

  it("reports too few notes", async () => {
    const out = await dreamProject(cfg, db, "vir", deps(), { ...opts, minNotes: 6 });
    expect(out).toEqual({ kind: "too-few", notes: 5 });
    expect(prompts).toHaveLength(0);
  });

  it("a bad reply writes nothing", async () => {
    const file = projectPagePath(cfg, "vir");
    mkdirSync(join(dir, "vir", "projects"), { recursive: true });
    writeFileSync(file, "old page");
    const out = await dreamProject(cfg, db, "vir", deps("no json here"), opts);
    expect(out.kind).toBe("failed");
    expect(readFileSync(file, "utf8")).toBe("old page");
  });

  it("writes nothing when every entry fails the quote check", async () => {
    const bad = '{"overview":"o","sections":[{"heading":"H","entries":[{"claim":"c","source":1,"quote":"invented","kind":"rule"}]}]}';
    const out = await dreamProject(cfg, db, "vir", deps(bad), opts);
    expect(out.kind).toBe("failed");
    expect(existsSync(projectPagePath(cfg, "vir"))).toBe(false);
  });

  it("flagged notes never reach the prompt", async () => {
    seed(6, "secret contradicted body");
    db.recordGround(pathOf(6), { verdict: "contradicted", reason: "x", contentHash: contentHash("secret contradicted body") });
    await dreamProject(cfg, db, "vir", deps(), opts);
    expect(prompts[0]).not.toContain("secret contradicted body");
    expect(prompts[0]).toContain("body two");
  });
});
