import confirm from "@inquirer/confirm";
import { loadConfig } from "../config.js";
import { runConnect, type ConnectDeps, type ConnectSummary } from "../connect/run.js";
import { computeCost, resolvePricing } from "../cost/pricing.js";
import {
  callLLM,
  maybeAnthropicClient,
  normalizeModelName,
  resolveModelShorthand,
  withRateLimitRetry,
} from "../pipeline/distiller.js";
import { resolveActiveProviderCached } from "../search/provider.js";
import { StateDb } from "../state/db.js";
import * as ui from "../ui/display.js";

const VERIFY_MAX_TOKENS = 1200;

export function formatConnectSummary(
  s: ConnectSummary,
  dryRun: boolean,
  opts: { quota?: boolean } = {},
): string[] {
  const lines = [`${s.lessons} lessons · ${s.clusters} clusters · ${s.candidates} candidates`];
  const skipped: string[] = [];
  if (s.unchanged > 0) skipped.push(`${s.unchanged} unchanged`);
  if (s.skippedRejected > 0) skipped.push(`${s.skippedRejected} previously rejected`);
  if (skipped.length > 0) lines.push(`skipped: ${skipped.join(" · ")}`);
  if (s.deferred > 0) lines.push(`${s.deferred} deferred (connectMaxCandidates)`);
  if (dryRun) {
    const calls = s.candidates - s.deferred;
    lines.push(
      opts.quota === true
        ? `${calls} LLM call(s) on your Claude Code subscription quota`
        : s.estCostUsd === null
        ? `${calls} LLM call(s), cost unknown (no price for this model)`
        : `up to $${s.estCostUsd.toFixed(2)} for ${calls} LLM call(s)`,
    );
    return lines;
  }
  const out: string[] = [`${s.proposed} proposed`, `${s.updated} updated`];
  if (s.additionsFlagged > 0) out.push(`${s.additionsFlagged} accepted rule(s) with new evidence`);
  if (s.unverified > 0) out.push(`${s.unverified} unverified`);
  if (s.llmFailures > 0) out.push(`${s.llmFailures} LLM failure(s)`);
  lines.push(`${s.llmCalls} LLM call(s): ${out.join(" · ")}`);
  if (s.keptRatios.length > 0) lines.push(`kept ${s.keptRatios.map(([k, t]) => `${k}/${t}`).join(", ")}`);
  if (s.proposed + s.updated + s.additionsFlagged > 0) lines.push("review them with: vir review --insights");
  return lines;
}

export async function cmdConnect(opts: { dryRun?: boolean; reconsider?: string; yes?: boolean }): Promise<void> {
  const cfg = loadConfig();
  const db = new StateDb();
  try {
    const client = maybeAnthropicClient(cfg);
    const model = normalizeModelName(resolveModelShorthand(cfg.models.distill), cfg.provider);
    const deps: ConnectDeps = {
      provider: await resolveActiveProviderCached(cfg.embeddingProvider),
      llm: (prompt) =>
        withRateLimitRetry(() =>
          callLLM(cfg, client, { prompt, model, maxTokens: VERIFY_MAX_TOKENS, cost: { stage: "connect" } }),
        ),
      model,
      estimateCostUsd: (inTok, outTok) =>
        cfg.provider === "claude-cli"
          ? 0
          : resolvePricing(cfg.provider, model, cfg.pricing, cfg.kieTopUpTier) === null
            ? null
            : computeCost(cfg.provider, model, inTok, outTok, cfg.pricing, cfg.kieTopUpTier),
      now: () => new Date(),
    };
    ui.header(`connect${opts.dryRun ? "  --dry-run" : ""}`);
    ui.blank();

    if (opts.reconsider !== undefined) {
      await runConnect(cfg, db, { dryRun: false, reconsider: opts.reconsider }, deps);
      ui.row(ui.success(ui.CHECK), ui.text(`${opts.reconsider} is proposed again — vir review --insights`));
      return;
    }

    const preview = await runConnect(cfg, db, { dryRun: true }, deps);
    const quota = cfg.provider === "claude-cli";
    for (const l of formatConnectSummary(preview, true, { quota })) ui.line(ui.text(`  ${l}`));
    if (opts.dryRun || preview.candidates === 0) return;

    if (opts.yes !== true) {
      if (process.stdin.isTTY !== true) {
        throw new Error("vir connect makes paid LLM calls — pass --yes to run it non-interactively");
      }
      const proceed = await confirm({ message: "Run the LLM calls now?", default: false });
      if (!proceed) {
        ui.line(ui.dim("  aborted"));
        return;
      }
    }
    ui.blank();
    const result = await runConnect(cfg, db, { dryRun: false }, deps);
    for (const l of formatConnectSummary(result, false, { quota })) ui.line(ui.text(`  ${l}`));
  } finally {
    db.close();
  }
}
