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
import { StateDb } from "../state/db.js";
import {
  approveNote,
  collectNotes,
  orderForAudit,
  parseFrontmatter,
  rejectNote,
  restoreRejected,
  setFrontmatter,
} from "./review.js";
import { syncRejections } from "../state/rejections.js";

// Build a note file body matching the writer's frontmatter shape. `extra`
// lets a test add review fields (verified, reviewed_at) inline.
function noteContent(
  opts: {
    topic?: string;
    project?: string;
    sessionId?: string;
    date?: string;
    extra?: string[];
  } = {},
): string {
  const {
    topic = "test topic",
    project = "demo",
    sessionId = "abc12345",
    date = "2026-05-01T10:00:00.000Z",
    extra = [],
  } = opts;
  return [
    "---",
    `topic: "${topic}"`,
    "category: pattern",
    `project: "${project}"`,
    `session_id: ${sessionId}`,
    `date: ${date}`,
    "confidence: 0.9",
    ...extra,
    "---",
    "",
    `Project: [[${project}]]`,
    "Category: [[pattern]]",
    "",
    "## Summary",
    "",
    "body text",
    "",
  ].join("\n");
}

describe("review frontmatter helpers", () => {
  it("parses notes that lack the review fields", () => {
    const fm = parseFrontmatter(noteContent());
    expect(fm.topic).toBe("test topic");
    expect(fm.confidence).toBe("0.9");
    expect(fm.verified).toBeUndefined();
    expect(fm.reviewed_at).toBeUndefined();
    expect(fm.rejected_at).toBeUndefined();
  });

  it("setFrontmatter adds new keys before the closing fence and preserves the body", () => {
    const updated = setFrontmatter(noteContent(), {
      verified: "true",
      reviewed_at: "2026-05-24T00:00:00.000Z",
    });
    const fm = parseFrontmatter(updated);
    expect(fm.verified).toBe("true");
    expect(fm.reviewed_at).toBe("2026-05-24T00:00:00.000Z");
    expect(updated).toContain("## Summary");
    expect(updated).toContain("body text");
    // original keys still present and unquoted-date untouched
    expect(fm.confidence).toBe("0.9");
  });

  it("setFrontmatter overwrites an existing key in place", () => {
    const once = setFrontmatter(noteContent(), { verified: "false" });
    const twice = setFrontmatter(once, { verified: "true" });
    expect((twice.match(/verified:/g) ?? []).length).toBe(1);
    expect(parseFrontmatter(twice).verified).toBe("true");
  });
});

describe("review note actions", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "vir-review-"));
    mkdirSync(join(vault, "patterns"), { recursive: true });
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("approve sets verified: true and reviewed_at", () => {
    const p = join(vault, "patterns", "x-abc12345.md");
    writeFileSync(p, noteContent());

    approveNote(p, "2026-05-24T12:00:00.000Z");

    const fm = parseFrontmatter(readFileSync(p, "utf8"));
    expect(fm.verified).toBe("true");
    expect(fm.reviewed_at).toBe("2026-05-24T12:00:00.000Z");
  });

  it("reject moves the file to .rejected/ and stamps rejected_at", () => {
    const p = join(vault, "patterns", "x-abc12345.md");
    writeFileSync(p, noteContent());

    const dest = rejectNote(p, vault, "2026-05-24T12:00:00.000Z");

    expect(existsSync(p)).toBe(false);
    expect(dest).toBe(join(vault, ".rejected", "x-abc12345.md"));
    expect(existsSync(dest)).toBe(true);
    const fm = parseFrontmatter(readFileSync(dest, "utf8"));
    expect(fm.rejected_at).toBe("2026-05-24T12:00:00.000Z");
  });
});

describe("collectNotes filtering", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "vir-review-"));
    mkdirSync(join(vault, "patterns"), { recursive: true });
    mkdirSync(join(vault, "gotchas"), { recursive: true });
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("excludes verified notes by default and includes them with --all", () => {
    writeFileSync(
      join(vault, "patterns", "unreviewed-aaaa1111.md"),
      noteContent({ topic: "unreviewed one", sessionId: "aaaa1111" }),
    );
    writeFileSync(
      join(vault, "gotchas", "approved-bbbb2222.md"),
      noteContent({
        topic: "approved one",
        sessionId: "bbbb2222",
        extra: ["verified: true", "reviewed_at: 2026-05-10T00:00:00.000Z"],
      }),
    );

    const def = collectNotes(vault, {});
    expect(def.map((n) => n.topic)).toEqual(["unreviewed one"]);

    const all = collectNotes(vault, { all: true });
    expect(all.map((n) => n.topic).sort()).toEqual([
      "approved one",
      "unreviewed one",
    ]);
  });

  it("a skipped (untouched) note still appears on the next collect", () => {
    const p = join(vault, "patterns", "skipme-cccc3333.md");
    writeFileSync(p, noteContent({ topic: "skip me", sessionId: "cccc3333" }));

    // skip = no mutation: the note remains unreviewed and reappears.
    expect(collectNotes(vault, {}).map((n) => n.topic)).toContain("skip me");
    expect(collectNotes(vault, {}).map((n) => n.topic)).toContain("skip me");
  });

  it("filters by project slug and honors limit", () => {
    writeFileSync(
      join(vault, "patterns", "a-1111.md"),
      noteContent({ topic: "growthq a", project: "GrowthQ", sessionId: "1111aaaa" }),
    );
    writeFileSync(
      join(vault, "patterns", "b-2222.md"),
      noteContent({ topic: "motorra b", project: "motorra", sessionId: "2222bbbb" }),
    );

    const growthq = collectNotes(vault, { project: "growthq" });
    expect(growthq.map((n) => n.topic)).toEqual(["growthq a"]);

    const limited = collectNotes(vault, { limit: 1 });
    expect(limited.length).toBe(1);
  });
});

