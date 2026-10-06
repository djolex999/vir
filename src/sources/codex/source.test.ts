import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSources } from "../registry.js";
import { createCodexSource, readCodexMeta } from "./source.js";

let dir: string;
let root: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vir-codex-source-"));
  root = join(dir, "sessions");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function rollout(rel: string, meta: Record<string, unknown>, firstLinePad = 0): string {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  const payload: Record<string, unknown> = { id: "x", cwd: "/x", originator: "codex_cli_rs", source: "cli", ...meta };
  if (firstLinePad > 0) payload.base_instructions = "p".repeat(firstLinePad);
  writeFileSync(
    path,
    JSON.stringify({ timestamp: "t", type: "session_meta", payload }) +
      "\n" +
      JSON.stringify({ timestamp: "t", type: "response_item", payload: { type: "message", role: "user", content: [] } }),
  );
  return path;
}

describe("Codex source", () => {
  it("category: object source → sidechain, string or no meta → session", () => {
    const src = createCodexSource(root);
    expect(src.category(rollout("a.jsonl", { source: { subagent: { other: "guardian" } } }))).toBe("sidechain");
    expect(src.category(rollout("b.jsonl", { source: { subagent: { thread_spawn: {} } } }))).toBe("sidechain");
    expect(src.category(rollout("c.jsonl", { source: "vscode" }))).toBe("session");
    expect(src.category(rollout("d.jsonl", { source: "cli" }))).toBe("session");
    const empty = join(root, "e.jsonl");
    writeFileSync(empty, "");
    expect(src.category(empty)).toBe("session");
  });

  // Shape verified 2026-10-07 on codex-cli 0.160.1: `codex exec` writes
  // source "exec", originator "codex_exec".
  it("agentEntrypoint: originator for headless exec, null for humans", () => {
    const src = createCodexSource(root);
    expect(src.agentEntrypoint(rollout("x.jsonl", { source: "exec", originator: "codex_exec" }))).toBe("codex_exec");
    expect(src.agentEntrypoint(rollout("y.jsonl", { source: "vscode", originator: "Codex Desktop" }))).toBeNull();
  });

  it("projectName: scratch chats collapse, worktrees map to the repo, else the leaf", () => {
    const src = createCodexSource(root, { home: "/h" });
    expect(src.projectName(rollout("1.jsonl", { cwd: "/h/Documents/Codex/2026-10-05/referenced-chat" }))).toBe("codex-scratch");
    expect(src.projectName(rollout("2.jsonl", { cwd: "/h/Documents/Codex/2026-10-04/other" }))).toBe("codex-scratch");
    expect(src.projectName(rollout("3.jsonl", { cwd: "/h/projects/growthq" }))).toBe("growthq");
    expect(src.projectName(rollout("4.jsonl", { cwd: "/h/projects/vir/.claude/worktrees/foo-123" }))).toBe("vir");
  });

  it("reads a 200 KB meta line; a 2 MB one yields null and the parent-dir fallback", () => {
    const big = rollout("2026/10/05/big.jsonl", { cwd: "/h/projects/growthq" }, 200_000);
    expect(readCodexMeta(big)?.cwd).toBe("/h/projects/growthq");
    const huge = rollout("2026/10/05/huge.jsonl", { cwd: "/h/projects/growthq" }, 2_000_000);
    expect(readCodexMeta(huge)).toBeNull();
    expect(createCodexSource(root, { home: "/h" }).projectName(huge)).toBe("05");
  });

  it("scan() tags rollouts as codex and never reaches archived_sessions", () => {
    rollout("2026/10/05/rollout-x.jsonl", {});
    const archived = join(dir, "archived_sessions", "rollout-y.jsonl");
    mkdirSync(dirname(archived), { recursive: true });
    writeFileSync(archived, "{}");
    const found = createCodexSource(root).scan();
    expect(found.map((s) => [s.path, s.source])).toEqual([
      [join(root, "2026/10/05/rollout-x.jsonl"), "codex"],
    ]);
  });

  it("buildSources registers Codex when codexSessionsDir is set", () => {
    expect(buildSources({ claudeProjectsDir: "/a", codexSessionsDir: root }).map((s) => s.id)).toEqual([
      "claude-code",
      "codex",
    ]);
  });
});
