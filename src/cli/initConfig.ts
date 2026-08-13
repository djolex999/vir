import type { Config } from "../config.js";

export interface InitAnswers {
  vaultPath: string;
  outputDir: string;
  claudeProjectsDir: string;
  cadenceHours: number;
  provider: "anthropic" | "kie" | "claude-cli";
  anthropicApiKey: string | undefined;
  kieApiKey: string | undefined;
  filterThreshold: number;
  articlesDir: string | undefined;
  pdfsDir: string | undefined;
  classifyModel: string;
  distillModel: string;
  // Decisions from the wizard's project multi-select. Merged OVER existing
  // decisions — projects the wizard didn't show stay as they were.
  projects: Record<string, "include" | "exclude">;
  // The wizard's agent-transcript question; undefined (scan failed, question
  // skipped) falls back to the existing setting, then the schema default.
  agentTranscripts?: "exclude" | "include";
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
    // Caught by the schema-enumerated survival test — the FOURTH silently
    // dropped key (after bug #5, projects, logQueries). Never carried since
    // 0.15.0: a configured embedding provider was reset to auto-detect on
    // every re-init.
    embeddingProvider: existing?.embeddingProvider,
    // Wizard-silent key (0.16.0): without this carry-over a re-init would
    // silently reset a user's logQueries:false back to the zod default.
    logQueries: existing?.logQueries,
    projects: { ...existing?.projects, ...a.projects },
    notifications: existing?.notifications,
    workflowTranscripts: existing?.workflowTranscripts,
    agentTranscripts: a.agentTranscripts ?? existing?.agentTranscripts,
    models: {
      classify: a.classifyModel,
      distill: a.distillModel,
      // New installs get hybrid routing out of the box: route routine sessions
      // to Haiku, keep the chosen distill model for decision/large ones.
      // claude-cli shares the anthropic id set (full ids pin via --model).
      distillFast:
        existing?.models?.distillFast ??
        (a.provider === "kie"
          ? "claude-haiku-4-5"
          : "claude-haiku-4-5-20251001"),
      ...(existing?.models?.distillThreshold != null
        ? { distillThreshold: existing.models.distillThreshold }
        : {}),
    },
  };
}
