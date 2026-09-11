import { describe, expect, it } from "vitest";
import { classifyRow, type PruneRow } from "./classify.js";

const PROJECTS = "/home/u/.claude/projects";
const row = (over: Partial<PruneRow> = {}): PruneRow => ({
  path: `${PROJECTS}/-home-u-projects-app/abc12345.jsonl`,
  entrypoint: null,
  isMergeWinner: false,
  ...over,
});

describe("prune classification", () => {
  it("prunes a sidechain transcript from its path alone", () => {
    expect(
      classifyRow(
        row({ path: `${PROJECTS}/-home-u-app/subagents/xyz.jsonl` }),
        PROJECTS,
      ),
    ).toEqual({ action: "prune", reason: "sidechain-transcript" });
  });

  it("prunes a workflow transcript from its path alone", () => {
    expect(
      classifyRow(
        row({ path: `${PROJECTS}/-home-u-app/subagents/wf_123/x.jsonl` }),
        PROJECTS,
      ),
    ).toEqual({ action: "prune", reason: "workflow-transcript" });
  });

  it("prunes a row whose stored entrypoint is an sdk launcher", () => {
    expect(classifyRow(row({ entrypoint: "sdk-py" }), PROJECTS)).toEqual({
      action: "prune",
      reason: "agent-transcript",
    });
  });

  // The C23 serbeval trap, from tasks/lessons.md: promptSource reads "sdk" on
  // a DESKTOP-launched human session. entrypoint is the only safe separator,
  // so the classifier must never consult anything else.
  it("never prunes a desktop-launched human session", () => {
    expect(classifyRow(row({ entrypoint: "claude-desktop" }), PROJECTS)).toEqual({
      action: "keep",
      reason: "human-entrypoint",
    });
  });

  it("never prunes a cli human session", () => {
    expect(classifyRow(row({ entrypoint: "cli" }), PROJECTS)).toEqual({
      action: "keep",
      reason: "human-entrypoint",
    });
  });

  // Turn count would kill these — a single-prompt autonomous run is a human
  // session with one turn. The classifier sees no turn data at all, by design.
  it("never prunes a single-prompt autonomous human run", () => {
    expect(
      classifyRow(
        row({ path: `${PROJECTS}/-home-u-app/single.jsonl`, entrypoint: "cli" }),
        PROJECTS,
      ),
    ).toEqual({ action: "keep", reason: "human-entrypoint" });
  });

  it("reports an unclassifiable row instead of pruning it", () => {
    expect(classifyRow(row(), PROJECTS)).toEqual({
      action: "keep",
      reason: "unclassifiable",
    });
  });

  // Merge parentage is not recorded anywhere, so a winner's sources cannot be
  // shown to be all-agent. Never prune what cannot be shown safe.
  it("never prunes a merge winner, even one on an agent path", () => {
    expect(
      classifyRow(
        row({
          path: `${PROJECTS}/-home-u-app/subagents/x.jsonl`,
          isMergeWinner: true,
        }),
        PROJECTS,
      ),
    ).toEqual({ action: "keep", reason: "merge-winner" });
  });
});
