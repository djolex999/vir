import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { TranscriptLine } from "../pipeline/types.js";

// Journal events: what a transcript proves happened. Everything here is
// deterministic, with no LLM in the path, and an event is only emitted once the
// tool result confirms the call worked. A task nobody confirmed and a commit
// git rejected are not evidence.
export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export type JournalEvent =
  | { kind: "task_created"; at: string; taskId: string; subject: string }
  | {
      kind: "task_updated";
      at: string;
      taskId: string;
      status?: TaskStatus;
      subject?: string;
      addBlockedBy?: string[];
    }
  | { kind: "commit"; at: string; sha: string; branch: string; message: string };

const GIT_COMMIT_RE = /\bgit\b[^\n;&|]*\bcommit\b/;
// `[main a1b2c3d] msg`, `[main (root-commit) a1b2c3d] msg`, `[detached HEAD a1b2c3d] msg`
const COMMIT_OUTPUT_RE = /^\[(.+?)(?: \(root-commit\))? ([0-9a-f]{7,40})\] (.+)$/gm;
const STATUSES = new Set<string>(["pending", "in_progress", "completed", "deleted"]);
// The Claude desktop app's task list. Same snapshot shape as TodoWrite
// (`items` replaces the list), plus step ops on the current list:
// `advance`, `done: [n]`, `start: n`, all 1-based.
const UPDATE_PLAN = "mcp__ccd_turn__update_plan";
// Its wrap-up checks off the step still in progress.
const WRAP_UP = "mcp__ccd_turn__wrap_up";
// A refused call (missing scope, a hook veto) can come back without is_error,
// so a plan op only counts when the result says it took.
const PLAN_OK_RE = /^Plan (shown|updated)\b/;
const WRAP_UP_OK_RE = /^(Shown in the next-step box|Nothing is pending)\b/;

interface PendingCall {
  name: string;
  input: Record<string, unknown>;
}

interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  is_error?: boolean;
  content?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Transcript text ends up in markdown and on a terminal: one line, no escapes.
export function cleanLine(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/[\x00-\x1f\x7f]+/g, " ").trim();
}

function resultText(block: ToolResultBlock): string {
  if (typeof block.content === "string") return block.content;
  if (!Array.isArray(block.content)) return "";
  return block.content
    .map((c: unknown) => (isRecord(c) && typeof c.text === "string" ? c.text : ""))
    .join("\n");
}

function asStatus(v: unknown): TaskStatus | undefined {
  return typeof v === "string" && STATUSES.has(v) ? (v as TaskStatus) : undefined;
}

function todoId(content: string): string {
  return `todo-${createHash("sha256").update(content).digest("hex").slice(0, 8)}`;
}

