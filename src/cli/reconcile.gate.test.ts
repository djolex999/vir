import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../config.js";
import { reconcileGate } from "./reconcile.js";

// Rows that errored before vir run's filters existed must not be retried past
// them: reconcile applies the same transcript, agent and project gates.

let dir: string;
const cfg = (over: Partial<Config> = {}): Config =>
  ({
    claudeProjectsDir: dir,
    workflowTranscripts: "exclude",
    agentTranscripts: "exclude",
    projects: { demo: "include", old: "exclude" },
    ...over,
  }) as unknown as Config;

function transcript(rel: string, firstLine = '{"type":"user","message":{"content":"hi"}}'): string {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, firstLine + "\n");
  return p;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vir-gate-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("reconcileGate", () => {
  it("lets an included human session through", () => {
    expect(reconcileGate({ path: transcript("demo/s1.jsonl") }, cfg())).toBeNull();
  });

  it("gates a subagent sidechain and a workflow transcript", () => {
    expect(reconcileGate({ path: transcript("demo/s1/subagents/agent-a1.jsonl") }, cfg())).toEqual({
      reason: "sidechain-transcript",
    });
    expect(
      reconcileGate({ path: transcript("demo/s1/subagents/workflows/wf_1/agent-a1.jsonl") }, cfg()),
    ).toEqual({ reason: "workflow-transcript" });
  });

  it("gates an SDK-launched agent transcript", () => {
    const p = transcript("demo/s2.jsonl", '{"type":"user","entrypoint":"sdk-ts","message":{"content":"x"}}');
    expect(reconcileGate({ path: p }, cfg())).toEqual({ reason: "agent-transcript", entrypoint: "sdk-ts" });
  });

  it("gates excluded and undecided projects", () => {
    expect(reconcileGate({ path: transcript("old/s3.jsonl") }, cfg())).toEqual({ reason: "project-excluded" });
    expect(reconcileGate({ path: transcript("newproj/s4.jsonl") }, cfg())).toEqual({ reason: "project-pending" });
  });

  it("respects the include knobs", () => {
    const p = transcript("demo/s1/subagents/agent-a1.jsonl");
    expect(reconcileGate({ path: p }, cfg({ workflowTranscripts: "include" }))).toBeNull();
  });
});
