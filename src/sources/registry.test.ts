import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { groupByProject } from "../pipeline/projects.js";
import { scanSessions } from "../pipeline/scanner.js";
import { buildSources, groupSessions, resolveSource, scanAll } from "./registry.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vir-src-registry-"));
  for (const [dir, file] of [
    ["-tmp-alpha", "a1.jsonl"],
    ["-tmp-alpha", "a2.jsonl"],
    ["-tmp-beta", "b1.jsonl"],
  ] as const) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, file), `{"type":"user","message":{"role":"user","content":"${file}"}}`);
  }
  mkdirSync(join(root, "-tmp-alpha", "a1", "subagents"), { recursive: true });
  writeFileSync(join(root, "-tmp-alpha", "a1", "subagents", "agent-x.jsonl"), "{}");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("source registry", () => {
  it("builds only the claude source from today's config", () => {
    expect(buildSources({ claudeProjectsDir: root }).map((s) => s.id)).toEqual(["claude-code"]);
  });

  it("groups exactly like groupByProject", () => {
    const srcs = buildSources({ claudeProjectsDir: root });
    const a = groupSessions(scanAll(srcs), srcs);
    const b = groupByProject(scanSessions(root), root);
    const shape = (m: Map<string, { totalBytes: number; sessions: unknown[] }>) =>
      [...m.entries()].map(([k, g]) => [k, g.totalBytes, g.sessions.length]);
    expect(shape(a)).toEqual(shape(b));
  });

  it("resolves an unowned path to fallback semantics instead of throwing", () => {
    const srcs = buildSources({ claudeProjectsDir: "/tmp/vir-test-projects" });
    const s = resolveSource(srcs, "/t/sess.jsonl");
    expect(s.id).toBe("unknown");
    expect(s.category("/t/sess.jsonl")).toBe("session");
    expect(s.projectName("/t/sess.jsonl")).toBe("t");
    expect(s.retentionDays).toBeNull();
  });

  it("names unowned paths the way groupByProject does", () => {
    const srcs = buildSources({ claudeProjectsDir: "/tmp/vir-test-projects" });
    const paths = ["/t/projects/demo/s.jsonl", "/x/-no-such-dir-anywhere/s.jsonl"];
    const sessions = paths.map((path) => ({ path, hash: "h", size: 1 }));
    expect([...groupSessions(sessions, srcs).keys()]).toEqual([
      ...groupByProject(sessions, "/tmp/vir-test-projects").keys(),
    ]);
  });

  it("resolves an owned path to its source", () => {
    const srcs = buildSources({ claudeProjectsDir: root });
    expect(resolveSource(srcs, join(root, "-tmp-beta", "b1.jsonl")).id).toBe("claude-code");
  });
});
