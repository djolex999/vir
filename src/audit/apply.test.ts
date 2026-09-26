import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { restoreRejected } from "../cli/review.js";
import { LockHeldError } from "../pipeline/lock.js";
import { StateDb } from "../state/db.js";
import { applyAuditRejects } from "./apply.js";
import { contentHash } from "./types.js";

const sid = (n: number): string => `abc1234${n}-0000-4000-8000-000000000001`;

describe("applyAuditRejects", () => {
  let root: string;
  let vault: string;
  let db: StateDb;
  let lockPath: string;

  const seed = (n: number, verdict: "keep" | "verify" | "merge" | "reject", project = "vir"): string => {
    const path = `/p/-home-u-${project}/${sid(n)}.jsonl`;
    db.record({
      path, hash: `h${n}`, skipped: false, notePaths: [], content: `body ${n}`,
      category: "gotcha", topic: `topic ${n}`, project, confidence: 0.9,
      startedAt: "2026-05-01T00:00:00.000Z",
    });
    db.recordAudit(path, { verdict, reason: "r", mergeInto: null, contentHash: contentHash(`body ${n}`) });
    const file = join(vault, "gotchas", `topic-${n}-${sid(n).slice(0, 8)}.md`);
    mkdirSync(join(vault, "gotchas"), { recursive: true });
    writeFileSync(file, `---\ntopic: "topic ${n}"\ncategory: gotcha\nsession_id: ${sid(n)}\n---\n\nbody ${n}\n`);
    return file;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "vir-apply-"));
    vault = join(root, "vir");
    lockPath = join(root, "vir.lock");
    db = new StateDb(join(root, "vir.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("moves a fresh reject to .rejected/, stamps who rejected it, and gates the row", () => {
    const file = seed(1, "reject");
    const s = applyAuditRejects(db, vault, { lockPath, now: "2026-09-25T00:00:00.000Z" });

    expect(s).toEqual({ moved: 1, missingFile: 0, collision: 0, verified: 0 });
    expect(existsSync(file)).toBe(false);
    const moved = readFileSync(join(vault, ".rejected", `topic-1-${sid(1).slice(0, 8)}.md`), "utf8");
    expect(moved).toContain("rejected_at: 2026-09-25T00:00:00.000Z");
    expect(moved).toContain("rejected_by: audit");
    expect(db.listDistilled()).toEqual([]);
  });

  // A human's approval (`verified: true` in the note file) outranks a stale-but
  // -fresh model verdict — `vir review` approve writes only the file, never the
  // DB row, so this check must read the file, not the audit table.
  it("skips a fresh reject whose note file is already verified", () => {
    const file = seed(1, "reject");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace("---\n\nbody 1", "verified: true\n---\n\nbody 1"),
    );
    const s = applyAuditRejects(db, vault, { lockPath });

    expect(s).toEqual({ moved: 0, missingFile: 0, collision: 0, verified: 1 });
    expect(existsSync(file)).toBe(true);
    expect(db.listDistilled()).toHaveLength(1);
  });

  // Only rejects are ever acted on; verify and merge need a human.
  it("never touches keep, verify or merge verdicts", () => {
    const files = [seed(1, "keep"), seed(2, "verify"), seed(3, "merge")];
    expect(applyAuditRejects(db, vault, { lockPath }).moved).toBe(0);
    for (const f of files) expect(existsSync(f)).toBe(true);
  });

  // The verdict judged text the note no longer has.
  it("ignores a reject whose verdict went stale", () => {
    const file = seed(1, "reject");
    db.record({ path: `/p/-home-u-vir/${sid(1)}.jsonl`, hash: "h9", skipped: false, notePaths: [], content: "rewritten" });
    expect(applyAuditRejects(db, vault, { lockPath }).moved).toBe(0);
    expect(existsSync(file)).toBe(true);
  });

  it("never overwrites a file already in .rejected/", () => {
    const file = seed(1, "reject");
    mkdirSync(join(vault, ".rejected"), { recursive: true });
    const clash = join(vault, ".rejected", `topic-1-${sid(1).slice(0, 8)}.md`);
    writeFileSync(clash, "earlier\n");

    expect(applyAuditRejects(db, vault, { lockPath })).toEqual({ moved: 0, missingFile: 0, collision: 1, verified: 0 });
    expect(readFileSync(clash, "utf8")).toBe("earlier\n");
    expect(existsSync(file)).toBe(true);
    expect(db.listDistilled()).toHaveLength(1);
  });

  it("counts a reject whose note file is gone, and leaves its row alone", () => {
    const file = seed(1, "reject");
    rmSync(file);
    expect(applyAuditRejects(db, vault, { lockPath })).toEqual({ moved: 0, missingFile: 1, collision: 0, verified: 0 });
    expect(db.listDistilled()).toHaveLength(1);
  });

  // Restoring a machine reject is itself a human verdict: it must stick even
  // if the reject verdict is still sitting fresh in the audits table.
  it("round trip: apply moves a reject, restore brings it back verified, a second apply moves nothing", () => {
    const file = seed(1, "reject");
    const s1 = applyAuditRejects(db, vault, { lockPath });
    expect(s1.moved).toBe(1);

    const dest = restoreRejected(db, vault, basename(file));
    expect(dest).toBe(file);
    const restored = readFileSync(dest, "utf8");
    expect(restored).toContain("verified: true");

    const s2 = applyAuditRejects(db, vault, { lockPath });
    expect(s2).toEqual({ moved: 0, missingFile: 0, collision: 0, verified: 1 });
    expect(existsSync(file)).toBe(true);
  });

  it("honours --project", () => {
    seed(1, "reject", "vir");
    const other = seed(2, "reject", "growthq");
    expect(applyAuditRejects(db, vault, { lockPath, project: "vir" }).moved).toBe(1);
    expect(existsSync(other)).toBe(true);
  });

  // A running `vir run` may be rewriting these notes.
  it("refuses while the pipeline lock is held", () => {
    const file = seed(1, "reject");
    writeFileSync(lockPath, String(process.pid));
    expect(() => applyAuditRejects(db, vault, { lockPath })).toThrow(LockHeldError);
    expect(existsSync(file)).toBe(true);
  });
});
