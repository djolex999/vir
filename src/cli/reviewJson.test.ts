import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateDb } from "../state/db.js";
import { contentHash } from "../audit/types.js";
import {
  ReviewJsonError,
  resolveRejectedName,
  resolveReviewTarget,
  reviewQueue,
  runReviewAction,
} from "./reviewJson.js";

const SID = "abc12345-0000-4000-8000-000000000001";
const SID2 = "abc12345-0000-4000-8000-000000000002";

function note(sessionId: string | null, extra: string[] = []): string {
  return [
    "---",
    `topic: "test topic"`,
    "category: pattern",
    `project: "demo"`,
    ...(sessionId ? [`session_id: ${sessionId}`] : []),
    "date: 2026-05-01T10:00:00.000Z",
    "confidence: 0.9",
    ...extra,
    "---",
    "",
    "body text",
    "",
  ].join("\n");
}

function kindOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof ReviewJsonError ? err.kind : `other: ${(err as Error).message}`;
  }
  return "no error";
}

let root: string;
let vault: string;
let db: StateDb;
let lockPath: string;

const write = (rel: string, content: string): void => {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
};
const seedRow = (sessionId: string): void => {
  db.record({
    path: `/p/-home-u-app/${sessionId}.jsonl`,
    hash: "h",
    skipped: false,
    notePaths: [],
    content: "body",
    category: "pattern",
    topic: "test topic",
    project: "demo",
    confidence: 0.9,
    startedAt: "2026-05-01T00:00:00.000Z",
  });
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vir-review-json-"));
  vault = join(root, "vir");
  mkdirSync(vault, { recursive: true });
  db = new StateDb(join(root, "vir.db"));
  lockPath = join(root, "vir.lock");
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("resolveReviewTarget", () => {
  it("accepts a session note in a category dir", () => {
    write("patterns/test-topic-abc12345.md", note(SID));
    expect(resolveReviewTarget(vault, "patterns/test-topic-abc12345.md")).toEqual({
      absPath: join(vault, "patterns/test-topic-abc12345.md"),
      relPath: "patterns/test-topic-abc12345.md",
      sessionId: SID,
    });
  });

  it("accepts a filename with spaces and a leading dash", () => {
    write("gotchas/-odd name.md", note(SID));
    expect(resolveReviewTarget(vault, "gotchas/-odd name.md").relPath).toBe("gotchas/-odd name.md");
  });

  it("rejects paths outside the reviewable category dirs", () => {
    write("topics/t.md", note(SID));
    write("articles/a.md", note(SID));
    for (const bad of ["../x.md", "/etc/passwd", "topics/t.md", "articles/a.md", "patterns/x.txt", "patterns/sub/x.md", ".rejected/x.md"]) {
      expect(kindOf(() => resolveReviewTarget(vault, bad))).toBe("invalid_args");
    }
  });

  it("reports a missing note as not_found", () => {
    expect(kindOf(() => resolveReviewTarget(vault, "patterns/missing.md"))).toBe("not_found");
  });

  it("refuses a note without a session_id", () => {
    write("patterns/no-session.md", note(null));
    expect(kindOf(() => resolveReviewTarget(vault, "patterns/no-session.md"))).toBe("invalid_args");
  });
});

describe("resolveRejectedName", () => {
  it("accepts a name with or without .md", () => {
    write(".rejected/test-topic-abc12345.md", note(SID));
    expect(resolveRejectedName(vault, "test-topic-abc12345")).toBe("test-topic-abc12345.md");
    expect(resolveRejectedName(vault, "test-topic-abc12345.md")).toBe("test-topic-abc12345.md");
  });
  it("refuses anything with a directory part", () => {
    expect(kindOf(() => resolveRejectedName(vault, "../patterns/x.md"))).toBe("invalid_args");
  });
  it("reports a missing rejected note as not_found", () => {
    expect(kindOf(() => resolveRejectedName(vault, "nope"))).toBe("not_found");
  });
});

describe("runReviewAction", () => {
  const NOW = "2026-09-28T12:00:00.000Z";

  it("approve stamps verified, returns the path, releases the lock", () => {
    write("patterns/test-topic-abc12345.md", note(SID));
    const res = runReviewAction({ vaultRoot: vault, db, lockPath, now: NOW }, "approve", "patterns/test-topic-abc12345.md");
    expect(res).toEqual({ action: "approve", path: "patterns/test-topic-abc12345.md", sessionId: SID });
    const after = readFileSync(join(vault, "patterns/test-topic-abc12345.md"), "utf8");
    expect(after).toContain("verified: true");
    expect(after).toContain(`reviewed_at: ${NOW}`);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("approving twice keeps a single verified line", () => {
    write("patterns/test-topic-abc12345.md", note(SID));
    const deps = { vaultRoot: vault, db, lockPath, now: NOW };
    runReviewAction(deps, "approve", "patterns/test-topic-abc12345.md");
    runReviewAction(deps, "approve", "patterns/test-topic-abc12345.md");
    const after = readFileSync(join(vault, "patterns/test-topic-abc12345.md"), "utf8");
    expect(after.match(/^verified:/gm)).toHaveLength(1);
  });

  it("reject moves the note and stops the row serving immediately", () => {
    seedRow(SID);
    write("patterns/test-topic-abc12345.md", note(SID));
    const res = runReviewAction({ vaultRoot: vault, db, lockPath, now: NOW }, "reject", "patterns/test-topic-abc12345.md");
    expect(res).toEqual({ action: "reject", path: ".rejected/test-topic-abc12345.md", sessionId: SID });
    expect(existsSync(join(vault, "patterns/test-topic-abc12345.md"))).toBe(false);
    expect(db.listDistilled()).toHaveLength(0);
  });

  it("restore puts a human reject back unreviewed and serving", () => {
    seedRow(SID);
    write("patterns/test-topic-abc12345.md", note(SID));
    const deps = { vaultRoot: vault, db, lockPath, now: NOW };
    runReviewAction(deps, "reject", "patterns/test-topic-abc12345.md");
    const res = runReviewAction(deps, "restore", "test-topic-abc12345.md");
    expect(res).toEqual({ action: "restore", path: "patterns/test-topic-abc12345.md", sessionId: SID });
    const after = readFileSync(join(vault, "patterns/test-topic-abc12345.md"), "utf8");
    expect(after).not.toContain("verified:");
    expect(after).not.toContain("rejected_at:");
    expect(db.listDistilled()).toHaveLength(1);
  });

  it("restore refuses to overwrite a recreated note and leaves both files", () => {
    write(".rejected/test-topic-abc12345.md", note(SID, ["rejected_at: 2026-09-01T00:00:00.000Z"]));
    write("patterns/test-topic-abc12345.md", note(SID));
    expect(kindOf(() => runReviewAction({ vaultRoot: vault, db, lockPath }, "restore", "test-topic-abc12345.md"))).toMatch(/^other: .*already exists/);
    expect(existsSync(join(vault, ".rejected/test-topic-abc12345.md"))).toBe(true);
  });

  it("fails busy without touching the note when the lock is held", () => {
    write("patterns/test-topic-abc12345.md", note(SID));
    writeFileSync(lockPath, String(process.pid)); // a live pid holds it
    expect(kindOf(() => runReviewAction({ vaultRoot: vault, db, lockPath }, "approve", "patterns/test-topic-abc12345.md"))).toBe("busy");
    expect(readFileSync(join(vault, "patterns/test-topic-abc12345.md"), "utf8")).not.toContain("verified:");
  });

  it("reports a bad path as invalid_args even while the lock is held", () => {
    writeFileSync(lockPath, String(process.pid));
    expect(kindOf(() => runReviewAction({ vaultRoot: vault, db, lockPath }, "approve", "../x.md"))).toBe("invalid_args");
  });
});

describe("reviewQueue", () => {
  it("lists fresh flagged notes worst first with counts", () => {
    seedRow(SID);
    seedRow(SID2);
    write("patterns/a-abc12345.md", note(SID));
    write("gotchas/b-abc12345.md", note(SID2).replace("category: pattern", "category: gotcha"));
    const hash = contentHash("body");
    db.recordAudit(`/p/-home-u-app/${SID}.jsonl`, { verdict: "verify", reason: "polish", mergeInto: null, contentHash: hash });
    db.recordAudit(`/p/-home-u-app/${SID2}.jsonl`, { verdict: "reject", reason: "noise", mergeInto: null, contentHash: hash });
    const q = reviewQueue(vault, db);
    expect(q.items.map((i) => [i.path, i.verdict, i.reason])).toEqual([
      ["gotchas/b-abc12345.md", "reject", "noise"],
      ["patterns/a-abc12345.md", "verify", "polish"],
    ]);
    expect(q.counts).toEqual({ unaudited: 0, stale: 0 });
  });
});
