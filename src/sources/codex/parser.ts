import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { buildRawSummary, extractToolResultContent } from "../../pipeline/parser.js";
import { renderToolResult, renderToolUse } from "../../pipeline/toolCallFilter.js";
import type { ParsedSession } from "../../pipeline/types.js";
import { stripCodexInjected } from "./inject.js";

const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;

interface CodexLine {
  timestamp?: unknown;
  type?: unknown;
  payload?: Record<string, unknown>;
}

// Same text/[type] flattening the Claude parser uses for tool results.
function messageText(content: unknown): string {
  return extractToolResultContent(
    Array.isArray(content)
      ? content.map((c) => {
          const b = (c ?? {}) as Record<string, unknown>;
          return typeof b.text === "string" ? { type: "text", text: b.text } : b;
        })
      : content,
  );
}

// renderToolUse needs single-line JSON (TOOL_USE_RE in toolCallFilter).
function toolInputJson(p: Record<string, unknown>): string {
  if (typeof p.arguments === "string") {
    try {
      return JSON.stringify(JSON.parse(p.arguments));
    } catch {
      return JSON.stringify({ arguments: p.arguments });
    }
  }
  return JSON.stringify({ input: typeof p.input === "string" ? p.input : (p.input ?? null) });
}

// Codex rollout → ParsedSession. Reads response_item lines only: event_msg,
// turn_context, token/world-state records and `compacted` (whose
// replacement_history would double-count prose) are skipped on purpose.
export function parseCodexSession(path: string, hash: string, projectSlug?: string): ParsedSession {
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0);
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let entrypoint: string | null = null;
  let isSidechain = false;
  let metaSeen = false;
  let cwd = "";
  let lineCount = 0;
  let toolCallCount = 0;
  const branches: string[] = [];
  const files = new Set<string>();
  const userBlocks: string[] = [];
  const assistantBlocks: string[] = [];
  const parts: string[] = [];
  const toolNameById = new Map<string, string>();

  for (const raw of lines) {
    let evt: CodexLine;
    try {
      evt = JSON.parse(raw) as CodexLine;
    } catch {
      continue;
    }
    if (typeof evt.timestamp === "string") {
      startedAt ??= evt.timestamp;
      endedAt = evt.timestamp;
    }
    const p = evt.payload ?? {};
    if (evt.type === "session_meta") {
      if (metaSeen) continue; // a rollout can repeat session_meta; first wins
      metaSeen = true;
      if (typeof p.cwd === "string") cwd = p.cwd;
      if (typeof p.originator === "string") entrypoint = p.originator;
      if (p.source !== null && typeof p.source === "object") isSidechain = true;
      const branch = (p.git as { branch?: unknown } | undefined)?.branch;
      if (typeof branch === "string" && branch.length > 0 && branch !== "HEAD") branches.push(branch);
      continue;
    }
    if (evt.type !== "response_item") continue;
    lineCount += 1; // the heuristic filter (filter.ts) is calibrated on content lines, not telemetry
    switch (p.type) {
      case "message": {
        const text = messageText(p.content);
        if (p.role === "user") {
          const kept = stripCodexInjected(text);
          if (kept !== null && kept.length > 0) {
            userBlocks.push(kept);
            parts.push(kept);
          }
        } else if (p.role === "assistant" && text.length > 0) {
          assistantBlocks.push(text);
          parts.push(text);
        }
        break; // "developer" = harness instructions, never user knowledge
      }
      case "function_call":
      case "custom_tool_call": {
        const name = typeof p.name === "string" ? p.name : "tool";
        toolCallCount += 1;
        if (typeof p.call_id === "string") toolNameById.set(p.call_id, name);
        const rawInput =
          typeof p.input === "string" ? p.input : typeof p.arguments === "string" ? p.arguments : "";
        for (const m of rawInput.matchAll(PATCH_FILE)) if (m[1]) files.add(m[1].trim());
        parts.push(renderToolUse(name, toolInputJson(p)));
        break;
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        const name = (typeof p.call_id === "string" ? toolNameById.get(p.call_id) : undefined) ?? "tool";
        const out = typeof p.output === "string" ? p.output : extractToolResultContent(p.output);
        parts.push(renderToolResult(name, out, false));
        break;
      }
      default:
        break; // reasoning (encrypted), agent_message, …
    }
  }

  const userText = userBlocks.join("\n\n");
  const assistantText = assistantBlocks.join("\n\n");
  const filesTouched = [...files];
  return {
    path,
    hash,
    sessionId: basename(path, ".jsonl"),
    projectSlug: projectSlug ?? (cwd ? basename(cwd) : basename(path)),
    startedAt,
    endedAt,
    lineCount,
    toolCallCount,
    filesTouched,
    assistantText,
    userText,
    rawSummary: buildRawSummary({ userText, assistantText, toolCallCount, filesTouched }),
    transcriptText: parts.join("\n\n"),
    isSidechain,
    entrypoint,
    branches,
  };
}
