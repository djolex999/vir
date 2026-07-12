import { describe, expect, it } from "vitest";
import { ConfigSchema, type Config } from "../config.js";
import { buildInitConfig, type InitAnswers } from "./initConfig.js";

const EXISTING: Config = {
  vaultPath: "/vault",
  outputDir: "vir",
  topicsDir: "concepts",
  claudeProjectsDir: "/claude",
  cadenceHours: 4,
  provider: "kie",
  anthropicApiKey: "sk-ant-existing-key",
  kieApiKey: "kie-existing-key",
  kieTopUpTier: "high",
  filterThreshold: 0.4,
  distillArticles: true,
  distillPdfs: true,
  filterToolCalls: "moderate",
  retrievalDiversity: 0.3,
  pricing: {
    kie: { "claude-sonnet-4-6": { inputPer1M: 1, outputPer1M: 5 } },
  },
  models: {
    classify: "claude-haiku-4-5",
    distill: "claude-sonnet-4-6",
  },
} as Config;

function answers(over: Partial<InitAnswers> = {}): InitAnswers {
  return {
    vaultPath: "/vault",
    outputDir: "vir",
    claudeProjectsDir: "/claude",
    cadenceHours: 4,
    provider: "kie",
    anthropicApiKey: undefined,
    kieApiKey: "kie-new-key",
    filterThreshold: 0.4,
    articlesDir: undefined,
    pdfsDir: undefined,
    classifyModel: "claude-haiku-4-5",
    distillModel: "claude-sonnet-4-6",
    ...over,
  };
}

describe("buildInitConfig preserves wizard-silent keys", () => {
  it("re-running init keeps kieTopUpTier, topicsDir, and pricing", () => {
    const candidate = buildInitConfig(EXISTING, answers());
    const parsed = ConfigSchema.safeParse(candidate);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.kieTopUpTier).toBe("high");
    expect(parsed.data.topicsDir).toBe("concepts");
    expect(parsed.data.pricing).toEqual(EXISTING.pricing);
  });

  it("choosing one provider keeps the other provider's saved key", () => {
    const kie = buildInitConfig(EXISTING, answers({ provider: "kie" }));
    expect((kie as { anthropicApiKey?: string }).anthropicApiKey).toBe(
      "sk-ant-existing-key",
    );

    const anthropic = buildInitConfig(
      EXISTING,
      answers({
        provider: "anthropic",
        anthropicApiKey: "sk-ant-new-key",
        kieApiKey: undefined,
      }),
    );
    expect((anthropic as { kieApiKey?: string }).kieApiKey).toBe(
      "kie-existing-key",
    );
  });
});
