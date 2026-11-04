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

  const applyTodos = (input: Record<string, unknown>, at: string): void => {
    if (!Array.isArray(input.todos)) return;
    const seen = new Set<string>();
    for (const item of input.todos as unknown[]) {
      if (!isRecord(item) || typeof item.content !== "string") continue;
      const subject = cleanLine(item.content);
      const taskId = todoId(subject);
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
        applyTodos(call.input, at);
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
