import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../config.js";
import type { Category } from "../pipeline/types.js";
import { StateDb } from "../state/db.js";
import { extractLesson, planUpdates, VIR_END, VIR_START } from "./updater.js";

let home: string;
let prevHome: string | undefined;
let db: StateDb;
const cfg = {} as Config;
const globalPath = (): string => join(home, ".claude", "CLAUDE.md");
const projectPath = (): string => join(home, "projects", "growthq", "CLAUDE.md");

function note(n: number, category: Category, confidence: number, content: string): void {
  db.record({
    path: `/t/growthq-${n}.jsonl`, hash: `h${n}`, skipped: false, notePaths: [],
    content, category, topic: `topic ${n}`, project: "growthq", confidence, startedAt: `2026-01-${String(n).padStart(2, "0")}`,
  });
}

const learned = (point: string): string =>
  `## Summary\nA session.\n\n## What Was Learned\n- ${point}\n- second point\n\n## Context\nx`;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "vir-home-"));
  prevHome = process.env.HOME;
  process.env.HOME = home;
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(globalPath(), "# me\n");
  mkdirSync(join(home, "projects", "growthq"), { recursive: true });
  writeFileSync(projectPath(), "# growthq\n");
  db = new StateDb(join(home, "vir.db"));
});
afterEach(() => {
  db.close();
  process.env.HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe("extractLesson", () => {
  it("takes the bold lead of the first learned point", () => {
    expect(
      extractLesson(learned("**Paddle webhooks must be verified before trusting the tier.** We granted ourselves pro."), "t"),
    ).toBe("Paddle webhooks must be verified before trusting the tier.");
  });

  it("takes the first sentence when the bold lead is only a label", () => {
    expect(extractLesson(learned("**Auth:** refresh tokens rotate on use. Old ones 401."), "t")).toBe(
      "Auth: refresh tokens rotate on use.",
    );
  });

  it("treats a colon or title-case lead as a label and keeps the sentence after it", () => {
    expect(extractLesson(learned("**Gate-field mismatch**: Auth must read the paid source. Details."), "t")).toBe(
      "Gate-field mismatch: Auth must read the paid source.",
    );
    expect(extractLesson(learned("**MIME Validation & Format Handling** Use anchored regexes. More."), "t")).toBe(
      "MIME Validation & Format Handling: Use anchored regexes.",
    );
    expect(extractLesson(learned("**1. Pills decouple display from API values**: — the labels are localized."), "t")).toBe(
      "Pills decouple display from API values: the labels are localized.",
    );
  });

  it("reads a bold paragraph and a numbered point the same as a bullet", () => {
    const paragraph = "## What Was Learned\n\n**Zod 4 toJSONSchema needs io input with transforms**\n\nIt throws otherwise.\n";
    expect(extractLesson(paragraph, "t")).toBe("Zod 4 toJSONSchema needs io input with transforms");
    expect(extractLesson("## What Was Learned\n1. Pin the npm version CI uses. It drifts.\n", "t")).toBe(
      "Pin the npm version CI uses.",
    );
  });

  it("reads bold that opens a running sentence straight through", () => {
    expect(extractLesson(learned("**Never** trust the client's tier value. Verify it."), "t")).toBe(
      "Never trust the client's tier value.",
    );
  });

  it("prefers an early point that reads as a gotcha over background", () => {
    const content = learned("**Codebase structure:** 304 files in a monorepo.").replace(
      "- second point",
      "- **Webhooks must be idempotent before they are retried.**",
    );
    expect(extractLesson(content, "t")).toBe("Webhooks must be idempotent before they are retried.");
  });

  it("does not end a sentence at e.g. and keeps backticks balanced when clipping", () => {
    expect(extractLesson(learned("Use a schema lib, e.g. Zod, before DB writes. More."), "t")).toBe(
      "Use a schema lib, e.g. Zod, before DB writes.",
    );
    const clipped = extractLesson(learned(`**Label**: ${"word ".repeat(36)}\`some.long.code.span.that.runs.past.the.limit()\` end.`), "t");
    expect((clipped.match(/`/g) ?? []).length % 2).toBe(0);
  });

  it("falls back to the Summary, then the topic", () => {
    expect(extractLesson("## Summary\nNext 16 renamed middleware to proxy. More.\n", "t")).toBe(
      "Next 16 renamed middleware to proxy.",
    );
    expect(extractLesson("no sections", "the-topic")).toBe("the-topic");
  });

  it("uses Key Points for article notes", () => {
    expect(extractLesson("## Summary\nx.\n\n## Key Points\n- Removing rules can raise quality.\n", "t")).toBe(
      "Removing rules can raise quality.",
    );
  });

  it("keeps the lesson one line, unmarked and short", () => {
    const lesson = extractLesson(learned(`**Never** trust <!-- VIR:END --> ${"word ".repeat(80)}`), "t");
    expect(lesson).not.toContain("<!--");
    expect(lesson).not.toContain("\n");
    expect(lesson.length).toBeLessThanOrEqual(201);
    expect(lesson.endsWith("…")).toBe(true);
  });
});

describe("VIR block contents", () => {
  it("puts only a project's top gotchas in its CLAUDE.md, as lessons without scores or markers", () => {
    for (let i = 1; i <= 7; i += 1) note(i, "gotcha", 0.9, learned(`**Gotcha number ${i} is a real lesson.**`));
    note(8, "pattern", 0.99, learned("**A pattern that should stay out.**"));

    const block = planUpdates(cfg, db).find((p) => p.target === projectPath())?.newBlock ?? "";

    expect(block).toContain("## Gotchas (from vir)");
    expect(block.match(/^- Gotcha number/gm)).toHaveLength(5);
    // Ties on confidence go to the newest notes.
    expect(block).toContain("- Gotcha number 7 is a real lesson.\n");
    expect(block).not.toContain("Gotcha number 1 is");
    expect(block).not.toContain("pattern that should stay out");
    expect(block).not.toMatch(/conf \d|vir-note/);
    // The pointer lives in the global file only.
    expect(block).not.toContain("vir_query");
  });

  it("keeps project notes out of the global CLAUDE.md, which gets the pointer", () => {
    note(1, "gotcha", 0.95, learned("**Cloudinary ids from the client allow cross-tenant deletes.**"));

    const block = planUpdates(cfg, db).find((p) => p.target === globalPath())?.newBlock ?? "";

    expect(block).not.toContain("Cloudinary");
    expect(block).not.toContain("## Gotchas");
    expect(block).toContain("`vir_query`");
  });

  it("drops duplicate lessons", () => {
    note(1, "gotcha", 0.95, learned("**Same lesson twice over here.**"));
    note(2, "gotcha", 0.95, learned("**Same lesson twice over here.**"));

    const block = planUpdates(cfg, db).find((p) => p.target === projectPath())?.newBlock ?? "";
    expect(block.match(/Same lesson/g)).toHaveLength(1);
  });

  it("shows an old-format block's entries leaving on the first sync", () => {
    writeFileSync(
      globalPath(),
      `# me\n${VIR_START}\n### Gotchas\n- gotcha/old-thing (conf 0.95) — old-thing\n${VIR_END}\n`,
    );
    note(1, "gotcha", 0.95, learned("**Something growthq-only and specific.**"));

    const plan = planUpdates(cfg, db).find((p) => p.target === globalPath());

    expect(plan?.diff.removed).toEqual([{ lesson: "gotcha/old-thing (conf 0.95) — old-thing" }]);
    expect(plan?.diff.added).toEqual([]);
  });

  it("diffs by lesson: a rerun is unchanged, a reworded lesson is one out and one in", () => {
    note(1, "gotcha", 0.95, learned("**First wording of this lesson here.**"));
    const first = planUpdates(cfg, db).find((p) => p.target === projectPath());
    writeFileSync(projectPath(), `# growthq\n${first?.newBlock ?? ""}\n`);

    expect(planUpdates(cfg, db).find((p) => p.target === projectPath())?.diff.unchanged).toHaveLength(1);

    db.updateContent("/t/growthq-1.jsonl", learned("**Second wording of this lesson here.**"));
    const second = planUpdates(cfg, db).find((p) => p.target === projectPath())?.diff;
    expect(second?.added).toEqual([{ lesson: "Second wording of this lesson here." }]);
    expect(second?.removed).toEqual([{ lesson: "First wording of this lesson here." }]);
  });
});
