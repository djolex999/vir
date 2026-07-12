#!/usr/bin/env node
import confirm from "@inquirer/confirm";
import input from "@inquirer/input";
import select from "@inquirer/select";
import chalk from "chalk";
import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, argv } from "node:process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_PATH,
  ConfigSchema,
  configExists,
  ensureVirDir,
  expandHome,
  loadConfig,
  saveConfig,
  type Config,
} from "./config.js";
import { applyPlan, planUpdates, type PlanItem } from "./claude/updater.js";
import { detectDuplicates } from "./dedupe/detector.js";
import { mergeNotes } from "./dedupe/merger.js";
import {
  contradictionCheck,
  orphanCheck,
  stalenessCheck,
} from "./lint/linter.js";
import { runPipeline } from "./pipeline/run.js";
import { scanSessions } from "./pipeline/scanner.js";
import { parseSession } from "./pipeline/parser.js";
import { scoreSession } from "./pipeline/filter.js";
import { scrub } from "./pipeline/scrubber.js";
import { filterToolCalls } from "./pipeline/toolCallFilter.js";
import {
  Distiller,
  normalizeModelName,
  resolveModelShorthand,
} from "./pipeline/distiller.js";
import {
  composeFromSources,
  estimateComposeCostTokens,
  gatherSources,
} from "./pipeline/composer.js";
import { computeCost } from "./cost/pricing.js";
import {
  countByCategory,
  summarizeAll,
  summarizeProject,
} from "./pipeline/summarizer.js";
import {
  buildPeriodPrompt,
  estimatePeriodCostTokens,
  periodLabel,
  periodRange,
  selectNotesInPeriod,
  summarizePeriod,
  type Period,
} from "./pipeline/periodSummary.js";
import {
  embeddingForNote,
  isOllamaAvailable,
} from "./search/embedder.js";
import { search, vaultRoot } from "./search/retriever.js";
import { buildQueryResults, errorPayload } from "./output/json.js";
import { synthesize } from "./search/synthesizer.js";
import { runMcpServer } from "./mcp/server.js";
import { runReview } from "./cli/review.js";
import { runAction } from "./cli/runAction.js";
import { buildInitConfig } from "./cli/initConfig.js";
import { runReconcile } from "./cli/reconcile.js";
import {
  installToClaudeCode,
  isClaudeAvailable,
  isInstalled,
  uninstallFromClaudeCode,
} from "./mcp/install.js";
import {
  install as installDaemon,
  status as daemonStatus,
  uninstall as uninstallDaemon,
  type DaemonStatus,
} from "./daemon/index.js";
import { StateDb, type KnowledgeStats } from "./state/db.js";
import { parseDuration, readCostLog } from "./cost/log.js";
import { buildReport } from "./cost/report.js";
import * as ui from "./ui/display.js";
import { VaultWriter } from "./pipeline/writer.js";
import { runDoctor, runDoctorJson } from "./diagnostics/doctor.js";

// Read version at runtime from package.json (one dir up from dist/cli.js) so
// `vir --version` never drifts from the published version. rootDir is ./src,
// so package.json can't be imported — read it instead.
const pkg = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
    "utf8",
  ),
) as { version: string };

const program = new Command();
program
  .name("vir")
  .description("Distill Claude Code sessions into an Obsidian vault")
  .version(pkg.version);

program
  .command("init")
  .description("Interactive setup")
  .action(
    runAction(async () => {
      await cmdInit();
    }),
  );

program
  .command("run")
  .description("Run pipeline once")
  .option("--full", "Re-process all sessions, ignoring state cache")
  .option("--daemon", "Quiet output, write to daemon log file")
  .option(
    "--rewrite-only",
    "Skip scan/filter/LLM; re-render stored notes from SQLite",
  )
  .option("--articles-only", "Distill only web articles, skip sessions")
  .option("--pdfs-only", "Distill only PDFs, skip sessions and articles")
  .option("--yes", "Skip the cost confirmation prompt")
  .option(
    "--force-model <model>",
    "Override the distill model for this run only: haiku | sonnet",
  )
  .option(
    "--dry-run",
    "Estimate per-session cost after filtering, then exit before any LLM call",
  )
  .action(
    runAction(
      async (opts: {
        full?: boolean;
        daemon?: boolean;
        rewriteOnly?: boolean;
        articlesOnly?: boolean;
        pdfsOnly?: boolean;
        yes?: boolean;
        forceModel?: string;
        dryRun?: boolean;
      }) => {
        const cfg = loadConfig();
        const daemon = opts.daemon === true;
        const rewriteOnly = opts.rewriteOnly === true;
        const articlesOnly = opts.articlesOnly === true;
        const pdfsOnly = opts.pdfsOnly === true;
        const dryRun = opts.dryRun === true;
        if (opts.forceModel && !["haiku", "sonnet"].includes(opts.forceModel)) {
          console.error(
            chalk.red(
              `--force-model must be 'haiku' or 'sonnet', got '${opts.forceModel}'`,
            ),
          );
          process.exitCode = 1;
          return;
        }
        const skipPrompt =
          opts.yes === true ||
          daemon ||
          rewriteOnly ||
          articlesOnly ||
          pdfsOnly ||
          dryRun;
        const summary = await runPipeline(cfg, {
          full: opts.full,
          quiet: daemon,
          logToFile: daemon,
          rewriteOnly,
          articlesOnly,
          pdfsOnly,
          forceDistillModel: opts.forceModel,
          dryRun,
          onConfirm: skipPrompt
            ? undefined
            : async (newCount) => confirmCostIfNeeded(cfg, newCount),
        });
        // Surface per-item distill failures via a non-zero exit so external
        // callers (and the user) don't get false "success" — the silent-success
        // bug that hid Kie's 200-with-error responses pre-0.7.2.
        if (
          summary.errored > 0 ||
          summary.articlesErrored > 0 ||
          summary.pdfsErrored > 0
        ) {
          process.exitCode = 1;
        }
      },
    ),
  );

