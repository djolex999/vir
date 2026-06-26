export type Provider = "anthropic" | "kie";

// Kie high-tier top-ups grant +10% bonus credits, so effective pricing is ~10%
// below the posted rates — a per-user adjustment, NOT a change to the canonical
// posted table. 'standard' leaves rates untouched.
export type TopUpTier = "standard" | "high";

// Effective discount for the high tier: +10% bonus credits ⇒ pay ~0.9× posted.
const KIE_HIGH_TIER_MULTIPLIER = 0.9;

export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

export type PricingOverrides = Partial<Record<Provider, Record<string, Partial<ModelPricing>>>>;

// USD per 1M tokens. Anthropic = public list rates (stable, track them).
// Kie = published-discount estimate ≈ 28% of Anthropic; APPROXIMATE and may
// drift — add a `// TODO(pricing): refresh against https://kie.ai/pricing` comment
// so the next maintainer knows to verify.
// TODO(pricing): refresh against https://kie.ai/pricing
export const DEFAULT_PRICING: Record<Provider, Record<string, ModelPricing>> = {
  anthropic: {
    "claude-haiku-4-5-20251001": { inputPer1M: 1.0,  outputPer1M: 5.0  },
    "claude-sonnet-4-6":         { inputPer1M: 3.0,  outputPer1M: 15.0 },
  },
  kie: {
    "claude-haiku-4-5-20251001": { inputPer1M: 0.28, outputPer1M: 1.4  },
    "claude-sonnet-4-6":         { inputPer1M: 0.84, outputPer1M: 4.2  },
  },
};

function findTableKey(table: Record<string, ModelPricing>, model: string): string | undefined {
  if (model in table) return model;
  for (const k of Object.keys(table)) {
    if (k.startsWith(model) || model.startsWith(k)) return k;
  }
  return undefined;
}

function findOverrideKey(
  table: Record<string, Partial<ModelPricing>>,
  model: string
): string | undefined {
  if (model in table) return model;
  for (const k of Object.keys(table)) {
    if (k.startsWith(model) || model.startsWith(k)) return k;
  }
  return undefined;
}

export function resolvePricing(
  provider: Provider,
  model: string,
  overrides?: PricingOverrides,
  tier: TopUpTier = "standard"
): ModelPricing | null {
  const table = DEFAULT_PRICING[provider];
  const baseKey = findTableKey(table, model);
  if (baseKey === undefined) return null;

  // Non-null assertion is safe: baseKey came from Object.keys(table)
  const base: ModelPricing = { ...table[baseKey]! };

  // Apply the high-tier discount to the POSTED base before any override patch,
  // so an explicit config.pricing override (most-specific) overwrites — and thus
  // beats — the tier multiplier. DEFAULT_PRICING itself stays canonical.
  if (provider === "kie" && tier === "high") {
    base.inputPer1M *= KIE_HIGH_TIER_MULTIPLIER;
    base.outputPer1M *= KIE_HIGH_TIER_MULTIPLIER;
  }

  const providerOverrides = overrides?.[provider];
  if (providerOverrides !== undefined) {
    const overrideKey = findOverrideKey(providerOverrides, model);
    if (overrideKey !== undefined) {
      const patch = providerOverrides[overrideKey]!;
      if (patch.inputPer1M  !== undefined) base.inputPer1M  = patch.inputPer1M;
      if (patch.outputPer1M !== undefined) base.outputPer1M = patch.outputPer1M;
    }
  }

  return base;
}

export function computeCost(
  provider: Provider,
  model: string,
  inputTokens: number,
  outputTokens: number,
  overrides?: PricingOverrides,
  tier: TopUpTier = "standard"
): number {
  const pricing = resolvePricing(provider, model, overrides, tier);
  if (pricing === null) return 0;
  return (inputTokens / 1e6) * pricing.inputPer1M + (outputTokens / 1e6) * pricing.outputPer1M;
}