describe("rejections reach the database", () => {
  const SID = "abc12345-0000-4000-8000-000000000001";
  let root: string;
  let vault: string;
  let db: StateDb;

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
  const writeRejected = (name: string, content: string): void => {
    mkdirSync(join(vault, ".rejected"), { recursive: true });
    writeFileSync(join(vault, ".rejected", name), content);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "vir-review-db-"));
    vault = join(root, "vir");
    mkdirSync(vault, { recursive: true });
    db = new StateDb(join(root, "vir.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  // The backfill: every note rejected before rejected_at existed (and any file
  // moved by rejectNote since) is found by its stamp and its full session id.
  it("syncRejections marks the row of every stamped note in .rejected/", () => {
    seedRow(SID);
    writeRejected(
      "test-topic-abc12345.md",
      noteContent({ sessionId: SID, extra: ["rejected_at: 2026-09-25T00:00:00.000Z"] }),
    );

    expect(syncRejections(db, vault)).toBe(1);
    expect(db.listDistilled()).toHaveLength(0);
    expect(syncRejections(db, vault)).toBe(0);
  });

  // `vir prune` also moves notes into .rejected/, but it owns its own state
  // (pruned_at) and restore. A file without the review stamp is not ours.
  it("ignores a pruned note that carries no rejected_at", () => {
    seedRow(SID);
    writeRejected(
      "test-topic-abc12345.md",
      noteContent({ sessionId: SID, extra: ["pruned_at: 2026-09-11T00:00:00.000Z"] }),
    );

    expect(syncRejections(db, vault)).toBe(0);
    expect(db.listDistilled()).toHaveLength(1);
  });

  it("restoreRejected moves the note back, unstamps it and clears the row", () => {
    seedRow(SID);
    writeRejected(
      "test-topic-abc12345.md",
      noteContent({ sessionId: SID, extra: ["rejected_at: 2026-09-25T00:00:00.000Z"] }),
    );
    syncRejections(db, vault);

    const dest = restoreRejected(db, vault, "test-topic-abc12345");

    expect(dest).toBe(join(vault, "patterns", "test-topic-abc12345.md"));
    expect(existsSync(join(vault, ".rejected", "test-topic-abc12345.md"))).toBe(false);
    expect(readFileSync(dest, "utf8")).not.toContain("rejected_at");
    expect(db.listDistilled()).toHaveLength(1);
  });

  it("restoreRejected refuses to overwrite a note already at the destination", () => {
    seedRow(SID);
    writeRejected(
      "test-topic-abc12345.md",
      noteContent({ sessionId: SID, extra: ["rejected_at: 2026-09-25T00:00:00.000Z"] }),
    );
    mkdirSync(join(vault, "patterns"), { recursive: true });
    writeFileSync(join(vault, "patterns", "test-topic-abc12345.md"), "live\n");

    expect(() => restoreRejected(db, vault, "test-topic-abc12345.md")).toThrow(
      /already exists/,
    );
    expect(existsSync(join(vault, ".rejected", "test-topic-abc12345.md"))).toBe(true);
  });

  it("restoreRejected names the missing note instead of guessing", () => {
    expect(() => restoreRejected(db, vault, "nope")).toThrow(/nope/);
  });
});

describe("orderForAudit", () => {
  const note = (sessionId: string, date: string) => ({
    filePath: `/v/patterns/${sessionId}.md`,
    relPath: `patterns/${sessionId}.md`,
    topic: sessionId,
    category: "pattern",
    project: "demo",
    confidence: 0.9,
    date,
    verified: false,
    sessionId,
  });
  const audit = (sessionId: string, verdict: "keep" | "verify" | "merge" | "reject", fresh = true) => ({
    path: `/p/x/${sessionId}.jsonl`,
    sessionId,
    verdict,
    reason: "r",
    mergeInto: null,
    auditedAt: "2026-09-25",
    fresh,
  });

  it("walks rejects, then merges, then verifies; keeps and stale verdicts are left out", () => {
    const out = orderForAudit(
      [note("a", "2026-05-01"), note("b", "2026-05-02"), note("c", "2026-05-03"), note("d", "2026-05-04"), note("e", "2026-05-05")],
      [audit("a", "verify"), audit("b", "reject"), audit("c", "keep"), audit("d", "merge"), audit("e", "reject", false)],
    );
    expect(out.map((n) => [n.sessionId, n.audit.verdict])).toEqual([
      ["b", "reject"],
      ["d", "merge"],
      ["a", "verify"],
    ]);
  });

  it("ignores notes with no verdict at all", () => {
    expect(orderForAudit([note("a", "2026-05-01")], [])).toEqual([]);
  });
});
