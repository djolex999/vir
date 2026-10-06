// src/connect/extract.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  archivedDuplicateSlugs, collectLessons, extractLessonTexts, lessonHash, normalizeLesson,
} from "./extract.js";

const NOTE = `---
topic: "x"
category: gotcha
project: "GrowthQ"
session_id: s-1
date: 2026-06-02T10:00:00.000Z
---
Project: [[growthq]]

## Summary

Did a thing.

## What Was Learned

**Next 16 renames middleware** — use proxy.ts.
Continuation line.

- **Bold dash item** — body
  - sub bullet
  - **nested bold is not a new lesson**

1. **Numbered item** — body

Some mid-line **bold** is not an item.

## Related
- [[other]]
`;

describe("extractLessonTexts", () => {
  it("parses all real item shapes and stops at the next heading", () => {
    const items = extractLessonTexts(NOTE);
    expect(items).toHaveLength(3);
    expect(items[0]).toContain("Continuation line.");
    expect(items[1]).toContain("nested bold is not a new lesson");
    expect(items[2]).toContain("Numbered item");
    expect(items[2]).toContain("Some mid-line");
    expect(items.join("\n")).not.toContain("[[other]]");
  });

  it("treats ### subheadings inside the section as group labels, not lesson text", () => {
    const md = "## What Was Learned\n\n### Group A\n\n**First** — one\n\n### Group B\n\n**Second** — two\n";
    const items = extractLessonTexts(md);
    expect(items).toEqual(["**First** — one", "**Second** — two"]);
  });

  it("falls back to the Summary paragraph when the section is missing", () => {
    expect(extractLessonTexts("## Summary\n\nOnly summary.\n\n## Context\nx")).toEqual(["Only summary."]);
  });

  it("returns [] for a note with neither section", () => {
    expect(extractLessonTexts("# Title\nbody")).toEqual([]);
  });
});

describe("normalizeLesson", () => {
  it("makes bold/list formatting irrelevant to the hash", () => {
    const a = normalizeLesson("**Use proxy.ts**   in Next 16");
    const b = normalizeLesson("- __Use proxy.ts__ in Next 16");
    expect(a).toBe("Use proxy.ts in Next 16");
    expect(lessonHash(a)).toBe(lessonHash(b));
  });
});

describe("archivedDuplicateSlugs", () => {
  it("reads the merge-winner section", () => {
    expect(archivedDuplicateSlugs("## Archived Duplicates\n- [[a-1]]\n- [[b-2]]\n\n## X")).toEqual(["a-1", "b-2"]);
  });
});

describe("collectLessons", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "vir-connect-"));
    for (const d of ["gotchas", "patterns", "archived", ".rejected", "insights/rules", "articles"]) {
      mkdirSync(join(root, d), { recursive: true });
    }
    writeFileSync(join(root, "gotchas", "winner-1.md"),
      NOTE + "\n## Archived Duplicates\n- [[loser-2]]\n");
    writeFileSync(join(root, "archived", "loser-2.md"),
      NOTE.replace("s-1", "s-2").replace("2026-06-02", "2026-06-20"));
    writeFileSync(join(root, "archived", "orphan-3.md"), NOTE.replace("s-1", "s-3"));
    writeFileSync(join(root, ".rejected", "rej-4.md"), NOTE.replace("s-1", "s-4"));
    writeFileSync(join(root, "insights", "rules", "r.md"), NOTE.replace("s-1", "s-5"));
    writeFileSync(join(root, "articles", "a.md"), NOTE.replace("s-1", "s-6"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("reads category notes plus linked archived losers, nothing else", () => {
    const lessons = collectLessons(root);
    expect(new Set(lessons.map((l) => l.sessionId))).toEqual(new Set(["s-1", "s-2"]));
    const archived = lessons.filter((l) => l.sessionId === "s-2");
    expect(archived.every((l) => l.archivedVia === "winner-1" && l.citeSlug === "winner-1")).toBe(true);
    expect(lessons.every((l) => l.project === "growthq")).toBe(true);
    expect(new Set(lessons.map((l) => l.id)).size).toBe(lessons.length);
  });
});
