import confirm from "@inquirer/confirm";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import {
  normalizeModelName,
  resolveModelShorthand,
} from "../pipeline/distiller.js";
import {
  countByCategory,
  summarizeAll,
  summarizeProject,
} from "../pipeline/summarizer.js";
import {
  buildPeriodPrompt,
  estimatePeriodCostTokens,
  periodLabel,
  periodRange,
  selectNotesInPeriod,
  summarizePeriod,
  type Period,
} from "../pipeline/periodSummary.js";
import { StateDb } from "../state/db.js";
import * as ui from "../ui/display.js";
import { estCostLabel } from "./costLabel.js";
import { withPipelineLock } from "./guards.js";

export async function summarizeCommand(
  project: string | undefined,
  opts: {
    all?: boolean;
    week?: string | boolean;
    month?: string | boolean;
    model?: string;
    dryRun?: boolean;
    yes?: boolean;
  },

): Promise<void> {
  // Writes notes and the DB: hold the lock (a dry run only reads).
  const run = async (): Promise<void> => {
    const cfg = loadConfig();
    const wantWeek = opts.week !== undefined;
    const wantMonth = opts.month !== undefined;

    if (wantWeek && wantMonth) {
      console.error(chalk.red("use --week or --month, not both"));
      process.exitCode = 1;
      return;
    }

    // ── period summary path (--week / --month) ──────────────────────────
    if (wantWeek || wantMonth) {
      if (project || opts.all) {
        console.error(
          chalk.red("--week/--month cannot be combined with a project or --all"),
        );
        process.exitCode = 1;
        return;
      }
      if (opts.model && !["haiku", "sonnet"].includes(opts.model)) {
        console.error(
          chalk.red(`--model must be 'haiku' or 'sonnet', got '${opts.model}'`),
        );
        process.exitCode = 1;
        return;
      }
      const kind = wantWeek ? "week" : "month";
      const raw = wantWeek ? opts.week : opts.month;
      // commander yields `true` for a bare flag, or the string value for `--week 2`
      const offset = typeof raw === "string" ? Number.parseInt(raw, 10) : 0;
      if (!Number.isInteger(offset) || offset < 0) {
        console.error(
          chalk.red(`--${kind} offset must be a non-negative integer`),
        );
        process.exitCode = 1;
        return;
      }
      const period: Period = { kind, offset };
      const now = new Date();
      const db = new StateDb();
      try {
        ui.header("summarize");
        ui.divider();
        const range = periodRange(period, now);
        const label = periodLabel(period, range);
        console.log(ui.text(label));
        ui.divider();
        ui.blank();

        const notes = selectNotesInPeriod(db.listDistilled(), period, now);
        if (notes.length === 0) {
          ui.row(
            ui.warn(ui.WARN_GLYPH),
            ui.text(`no notes distilled in ${label} — nothing to summarize`),
          );
          ui.line(ui.dim("  run `vir run` to distill more sessions first"));
          return;
        }

        const model = normalizeModelName(
          resolveModelShorthand(opts.model ?? cfg.models.distill),
          cfg.provider,
        );
        const counts = countByCategory(notes);
        const prompt = buildPeriodPrompt(label, notes, counts);
        const { inputTokens, outputTokens } = estimatePeriodCostTokens(prompt);
        const estCost = estCostLabel(cfg, model, inputTokens, outputTokens);

        ui.summary({
          notes: { value: notes.length, color: ui.info },
          model: { value: model, color: ui.accent },
          "est. cost": { value: estCost, color: ui.warn },
        });
        ui.divider();

        if (opts.dryRun === true) {
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

        const sp = ui.spinner("synthesizing period summary").start();
        let result: Awaited<ReturnType<typeof summarizePeriod>>;
        try {
          result = await summarizePeriod(cfg, db, period, {
            now,
            model: opts.model,
          });
          sp.stop();
        } catch (err) {
          sp.fail(ui.errorColor((err as Error).message));
          process.exitCode = 1;
          return;
        }
        if (!result) {
          ui.row(ui.warn(ui.WARN_GLYPH), ui.text("nothing to summarize"));
          return;
        }
        ui.row(
          ui.success(ui.CHECK),
          ui.text(
            `wrote ${result.relPath} (${result.noteCount} notes)`,
          ),
        );
        ui.blank();
      } finally {
        db.close();
      }
      return;
    }

    // ── project / --all path (unchanged) ────────────────────────────────
    const db = new StateDb();
    try {
      if (opts.all) {
        const results = await summarizeAll(cfg, db);
        if (results.length === 0) {
          console.log(chalk.yellow("no projects with notes"));
          return;
        }
        for (const r of results) {
          console.log(
            chalk.green(`summarized project/${r.slug}`) +
              ` (${r.counts.total} sessions)`,
          );
        }
        return;
      }
      if (!project) {
        console.error(
          chalk.red("usage: vir summarize <project> | --all | --week [n] | --month [n]"),
        );
        process.exitCode = 1;
        return;
      }
      const res = await summarizeProject(cfg, project, db);
      if (!res) {
        console.log(chalk.yellow(`no distilled notes for project '${project}'`));
        return;
      }
      console.log(
        chalk.green(`summarized project/${res.slug}`) +
          ` (${res.counts.total} sessions) → ${res.path}`,
      );
    } finally {
      db.close();
    }
  };
  if (opts.dryRun) await run();
  else await withPipelineLock(run);

}