async function confirmCostIfNeeded(
  cfg: Config,
  newCount: number,
): Promise<boolean> {
  if (newCount <= 20) return true;
  ui.box(
    [
      `${ui.text(String(newCount))} ${ui.dim("new sessions to process")}`,
      `${ui.dim("estimated:")} ${ui.warn("$1–5")} ${ui.dim("depending on session")}`,
      `${ui.dim("depth (deep code reviews cost more)")}`,
      `${ui.dim("provider:")} ${ui.accent(cfg.provider)}`,
    ],
    { title: "cost estimate" },
  );
  const rl = createInterface({ input: stdin, output: stdout });
  const ans = (await rl.question(ui.muted("continue? (y/n) ")))
    .trim()
    .toLowerCase();
  rl.close();
  return ans === "y" || ans === "yes";
}

program
  .command("cost")
  .description("Report API cost from ~/.vir/cost.log")
  .option("--since <duration>", "Time window, e.g. 7d, 24h, 2w", "7d")
  .option("--by-session", "Show the full per-session distribution")
  .option("--top <n>", "How many top sessions to show (default 5)", "5")
  .action(
    runAction(async (opts: { since?: string; bySession?: boolean; top?: string }) => {
      ui.header("cost");
      ui.blank();
      const since = opts.since ?? "7d";
      let cutoffMs: number;
      try {
        cutoffMs = Date.now() - parseDuration(since);
      } catch {
        console.error(chalk.red(`invalid --since value: ${since}`));
        process.exitCode = 1;
        return;
      }
      const records = readCostLog(cutoffMs);
      if (records.length === 0) {
        ui.row(
          ui.warn(ui.WARN_GLYPH),
          ui.text(`no cost records in the last ${since}`),
        );
        ui.line(ui.dim("  cost.log fills as vir distills — run `vir run` first"));
        return;
      }

      const report = buildReport(records);
      ui.stat("window", since);
      ui.stat("llm calls", report.recordCount);
      ui.stat("sessions", report.sessionCount);
      ui.stat("total", ui.formatUsd(report.total), ui.warn);
      ui.stat("median/session", ui.formatUsd(report.median));
      ui.stat("p90/session", ui.formatUsd(report.p90), ui.warn);
      ui.blank();

      const topN = Math.max(1, Number(opts.top ?? "5") || 5);
      const rows = opts.bySession
        ? report.bySession
        : report.bySession.slice(0, topN);
      ui.line(
        ui.dim(
          opts.bySession
            ? "  by session"
            : `  top ${Math.min(topN, rows.length)} sessions`,
        ),
      );
      for (const s of rows) {
        const id = s.session.slice(0, 8);
        const label = s.project ? `${s.project}/${id}` : id;
        ui.line(
          `  ${ui.dim(ui.BULLET)} ${ui.text(label.padEnd(42))} ${ui.dim(`${s.calls}×`)}  ${ui.warn(ui.formatUsd(s.cost))}`,
        );
      }
    }),
  );

program
  .command("calibrate <sessionId>")
  .description(
    "Distill ONE session to stdout for A/B model comparison — never writes vault or DB",
  )
  .option("--model <model>", "Distill model: haiku | sonnet", "sonnet")
  .action(
    runAction(async (sessionId: string, opts: { model?: string }) => {
    const cfg = loadConfig();
    const model = opts.model ?? "sonnet";
    if (!["haiku", "sonnet"].includes(model)) {
      console.error(chalk.red(`--model must be 'haiku' or 'sonnet', got '${model}'`));
      process.exitCode = 1;
      return;
    }
    const found = scanSessions(cfg.claudeProjectsDir).find(
      (s) => basename(s.path, ".jsonl") === sessionId,
    );
    if (!found) {
      console.error(chalk.red(`session not found under ${cfg.claudeProjectsDir}: ${sessionId}`));
      process.exitCode = 1;
      return;
    }

    // Same pipeline as production up to (but NOT including) writer.write / db.record.
    // classify always runs on Haiku (matches production); only distill varies.
    const parsed = parseSession(found.path, found.hash);
    const score = scoreSession(parsed, cfg.filterThreshold);
    const scrubbedSummary = scrub(parsed.rawSummary);
    const scrubbedContent = scrub(
      filterToolCalls(parsed.transcriptText, cfg.filterToolCalls).filtered,
    );
    const distiller = new Distiller(cfg, { forceDistillModel: model });
    const cls = await distiller.classify(parsed, scrubbedSummary);
    const markdown = await distiller.distill(parsed, scrubbedContent, cls);

    // The callLLM chokepoint already logged this distill to cost.log; read it
    // back so the footer is guaranteed to match cost.log exactly.
    const distillRecs = readCostLog().filter(
      (r) => r.session === sessionId && r.stage === "distill",
    );
    const last = distillRecs[distillRecs.length - 1];

    console.log(`# calibrate ${sessionId}`);
    console.log(
      `model=${model} filterScore=${score.score} passes=${score.passes} ` +
        `toolCalls=${parsed.toolCallCount} proseChars=${parsed.assistantText.length + parsed.userText.length} ` +
        `distillInputChars=${scrubbedContent.length}`,
    );
    console.log(`\n## classification\n${JSON.stringify(cls, null, 2)}`);
    console.log(`\n## distilled markdown\n${markdown}`);
    if (last) {
      console.log(
        `\n## cost\nmodel=${last.model} input_tokens=${last.input_tokens} ` +
          `output_tokens=${last.output_tokens} token_source=${last.token_source} ` +
          `estimated_cost_usd=${last.estimated_cost_usd}`,
      );
    } else {
      console.log(`\n## cost\n(no distill cost record found for ${sessionId})`);
    }
  }),
  );

const schedule = program
  .command("schedule")
  .description("Manage the background daemon (launchd / systemd / cron)");
schedule
  .command("install")
  .description("Install + start the scheduled daemon")
  .action(
    runAction(async () => {
      const cfg = loadConfig();
      await installDaemon(cfg);
      const ds = await daemonStatus();
      console.log(
        chalk.green(
          `installed via ${ds.method}: ${ds.configPath ?? "(no path)"} (active=${ds.active})`,
        ),
      );
    }),
  );
schedule
  .command("uninstall")
  .description("Stop + remove the scheduled daemon")
  .action(
    runAction(async () => {
      const before = await daemonStatus();
      await uninstallDaemon();
      if (before.installed) {
        console.log(
          chalk.green(`removed ${before.configPath ?? before.method} daemon`),
        );
      } else {
        console.log(chalk.yellow("no vir daemon found"));
      }
    }),
  );

