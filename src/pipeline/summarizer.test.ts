import { describe, expect, it } from "vitest";
import type { DistilledRow } from "../state/db.js";
import {
  buildSummaryPrompt,
  countByCategory,
  type ProjectCounts,
  type SummaryScope,
} from "./summarizer.js";

function row(category: DistilledRow["category"], topic: string, content: string): DistilledRow {
  return {
    path: `/p/${topic}`,
    sessionId: "s",
    startedAt: "2026-06-23T00:00:00Z",
    category,
    topic,
    project: "vir",
    confidence: 0.8,
    content,
  };
}

const PROJECT_SCOPE: SummaryScope = {
  noun: "project",
  heading: "Project: vir\nTotal sessions: 1",
  overviewHint: "what this project is, what stack/approach dominates",
};

describe("buildSummaryPrompt", () => {
  it("reproduces the original project prompt byte-for-byte (refactor lock)", () => {
    const rows = [row("pattern", "foo", "bar baz")];
    const counts: ProjectCounts = {
      patterns: 1,
      gotchas: 0,
      decisions: 0,
      tools: 0,
      total: 1,
    };
    const expected = `You are synthesizing a project knowledge summary from distilled Claude Code session notes.

Project: vir
Total sessions: 1

Patterns (1):
- foo: bar baz

Gotchas (0):
(none)

Decisions (0):
(none)

Tools (0):
(none)

Write a project summary with these exact sections:
## Overview
2-3 sentences: what this project is, what stack/approach dominates

## Key Patterns
Bullet list of the most reusable patterns, 1 sentence each

## Watch Out For
Bullet list of the most important gotchas, 1 sentence each

## Architecture Decisions
Bullet list of significant decisions made, 1 sentence each

## Knowledge Gaps
1-2 sentences: what topics appear underrepresented or missing

Be specific and direct. Use the actual topic names.`;
    expect(buildSummaryPrompt(PROJECT_SCOPE, rows, counts)).toBe(expected);
  });

  it("swaps the scope noun and heading for a non-project scope", () => {
    const counts: ProjectCounts = {
      patterns: 0,
      gotchas: 0,
      decisions: 0,
      tools: 0,
      total: 0,
    };
    const prompt = buildSummaryPrompt(
      { noun: "period", heading: "Period: 2026-W26", overviewHint: "what shipped" },
      [],
      counts,
    );
    expect(prompt).toContain("synthesizing a period knowledge summary");
    expect(prompt).toContain("Period: 2026-W26");
    expect(prompt).toContain("Write a period summary");
    expect(prompt).toContain("2-3 sentences: what shipped");
  });
});

describe("countByCategory", () => {
  it("tallies each category and the total", () => {
    const counts = countByCategory([
      row("pattern", "a", "x"),
      row("gotcha", "b", "y"),
      row("gotcha", "c", "z"),
      row("decision", "d", "w"),
    ]);
    expect(counts).toEqual({ patterns: 1, gotchas: 2, decisions: 1, tools: 0, total: 4 });
  });
});
