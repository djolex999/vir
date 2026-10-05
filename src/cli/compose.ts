import confirm from "@inquirer/confirm";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import {
  normalizeModelName,
  resolveModelShorthand,
} from "../pipeline/distiller.js";
import {
  composeFromSources,
  estimateComposeCostTokens,
  gatherSources,
} from "../pipeline/composer.js";
import { StateDb } from "../state/db.js";
import { readCostLog } from "../cost/log.js";
import * as ui from "../ui/display.js";
import { estCostLabel } from "./costLabel.js";
import { VaultWriter } from "../pipeline/writer.js";
import { withPipelineLock } from "./guards.js";

export async function composeCommand(
  topic: string,
  opts: {
    limit?: string;
    model?: string;
    dryRun?: boolean;
    yes?: boolean;
  },

): Promise<void> {
  // Writes notes and the DB: hold the lock (a dry run only reads).
  const run = async (): Promise<void> => {
    const cfg = loadConfig();
    if (opts.model && !["haiku", "sonnet"].includes(opts.model)) {
      console.error(
        chalk.red(`--model must be 'haiku' or 'sonnet', got '${opts.model}'`),
      );
      process.exitCode = 1;
      return;
    }
    const limit = Math.min(
      50,
      Math.max(1, Number.parseInt(opts.limit ?? "20", 10) || 20),
    );
    const db = new StateDb();
    try {
      ui.header("compose");
      ui.divider();
      console.log(ui.text(topic));
      ui.divider();
      ui.blank();

      const sp = ui.spinner("searching vault for related notes").start();
      const sources = await gatherSources(cfg, db, topic, limit);
      sp.stop();

      if (sources.length === 0) {
        ui.row(
          ui.warn(ui.WARN_GLYPH),
          ui.text("no related notes found — nothing to synthesize"),
        );
        ui.line(ui.dim("  run `vir run` to distill more sessions first"));
        return;
      }

      for (const s of sources.slice(0, 10)) ui.sourceRow(s.title, s.score);
      ui.divider();

      const model = normalizeModelName(
        resolveModelShorthand(opts.model ?? cfg.models.distill),
        cfg.provider,
      );
      const { inputTokens, outputTokens } = estimateComposeCostTokens(
        topic,
        sources,
      );
      const estCost = estCostLabel(cfg, model, inputTokens, outputTokens);

      ui.summary({
        sources: { value: sources.length, color: ui.info },
        model: { value: model, color: ui.accent },
        "est. cost": { value: estCost, color: ui.warn },
      });
      ui.divider();

      if (opts.dryRun) {
        ui.line(
          ui.dim("  dry run — no synthesis performed; actuals may vary ±30%"),
        );
        return;
      }

      if (opts.yes !== true) {
        const proceed = await confirm({
          message: `synthesize with ${model} (~${estCost})?`,
          default: true,
        });
        if (!proceed) {
          ui.line(ui.dim("aborted"));
          return;
        }
      }

      const writer = new VaultWriter(cfg, db);
      const sp2 = ui.spinner("synthesizing topic page").start();
      let result: Awaited<ReturnType<typeof composeFromSources>>;
      try {
        result = await composeFromSources(cfg, db, topic, sources, writer, {
          forceModel: opts.model,
        });
        sp2.stop();
      } catch (err) {
        sp2.fail(ui.errorColor((err as Error).message));
        process.exitCode = 1;
        return;
      }

      ui.row(ui.success(ui.CHECK), ui.text(`wrote ${result.relPath}`));
      ui.blank();

      // Actual cost from the record callLLM just appended for this compose.
      const rec = [...readCostLog()]
        .reverse()
        .find((r) => r.stage === "compose" && r.session === result.slug);
      ui.summary({
        title: { value: result.title, color: ui.text },
        sources: { value: result.sourceCount, color: ui.info },
        confidence: { value: result.confidence.toFixed(2), color: ui.info },
        ...(rec && rec.estimated_cost_usd !== null
          ? { cost: { value: ui.formatUsd(rec.estimated_cost_usd), color: ui.warn } }
          : {}),
      });
    } finally {
      db.close();
    }
  };
  if (opts.dryRun) await run();
  else await withPipelineLock(run);

}