program
  .command("sync-claude [project]")
  .description("Update Vir blocks in CLAUDE.md files (global + per-project)")
  .option("--dry-run", "Show diff only, never write")
  .option("--force", "Apply without confirmation")
  .option("--global", "Only update ~/.claude/CLAUDE.md")
  .action(
    runAction(async (
      projectArg: string | undefined,
      opts: { dryRun?: boolean; force?: boolean; global?: boolean },
    ) => {
      const cfg = loadConfig();
      const db = new StateDb();
      try {
        const plans = planUpdates(cfg, db, {
          project: projectArg,
          globalOnly: opts.global === true,
        });
        ui.header(
          `sync-claude${opts.dryRun ? "  --dry-run" : opts.force ? "  --force" : ""}`,
        );
        ui.blank();
        if (plans.length === 0) {
          ui.row(ui.warn(ui.WARN_GLYPH), ui.text("nothing to plan"));
          return;
        }

        for (const p of plans) {
          renderPlan(p);
          ui.blank();
        }

        if (opts.dryRun) {
          ui.line(ui.dim("run without --dry-run to apply"));
          return;
        }

        let proceed = opts.force === true;
        if (!proceed) {
          const rl = createInterface({ input: stdin, output: stdout });
          const ans = (await rl.question(ui.dim("apply these changes? (y/n) ")))
            .trim()
            .toLowerCase();
          rl.close();
          proceed = ans === "y" || ans === "yes";
        }
        if (!proceed) {
          ui.line(ui.dim("aborted"));
          return;
        }

        for (const p of plans) {
          if (!p.exists) {
            ui.row(ui.warn(ui.WARN_GLYPH), ui.text(`skipped ${collapseHome(p.target)}`));
            continue;
          }
          const ok = applyPlan(p);
          ui.row(
            ok ? ui.success(ui.CHECK) : ui.errorColor(ui.CROSS),
            ui.text(collapseHome(p.target)),
          );
        }
      } finally {
        db.close();
      }
    }),
  );

program
  .command("dedupe")
  .description("Interactive duplicate detection + merge")
  .action(
    runAction(async () => {
    const cfg = loadConfig();
    const db = new StateDb();
    try {
      console.log("scanning for duplicate candidates...");
      const result = await detectDuplicates(cfg, db);
      console.log(
        `${result.checked} candidate pairs checked, ${result.duplicates.length} flagged as duplicates`,
      );
      if (result.duplicates.length === 0) {
        return;
      }

      const rl = createInterface({ input: stdin, output: stdout });
      let merged = 0;
      let skipped = 0;
      for (const dup of result.duplicates) {
        console.log("\nDuplicate found:");
        console.log(
          `A: ${noteRefOf(dup.a)} (conf: ${dup.a.confidence.toFixed(2)}, ${dup.a.startedAt?.slice(0, 10) ?? "?"})`,
        );
        console.log(`   "${preview(dup.a.content)}"`);
        console.log(
          `B: ${noteRefOf(dup.b)} (conf: ${dup.b.confidence.toFixed(2)}, ${dup.b.startedAt?.slice(0, 10) ?? "?"})`,
        );
        console.log(`   "${preview(dup.b.content)}"`);
        console.log(`Reason: ${dup.reason}`);
        const suggestion =
          dup.keepWhich === "merge"
            ? "merge both"
            : `keep ${dup.keepWhich}`;
        console.log(`Suggested: ${suggestion}`);

        const ans = (
          await rl.question(
            "[k]eep suggestion / [s]wap / [m]erge / [x] skip: ",
          )
        )
          .trim()
          .toLowerCase();

        let action: "A" | "B" | "merge" | null = null;
        if (ans === "k" || ans === "") {
          action = dup.keepWhich;
        } else if (ans === "s") {
          action =
            dup.keepWhich === "A"
              ? "B"
              : dup.keepWhich === "B"
                ? "A"
                : "merge";
        } else if (ans === "m") {
          action = "merge";
        } else if (ans === "x") {
          skipped += 1;
          continue;
        } else {
          console.log(chalk.yellow("unknown input — skipping"));
          skipped += 1;
          continue;
        }

        try {
          const outcome = await mergeNotes(cfg, db, dup.a, dup.b, action);
          merged += 1;
          console.log(
            chalk.green(
              `merged (${outcome.action}): winner=${outcome.winnerPath} archived=${outcome.archivedPath}`,
            ),
          );
        } catch (err) {
          console.error(
            chalk.red(`merge failed: ${(err as Error).message}`),
          );
        }
      }
      rl.close();
      console.log(
        `\n${result.duplicates.length} pairs reviewed, ${merged} merged, ${skipped} skipped.`,
      );
    } finally {
      db.close();
    }
  }),
  );

