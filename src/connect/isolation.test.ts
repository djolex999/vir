import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectNotes } from "../cli/review.js";
import type { Config } from "../config.js";
import { orphanCheck } from "../lint/linter.js";
import { strayFileCheck } from "../lint/strayFiles.js";
import { StateDb } from "../state/db.js";
import { INSIGHTS_RULES_DIR, writeInsightFile } from "./insightFile.js";
import { sampleInsight } from "./testFixtures.js";

// Every pass that walks or reads the vault must ignore insights/: a rule must
// never be reviewed as a note, flagged as a stray, linked as an orphan, or
// enter the DB-driven passes (dedupe, audit, prune, summarize, sync-claude).
let dir: string;
let root: string;
let db: StateDb;
let cfg: Config;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vir-isolation-"));
  root = join(dir, "vault", "vir");
  mkdirSync(join(root, "gotchas"), { recursive: true });
  writeFileSync(
    join(root, "gotchas", "real-note-abcd1234.md"),
    "---\ntopic: real\ncategory: gotcha\nsession_id: abcd1234\n---\n## Summary\n\nx\n",
  );
  db = new StateDb(join(dir, "vir.db"));
  const row = sampleInsight({ status: "accepted" });
  db.upsertInsight(row);
  writeInsightFile(root, row);
  cfg = { vaultPath: join(dir, "vault"), outputDir: "vir", topicsDir: "topics" } as unknown as Config;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("other passes ignore insights/", () => {
  it("vir review never lists a rule as a note", () => {
    const notes = collectNotes(root, { all: true });
    expect(notes.map((n) => n.relPath)).toEqual(["gotchas/real-note-abcd1234.md"]);
    expect(notes.some((n) => n.filePath.includes(INSIGHTS_RULES_DIR))).toBe(false);
  });

  it("stray-file lint never scans or flags a rule", () => {
    const r = strayFileCheck(cfg, db);
    expect(r.strays.some((s) => JSON.stringify(s).includes("insights"))).toBe(false);
    expect(r.scanned).toBe(1);
  });

  it("orphan lint never reports a rule", () => {
    expect(orphanCheck(cfg).orphans.some((o) => o.includes("insights"))).toBe(false);
  });

  it("DB-driven passes never see a rule as a distilled note", () => {
    expect(db.listDistilled()).toEqual([]);
    expect(db.listAllNoteRows()).toEqual([]);
  });
});
