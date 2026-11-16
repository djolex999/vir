import { noteIsVerified, parseLimitOption } from "../audit/run.js";
import { loadConfig, type Config } from "../config.js";
import { dreamProject, planDream, type DreamOutcome } from "../dream/run.js";
import {
  callLLM,
  maybeAnthropicClient,
  normalizeModelName,
  resolveModelShorthand,
  withRateLimitRetry,
} from "../pipeline/distiller.js";
import { kebab } from "../pipeline/slug.js";
import { buildNoteUsage } from "../search/noteUsage.js";
import { readQueryLog } from "../search/queryLog.js";
import { vaultRoot } from "../search/retriever.js";
import { StateDb, type DistilledRow } from "../state/db.js";
import * as ui from "../ui/display.js";
import { estCostLabel } from "./costLabel.js";
import { confirmPaidStep, withPipelineLock } from "./guards.js";

// `vir dream`: rebuild a project's reference page from its notes. Estimate
// first, confirm, then one model call per project that changed.

const PROMPT_OVERHEAD_TOKENS = 600;
const OUTPUT_TOKENS = 3000;

export function dreamTargets(rows: DistilledRow[], project: string | undefined, all: boolean): string[] {
  if (project !== undefined) return [kebab(project)];
  if (!all) return [];
  return [...new Set(rows.map((r) => kebab(r.project)).filter((s) => s.length > 0))].sort();
}

function dreamLlm(cfg: Config, model: string): (prompt: string) => Promise<string> {
  const client = maybeAnthropicClient(cfg);
  return (prompt) =>
    withRateLimitRetry(() => callLLM(cfg, client, { prompt, model, maxTokens: 8000, cost: { stage: "dream" } }));
}

function fail(message: string): void {
  ui.header("dream");
  ui.blank();
  ui.row(ui.errorColor(ui.CROSS), ui.text(message));
  process.exitCode = 1;
}

function outcomeLine(slug: string, o: DreamOutcome): void {
  switch (o.kind) {
    case "written": {
      const s = o.stats;
      const detail = `${s.kept} entries (${s.confirmed} confirmed), ${s.dropped} dropped, coverage ${Math.round(s.coverage * 100)}%, ratio ${s.ratio.toFixed(2)}`;
      const conflicts = o.conflicts > 0 ? `, ${o.conflicts} conflict(s) under Needs review` : "";
      ui.row(ui.success(ui.CHECK), ui.text(`${slug}: ${detail}${conflicts}`));
      return;
    }
    case "unchanged":
      ui.row(ui.muted("·"), ui.dim(`${slug}: unchanged since the last dream`));
      return;
    case "too-few":
      ui.row(ui.muted("·"), ui.dim(`${slug}: only ${o.notes} note(s), skipped`));
      return;
    case "failed":
      ui.row(ui.errorColor(ui.CROSS), ui.text(`${slug}: ${o.reason}`));
  }
}

export async function dreamCommand(
  project: string | undefined,
  opts: { all?: boolean; dryRun?: boolean; yes?: boolean; model?: string; force?: boolean; minNotes?: string },
): Promise<void> {
  if (project === undefined && opts.all !== true) return fail("usage: vir dream <project> | --all");
  if (opts.model !== undefined && !["haiku", "sonnet"].includes(opts.model)) {
    return fail(`--model must be haiku or sonnet, got "${opts.model}"`);
  }
  const minNotes = parseLimitOption(opts.minNotes);
  if (minNotes === null) return fail(`--min-notes must be a positive integer, got "${opts.minNotes}"`);

  const cfg = loadConfig();
  const model = normalizeModelName(resolveModelShorthand(opts.model ?? cfg.models.distill), cfg.provider);
  const db = new StateDb();
  try {
    const root = vaultRoot(cfg);
    const deps = { isVerified: (r: DistilledRow) => noteIsVerified(root, r), usage: buildNoteUsage(readQueryLog()) };
    const runOpts = { force: opts.force, minNotes, model };
    const targets = dreamTargets(db.listDistilled(), project, opts.all === true);

    const plans = targets.map((slug) => ({ slug, plan: planDream(cfg, db, slug, deps, runOpts) }));
    const toRun = plans.filter((p) => p.plan.skip === null);
    const inputTokens = toRun.reduce(
      (n, p) => n + PROMPT_OVERHEAD_TOKENS + p.plan.selection.notes.reduce((c, x) => c + Math.ceil(x.text.length / 4), 0),
      0,
    );
    const estCost = estCostLabel(cfg, model, inputTokens, toRun.length * OUTPUT_TOKENS);

    ui.header("dream");
    ui.blank();
    for (const { slug, plan } of plans) {
      const flagged = plan.selection.excludedFlagged > 0 ? `, ${plan.selection.excludedFlagged} flagged left out` : "";
      if (plan.skip !== null) outcomeLine(slug, plan.skip);
      else ui.row(ui.info("•"), ui.text(`${slug}: ${plan.selection.notes.length} notes${flagged}`));
    }
    ui.summary({
      projects: { value: toRun.length, color: ui.info },
      model: { value: model, color: ui.accent },
      "est. cost": { value: estCost, color: ui.warn },
    });
    ui.divider();
    if (toRun.length === 0) {
      ui.row(ui.success(ui.CHECK), ui.text("nothing to dream"));
      return;
    }
    if (opts.dryRun) {
      ui.line(ui.dim("  dry run — no model calls made"));
      return;
    }
    // No TTY (a script, cron, the old `vir summarize` callers): skip with a
    // note instead of hanging on a prompt. --yes runs it.
    const proceed = await confirmPaidStep(`rebuild ${toRun.length} project page(s) with ${model} (~${estCost})`, {
      yes: opts.yes,
    });
    if (!proceed) return;

    const llm = dreamLlm(cfg, model);
    await withPipelineLock(async () => {
      for (const { slug } of toRun) {
        const sp = ui.spinner(`dreaming ${slug}`).start();
        let outcome: DreamOutcome;
        try {
          outcome = await dreamProject(cfg, db, slug, { ...deps, llm }, runOpts);
        } catch (err) {
          outcome = { kind: "failed", reason: (err as Error).message };
        }
        sp.stop();
        outcomeLine(slug, outcome);
        if (outcome.kind === "failed") process.exitCode = 1;
      }
    });
    ui.line(ui.dim("  notes were not changed — conflicts are listed on each page under Needs review"));
  } finally {
    db.close();
  }
}