program
  .command("lint")
  .description("Run orphan, staleness, and contradiction checks on the vault")
  .option("--orphans", "Run only the orphan check (free)")
  .option("--stale", "Run only the staleness check (free)")
  .option("--contradictions", "Run only the contradiction check (Haiku tokens)")
  .action(
    runAction(async (opts: {
      orphans?: boolean;
      stale?: boolean;
      contradictions?: boolean;
    }) => {
      const cfg = loadConfig();
      const db = new StateDb();
      try {
        const runAll = !opts.orphans && !opts.stale && !opts.contradictions;
        const checks: string[] = [];
        if (runAll || opts.orphans) checks.push("orphans");
        if (runAll || opts.stale) checks.push("stale");
        if (runAll || opts.contradictions) checks.push("contradictions");

        ui.header("lint");
        ui.blank();

        let orphanCount = 0;
        let staleCount = 0;
        let contradictionCount = 0;
        let issues = 0;

        if (runAll || opts.orphans) {
          const sp = ui.spinner("checking orphans").start();
          const r = orphanCheck(cfg);
          sp.stop();
          orphanCount = r.orphans.length;
          issues += orphanCount;
          if (orphanCount === 0) {
            ui.row(ui.success(ui.CHECK), `${ui.text("orphans")}  ${ui.dim("none")}`);
          } else {
            ui.row(ui.errorColor(ui.CROSS), `${ui.text("orphans")} ${ui.dim("(" + orphanCount + ")")}`);
            for (const o of r.orphans) {
              console.log(`   ${ui.dim(ui.BULLET)} ${ui.text(ui.shortNotePath(o))}`);
            }
          }
        }

        if (runAll || opts.stale) {
          const sp = ui.spinner("checking staleness").start();
          const stale = stalenessCheck(cfg, db);
          sp.stop();
          staleCount = stale.length;
          issues += staleCount;
          if (staleCount === 0) {
            ui.row(ui.success(ui.CHECK), `${ui.text("stale")}    ${ui.dim("none")}`);
          } else {
            ui.row(ui.errorColor(ui.CROSS), `${ui.text("stale")} ${ui.dim("(" + staleCount + ")")}`);
            for (const s of stale) {
              console.log(
                `   ${ui.dim(ui.BULLET)} ${ui.text(ui.shortNotePath(s.relPath))}  ${ui.muted(`${s.ageDays}d`)}  ${ui.dim(`${s.newerSameProjectCount} newer ${s.project} sessions`)}`,
              );
            }
          }
        }

        if (runAll || opts.contradictions) {
          const sp = ui.spinner("checking contradictions (haiku)").start();
          const c = await contradictionCheck(cfg, db);
          sp.stop();
          contradictionCount = c.contradictions.length;
          issues += contradictionCount;
          if (contradictionCount === 0) {
            ui.row(
              ui.success(ui.CHECK),
              `${ui.text("contradictions")}  ${ui.dim(`none found in ${c.checked} pairs`)}`,
            );
          } else {
            ui.row(
              ui.errorColor(ui.CROSS),
              `${ui.text("contradictions")} ${ui.dim("(" + contradictionCount + ")")}`,
            );
            for (const x of c.contradictions) {
              console.log(
                `   ${ui.dim(ui.BULLET)} ${ui.text(ui.shortNotePath(x.a))} ${ui.dim("vs")} ${ui.text(ui.shortNotePath(x.b))}`,
              );
              console.log(`     ${ui.muted(x.reason)}`);
            }
          }
        }

        ui.blank();
        ui.divider();
        ui.summary({
          issues: {
            value: issues,
            color: issues > 0 ? ui.errorColor : ui.success,
          },
          orphans: { value: orphanCount, color: ui.muted },
          stale: { value: staleCount, color: ui.muted },
          contradictions: { value: contradictionCount, color: ui.muted },
        });
        ui.divider();
      } finally {
        db.close();
      }
    }),
  );