export function parseJournalLines(raw: string): JournalEvent[] {
  const events: JournalEvent[] = [];
  const pending = new Map<string, PendingCall>();
  // Older Claude Code sends the whole list on every TodoWrite; diff the
  // snapshots into the same events TaskCreate/TaskUpdate produce.
  const todos = new Map<string, { status: TaskStatus }>();
  // update_plan's step numbers index the list as last sent.
  let planOrder: string[] = [];

  const setStatus = (taskId: string | undefined, status: TaskStatus, at: string): void => {
    const t = taskId === undefined ? undefined : todos.get(taskId);
    if (taskId === undefined || !t || t.status === status) return;
    events.push({ kind: "task_updated", at, taskId, status });
    t.status = status;
  };

  // Returns the snapshot's task ids in list order.
  const applyTodos = (list: unknown, at: string): string[] => {
    if (!Array.isArray(list)) return [];
    const order: string[] = [];
    const seen = new Set<string>();
    for (const item of list as unknown[]) {
      if (!isRecord(item) || typeof item.content !== "string") continue;
      const subject = cleanLine(item.content);
      const taskId = todoId(subject);
      order.push(taskId);
      seen.add(taskId);
      const status = asStatus(item.status) ?? "pending";
      const prev = todos.get(taskId);
      if (!prev) {
        events.push({ kind: "task_created", at, taskId, subject });
        if (status !== "pending") events.push({ kind: "task_updated", at, taskId, status });
        todos.set(taskId, { status });
      } else if (prev.status !== status) {
        events.push({ kind: "task_updated", at, taskId, status });
        prev.status = status;
      }
    }
    // Finished items leaving the list are normal. Unfinished ones were dropped.
    for (const [taskId, t] of todos) {
      if (seen.has(taskId) || t.status === "completed" || t.status === "deleted") continue;
      events.push({ kind: "task_updated", at, taskId, status: "deleted" });
      t.status = "deleted";
    }
    return order;
  };

  const inProgress = (): string | undefined =>
    planOrder.find((id) => todos.get(id)?.status === "in_progress");

  const applyPlan = (input: Record<string, unknown>, at: string): void => {
    // A new list replaces the old one; step ops in the same call would index
    // an ambiguous list, so they are not applied.
    if (Array.isArray(input.items)) {
      planOrder = applyTodos(input.items, at);
      return;
    }
    const step = (n: unknown): string | undefined =>
      typeof n === "number" && Number.isInteger(n) && n >= 1 ? planOrder[n - 1] : undefined;
    if (input.advance === true) {
      const current = inProgress();
      setStatus(current, "completed", at);
      const from = current === undefined ? 0 : planOrder.indexOf(current) + 1;
      const next = [...planOrder.slice(from), ...planOrder.slice(0, from)].find(
        (id) => todos.get(id)?.status === "pending",
      );
      setStatus(next, "in_progress", at);
    }
    if (Array.isArray(input.done)) for (const n of input.done as unknown[]) setStatus(step(n), "completed", at);
    if (input.start !== undefined) setStatus(step(input.start), "in_progress", at);
  };

  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    let evt: TranscriptLine;
    try {
      evt = JSON.parse(line) as TranscriptLine;
    } catch {
      continue;
    }
    const at = typeof evt.timestamp === "string" ? evt.timestamp : null;
    const content = evt.message?.content;
    if (at === null || !Array.isArray(content)) continue;

    for (const block of content as unknown[]) {
      if (!isRecord(block)) continue;
      if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        pending.set(block.id, {
          name: block.name,
          input: isRecord(block.input) ? block.input : {},
        });
        continue;
      }
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      const result = block as unknown as ToolResultBlock;
      const call = pending.get(result.tool_use_id);
      if (!call || result.is_error === true) continue;
      pending.delete(result.tool_use_id);
      const extra = isRecord(evt.toolUseResult) ? evt.toolUseResult : {};

      if (call.name === "Bash") {
        const command = call.input.command;
        if (typeof command !== "string" || !GIT_COMMIT_RE.test(command)) continue;
        const stdout = typeof extra.stdout === "string" ? extra.stdout : resultText(result);
        for (const m of stdout.matchAll(COMMIT_OUTPUT_RE)) {
          events.push({
            kind: "commit",
            at,
            branch: cleanLine(m[1] ?? ""),
            sha: m[2] ?? "",
            message: cleanLine(m[3] ?? ""),
          });
        }
      } else if (call.name === "TaskCreate") {
        const task = isRecord(extra.task) ? extra.task : null;
        const id = task?.id;
        const subject = task?.subject ?? call.input.subject;
        if (typeof id !== "string" || typeof subject !== "string") continue;
        events.push({ kind: "task_created", at, taskId: id, subject: cleanLine(subject) });
      } else if (call.name === "TaskUpdate") {
        if (extra.success === false || typeof call.input.taskId !== "string") continue;
        const status = asStatus(call.input.status);
        const subject = call.input.subject;
        const blockers = call.input.addBlockedBy;
        const addBlockedBy = Array.isArray(blockers)
          ? blockers.filter((b): b is string => typeof b === "string")
          : [];
        if (status === undefined && typeof subject !== "string" && addBlockedBy.length === 0) continue;
        events.push({
          kind: "task_updated",
          at,
          taskId: call.input.taskId,
          ...(status !== undefined ? { status } : {}),
          ...(typeof subject === "string" ? { subject: cleanLine(subject) } : {}),
          ...(addBlockedBy.length > 0 ? { addBlockedBy } : {}),
        });
      } else if (call.name === "TodoWrite") {
        applyTodos(call.input.todos, at);
      } else if (call.name === UPDATE_PLAN) {
        if (PLAN_OK_RE.test(resultText(result).trim())) applyPlan(call.input, at);
      } else if (call.name === WRAP_UP) {
        if (WRAP_UP_OK_RE.test(resultText(result).trim())) setStatus(inProgress(), "completed", at);
      }
    }
  }
  return events;
}

// First and last timestamp in the transcript, for session counts per day.
export function sessionBounds(raw: string): { startedAt: string | null; endedAt: string | null } {
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const ts = (JSON.parse(line) as TranscriptLine).timestamp;
      if (typeof ts === "string") {
        startedAt ??= ts;
        endedAt = ts;
      }
    } catch {
      // A truncated last line is normal for a live session.
    }
  }
  return { startedAt, endedAt };
}

export function parseJournalFile(path: string): {
  events: JournalEvent[];
  startedAt: string | null;
  endedAt: string | null;
} {
  const raw = readFileSync(path, "utf8");
  return { events: parseJournalLines(raw), ...sessionBounds(raw) };
}
