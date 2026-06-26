import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import type { DistilledRow } from "../state/db.js";
import { StateDb } from "../state/db.js";
import { callLLM } from "./distiller.js";
import {
  buildPeriodPrompt,
  estimatePeriodCostTokens,
  isoWeek,
  periodLabel,
  periodRange,
  periodRelPath,
  periodSlug,
  selectNotesInPeriod,
  summarizePeriod,
  type Period,
} from "./periodSummary.js";

// Stub the LLM so the orchestrator runs end-to-end offline and deterministically.
vi.mock("./distiller.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./distiller.js")>();
  return {
    ...actual,
    callLLM: vi.fn(
      async () =>
        "## Overview\n\nThis week's work centered on the distill pipeline and retrieval.",
    ),
  };
});

const NOW = new Date("2026-06-26T12:00:00Z"); // Friday, ISO 2026-W26

function note(
  startedAt: string | null,
  over: Partial<DistilledRow> = {},
): DistilledRow {
  return {
    path: over.path ?? `/p/${startedAt ?? "null"}-${Math.random()}`,
    sessionId: over.sessionId ?? "sess",
    startedAt,
    category: over.category ?? "pattern",
    topic: over.topic ?? "a topic",
    project: over.project ?? "vir",
    confidence: over.confidence ?? 0.8,
    content: over.content ?? "some durable lesson body",
  };
}

// ── isoWeek ──────────────────────────────────────────────────────────────────

describe("isoWeek", () => {
  it("numbers a mid-year Thursday correctly", () => {
    expect(isoWeek(new Date("2026-06-25T12:00:00Z"))).toEqual({
      weekYear: 2026,
      week: 26,
    });
  });

  it("puts Jan 1 (a Thursday) in week 1 of its own year", () => {
    expect(isoWeek(new Date("2026-01-01T12:00:00Z"))).toEqual({
      weekYear: 2026,
      week: 1,
    });
  });

  it("assigns a late-December date to the next year's W01 when the ISO week spans the boundary", () => {
    // 2025-12-30 (Tue) belongs to the ISO week whose Thursday is 2026-01-01.
    expect(isoWeek(new Date("2025-12-30T12:00:00Z"))).toEqual({
      weekYear: 2026,
      week: 1,
    });
  });

  it("recognizes a 53-week year (2026 starts on a Thursday)", () => {
    expect(isoWeek(new Date("2026-12-31T12:00:00Z"))).toEqual({
      weekYear: 2026,
      week: 53,
    });
    // Jan 1 2027 (Fri) still belongs to 2026-W53.
    expect(isoWeek(new Date("2027-01-01T12:00:00Z"))).toEqual({
      weekYear: 2026,
      week: 53,
    });
  });
});

// ── periodRange ──────────────────────────────────────────────────────────────

