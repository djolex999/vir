import { pairedBootstrapCI } from "../metrics/bootstrap.js";
import type { Rng } from "../rng.js";
import type { AnswerScore, GateResult } from "./types.js";

// Frozen in the spec (§7) before any run. Changing one is a spec change.
export const NONINFERIORITY_RECALL = -0.05;
export const MAX_CONTRA_RISE = 0.02;
export const MIN_EXPOSED = 15;
export const MAX_DEGRADED_SHARE = 0.25;
export const BOOTSTRAP_ROUNDS = 2000;

export interface GateInput {
  rejectCount: number;
  probesPass: boolean;
  probeFailures: string[];
  sampledExposed: number;
  excludedDegraded: number;
  pairs: ReadonlyArray<{ full: AnswerScore; ablated: AnswerScore }>;
  rng: Rng;
}

export function computeVerdict(i: GateInput): GateResult {
  const recall = pairedBootstrapCI(i.pairs.map((p) => p.ablated.recall - p.full.recall), BOOTSTRAP_ROUNDS, i.rng);
  const contradiction = pairedBootstrapCI(
    i.pairs.map((p) => p.ablated.contradiction - p.full.contradiction),
    BOOTSTRAP_ROUNDS,
    i.rng,
  );
  const result = (verdict: GateResult["verdict"], reason: string): GateResult => ({
    verdict, reason, n: i.pairs.length, recall, contradiction,
  });
  // Ruling R5: nothing to remove means nothing was tested.
  if (i.rejectCount === 0) return result("NO VERDICT", "no fresh reject verdicts to test");
  if (!i.probesPass) return result("NO VERDICT", `grader unreliable: ${i.probeFailures.join("; ")}`);
  if (i.pairs.length < MIN_EXPOSED) return result("NO VERDICT", `insufficient sample: ${i.pairs.length} < ${MIN_EXPOSED} exposed questions`);
  if (i.sampledExposed > 0 && i.excludedDegraded / i.sampledExposed > MAX_DEGRADED_SHARE) {
    return result("NO VERDICT", `retrieval degraded: ${i.excludedDegraded}/${i.sampledExposed} exposed questions fell back to TF-IDF — is Ollama running?`);
  }
  if (recall.lo <= NONINFERIORITY_RECALL) return result("FAIL", `recall CI lower bound ${recall.lo.toFixed(3)} ≤ ${NONINFERIORITY_RECALL}`);
  if (contradiction.hi > MAX_CONTRA_RISE + 1e-14) return result("FAIL", `contradiction CI upper bound ${contradiction.hi.toFixed(3)} > +${MAX_CONTRA_RISE}`);
  return result("PASS", `recall CI [${recall.lo.toFixed(3)}, ${recall.hi.toFixed(3)}], contradiction CI [${contradiction.lo.toFixed(3)}, ${contradiction.hi.toFixed(3)}]`);
}
