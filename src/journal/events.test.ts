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

  describe("the desktop app's update_plan", () => {
    const PLAN = "mcp__ccd_turn__update_plan";
    const text = (t: string): object[] => [{ type: "text", text: t }];
    const steps = (events: ReturnType<typeof parse>) =>
      events.map((e) => [e.kind, e.kind === "commit" ? "" : e.kind === "task_updated" ? e.status : e.subject]);

    it("reads a plan, advance, done/start and the wrap-up that checks off the last step", () => {
      const events = parse([
        use("a", PLAN, {
          scope: "first_task",
          items: [
            { content: "Read code", status: "in_progress" },
            { content: "Fix bug", status: "pending" },
            { content: "Write docs", status: "pending" },
            { content: "Run tests", status: "pending" },
          ],
        }),
        result("a", text("Plan shown (4 steps).")),
        use("b", PLAN, { advance: true }),
        result("b", text("Plan updated: step 2 of 4 is in progress.")),
        use("c", PLAN, { done: [2], start: 4 }),
        result("c", text("Plan updated: step 4 of 4 is in progress.")),
        use("d", "mcp__ccd_turn__wrap_up", { recap: "Fixed." }),
        result("d", text("Shown in the next-step box. Your closing message is your answer.")),
      ]);
      expect(steps(events)).toEqual([
        ["task_created", "Read code"],
        ["task_updated", "in_progress"],
        ["task_created", "Fix bug"],
        ["task_created", "Write docs"],
        ["task_created", "Run tests"],
        ["task_updated", "completed"], // advance: Read code
        ["task_updated", "in_progress"], // advance: Fix bug
        ["task_updated", "completed"], // done [2]: Fix bug
        ["task_updated", "in_progress"], // start 4: Run tests
        ["task_updated", "completed"], // wrap_up: Run tests
      ]);
      // Write docs was never started, so the wrap-up does not mark it done.
      const docs = events.find((e) => e.kind === "task_created" && e.subject === "Write docs");
      const docsId = docs?.kind === "task_created" ? docs.taskId : "";
      expect(events.filter((e) => e.kind === "task_updated" && e.taskId === docsId)).toEqual([]);
    });

    it("a new plan drops unfinished steps of the old one", () => {
      const events = parse([
        use("a", PLAN, { scope: "first_task", items: [{ content: "Old", status: "in_progress" }] }),
        result("a", text("Plan shown (1 steps).")),
        use("b", PLAN, { scope: "new_task", items: [{ content: "New", status: "in_progress" }] }),
        result("b", text("Plan shown (1 steps).")),
      ]);
      expect(steps(events)).toEqual([
        ["task_created", "Old"],
        ["task_updated", "in_progress"],
        ["task_created", "New"],
        ["task_updated", "in_progress"],
        ["task_updated", "deleted"],
      ]);
    });

    it("ignores a refused call, a hook error and a wrap-up with no plan", () => {
      const events = parse([
        use("a", PLAN, { items: [{ content: "No scope", status: "in_progress" }] }),
        result("a", text('items also needs "scope": "first_task", "continuation" or "new_task".')),
        use("b", PLAN, { scope: "first_task", items: [{ content: "Hooked", status: "in_progress" }] }),
        result("b", "PreToolUse:mcp__ccd_turn__update_plan hook error: Not shown", {}, true),
        use("c", "mcp__ccd_turn__wrap_up", { recap: "x" }),
        result("c", text("Nothing is pending, so the app draws no box.")),
        use("d", PLAN, { advance: true }),
        result("d", text("Plan updated: no step is in progress.")),
      ]);
      expect(events).toEqual([]);
    });
  });

  it("survives bad lines", () => {
    expect(parseJournalLines('not json\n{"type":"user"}\n{"timestamp":"x","message":{"content":"s"}}')).toEqual([]);
  });

  it("flattens newlines and terminal escapes", () => {
    expect(cleanLine("a\n\u001b[31mb\u001b[0m\tc")).toBe("a b c");
  });
});
