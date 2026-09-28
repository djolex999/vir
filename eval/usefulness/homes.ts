import { join } from "node:path";
import { StateDb } from "../../src/state/db.js";
import type { ArmSpec } from "../arms.js";
import { prepareHomes } from "../prepareHomes.js";
import { armHome } from "../runArm.js";
import type { RetrievalArm } from "./types.js";

// Both arms are the harness's production baseline (nomic, MMR on); they differ
// only in the DB copy.
export const USEFULNESS_ARM_SPECS: Record<RetrievalArm, ArmSpec> = {
  full: { id: "usefulness-full", provider: "ollama", mmr: true, label: "usefulness: full vault" },
  ablated: { id: "usefulness-ablated", provider: "ollama", mmr: true, label: "usefulness: audit rejects removed" },
};

// Uses the production reject gate, so the ablation hides exactly what
// `vir audit --apply-rejects` would. Only ever called on an arm's DB copy.
export function applyAblation(dbPath: string, sessionIds: readonly string[]): number {
  const db = new StateDb(dbPath);
  try {
    return sessionIds.reduce((n, id) => n + db.markRejected(id), 0);
  } finally {
    db.close();
  }
}

// Fresh copies every run: a stale ablated copy from an earlier reject set
// would silently test the wrong thing.
export async function prepareUsefulnessHomes(rejectIds: readonly string[]): Promise<{ ablatedMarked: number }> {
  await prepareHomes({ arms: [USEFULNESS_ARM_SPECS.full, USEFULNESS_ARM_SPECS.ablated], refresh: true });
  return { ablatedMarked: applyAblation(join(armHome(USEFULNESS_ARM_SPECS.ablated), ".vir", "vir.db"), rejectIds) };
}
