import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSession } from "./parser.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vir-parser-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeSession(lines: object[]): string {
  const path = join(dir, "session.jsonl");
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"));
  return path;
}

describe("parseSession tool block emission", () => {
  it("emits tool_use and tool_result into transcriptText, not prose", () => {
    const path = writeSession([
      {
        type: "assistant",
        timestamp: "2026-05-01T10:00:00.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Let me list the files." },
            {
              type: "tool_use",
              id: "tu_1",
              name: "Bash",
              input: { command: "ls -la" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_1",
              content: "file1.txt\nfile2.txt",
            },
          ],
        },
      },
    ]);

    const parsed = parseSession(path, "hash");

    expect(parsed.toolCallCount).toBe(1);
    expect(parsed.transcriptText).toContain("[tool_use: Bash]");
    expect(parsed.transcriptText).toContain('"command":"ls -la"');
    expect(parsed.transcriptText).toContain("[tool_result: Bash]");
    expect(parsed.transcriptText).toContain("file1.txt");
    expect(parsed.transcriptText).toContain("Let me list the files.");

    // Prose fields (which feed rawSummary + the heuristic filter) stay clean.
    expect(parsed.assistantText).toBe("Let me list the files.");
    expect(parsed.assistantText).not.toContain("[tool_use");
    expect(parsed.userText).not.toContain("[tool_result");
    expect(parsed.rawSummary).not.toContain("[tool_result");
  });

  it("marks errored tool_results and resolves the tool name by id", () => {
    const path = writeSession([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tu_9", name: "Bash", input: {} },
          ],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_9",
              content: "command not found",
              is_error: true,
            },
          ],
        },
      },
    ]);

    const parsed = parseSession(path, "hash");
    expect(parsed.transcriptText).toContain("[tool_result: Bash ERROR]");
    expect(parsed.transcriptText).toContain("command not found");
  });

  it("falls back to 'unknown' when the tool_use_id is unseen", () => {
    const path = writeSession([
      {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "missing", content: "data" },
          ],
        },
      },
    ]);

    const parsed = parseSession(path, "hash");
    expect(parsed.transcriptText).toContain("[tool_result: unknown]");
  });
});
