import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runLessonBackfill } from "../cli/syncClaude.js";
import type { Config } from "../config.js";
import { SubscriptionLimitError } from "../pipeline/subscription.js";
import type { Category } from "../pipeline/types.js";
import { StateDb } from "../state/db.js";
import { backfillLessons, lessonlessGotchas, type LessonSource } from "./backfillLessons.js";
import { planUpdates } from "./updater.js";

let home: string;
let prevHome: string | undefined;
let db: StateDb;
const cfg = { models: { classify: "claude-haiku-5-5" } } as unknown as Config;
const projectPath = (): string => join(home, "projects", "growthq", "CLAUDE.md");
const lockPath = (): string => join(home, "vir.lock");

function note(n: number, opts: { category?: Category; project?: string; lesson?: string | null } = {}): void {
  db.record({
    path: `/t/s-${n}.jsonl`, hash: `h${n}`, skipped: false, notePaths: [],
    content: `## Summary\nA session.\n\n## What Was Learned\n- **Codebase structure:** ${n} files.\n`,
    category: opts.category ?? "gotcha", topic: `topic-${n}`, project: opts.project ?? "growthq",
    confidence: 0.9, startedAt: `2026-01-${String(n).padStart(2, "0")}`, lesson: opts.lesson,
  });
}

const lessonOf = (n: number): string | null | undefined =>
  db.listDistilled().find((r) => r.path === `/t/s-${n}.jsonl`)?.lesson;

function source(answer: (topic: string) => string | null | Error): LessonSource & { topics: string[] } {
  const topics: string[] = [];
  return {
    topics,
    async lesson(_session, _markdown, cls) {
      topics.push(cls.topic);
      const a = answer(cls.topic);
      if (a instanceof Error) throw a;
      return a;
    },
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "vir-backfill-"));
  prevHome = process.env.HOME;
  process.env.HOME = home;
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "CLAUDE.md"), "# me\n");
  mkdirSync(join(home, "projects", "growthq"), { recursive: true });
  writeFileSync(projectPath(), "# growthq\n");
  db = new StateDb(join(home, "vir.db"));
});
afterEach(() => {
  db.close();
  process.env.HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("lessonlessGotchas", () => {
  it("picks gotchas with no lesson yet, in the project asked for", () => {
    note(1);
    note(2, { lesson: "Already has one." });
    note(3, { lesson: "" }); // asked before, model found no rule
    note(4, { category: "pattern" });
    note(5, { project: "other" });

    expect(lessonlessGotchas(db).map((r) => r.topic).sort()).toEqual(["topic-1", "topic-5"]);
    expect(lessonlessGotchas(db, "growthq").map((r) => r.topic)).toEqual(["topic-1"]);
  });
});

describe("backfillLessons", () => {
  it("stores lessons, marks NONE so it isn't asked again, and leaves failures for the next run", async () => {
    note(1);
    note(2);
    note(3);
    const src = source((t) => (t === "topic-1" ? "Pin the npm version CI uses." : t === "topic-2" ? null : new Error("boom")));

    const result = await backfillLessons(db, src, lessonlessGotchas(db));

    expect(result).toEqual({ written: 1, none: 1, failed: 1, stoppedBy: null });
    expect(lessonOf(1)).toBe("Pin the npm version CI uses.");
    expect(lessonOf(2)).toBe("");
    expect(lessonOf(3)).toBeNull();
    expect(lessonlessGotchas(db).map((r) => r.topic)).toEqual(["topic-3"]);
  });

  it("asks with the note's stored title", async () => {
    note(1);
    const src = source(() => "x");
    await backfillLessons(db, src, lessonlessGotchas(db));
    expect(src.topics).toEqual(["topic-1"]);
  });

  it("stops at a subscription limit and leaves the rest untouched", async () => {
    note(1);
    note(2);
    const limit = new SubscriptionLimitError("You've hit your session limit", null);
    const src = source(() => limit);

    const result = await backfillLessons(db, src, lessonlessGotchas(db));

    expect(result.stoppedBy).toBe(limit);
    expect(src.topics).toHaveLength(1);
    expect(lessonOf(1)).toBeNull();
    expect(lessonOf(2)).toBeNull();
  });

  it("the sync that follows uses the backfilled lesson; NONE keeps the extracted line", async () => {
    note(1);
    note(2);
    await backfillLessons(db, source((t) => (t === "topic-1" ? "Backfilled rule for this gotcha." : null)), lessonlessGotchas(db));

    const block = planUpdates(cfg, db).find((p) => p.target === projectPath())?.newBlock ?? "";
    expect(block).toContain("- Backfilled rule for this gotcha.\n");
    expect(block).toContain("- Codebase structure: 2 files.\n");
  });
});

describe("runLessonBackfill", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("makes no call when the owner declines or there is no terminal", async () => {
    note(1);
    const src = source(() => "x");

    await runLessonBackfill(cfg, db, src, { interactive: true, ask: async () => false, lockPath: lockPath() });
    await runLessonBackfill(cfg, db, src, { interactive: false, lockPath: lockPath() });

    expect(src.topics).toEqual([]);
    expect(lessonOf(1)).toBeNull();
  });

  it("asks with the call count, then backfills under the lock", async () => {
    note(1);
    note(2);
    let asked = "";
    const src = source(() => "A rule.");

    await runLessonBackfill(cfg, db, src, {
      interactive: true,
      ask: async (m) => {
        asked = m;
        return true;
      },
      lockPath: lockPath(),
    });

    expect(asked).toContain("2 paid call(s) with claude-haiku-5-5");
    expect(lessonOf(1)).toBe("A rule.");
    expect(lessonOf(2)).toBe("A rule.");
  });

  it("asks nothing when every gotcha already has a lesson", async () => {
    note(1, { lesson: "Done." });
    const ask = vi.fn(async () => true);
    await runLessonBackfill(cfg, db, source(() => "x"), { interactive: true, ask, lockPath: lockPath() });
    expect(ask).not.toHaveBeenCalled();
  });
});
