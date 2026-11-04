import { describe, expect, it } from "vitest";
import { cleanLine, parseJournalLines } from "./events.js";

// Shapes copied from real Claude Code transcripts, with the text replaced.
const AT = "2026-11-04T22:30:00.000Z";
const use = (id: string, name: string, input: object, timestamp = AT): object => ({
  type: "assistant",
  timestamp,
  message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
});
const result = (id: string, content: unknown, extra: object = {}, isError = false, timestamp = AT): object => ({
  type: "user",
  timestamp,
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }],
  },
  ...extra,
});
const parse = (lines: object[]) => parseJournalLines(lines.map((l) => JSON.stringify(l)).join("\n"));

describe("parseJournalLines", () => {
  it("reads TaskCreate and TaskUpdate once their results confirm them", () => {
    const events = parse([
      use("a", "TaskCreate", { subject: "Build parser", description: "x" }),
      result("a", "Task #1 created", { toolUseResult: { task: { id: "1", subject: "Build parser" } } }),
      use("b", "TaskUpdate", { taskId: "1", status: "completed" }),
      result("b", "Updated", { toolUseResult: { success: true, taskId: "1" } }),
    ]);
    expect(events).toEqual([
      { kind: "task_created", at: AT, taskId: "1", subject: "Build parser" },
      { kind: "task_updated", at: AT, taskId: "1", status: "completed" },
    ]);
  });

  it("ignores a call with no result, a failed result and a failed update", () => {
    const events = parse([
      use("a", "TaskCreate", { subject: "never answered" }),
      use("b", "TaskUpdate", { taskId: "1", status: "completed" }),
      result("b", "no such task", {}, true),
      use("c", "TaskUpdate", { taskId: "2", status: "completed" }),
      result("c", "nope", { toolUseResult: { success: false } }),
    ]);
    expect(events).toEqual([]);
  });

  it("takes a commit from git's output, for every branch form", () => {
    const events = parse([
      use("a", "Bash", { command: 'git add . && git commit -m "x"' }),
      result("a", "ignored", {
        toolUseResult: { stdout: "[claude/journal-v1 a1b2c3d] Add parser\n 2 files changed", stderr: "" },
      }),
      use("b", "Bash", { command: "git -C repo commit -m y" }),
      result("b", "[main (root-commit) 1234567] First"),
      use("c", "Bash", { command: "git commit -m z" }),
      result("c", "[detached HEAD 89abcde] Third"),
    ]);
    expect(events.map((e) => (e.kind === "commit" ? [e.branch, e.sha, e.message] : null))).toEqual([
      ["claude/journal-v1", "a1b2c3d", "Add parser"],
      ["main", "1234567", "First"],
      ["detached HEAD", "89abcde", "Third"],
    ]);
  });

  it("does not count a rejected commit or commit-shaped text from another command", () => {
    const events = parse([
      use("a", "Bash", { command: "git commit -m x" }),
      result("a", "nothing to commit, working tree clean"),
      use("b", "Bash", { command: "git commit -m x" }),
      result("b", "[main 1234567] hook failed", {}, true),
      use("c", "Bash", { command: "cat notes.txt" }),
      result("c", "[main 1234567] pasted"),
    ]);
    expect(events).toEqual([]);
  });

  it("diffs TodoWrite snapshots, and a dropped unfinished todo counts as deleted", () => {
    const events = parse([
      use("a", "TodoWrite", { todos: [{ content: "A", status: "in_progress" }, { content: "B", status: "pending" }] }),
      result("a", "ok"),
      use("b", "TodoWrite", { todos: [{ content: "A", status: "completed" }] }),
      result("b", "ok"),
      use("c", "TodoWrite", { todos: [] }),
      result("c", "ok"),
    ]);
    expect(events.map((e) => [e.kind, e.kind === "commit" ? "" : e.kind === "task_updated" ? e.status : e.subject])).toEqual([
      ["task_created", "A"],
      ["task_updated", "in_progress"],
      ["task_created", "B"],
      ["task_updated", "completed"],
      ["task_updated", "deleted"],
    ]);
  });

  it("survives bad lines", () => {
    expect(parseJournalLines('not json\n{"type":"user"}\n{"timestamp":"x","message":{"content":"s"}}')).toEqual([]);
  });

  it("flattens newlines and terminal escapes", () => {
    expect(cleanLine("a\n\u001b[31mb\u001b[0m\tc")).toBe("a b c");
  });
});
