import type { Config } from "../config.js";

export interface InitAnswers {
  vaultPath: string;
  outputDir: string;
  claudeProjectsDir: string;
  cadenceHours: number;
  provider: "anthropic" | "kie";
  anthropicApiKey: string | undefined;
  kieApiKey: string | undefined;
  filterThreshold: number;
  articlesDir: string | undefined;
  pdfsDir: string | undefined;
  classifyModel: string;
  distillModel: string;
}

// Assembles the candidate config a re-run of `vir init` hands to
// ConfigSchema.safeParse. Every existing key the wizard doesn't ask about
// must be carried over from `existing` — anything omitted here gets zod's
// default and is silently PERSISTED by saveConfig, destroying user config.
export function buildInitConfig(
  existing: Config | null,
  a: InitAnswers,
): Record<string, unknown> {
  return {
    vaultPath: a.vaultPath,
    outputDir: a.outputDir,
    claudeProjectsDir: a.claudeProjectsDir,
    cadenceHours: a.cadenceHours,
    provider: a.provider,
    // The wizard only asks for the ACTIVE provider's key — the other one must
    // survive a re-init so switching back later doesn't require re-entering it.
    anthropicApiKey: a.anthropicApiKey ?? existing?.anthropicApiKey,
    kieApiKey: a.kieApiKey ?? existing?.kieApiKey,
    kieTopUpTier: existing?.kieTopUpTier,
    topicsDir: existing?.topicsDir,
    pricing: existing?.pricing,
    filterThreshold: a.filterThreshold,
    articlesDir: a.articlesDir,
    distillArticles: existing?.distillArticles,
    pdfsDir: a.pdfsDir,
    distillPdfs: existing?.distillPdfs,
    filterToolCalls: existing?.filterToolCalls,
    retrievalDiversity: existing?.retrievalDiversity,
    models: {
      classify: a.classifyModel,
      distill: a.distillModel,
      // New installs get hybrid routing out of the box: route routine sessions
      // to Haiku, keep the chosen distill model for decision/large ones.
      distillFast:
        existing?.models?.distillFast ??
        (a.provider === "anthropic"
          ? "claude-haiku-4-5-20251001"
          : "claude-haiku-4-5"),
      ...(existing?.models?.distillThreshold != null
        ? { distillThreshold: existing.models.distillThreshold }
        : {}),
    },
  };
}
