import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { renderToolResult, renderToolUse } from "./toolCallFilter.js";
import type { ParsedSession, TranscriptLine } from "./types.js";

const FILE_TOOLS = new Set([
  "Read",
  "Edit",
  "Write",
  "NotebookEdit",
  "MultiEdit",
]);

export function parseSession(path: string, hash: string): ParsedSession {
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);

  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let toolCallCount = 0;
  const filesTouched = new Set<string>();
  const assistantBlocks: string[] = [];
  const userBlocks: string[] = [];
  // Chronological prose + tool blocks for the distill stage.
  const transcriptParts: string[] = [];
  // tool_result blocks carry only a tool_use_id, not the tool name; resolve it
  // from the tool_use we saw earlier in the stream.
  const toolNameById = new Map<string, string>();

  for (const line of lines) {
    let evt: TranscriptLine;
    try {
      evt = JSON.parse(line) as TranscriptLine;
    } catch {
      continue;
    }

    const ts = typeof evt.timestamp === "string" ? evt.timestamp : null;
    if (ts) {
      if (!startedAt) startedAt = ts;
      endedAt = ts;
    }

    const msg = evt.message ?? evt;
    const role = typeof msg.role === "string" ? msg.role : evt.role;
    const content = msg.content ?? evt.content;

    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        const blockType = typeof b.type === "string" ? b.type : null;

        if (blockType === "text" && typeof b.text === "string") {
          if (role === "assistant") assistantBlocks.push(b.text);
          else if (role === "user") userBlocks.push(b.text);
          transcriptParts.push(b.text);
        }

        if (blockType === "tool_use") {
          toolCallCount += 1;
          const toolName = typeof b.name === "string" ? b.name : "";
          const input = (b.input as Record<string, unknown> | undefined) ?? {};
          if (typeof b.id === "string" && toolName)
            toolNameById.set(b.id, toolName);
          if (FILE_TOOLS.has(toolName)) {
            const fp =
              typeof input.file_path === "string"
                ? input.file_path
                : typeof input.path === "string"
                  ? input.path
                  : null;
            if (fp) filesTouched.add(fp);
          }
          transcriptParts.push(
            renderToolUse(toolName || "unknown", safeStringify(input)),
          );
        }

        if (blockType === "tool_result") {
          const id =
            typeof b.tool_use_id === "string" ? b.tool_use_id : undefined;
          const name = (id && toolNameById.get(id)) || "unknown";
          transcriptParts.push(
            renderToolResult(
              name,
              extractToolResultContent(b.content),
              b.is_error === true,
            ),
          );
        }
      }
    } else if (typeof content === "string") {
      if (role === "assistant") assistantBlocks.push(content);
      else if (role === "user") userBlocks.push(content);
    }
  }

  const assistantText = assistantBlocks.join("\n\n");
  const userText = userBlocks.join("\n\n");
  const transcriptText = transcriptParts.join("\n\n");
  const rawSummary = buildRawSummary({
    userText,
    assistantText,
    toolCallCount,
    filesTouched: [...filesTouched],
  });

  return {
    path,
    hash,
    sessionId: basename(path, ".jsonl"),
    projectSlug: basename(dirname(path)),
    startedAt,
    endedAt,
    lineCount: lines.length,
    toolCallCount,
    filesTouched: [...filesTouched],
    assistantText,
    userText,
    rawSummary,
    transcriptText,
  };
}

// tool_use inputs are arbitrary JSON; never let a stringify failure kill a
// whole session parse.
function safeStringify(input: unknown): string {
  try {
    return JSON.stringify(input) ?? "{}";
  } catch {
    return "{}";
  }
}

// A tool_result's content is either a plain string or an array of content
// blocks (text/image/…). Flatten to text; represent non-text blocks compactly.
function extractToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (p.type === "text" && typeof p.text === "string") parts.push(p.text);
    else if (typeof p.type === "string") parts.push(`[${p.type}]`);
  }
  return parts.join("\n");
}

function buildRawSummary(opts: {
  userText: string;
  assistantText: string;
  toolCallCount: number;
  filesTouched: string[];
}): string {
  const userPreview = truncate(opts.userText, 4000);
  const assistantPreview = truncate(opts.assistantText, 8000);
  return [
    `# User messages\n${userPreview}`,
    `# Assistant messages\n${assistantPreview}`,
    `# Tool calls: ${opts.toolCallCount}`,
    `# Files touched (${opts.filesTouched.length}):\n${opts.filesTouched.slice(0, 50).join("\n")}`,
  ].join("\n\n");
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + `\n…[truncated ${s.length - n} chars]`;
}