describe("periodRange", () => {
  it("week offset 0 spans Monday→next Monday (half-open) of the current ISO week", () => {
    const { start, end } = periodRange({ kind: "week", offset: 0 }, NOW);
    expect(start.toISOString()).toBe("2026-06-22T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-06-29T00:00:00.000Z");
  });

  it("week offset 1 selects the previous ISO week", () => {
    const { start, end } = periodRange({ kind: "week", offset: 1 }, NOW);
    expect(start.toISOString()).toBe("2026-06-15T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-06-22T00:00:00.000Z");
  });

  it("month offset 0 spans the first→first-of-next month", () => {
    const { start, end } = periodRange({ kind: "month", offset: 0 }, NOW);
    expect(start.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("month offset crossing a year boundary resolves to the prior December", () => {
    const { start, end } = periodRange(
      { kind: "month", offset: 1 },
      new Date("2026-01-15T12:00:00Z"),
    );
    expect(start.toISOString()).toBe("2025-12-01T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });
});

// ── periodSlug / periodRelPath ───────────────────────────────────────────────

describe("periodSlug", () => {
  it("builds a zero-padded ISO week slug", () => {
    expect(periodSlug({ kind: "week", offset: 0 }, new Date("2026-06-22T00:00:00Z"))).toBe(
      "week-2026-W26",
    );
  });

  it("zero-pads single-digit weeks", () => {
    expect(periodSlug({ kind: "week", offset: 0 }, new Date("2026-01-01T00:00:00Z"))).toBe(
      "week-2026-W01",
    );
  });

  it("uses the ISO week-year (not the calendar year) at a boundary", () => {
    expect(periodSlug({ kind: "week", offset: 0 }, new Date("2025-12-30T00:00:00Z"))).toBe(
      "week-2026-W01",
    );
  });

  it("builds a zero-padded month slug", () => {
    expect(periodSlug({ kind: "month", offset: 0 }, new Date("2026-06-01T00:00:00Z"))).toBe(
      "month-2026-06",
    );
  });
});

describe("periodRelPath", () => {
  it("files period summaries under summaries/<slug>.md", () => {
    expect(periodRelPath("week-2026-W26")).toBe("summaries/week-2026-W26.md");
    expect(periodRelPath("month-2026-06")).toBe("summaries/month-2026-06.md");
  });
});

// ── periodLabel ──────────────────────────────────────────────────────────────

describe("periodLabel", () => {
  it("renders a human week label with the inclusive date range", () => {
    const range = periodRange({ kind: "week", offset: 0 }, NOW);
    const label = periodLabel({ kind: "week", offset: 0 }, range);
    expect(label).toContain("2026-W26");
    expect(label).toContain("2026-06-22");
    expect(label).toContain("2026-06-28"); // inclusive last day, not the exclusive end
  });

  it("renders a human month label with the inclusive date range", () => {
    const range = periodRange({ kind: "month", offset: 0 }, NOW);
    const label = periodLabel({ kind: "month", offset: 0 }, range);
    expect(label).toContain("2026-06");
    expect(label).toContain("2026-06-01");
    expect(label).toContain("2026-06-30");
  });
});

// ── selectNotesInPeriod (the testable core) ──────────────────────────────────

describe("selectNotesInPeriod", () => {
  const week: Period = { kind: "week", offset: 0 };

  it("includes notes whose date falls inside the half-open window", () => {
    const notes = [
      note("2026-06-23T09:00:00Z"),
      note("2026-06-26T23:00:00Z"),
    ];
    expect(selectNotesInPeriod(notes, week, NOW)).toHaveLength(2);
  });

  it("includes the first instant of the window and excludes the first instant of the next", () => {
    const atStart = note("2026-06-22T00:00:00Z");
    const atEnd = note("2026-06-29T00:00:00Z"); // belongs to the next week
    const justBeforeEnd = note("2026-06-28T23:59:59Z");
    const got = selectNotesInPeriod([atStart, atEnd, justBeforeEnd], week, NOW);
    expect(got).toContain(atStart);
    expect(got).toContain(justBeforeEnd);
    expect(got).not.toContain(atEnd);
  });

  it("excludes notes from the previous week", () => {
    expect(selectNotesInPeriod([note("2026-06-15T12:00:00Z")], week, NOW)).toHaveLength(0);
  });

  it("excludes notes with no date (null startedAt)", () => {
    expect(selectNotesInPeriod([note(null)], week, NOW)).toHaveLength(0);
  });

  it("excludes notes with an unparseable date", () => {
    expect(selectNotesInPeriod([note("not-a-date")], week, NOW)).toHaveLength(0);
  });

  it("returns an empty array for an empty window", () => {
    const notes = [note("2026-01-01T12:00:00Z"), note("2026-12-31T12:00:00Z")];
    expect(selectNotesInPeriod(notes, week, NOW)).toHaveLength(0);
  });

  it("collects notes across a month boundary within one ISO week (W27 spans Jun/Jul)", () => {
    const w27: Period = { kind: "week", offset: 0 };
    const now = new Date("2026-07-01T12:00:00Z"); // ISO 2026-W27: Mon 06-29 → Sun 07-05
    const june = note("2026-06-30T12:00:00Z");
    const july = note("2026-07-02T12:00:00Z");
    const got = selectNotesInPeriod([june, july], w27, now);
    expect(got).toHaveLength(2);
  });

  it("windows by calendar month for month periods", () => {
    const month: Period = { kind: "month", offset: 0 };
    const inJune = note("2026-06-15T12:00:00Z");
    const inMay = note("2026-05-31T23:59:59Z");
    const inJuly = note("2026-07-01T00:00:00Z");
    const got = selectNotesInPeriod([inJune, inMay, inJuly], month, NOW);
    expect(got).toEqual([inJune]);
  });
});

// ── buildPeriodPrompt / estimate ─────────────────────────────────────────────

describe("buildPeriodPrompt", () => {
  it("is period-flavored and lists notes by category", () => {
    const notes = [
      note("2026-06-23T00:00:00Z", { category: "gotcha", topic: "kie 200 body error" }),
    ];
    const counts = { patterns: 0, gotchas: 1, decisions: 0, tools: 0, total: 1 };
    const prompt = buildPeriodPrompt("2026-W26 (2026-06-22 to 2026-06-28)", notes, counts);
    expect(prompt).toContain("period knowledge summary");
    expect(prompt).toContain("Period: 2026-W26");
    expect(prompt).toContain("Total notes: 1");
    expect(prompt).toContain("kie 200 body error");
  });
});

describe("estimatePeriodCostTokens", () => {
  it("estimates input from the prompt length and a fixed output budget", () => {
    const { inputTokens, outputTokens } = estimatePeriodCostTokens("a".repeat(400));
    expect(inputTokens).toBe(100);
    expect(outputTokens).toBeGreaterThan(0);
  });
});

// ── summarizePeriod orchestration (end-to-end, LLM mocked) ────────────────────

describe("summarizePeriod (end-to-end, LLM mocked)", () => {
  let vault: string;
  let db: StateDb;

  function cfg(): Config {
    return {
      vaultPath: vault,
      outputDir: "vir",
      topicsDir: "topics",
      claudeProjectsDir: "/tmp/claude-projects",
      cadenceHours: 3,
      provider: "anthropic",
      anthropicApiKey: "sk-ant-test",
      kieTopUpTier: "standard",
      filterThreshold: 0.4,
      distillArticles: true,
      filterToolCalls: "moderate",
      retrievalDiversity: 0.3,
      models: {
        classify: "claude-haiku-4-5-20251001",
        distill: "claude-sonnet-4-6",
      },
    };
  }

  function record(path: string, startedAt: string, over: Partial<{ category: string; topic: string }> = {}): void {
    db.record({
      path,
      hash: path,
      skipped: false,
      notePaths: [],
      content: "a durable lesson",
      category: over.category ?? "pattern",
      topic: over.topic ?? "topic " + path,
      project: "vir",
      confidence: 0.8,
      startedAt,
    });
  }

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "vir-period-"));
    db = new StateDb(join(vault, "state.db"));
    mkdirSync(join(vault, "vir"), { recursive: true });
  });

  afterEach(() => {
    db.close();
    rmSync(vault, { recursive: true, force: true });
  });

  it("returns null and writes nothing when no notes fall in the window", async () => {
    record("/s/old", "2026-01-05T12:00:00Z");
    const res = await summarizePeriod(cfg(), db, { kind: "week", offset: 0 }, { now: NOW });
    expect(res).toBeNull();
  });

  it("writes a dated summary note with frontmatter for the in-window notes", async () => {
    record("/s/a", "2026-06-23T09:00:00Z", { category: "gotcha", topic: "kie body error" });
    record("/s/b", "2026-06-26T10:00:00Z", { category: "decision", topic: "hybrid routing" });
    record("/s/old", "2026-06-15T10:00:00Z"); // previous week, excluded

    const res = await summarizePeriod(cfg(), db, { kind: "week", offset: 0 }, { now: NOW });
    expect(res).not.toBeNull();
    expect(res!.slug).toBe("week-2026-W26");
    expect(res!.relPath).toBe("summaries/week-2026-W26.md");
    expect(res!.noteCount).toBe(2);

    const file = readFileSync(join(vault, "vir", res!.relPath), "utf8");
    expect(file).toContain("type: summary");
    expect(file).toContain("period: week");
    expect(file).toContain("range_start: 2026-06-22");
    expect(file).toContain("range_end: 2026-06-28");
    expect(file).toContain("note_count: 2");
    expect(file).toContain("This week's work centered on");
  });

  it("prices the synthesis through the callLLM cost chokepoint", async () => {
    record("/s/a", "2026-06-23T09:00:00Z");
    vi.mocked(callLLM).mockClear(); // module-level mock accumulates across tests
    await summarizePeriod(cfg(), db, { kind: "month", offset: 0 }, { now: NOW });
    // The orchestrator must route through callLLM exactly once.
    expect(vi.mocked(callLLM)).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(callLLM).mock.calls[0]!;
    expect(callArgs[2]?.cost?.stage).toContain("summarize");
  });
});
