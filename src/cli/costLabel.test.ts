import { describe, expect, it } from "vitest";
import type { Config } from "../config.js";
import { estCostLabel } from "./costLabel.js";

const cfg = (provider: Config["provider"]): Config =>
  ({ provider, kieTopUpTier: "standard" }) as unknown as Config;

describe("estCostLabel", () => {
  it("says unknown for a model the provider has no price for", () => {
    expect(estCostLabel(cfg("kie"), "claude-sonnet-5", 1000, 100)).toBe("unknown (no price for claude-sonnet-5)");
  });

  it("formats a priced model in dollars", () => {
    expect(estCostLabel(cfg("kie"), "claude-haiku-4-5", 1_000_000, 0)).toBe("$0.280");
  });

  it("claude-cli is quota, not dollars", () => {
    expect(estCostLabel(cfg("claude-cli"), "claude-sonnet-5", 1000, 100)).toBe("subscription quota (no $)");
  });
});
