import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClaudeCodeSource } from "./claudeCode.js";

let root: string;

function writeJsonl(path: string, lines: object[]): void {
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vir-src-claude-"));
  const proj = join(root, "-tmp-proj");
  mkdirSync(join(proj, "s1", "subagents"), { recursive: true });
  writeJsonl(join(proj, "s1.jsonl"), [
    { type: "user", entrypoint: "cli", message: { role: "user", content: "hi" } },
  ]);
  writeJsonl(join(proj, "s1", "subagents", "agent-a.jsonl"), [
    { type: "user", isSidechain: true, message: { role: "user", content: "x" } },
  ]);
  writeJsonl(join(proj, "s2.jsonl"), [
    { type: "user", entrypoint: "sdk-py", message: { role: "user", content: "review" } },
  ]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("createClaudeCodeSource", () => {
  it("delegates to the existing Claude Code functions", () => {
    const src = createClaudeCodeSource(root);
    const found = src.scan();
    expect(found).toHaveLength(3);
    expect(new Set(found.map((s) => s.source))).toEqual(new Set(["claude-code"]));
    const sub = found.find((s) => s.path.includes("subagents"));
    expect(sub && src.category(sub.path)).toBe("sidechain");
    expect(src.agentEntrypoint(join(root, "-tmp-proj", "s2.jsonl"))).toBe("sdk-py");
    expect(src.agentEntrypoint(join(root, "-tmp-proj", "s1.jsonl"))).toBeNull();
    expect(src.owns(join(root, "-tmp-proj", "s1.jsonl"))).toBe(true);
    expect(src.owns("/elsewhere/x.jsonl")).toBe(false);
    expect(src.owns(root)).toBe(false);
    expect(src.retentionDays).toBe(30);
  });

  it("decodes each project dir once, not once per session", () => {
    const readDir = vi.fn((_path: string): string[] => []);
    const src = createClaudeCodeSource(root, { readDir });
    src.projectName(join(root, "-tmp-proj", "s1.jsonl"));
    src.projectName(join(root, "-tmp-proj", "s2.jsonl"));
    const calls = readDir.mock.calls.length;
    src.projectName(join(root, "-tmp-proj", "s1", "subagents", "agent-a.jsonl"));
    expect(readDir.mock.calls.length).toBe(calls);
  });
});
