import { CONFIG_VERSION, expandHome } from "../src/config.js";
import type { ArmSpec } from "./arms.js";

const SECRET_KEYS = ["anthropicApiKey", "kieApiKey"] as const;
// Paths the child resolves relative to ITS home unless they are already
// absolute. The parent expands them against the real home before copying.
const PATH_KEYS = ["vaultPath", "claudeProjectsDir", "articlesDir", "pdfsDir"] as const;

// Pure: the arm's config.json as a plain object. Secrets are stripped (arms
// never call an LLM; `claude-cli` is the only provider value the schema
// accepts without a key), paths are made absolute against the parent's home
// (the child's HOME is the arm dir, so `~/Vir` would resolve to nothing),
// and the query log is off so an arm can never write telemetry anywhere.
// The MMR arms measure the setting production shipped through 0.26 (0.3), a
// constant: copying the live value would silently turn them into non-MMR arms
// once a config is migrated to 0.27.0's default of 0.
export const MMR_ARM_DIVERSITY = 0.3;

export function buildArmConfig(raw: Record<string, unknown>, arm: ArmSpec): Record<string, unknown> {
  const cfg: Record<string, unknown> = { ...raw };
  for (const k of SECRET_KEYS) delete cfg[k];
  for (const k of PATH_KEYS) {
    const v = cfg[k];
    if (typeof v === "string") cfg[k] = expandHome(v);
  }
  cfg["provider"] = "claude-cli";
  cfg["embeddingProvider"] = arm.provider;
  cfg["retrievalDiversity"] = arm.mmr ? MMR_ARM_DIVERSITY : 0;
  // Already current: the child's loadConfig must not migrate the arm's value.
  cfg["configVersion"] = CONFIG_VERSION;
  cfg["logQueries"] = false;
  return cfg;
}
