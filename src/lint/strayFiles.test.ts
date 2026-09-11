import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../config.js";
import { StateDb } from "../state/db.js";
import { strayFileCheck } from "./strayFiles.js";

let root: string;
let vault: string;
let db: StateDb;

function cfg(): Config {
  return { vaultPath: vault, outputDir: "vir" } as Config;
}

// A distilled row plus the note file the writer would have produced for it.
function seed(opts: {
  sessionId: string;
  topic: string;
  content?: string | null;
  pruned?: boolean;
}): void {
  const path = `/t/projects/demo/${opts.sessionId}.jsonl`;
  db.record({
    path,
    hash: `h-${opts.sessionId}`,
    skipped: false,
    notePaths: [],
    content: opts.content === undefined ? "body" : opts.content,
    category: "pattern",
    topic: opts.topic,
    project: "demo",
    confidence: 0.9,
    startedAt: "2026-05-01T00:00:00.000Z",
  });
  if (opts.pruned === true) db.markPruned(path, "sidechain-transcript");
}

function writeNote(slug: string): void {
  const dir = join(vault, "vir", "patterns");
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + `/${slug}.md`, `---\ntopic: "x"\n---\n\nbody\n`);
}

describe("strayFileCheck", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "vir-stray-"));
    vault = join(root, "vault");
    db = new StateDb(join(root, "vir.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("finds nothing when every file is backed by a live row", () => {
    seed({ sessionId: "aaaa1111", topic: "first topic" });
    writeNote("first-topic-aaaa1111");

    expect(strayFileCheck(cfg(), db).strays).toEqual([]);
  });

  // The file the writer left behind when the distiller retitled a session
  // before 0.17.3 removed the old path. Its session has a live note under the
  // new title, so the content is not unique.
  it("flags a retitle duplicate and names its live sibling", () => {
    seed({ sessionId: "aaaa1111", topic: "new title" });
    writeNote("new-title-aaaa1111");
    writeNote("old-title-aaaa1111");

    const r = strayFileCheck(cfg(), db);

    expect(r.strays).toHaveLength(1);
    expect(r.strays[0]?.relPath).toContain("old-title-aaaa1111.md");
    expect(r.strays[0]?.kind).toBe("retitle-duplicate");
    expect(r.strays[0]?.liveSibling).toBe("new-title-aaaa1111");
  });

  // The trap that nearly demoted a real note during the live cleanup: a
  // session awaiting `vir reconcile` has an EMPTY content column, but it is a
  // live note and its file on disk is the only copy of that text. Content must
  // not be part of the test.
  it("never flags a note whose row is awaiting reconcile", () => {
    seed({ sessionId: "bbbb2222", topic: "pending topic", content: "" });
    writeNote("pending-topic-bbbb2222");

    expect(strayFileCheck(cfg(), db).strays).toEqual([]);
  });

  it("flags a file with no row at all as unknown, not as a duplicate", () => {
    writeNote("who-knows-cccc3333");

    const r = strayFileCheck(cfg(), db);

    expect(r.strays).toHaveLength(1);
    expect(r.strays[0]?.kind).toBe("unknown");
    expect(r.strays[0]?.liveSibling).toBeNull();
  });

  // A pruned note lives in `.rejected/`, so a file left in a category dir for
  // a pruned session is debris — but it is NOT a retitle duplicate, and saying
  // so would invite deleting the only copy.
  it("classifies a file whose session was pruned as pruned-leftover", () => {
    seed({ sessionId: "dddd4444", topic: "pruned topic", pruned: true });
    writeNote("pruned-topic-dddd4444");

    const r = strayFileCheck(cfg(), db);

    expect(r.strays).toHaveLength(1);
    expect(r.strays[0]?.kind).toBe("pruned-leftover");
  });

  it("ignores .rejected/ and archived/ entirely", () => {
    for (const sub of [".rejected", "archived"]) {
      const dir = join(vault, "vir", sub);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "whatever-eeee5555.md"), "---\n---\nbody\n");
    }

    expect(strayFileCheck(cfg(), db).strays).toEqual([]);
  });
});