program
  .command("summarize [project]")
  .description(
    "Generate a project, --all, or period (--week/--month) knowledge summary",
  )
  .option("--all", "Regenerate summaries for every project with notes")
  .option(
    "--week [n]",
    "Summarize a calendar week (offset back; --week 1 = last week)",
  )
  .option(
    "--month [n]",
    "Summarize a calendar month (offset back; --month 1 = last month)",
  )
  .option("--model <model>", "Synthesis model: haiku | sonnet (period only)")
  .option("--dry-run", "Show note count + estimated cost, exit before LLM")
  .option("--yes", "Skip the cost confirmation prompt (period only)")
  .action(
    runAction(
      async (
        project: string | undefined,
        opts: {
          all?: boolean;
          week?: string | boolean;
          month?: string | boolean;
          model?: string;
          dryRun?: boolean;
          yes?: boolean;
        },
      ) => {
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
            const estCost = computeCost(
              cfg.provider,
              model,
              inputTokens,
              outputTokens,
              cfg.pricing,
              cfg.kieTopUpTier,
            );

            ui.summary({
              notes: { value: notes.length, color: ui.info },
              model: { value: model, color: ui.accent },
              "est. cost": { value: ui.formatUsd(estCost), color: ui.warn },
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
                message: `synthesize with ${model} (~${ui.formatUsd(estCost)})?`,
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
      },
    ),
  );

program
  .command("embed")
  .description("Generate Ollama embeddings for distilled notes")
  .option("--force", "Regenerate even if embedding already exists")
  .action(
    runAction(async (opts: { force?: boolean }) => {
    const cfg = loadConfig();
    ui.header("embed");
    ui.blank();
    if (!(await isOllamaAvailable())) {
      ui.row(ui.errorColor(ui.CROSS), ui.text("Ollama not running"));
      ui.line(ui.dim("  brew install ollama"));
      ui.line(ui.dim("  ollama pull nomic-embed-text"));
      ui.line(ui.dim("  ollama serve"));
      process.exitCode = 1;
      return;
    }
    const db = new StateDb();
    try {
      const rows = db.listDistilled();
      const root = join(cfg.vaultPath, cfg.outputDir);
      const existing = new Set(
        db.getEmbeddings(root).map((r) => r.sessionId),
      );
      const target = opts.force
        ? rows
        : rows.filter((r) => !existing.has(r.sessionId));

      // Topics live in their own table, so backfill them here too — a compose
      // while Ollama was down heals on a manual `vir embed`, not only the next
      // `vir run` sweep. --force re-embeds all topics; otherwise just NULL ones.
      const topicTargets: Array<{ id: string; content: string | null }> =
        opts.force
          ? db.listTopics().map((t) => ({ id: t.id, content: t.content }))
          : db.listTopicEmbeddingTargets();

      // Articles live in their own table too — back-fill them here so a clip
      // distilled while Ollama was down heals on a manual `vir embed`, not only
      // the next `vir run` sweep. --force re-embeds all embeddable articles
      // (keyed by source path); otherwise just the NULL-embedding ones.
      const articleTargets: Array<{ path: string; content: string | null }> =
        opts.force
          ? db.listArticles().map((a) => ({ path: a.path, content: a.content }))
          : db.listArticleEmbeddingTargets();

      // PDFs live in their own table too — same back-fill rationale as articles.
      const pdfTargets: Array<{ path: string; content: string | null }> =
        opts.force
          ? db.listPdfs().map((p) => ({ path: p.path, content: p.content }))
          : db.listPdfEmbeddingTargets();

      const total =
        target.length +
        topicTargets.length +
        articleTargets.length +
        pdfTargets.length;
      if (total === 0) {
        ui.row(ui.success(ui.CHECK), ui.text("all notes already embedded"));
        return;
      }

      const sp = ui.spinner(`embedding notes (0/${total})`).start();
      let embedded = 0;
      let skipped = 0;
      let errors = 0;
      for (let i = 0; i < target.length; i += 1) {
        const r = target[i];
        if (!r) continue;
        if (r.content.trim().length === 0) {
          skipped += 1;
          continue;
        }
        const vec = await embeddingForNote(r.content);
        if (!vec) {
          errors += 1;
          continue;
        }
        db.storeEmbedding(r.sessionId, vec);
        embedded += 1;
        sp.text = ui.dim(`embedding notes (${embedded}/${total})`);
      }
      for (const t of topicTargets) {
        if (!t.content || t.content.trim().length === 0) {
          skipped += 1;
          continue;
        }
        const vec = await embeddingForNote(t.content);
        if (!vec) {
          errors += 1;
          continue;
        }
        db.storeTopicEmbedding(t.id, vec);
        embedded += 1;
        sp.text = ui.dim(`embedding notes (${embedded}/${total})`);
      }
      for (const a of articleTargets) {
        if (!a.content || a.content.trim().length === 0) {
          skipped += 1;
          continue;
        }
        const vec = await embeddingForNote(a.content);
        if (!vec) {
          errors += 1;
          continue;
        }
        db.storeArticleEmbedding(a.path, vec);
        embedded += 1;
        sp.text = ui.dim(`embedding notes (${embedded}/${total})`);
      }
      for (const p of pdfTargets) {
        if (!p.content || p.content.trim().length === 0) {
          skipped += 1;
          continue;
        }
        const vec = await embeddingForNote(p.content);
        if (!vec) {
          errors += 1;
          continue;
        }
        db.storePdfEmbedding(p.path, vec);
        embedded += 1;
        sp.text = ui.dim(`embedding notes (${embedded}/${total})`);
      }
      sp.succeed(ui.text(`embedded ${embedded} notes`));
      ui.blank();
      ui.divider();
      ui.summary({
        embedded: { value: embedded, color: ui.success },
        skipped: { value: skipped, color: ui.muted },
        errors: {
          value: errors,
          color: errors > 0 ? ui.errorColor : ui.dim,
        },
      });
      ui.divider();
    } finally {
      db.close();
    }
  }),
  );

// JSON path for `vir query --json`: stdout gets a single JSON array on success
// (`[]` when nothing matched), exit 0. On failure stdout stays EMPTY so the
// plugin can `JSON.parse(stdout)` unguarded — the error goes to stderr as a
// one-line VirErrorPayload and the exit code is non-zero. Ollama being down is
// NOT a failure here: search() degrades to TF-IDF (Ollama is best-effort).
async function runQueryJson(question: string, limit: number): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    process.stderr.write(
      JSON.stringify(errorPayload("no_vault", (err as Error).message)) + "\n",
    );
    process.exitCode = 1;
    return;
  }
  if (!existsSync(cfg.vaultPath)) {
    process.stderr.write(
      JSON.stringify(
        errorPayload("no_vault", `vault path not found: ${cfg.vaultPath}`),
      ) + "\n",
    );
    process.exitCode = 1;
    return;
  }
  const db = new StateDb();
  try {
    const hits = await search(cfg, db, question, limit);
    const results = buildQueryResults(hits, vaultRoot(cfg), cfg.topicsDir);
    process.stdout.write(JSON.stringify(results) + "\n");
  } catch (err) {
    process.stderr.write(
      JSON.stringify(errorPayload("internal", (err as Error).message)) + "\n",
    );
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

program
  .command("query <question>")
  .description("Search the vault: embedding/TF-IDF retrieval + Claude synthesis")
  .option("--json", "Emit machine-readable JSON for programmatic consumers")
  .option("--limit <n>", "Number of notes to retrieve", "8")
  .action(
    runAction(async (question: string, opts: { json?: boolean; limit?: string }) => {
    const limit = Math.max(1, Number.parseInt(opts.limit ?? "8", 10) || 8);
    if (opts.json) {
      await runQueryJson(question, limit);
      return;
    }
    const cfg = loadConfig();
    const db = new StateDb();
    try {
      ui.header("query");
      ui.divider();
      console.log(ui.text(question));
      ui.divider();
      ui.blank();

      const ollamaUp = await isOllamaAvailable();
      const sp = ui
        .spinner(`searching vault (${ollamaUp ? "embeddings" : "tfidf"})`)
        .start();
      let hits;
      try {
        hits = await search(cfg, db, question, 8);
        sp.stop();
      } catch (err) {
        sp.fail(ui.errorColor((err as Error).message));
        return;
      }

      if (hits.length === 0) {
        ui.row(ui.warn(ui.WARN_GLYPH), ui.text("no documents matched"));
        return;
      }

      const answer = await synthesize(cfg, question, hits);
      ui.blank();
      console.log(ui.text(ui.wrap(answer.trim(), 60)));
      ui.blank();

      const method = hits[0]?.method ?? "tfidf";
      const relevant = hits.filter((h) => h.score > 0).slice(0, 3);
      ui.divider();
      for (const h of relevant) ui.sourceRow(h.title, h.score);
      ui.divider();
      const totalNotes =
        method === "embedding"
          ? db.getEmbeddings(join(cfg.vaultPath, cfg.outputDir)).length
          : new VaultWriter(cfg).noteCount();
      ui.summary({
        sources: { value: relevant.length, color: ui.info },
        via: { value: method, color: ui.accent },
        searched: { value: totalNotes, color: ui.muted },
      });
    } finally {
      db.close();
    }
  }),
  );

program
  .command("compose <topic>")
  .description("Synthesize a topic page from related vault notes")
  .option("--limit <n>", "Top N notes to synthesize from (max 50)", "20")
  .option("--model <model>", "Synthesis model: haiku | sonnet")
  .option("--dry-run", "Show top sources + estimated cost, exit before LLM")
  .option("--yes", "Skip the cost confirmation prompt")
  .action(
    runAction(async (
      topic: string,
      opts: {
        limit?: string;
        model?: string;
        dryRun?: boolean;
        yes?: boolean;
      },
    ) => {
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
        const estCost = computeCost(
          cfg.provider,
          model,
          inputTokens,
          outputTokens,
          cfg.pricing,
          cfg.kieTopUpTier,
        );

        ui.summary({
          sources: { value: sources.length, color: ui.info },
          model: { value: model, color: ui.accent },
          "est. cost": { value: ui.formatUsd(estCost), color: ui.warn },
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
            message: `synthesize with ${model} (~${ui.formatUsd(estCost)})?`,
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
          ...(rec
            ? { cost: { value: ui.formatUsd(rec.estimated_cost_usd), color: ui.warn } }
            : {}),
        });
      } finally {
        db.close();
      }
    }),
  );

program
  .command("status")
  .description("Show processing status + knowledge base breakdown")
  .action(
    runAction(async () => {
      const cfg = configExists() ? loadConfig() : null;
      if (!cfg) {
        ui.header("status");
        ui.row(ui.warn(ui.WARN_GLYPH), ui.text("not configured — run `vir init`"));
        return;
      }
      const db = new StateDb();
      const knowledge = db.getStats();
      const pendingEmbedding =
        db.listEmbeddingTargets().length +
        db.listTopicEmbeddingTargets().length +
        db.listArticleEmbeddingTargets().length;
      db.close();
      const ds = await daemonStatus();

      ui.header("status");
      ui.blank();
      renderKnowledge(knowledge);
      if (pendingEmbedding > 0) {
        ui.line(
          ui.dim(
            `  ${pendingEmbedding} notes pending embedding — \`vir run\` will backfill (or run \`vir embed\`)`,
          ),
        );
      }
      ui.blank();
      renderDaemon(ds, cfg.cadenceHours);
    }),
  );

program
  .command("reconcile")
  .description(
    "Retry sessions that silently failed pre-0.7.2 (null/empty content despite skipped=0)",
  )
  .option(
    "--dry-run",
    "Report recoverable count + estimated cost + false-cost collateral; exit before any LLM call",
  )
  .option("--yes", "Skip the cost confirmation prompt")
  .action(
    runAction(async (opts: { dryRun?: boolean; yes?: boolean }) => {
      const cfg = loadConfig();
      await runReconcile(cfg, { dryRun: opts.dryRun, yes: opts.yes });
    }),
  );

program
  .command("review")
  .description("Walk through new distilled notes and approve/edit/reject")
  .option("--all", "Review all notes, including verified ones")
  .option("--project <slug>", "Filter by project")
  .option("--limit <n>", "Max notes to review in this session", "50")
  .action(runAction(runReview));

program
  .command("doctor")
  .description("Run diagnostic checks on Vir installation")
  .option("--json", "Emit machine-readable JSON for programmatic consumers")
  .action(
    runAction(async (opts: { json?: boolean }) => {
      if (opts.json) {
        await runDoctorJson();
        return;
      }
      await runDoctor();
    }),
  );

const mcpCmd = program
  .command("mcp")
  .description("MCP server + Claude Code registration")
  .addHelpText(
    "after",
    `
Quick start:
  vir mcp install      register with Claude Code (recommended)
  vir mcp status       check registration
  vir mcp run          run the stdio server directly (vir mcp = vir mcp run)

After installing, restart Claude Code. Tools become available:
  vir_query            search the vault (synthesized answer + sources)
  vir_status           knowledge base overview + gaps
  vir_recent_notes     most recently distilled session notes
  vir_recent_articles  most recently distilled web articles
  vir_project_summary  synthesized per-project summary`,
  );

// Shared by `vir mcp run` and the bare `vir mcp` alias below.
const runMcp = async (): Promise<void> => {
  const cfg = loadConfig();
  await runMcpServer(cfg);
};

mcpCmd
  .command("run")
  .description("Run the MCP server over stdio")
  .action(runAction(runMcp));

mcpCmd
  .command("install")
  .description("Register Vir with Claude Code")
  .option("--scope <scope>", "user or project", "user")
  .action(
    runAction(async (opts: { scope: string }) => {
      await installToClaudeCode(opts.scope as "user" | "project");
    }),
  );

mcpCmd
  .command("uninstall")
  .description("Unregister Vir from Claude Code")
  .action(
    runAction(async () => {
      await uninstallFromClaudeCode();
    }),
  );

mcpCmd
  .command("status")
  .description("Check Vir MCP registration")
  .action(
    runAction(async () => {
    if (!(await isClaudeAvailable())) {
      ui.row(
        ui.warn(ui.WARN_GLYPH),
        ui.text("claude CLI not detected"),
        "install: https://claude.com/claude-code",
      );
      return;
    }
    const installed = await isInstalled();
    ui.row(
      installed ? ui.success(ui.CHECK) : ui.errorColor(ui.CROSS),
      ui.text(installed ? "registered with Claude Code" : "not registered"),
      installed ? undefined : "run: vir mcp install",
    );
  }),
  );

// Backwards compat: `vir mcp` with no subcommand runs the server. The MCP
// registration (`claude mcp add vir vir mcp`) invokes exactly this, so it must
// keep launching the stdio server — don't change it to print help.
mcpCmd.action(runAction(runMcp));

function renderKnowledge(k: KnowledgeStats): void {
  if (k.total === 0) {
    ui.box(
      [
        ui.text("no distilled notes yet"),
        ui.dim("run `vir run --full` to populate"),
      ],
      { title: "knowledge" },
    );
    return;
  }

  const lines: string[] = [];
  lines.push(
    `${ui.dim("notes")}      ${ui.text(String(k.total).padStart(3))}   ${ui.dim("avg conf")}  ${ui.info(k.avgConfidence.toFixed(2))}`,
  );
  lines.push(
    `${ui.dim("high signal")} ${ui.success(String(k.highConf).padStart(2))}   ${ui.dim("low signal")} ${ui.errorColor(String(k.lowConf).padStart(2))}`,
  );
  const oldest = (k.oldestNote || "?").slice(0, 10);
  const newest = (k.newestNote || "?").slice(0, 10);
  lines.push(
    `${ui.muted(oldest)}  ${ui.dim(ui.ARROW)}  ${ui.muted(newest)}`,
  );
  ui.box(lines, { title: "knowledge" });

  ui.blank();
  const entries: Array<[string, number]> = [
    ["pattern", k.byCategory.pattern ?? 0],
    ["decision", k.byCategory.decision ?? 0],
    ["gotcha", k.byCategory.gotcha ?? 0],
    ["tool", k.byCategory.tool ?? 0],
  ];
  const maxCount = Math.max(1, ...entries.map(([, c]) => c));
  for (const [label, count] of entries) {
    const w = 16;
    const filled = Math.round((count / maxCount) * w);
    const bar = "█".repeat(filled) + "░".repeat(w - filled);
    const pct = k.total > 0 ? Math.round((count / k.total) * 100) : 0;
    const color = ui.colorForCategory[label] ?? ui.text;
    console.log(
      `${color(label.padEnd(9))} ${color(bar)} ${ui.text(String(count).padStart(3))}  ${ui.dim(String(pct).padStart(3) + "%")}`,
    );
  }

  ui.blank();
  const projectLines: string[] = [];
  const projects = Object.entries(k.byProject).sort(
    (a, b) => b[1].total - a[1].total,
  );
  for (const [name, p] of projects) {
    const last = p.lastSeen ? p.lastSeen.slice(0, 10) : "—";
    const conf = p.avgConfidence.toFixed(2);
    projectLines.push(
      `${ui.text(name.padEnd(10).slice(0, 10))} ${ui.info(String(p.total).padStart(3))}   ` +
        `${ui.dim("P")}${ui.text(String(p.patterns).padStart(2))} ` +
        `${ui.dim("G")}${ui.text(String(p.gotchas).padStart(2))} ` +
        `${ui.dim("D")}${ui.text(String(p.decisions).padStart(2))} ` +
        `${ui.dim("T")}${ui.text(String(p.tools).padStart(2))}   ` +
        `${ui.info(conf)}  ${ui.muted(last)}`,
    );
  }
  ui.box(projectLines, { title: "projects", width: 52 });

  ui.blank();
  for (const [name, p] of projects) {
    if (p.total === 0) continue;
    if (p.gotchas === 0) {
      ui.row(
        ui.warn(ui.WARN_GLYPH),
        ui.text(`${name} — no gotchas recorded`),
      );
    }
    if (p.decisions === 0) {
      ui.row(
        ui.warn(ui.WARN_GLYPH),
        ui.text(`${name} — no architecture decisions`),
      );
    }
    if (p.avgConfidence < 0.65) {
      ui.row(
        ui.warn(ui.WARN_GLYPH),
        ui.text(
          `${name} — low avg confidence (${p.avgConfidence.toFixed(2)})`,
        ),
      );
    }
  }
}

function renderDaemon(ds: DaemonStatus, cadenceHours: number): void {
  const status = ds.active ? "running" : ds.installed ? "loaded" : "off";
  const statusColor = ds.active
    ? ui.success
    : ds.installed
      ? ui.warn
      : ui.dim;
  // Prefer the cadence parsed from the installed unit (systemd/cron); fall
  // back to config when the platform doesn't expose it (launchd).
  const cadence = ds.cadenceHours ?? cadenceHours;
  ui.box(
    [
      `${ui.dim("status")}   ${statusColor(status)}`,
      `${ui.dim("method")}   ${ui.text(ds.method)}`,
      `${ui.dim("cadence")}  ${ui.text(`every ${cadence}h`)}`,
      `${ui.dim("config")}   ${ui.muted(ds.configPath ? collapseHome(ds.configPath) : "—")}`,
    ],
    { title: "daemon", width: 52 },
  );
}

async function cmdInit(): Promise<void> {
  ensureVirDir();
  const existing = configExists() ? safeLoad() : null;

  ui.header("init");
  ui.blank();

  // ── vault path ──────────────────────────────────────────────────────────
  let vaultPath = "";
  for (;;) {
    vaultPath = await input({
      message: "Obsidian vault path",
      default:
        existing?.vaultPath ??
        join(homedir(), "Documents", "Obsidian", "MyVault"),
    });
    const expanded = expandHome(vaultPath);
    if (existsSync(expanded)) break;
    const create = await confirm({
      message: `Vault path does not exist (${expanded}). Create it?`,
      default: true,
    });
    if (create) {
      try {
        mkdirSync(expanded, { recursive: true });
        break;
      } catch (err) {
        console.error(
          chalk.red(`failed to create: ${(err as Error).message}`),
        );
      }
    }
  }

  const outputDir = await input({
    message: "Output subdir inside vault",
    default: existing?.outputDir ?? "vir",
  });

  // ── claude projects dir ─────────────────────────────────────────────────
  let claudeProjectsDir = "";
  for (;;) {
    claudeProjectsDir = await input({
      message: "Claude Code projects dir",
      default:
        existing?.claudeProjectsDir ?? join(homedir(), ".claude", "projects"),
    });
    const expanded = expandHome(claudeProjectsDir);
    if (existsSync(expanded)) break;
    console.warn(
      chalk.yellow(
        "directory not found — Claude Code sessions may not exist yet",
      ),
    );
    const cont = await confirm({
      message: "continue anyway?",
      default: false,
    });
    if (cont) break;
  }

  // ── web articles (optional second input source) ─────────────────────────
  let articlesDir: string | undefined = existing?.articlesDir;
  const wantsArticles = await confirm({
    message:
      "Do you save web articles to a folder (e.g. Obsidian Web Clipper)?",
    default: existing?.articlesDir !== undefined,
  });
  if (wantsArticles) {
    for (;;) {
      articlesDir = await input({
        message: "Articles (raw/) directory",
        default:
          existing?.articlesDir ??
          join(homedir(), "Documents", "Obsidian", "raw"),
      });
      const expanded = expandHome(articlesDir);
      if (existsSync(expanded)) break;
      const create = await confirm({
        message: `Path does not exist (${expanded}). Create it?`,
        default: true,
      });
      if (create) {
        try {
          mkdirSync(expanded, { recursive: true });
          break;
        } catch (err) {
          console.error(
            chalk.red(`failed to create: ${(err as Error).message}`),
          );
        }
      } else {
        break;
      }
    }
  } else {
    articlesDir = undefined;
  }

  // ── PDFs / papers (optional third input source) ──────────────────────────
  let pdfsDir: string | undefined = existing?.pdfsDir;
  const wantsPdfs = await confirm({
    message: "Do you keep PDFs / papers in a folder to ingest?",
    default: existing?.pdfsDir !== undefined,
  });
  if (wantsPdfs) {
    for (;;) {
      pdfsDir = await input({
        message: "PDFs directory",
        default: existing?.pdfsDir ?? join(homedir(), "Documents", "papers"),
      });
      const expanded = expandHome(pdfsDir);
      if (existsSync(expanded)) break;
      const create = await confirm({
        message: `Path does not exist (${expanded}). Create it?`,
        default: true,
      });
      if (create) {
        try {
          mkdirSync(expanded, { recursive: true });
          break;
        } catch (err) {
          console.error(
            chalk.red(`failed to create: ${(err as Error).message}`),
          );
        }
      } else {
        break;
      }
    }
  } else {
    pdfsDir = undefined;
  }

  const cadenceHours = Number(
    await input({
      message: "Cadence (hours)",
      default: String(existing?.cadenceHours ?? 3),
      validate: (v: string) => {
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? true : "must be a positive number";
      },
    }),
  );

  // ── provider picker ─────────────────────────────────────────────────────
  const provider = (await select({
    message: "Provider",
    default: existing?.provider ?? "anthropic",
    choices: [
      {
        name: "Anthropic  (direct, official pricing)",
        value: "anthropic" as const,
      },
      {
        name: "Kie.ai     (same Claude models, ~72% cheaper)",
        value: "kie" as const,
      },
    ],
  })) as "anthropic" | "kie";

  let anthropicApiKey: string | undefined;
  let kieApiKey: string | undefined;
  if (provider === "anthropic") {
    anthropicApiKey = await input({
      message: "Anthropic API key",
      default: existing?.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY ?? "",
      validate: (v: string) =>
        v.startsWith("sk-ant-") ? true : "key should start with sk-ant-",
    });
  } else {
    kieApiKey = await input({
      message: "Kie.ai API key",
      default: existing?.kieApiKey ?? process.env.KIE_API_KEY ?? "",
      validate: (v: string) =>
        v.length > 10 ? true : "enter a valid Kie.ai API key",
    });
  }

  // ── model pickers (provider-aware) ──────────────────────────────────────
  const classifyChoices =
    provider === "anthropic"
      ? [
          {
            name: "claude-haiku-4-5-20251001  (recommended)",
            value: "claude-haiku-4-5-20251001",
          },
          { name: "claude-sonnet-4-6", value: "claude-sonnet-4-6" },
        ]
      : [
          {
            name: "claude-haiku-4-5  (recommended)",
            value: "claude-haiku-4-5",
          },
          { name: "claude-sonnet-4-6", value: "claude-sonnet-4-6" },
        ];
  const classifyModel = await select({
    message: "Classify model (fast pass)",
    choices: classifyChoices,
  });

  const distillChoices =
    provider === "anthropic"
      ? [
          {
            name: "claude-sonnet-4-6  (recommended)",
            value: "claude-sonnet-4-6",
          },
          {
            name: "claude-haiku-4-5-20251001  (faster, cheaper)",
            value: "claude-haiku-4-5-20251001",
          },
        ]
      : [
          {
            name: "claude-sonnet-4-6  (recommended)",
            value: "claude-sonnet-4-6",
          },
          {
            name: "claude-haiku-4-5  (faster, cheaper)",
            value: "claude-haiku-4-5",
          },
        ];
  const distillModel = await select({
    message: "Distill model (deep extraction)",
    choices: distillChoices,
  });

  const filterThreshold = Number(
    await input({
      message: "Filter threshold (0..1)",
      default: String(existing?.filterThreshold ?? 0.4),
      validate: (v: string) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 && n <= 1
          ? true
          : "must be between 0 and 1";
      },
    }),
  );

  const parsed = ConfigSchema.safeParse(
    buildInitConfig(existing, {
      vaultPath,
      outputDir,
      claudeProjectsDir,
      cadenceHours,
      provider,
      anthropicApiKey,
      kieApiKey,
      filterThreshold,
      articlesDir,
      pdfsDir,
      classifyModel,
      distillModel,
    }),
  );

  if (!parsed.success) {
    console.error(chalk.red("invalid config:"));
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exitCode = 1;
    return;
  }

  saveConfig(parsed.data);
  ui.blank();
  ui.row(ui.success(ui.CHECK), ui.text(`saved ${CONFIG_PATH}`));

  ui.blank();
  const wantsMcp = await confirm({
    message: "Register Vir with Claude Code now? (recommended)",
    default: true,
  });
  if (wantsMcp) {
    await installToClaudeCode("user");
  }

  ui.blank();
  ui.line(ui.dim("next: `vir run` to test once, then `vir schedule install`"));
}

