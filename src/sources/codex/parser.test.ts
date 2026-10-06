import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCodexSession } from "./parser.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vir-codex-parser-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeSessionAt(name: string, lines: object[]): string {
  const path = join(dir, name);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"));
  return path;
}

describe("parseCodexSession", () => {
  it("maps a rollout to ParsedSession", () => {
    const path = writeSessionAt("rollout-2026-10-05T03-04-02-abc.jsonl", [
      { timestamp: "2026-10-05T01:00:00Z", type: "session_meta", payload: {
        id: "abc", cwd: "/Users/me/projects/growthq", originator: "codex_cli_rs",
        source: "cli", git: { branch: "main", commit_hash: "x" } } },
      { timestamp: "2026-10-05T01:00:00Z", type: "event_msg", payload: { type: "token_count" } },
      { timestamp: "2026-10-05T01:00:01Z", type: "response_item", payload: {
        type: "message", role: "developer", content: [{ type: "input_text", text: "SYSTEM" }] } },
      { timestamp: "2026-10-05T01:00:02Z", type: "response_item", payload: {
        type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>x</environment_context>" }] } },
      { timestamp: "2026-10-05T01:00:03Z", type: "response_item", payload: {
        type: "message", role: "user", content: [
          { type: "input_text", text: "use zod for env parsing" }, { type: "input_image", image_url: "data:" }] } },
      { timestamp: "2026-10-05T01:00:04Z", type: "response_item", payload: {
        type: "custom_tool_call", call_id: "c1", name: "apply_patch",
        input: "*** Begin Patch\n*** Update File: src/env.ts\n@@\n-x\n+y\n*** End Patch" } },
      { timestamp: "2026-10-05T01:00:05Z", type: "response_item", payload: {
        type: "custom_tool_call_output", call_id: "c1", output: "Success" } },
      { timestamp: "2026-10-05T01:00:06Z", type: "response_item", payload: {
        type: "message", role: "assistant", content: [{ type: "output_text", text: "Switched env parsing to zod." }] } },
    ]);
    const p = parseCodexSession(path, "h", "growthq");
    expect(p.sessionId).toBe("rollout-2026-10-05T03-04-02-abc"); // filename, not payload.id
    expect(p.userText).toBe("use zod for env parsing\n[input_image]");
    expect(p.userText).not.toMatch(/environment_context|SYSTEM/);
    expect(p.assistantText).toBe("Switched env parsing to zod.");
    expect(p.rawSummary.startsWith("# User messages\n")).toBe(true);
    expect(p.rawSummary).toContain("# Files touched (1):\nsrc/env.ts");
    expect(p.transcriptText).toContain("use zod for env parsing");
    expect(p.transcriptText).not.toContain("USER:");
    expect(p.transcriptText).toContain("[tool_use: apply_patch]");
    expect(p.toolCallCount).toBe(1);
    expect(p.lineCount).toBe(6); // response_item lines only
    expect(p.entrypoint).toBe("codex_cli_rs");
    expect(p.isSidechain).toBe(false);
    expect(p.branches).toEqual(["main"]);
    expect([p.startedAt, p.endedAt]).toEqual(["2026-10-05T01:00:00Z", "2026-10-05T01:00:06Z"]);
  });

  it("marks subagent and guardian threads as sidechain", () => {
    for (const source of [{ subagent: { other: "guardian" } }, { subagent: { thread_spawn: { depth: 1 } } }]) {
      const path = writeSessionAt("rollout-s.jsonl", [{ timestamp: "t", type: "session_meta",
        payload: { id: "s", cwd: "/x", originator: "Codex Desktop", source } }]);
      expect(parseCodexSession(path, "h").isSidechain).toBe(true);
    }
  });

  it("skips garbage and truncated lines without throwing", () => {
    const path = join(dir, "rollout-z.jsonl");
    writeFileSync(path, '{"type":"session_meta","payload":{"id":"z","cwd":"/x","source":"cli"}}\n{"type":"respo');
    expect(parseCodexSession(path, "h").sessionId).toBe("rollout-z");
  });
});
