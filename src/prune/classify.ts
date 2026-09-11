import { classifyTranscript } from "../pipeline/projects.js";

// Why a row is being demoted. These mirror the forward-only skip reasons
// 0.14.0 introduced, so the vault tells one story about agent transcripts
// whether they were filtered at scan time or pruned afterwards.
export type PruneReason =
  | "workflow-transcript"
  | "sidechain-transcript"
  | "agent-transcript";

// Why a row survives. `unclassifiable` and `merge-winner` are reported, never
// acted on — they are the two buckets where the evidence does not exist.
export type KeepReason = "human-entrypoint" | "unclassifiable" | "merge-winner";

export type PruneDecision =
  | { action: "prune"; reason: PruneReason }
  | { action: "keep"; reason: KeepReason };

export interface PruneRow {
  path: string;
  entrypoint: string | null;
  // The note carries an "## Archived Duplicates" section, i.e. `vir dedupe`
  // merged at least one other note into it.
  isMergeWinner: boolean;
}

// Decide one row. Pure and zero-I/O: 396 of 411 distilled transcripts are
// already deleted from disk (Claude Code prunes at ~30 days), so any rule that
// needs to READ the transcript can decide almost nothing. Everything here comes
// from the stored path and the stored entrypoint.
export function classifyRow(row: PruneRow, projectsDir: string): PruneDecision {
  // A merge winner's sources are not recorded anywhere, so it can never be
  // SHOWN to be all-agent. Checked first: it outranks every prune signal.
  if (row.isMergeWinner) return { action: "keep", reason: "merge-winner" };

  // entrypoint is the only trustworthy launcher signal (lessons.md: promptSource
  // reads "sdk" on desktop-launched human sessions, and turn count kills
  // single-prompt autonomous runs). A known non-sdk launcher is a human.
  if (row.entrypoint !== null) {
    return row.entrypoint.startsWith("sdk")
      ? { action: "prune", reason: "agent-transcript" }
      : { action: "keep", reason: "human-entrypoint" };
  }

  const structural = classifyTranscript(row.path, projectsDir);
  if (structural === "workflow")
    return { action: "prune", reason: "workflow-transcript" };
  if (structural === "sidechain")
    return { action: "prune", reason: "sidechain-transcript" };

  // Null entrypoint, ordinary path, transcript long gone: no evidence either
  // way. 241 of 411 live rows land here. Reported, never pruned.
  return { action: "keep", reason: "unclassifiable" };
}