function renderPlan(p: PlanItem): void {
  const title = collapseHome(p.target);
  if (!p.exists) {
    ui.box([ui.dim("no CLAUDE.md found — would be skipped")], { title });
    return;
  }
  const lines: string[] = [];
  for (const e of p.diff.added) {
    lines.push(`${ui.success("+")} ${ui.text(e.slug)}`);
  }
  for (const u of p.diff.upgraded) {
    lines.push(
      `${ui.info(ui.UP_ARROW)} ${ui.text(u.slug)}  ${ui.dim(`${u.oldConf.toFixed(2)}${ui.ARROW}${u.newConf.toFixed(2)}`)}`,
    );
  }
  for (const r of p.diff.removed) {
    lines.push(`${ui.warn("-")} ${ui.text(r.slug)}`);
  }
  if (p.diff.unchanged.length > 0) {
    lines.push(
      `${ui.dim("~")} ${ui.dim(`${p.diff.unchanged.length} entries unchanged`)}`,
    );
  }
  if (lines.length === 0) lines.push(ui.dim("no changes"));
  ui.box(lines, { title });
}

function collapseHome(p: string): string {
  const h = homedir();
  return p.startsWith(h) ? "~" + p.slice(h.length) : p;
}

function noteRefOf(r: {
  category: string;
  topic: string;
  sessionId: string;
}): string {
  const dir = `${r.category}s`;
  const slug = r.topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${dir}/${slug}-${r.sessionId.slice(0, 8)}`;
}

function preview(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 80);
}

function safeLoad(): Config | null {
  try {
    return loadConfig();
  } catch {
    return null;
  }
}

// Safety net for anything that escapes the per-action `runAction` wrapper (e.g.
// commander-internal rejections before the action handler is reached). Set
// `process.exitCode` instead of calling `process.exit` so buffered stdout/stderr
// can drain before the process exits.
program.parseAsync(argv).catch((err: unknown) => {
  console.error(chalk.red((err as Error).message ?? String(err)));
  process.exitCode = 1;
});
