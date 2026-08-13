import { describe, expect, it } from "vitest";
import { ConfigSchema, type Config } from "../config.js";
import { buildInitConfig, type InitAnswers } from "./initConfig.js";

// ── Schema-enumerated survival guard ─────────────────────────────────────────
// buildInitConfig has silently dropped a config key THREE times (bug #5, the
// projects map, logQueries) — each time because a new schema key wasn't added
// to the carry-over list. This suite enumerates the schema itself, so adding a
// key without deciding its re-init fate fails here by construction:
//   1. A new key MUST get a non-default sample value in SURVIVAL_SAMPLE
//      (the "unknown key" assertion fails until it does).
//   2. Its sampled value MUST survive buildInitConfig with wizard answers
//      that mirror the existing config (the survival assertion fails if the
//      builder forgot to carry it).

// One NON-DEFAULT value per schema key. Non-default matters: a dropped key
// falls back to the zod default, and only a value ≠ default can detect that.
const SURVIVAL_SAMPLE: Record<string, unknown> = {
  vaultPath: "/survival/vault",
  outputDir: "surviva-out",
  topicsDir: "surviva-topics",
  claudeProjectsDir: "/survival/claude",
  cadenceHours: 7,
  provider: "kie",
  anthropicApiKey: "sk-ant-survival",
  kieApiKey: "kie-survival-key",
  kieTopUpTier: "high",
  filterThreshold: 0.77,
  projects: { alpha: "include", beta: "exclude" },
  notifications: false,
  workflowTranscripts: "include",
  agentTranscripts: "include",
  articlesDir: "/survival/articles",
  distillArticles: false,
  pdfsDir: "/survival/pdfs",
  distillPdfs: false,
  filterToolCalls: "aggressive",
  embeddingProvider: "local",
  retrievalDiversity: 0.9,
  logQueries: false,
  models: {
    classify: "claude-haiku-4-5",
    distill: "claude-sonnet-4-6",
    distillFast: "claude-haiku-4-5",
    distillThreshold: 55_000,
  },
  pricing: {
    kie: { "claude-sonnet-4-6": { inputPer1M: 1.23, outputPer1M: 4.56 } },
  },
};

// Keys the wizard ASKS about — their post-init value comes from the answers,
// which this test sets equal to the sample, so equality still holds.
describe("buildInitConfig — every schema key survives re-init (enumerated)", () => {
  const shape = ConfigSchema.innerType().shape;
  const schemaKeys = Object.keys(shape);

  it("every schema key has a non-default survival sample (add one when adding a key)", () => {
    for (const key of schemaKeys) {
      expect(
        SURVIVAL_SAMPLE,
        `new config key "${key}" has no entry in SURVIVAL_SAMPLE — add a NON-DEFAULT sample value AND make buildInitConfig carry it`,
      ).toHaveProperty(key);
    }
    // Stale entries point at renamed/removed keys — keep the table honest.
    for (const key of Object.keys(SURVIVAL_SAMPLE)) {
      expect(schemaKeys, `SURVIVAL_SAMPLE has stale key "${key}"`).toContain(key);
    }
  });

  it("every key's value survives a re-init that mirrors the existing config", () => {
    const existing = ConfigSchema.parse(SURVIVAL_SAMPLE) as Config;
    const sample = SURVIVAL_SAMPLE as Record<string, never>;
    const rebuilt = ConfigSchema.parse(
      buildInitConfig(existing, {
        vaultPath: sample["vaultPath"],
        outputDir: sample["outputDir"],
        claudeProjectsDir: sample["claudeProjectsDir"],
        cadenceHours: sample["cadenceHours"],
        provider: sample["provider"],
        anthropicApiKey: undefined,
        kieApiKey: undefined,
        filterThreshold: sample["filterThreshold"],
        articlesDir: sample["articlesDir"],
        pdfsDir: sample["pdfsDir"],
        classifyModel: existing.models.classify,
        distillModel: existing.models.distill,
        projects: {},
        agentTranscripts: undefined,
      }),
    ) as Config;

    for (const key of schemaKeys) {
      expect(
        (rebuilt as Record<string, unknown>)[key],
        `config key "${key}" did not survive re-init — buildInitConfig must carry it over`,
      ).toEqual((existing as Record<string, unknown>)[key]);
    }
  });
});

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
  logQueries: true,
  projects: {},
  notifications: true,
  workflowTranscripts: "exclude",
  agentTranscripts: "exclude",
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
    projects: {},
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

  it("carries existing project decisions over, wizard answers winning on overlap", () => {
    const existing = {
      ...EXISTING,
      projects: { vir: "include", scratch: "exclude", legacy: "exclude" },
    } as Config;
    const candidate = buildInitConfig(
      existing,
      answers({ projects: { scratch: "include", fresh: "exclude" } }),
    );
    const parsed = ConfigSchema.safeParse(candidate);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.projects).toEqual({
      vir: "include",
      scratch: "include",
      legacy: "exclude",
      fresh: "exclude",
    });
  });

  it("carries workflowTranscripts over on re-init (wizard-silent key)", () => {
    const existing = { ...EXISTING, workflowTranscripts: "include" } as Config;
    const candidate = buildInitConfig(existing, answers());
    const parsed = ConfigSchema.safeParse(candidate);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.workflowTranscripts).toBe("include");
  });

  it("agentTranscripts comes from the wizard answer, falling back to existing", () => {
    const answered = buildInitConfig(
      EXISTING,
      answers({ agentTranscripts: "include" }),
    );
    const p1 = ConfigSchema.safeParse(answered);
    expect(p1.success).toBe(true);
    if (p1.success) expect(p1.data.agentTranscripts).toBe("include");

    const existing = { ...EXISTING, agentTranscripts: "include" } as Config;
    const carried = buildInitConfig(
      existing,
      answers({ agentTranscripts: undefined }),
    );
    const p2 = ConfigSchema.safeParse(carried);
    expect(p2.success).toBe(true);
    if (p2.success) expect(p2.data.agentTranscripts).toBe("include");
  });

  it("carries the notifications flag over on re-init", () => {
    const existing = { ...EXISTING, notifications: false } as Config;
    const candidate = buildInitConfig(existing, answers());
    const parsed = ConfigSchema.safeParse(candidate);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.notifications).toBe(false);
  });
});
