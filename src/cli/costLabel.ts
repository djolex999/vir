import type { Config } from "../config.js";
import { computeCost, resolvePricing } from "../cost/pricing.js";
import * as ui from "../ui/display.js";
import { isSubscriptionProvider } from "../pipeline/subscription.js";

// Dollar-estimate label for the ACTIVE provider. On the subscription path the
// honest label is quota, never "$0.00" — a zero would read as "free API call"
// and hide that the run consumes the user's Claude Code limits.
export function estCostLabel(
  cfg: Config,
  model: string,
  inputTokens: number,
  outputTokens: number,
): string {
  if (isSubscriptionProvider(cfg.provider)) return "subscription quota (no $)";
  if (resolvePricing(cfg.provider, model, cfg.pricing, cfg.kieTopUpTier) === null) {
    return `unknown (no price for ${model})`;
  }
  return ui.formatUsd(
    computeCost(
      cfg.provider,
      model,
      inputTokens,
      outputTokens,
      cfg.pricing,
      cfg.kieTopUpTier,
    ),
  );
}
