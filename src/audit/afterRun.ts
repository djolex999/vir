import { SubscriptionLimitError } from "../pipeline/subscription.js";
import type { StateDb } from "../state/db.js";
import { runGround, type GroundDeps, type GroundSummary } from "./ground.js";

// The daemon's transcript check: after a distill pass, check up to `perRun`
// notes against their transcripts, oldest first, so no note ages past the
// agent's transcript retention unchecked. Runs inside the pass's pipeline lock.

export interface AfterRunConfig {
  checkTranscripts?: boolean;
  checkTranscriptsPerRun?: number;
}

export const DEFAULT_CHECKS_PER_RUN = 20;

export type AfterRunOutcome =
  | { kind: "off" }
  | { kind: "checked"; summary: GroundSummary }
  | { kind: "stopped"; reason: string };

export async function checkTranscriptsAfterRun(
  cfg: AfterRunConfig,
  db: StateDb,
  deps: GroundDeps & { log: (msg: string) => void },
): Promise<AfterRunOutcome> {
  if (cfg.checkTranscripts !== true) return { kind: "off" };
  let summary: GroundSummary;
  try {
    summary = await runGround(db, { limit: cfg.checkTranscriptsPerRun ?? DEFAULT_CHECKS_PER_RUN }, deps);
  } catch (err) {
    // An optional step after a finished distill pass: a quota halt or a failed
    // call is logged and retried next pass, never turned into a failed run.
    const reason =
      err instanceof SubscriptionLimitError
        ? `subscription limit: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    deps.log(`transcript check stopped: ${reason}`);
    return { kind: "stopped", reason };
  }
  if (summary.checked > 0 || summary.failed > 0) {
    deps.log(
      `transcript check: ${summary.checked} checked, ${summary.contradicted} contradicted ` +
        `(${summary.flagged} sent to review), ${summary.unbacked} unbacked, ${summary.failed} failed`,
    );
  }
  return { kind: "checked", summary };
}
