#!/usr/bin/env node
import chalk from "chalk";
import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, argv } from "node:process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configExists, loadConfig, type Config } from "./config.js";
import { applyPlan, planUpdates, type PlanItem } from "./claude/updater.js";
import { pruneCommand } from "./cli/pruneAction.js";
import { setupNotifications } from "./cli/notificationsSetup.js";
import { runPipeline } from "./pipeline/run.js";
import { projectNameFor } from "./pipeline/projects.js";
import {
  persistProjectDecisions,
  promptProjectDecisions,
} from "./cli/projectSelect.js";
import { gatherProjectsReport } from "./cli/projects.js";
import { scanSessions } from "./pipeline/scanner.js";
import { parseSession } from "./pipeline/parser.js";
import { scoreSession } from "./pipeline/filter.js";
import { scrub } from "./pipeline/scrubber.js";
import { filterToolCalls } from "./pipeline/toolCallFilter.js";
import { Distiller } from "./pipeline/distiller.js";
import { acquireLock, LockHeldError, releaseLock } from "./pipeline/lock.js";
import { loadIndex, searchWithOutcome, vaultRoot } from "./search/retriever.js";
import {
  QUERY_LOG_PATH,
  readQueryLog,
  recordQueryEvent,
} from "./search/queryLog.js";
import { MIN_DEAD_WEIGHT_SAMPLE, buildQueriesReport } from "./cli/queries.js";
import { buildQueryResults, errorPayload } from "./output/json.js";
import { synthesize } from "./search/synthesizer.js";
import { runMcpServer } from "./mcp/server.js";
import { runReview, type ReviewCliOptions } from "./cli/review.js";
import { runReviewJson, type ReviewJsonOptions } from "./cli/reviewJson.js";
import { runAction } from "./cli/runAction.js";
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
import { withPipelineLock } from "./cli/guards.js";
import { runDoctor, runDoctorJson } from "./diagnostics/doctor.js";
import { embedCommand } from "./cli/embed.js";
import { lintCommand } from "./cli/lint.js";
import { summarizeCommand } from "./cli/summarize.js";
import { auditCommand } from "./cli/audit.js";
import { composeCommand } from "./cli/compose.js";
import { dedupeCommand } from "./cli/dedupe.js";
import { cmdInit } from "./cli/init.js";

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
  .option(
    "--only <project>",
    "Restrict this run to a project (repeatable, never persisted)",
    (v: string, acc: string[]) => acc.concat(v),
    [] as string[],
  )
  .option(
    "--exclude-project <project>",
    "Skip a project for this run only (repeatable, never persisted)",
    (v: string, acc: string[]) => acc.concat(v),
    [] as string[],
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
        only?: string[];
        excludeProject?: string[];
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
        // Dry-run and rewrite-only never call the distiller — no lock needed,
        // and they must not be blocked by (or block) a running pipeline.
        const needsLock = !dryRun && !rewriteOnly;
        if (needsLock) {
          try {
            acquireLock();
          } catch (err) {
            if (err instanceof LockHeldError) {
              console.error(chalk.yellow(err.message));
              process.exitCode = 1;
              return;
            }
            throw err;
          }
        }
        // Interactivity for the undecided-projects triage is a TTY question,
        // not a --yes question: --yes skips the COST prompt but a human at a
        // terminal can still answer include/exclude. launchd/cron have no
        // TTY, so the daemon path can never reach the prompt.
        const canPromptProjects =
          process.stdin.isTTY === true && !daemon && !dryRun;
        let summary;
        try {
          summary = await runPipeline(cfg, {
            full: opts.full,
            quiet: daemon,
            rewriteOnly,
            articlesOnly,
            pdfsOnly,
            forceDistillModel: opts.forceModel,
            dryRun,
            onlyProjects: opts.only?.length ? opts.only : undefined,
            excludeProjects: opts.excludeProject?.length
              ? opts.excludeProject
              : undefined,
            onUndecidedProjects: canPromptProjects
              ? async (pending) => {
                  const answers = await promptProjectDecisions(
                    pending,
                    cfg.projects,
                    `${pending.length} project(s) have sessions awaiting a decision — select the ones vir should track`,
                  );
                  persistProjectDecisions(answers);
                  ui.row(
                    ui.success(ui.CHECK),
                    ui.text(
                      `saved ${Object.keys(answers).length} project decision(s)`,
                    ),
                  );
                  return answers;
                }
              : undefined,
            onConfirm: skipPrompt
              ? undefined
              : async (newCount, estimatedUsd) =>
                  confirmCostIfNeeded(cfg, newCount, estimatedUsd),
          });
        } finally {
          if (needsLock) releaseLock();
        }
        // Surface per-item distill failures via a non-zero exit so external
        // callers (and the user) don't get false "success" — the silent-success
        // bug that hid Kie's 200-with-error responses pre-0.7.2.
        if (
          summary.errored > 0 ||
          summary.articlesErrored > 0 ||
          summary.pdfsErrored > 0 ||
          // A limit halt is an incomplete run — schedulers must not read it
          // as success. The message itself already printed from the loop.
          summary.limitHalted !== null
        ) {
          process.exitCode = 1;
        }
      },
    ),
  );

async function confirmCostIfNeeded(
  cfg: Config,
  newCount: number,
  estimatedUsd: number | null,
): Promise<boolean> {
  if (newCount <= 20) return true;
  // Upper bound from transcript sizes; sessions the filter drops cost nothing.
  const estimate =
    cfg.provider === "claude-cli"
      ? "subscription quota (no $)"
      : estimatedUsd === null
        ? "unknown (no price for the configured models)"
        : `up to ${ui.formatUsd(estimatedUsd)}`;
  ui.box(
    [
      `${ui.text(String(newCount))} ${ui.dim("new sessions to process")}`,
      `${ui.dim("estimated:")} ${ui.warn(estimate)} ${ui.dim("(filtered sessions cost nothing)")}`,
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
      if (report.subscriptionCalls > 0) {
        ui.stat(
          "subscription",
          `${report.subscriptionCalls} claude-cli calls (quota, no $ — excluded from totals)`,
        );
      }
      if (report.unpricedCalls > 0) {
        ui.stat(
          "unpriced",
          `${report.unpricedCalls} calls to a model with no price (real spend, not in the total — add it under pricing in config.json)`,
          ui.warn,
        );
      }
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
  .command("queries")
  .description("Report on logged retrievals from ~/.vir/queries.jsonl")
  .option("--json", "Emit the full report as JSON for scripting")
  .option("--top <n>", "How many top-surfaced notes to show (default 10)", "10")
  .action(
    runAction(async (opts: { json?: boolean; top?: string }) => {
      const cfg = loadConfig();
      const topN = Math.max(1, Number(opts.top ?? "10") || 10);
      const records = readQueryLog();
      // loadIndex walks exactly the retrievable notes (skips summaries/,
      // .rejected/, archived/, index/log) — the honest denominator for
      // dead weight.
      const allSlugs = loadIndex(cfg).map((d) => d.relPath.replace(/\.md$/, ""));
      const report = buildQueriesReport(records, allSlugs, topN);

      if (opts.json) {
        // NOT a plugin contract — scripting output like `vir projects --json`.
        process.stdout.write(JSON.stringify(report) + "\n");
        return;
      }

      ui.header("queries");
      ui.blank();
      if (report.total === 0) {
        ui.row(ui.warn(ui.WARN_GLYPH), ui.text("no logged queries yet"));
        ui.line(ui.dim(`  ${QUERY_LOG_PATH} fills as you run \`vir query\` or use the MCP tools`));
        return;
      }
      ui.stat("queries", report.total);
      ui.stat(
        "method",
        `${report.byMethod.embedding} embedding · ${report.byMethod.tfidf} tfidf`,
      );
      ui.stat(
        "degraded",
        `${report.degraded} (${Math.round(report.degradedRate * 100)}%)`,
        report.degraded > 0 ? ui.warn : undefined,
      );
      ui.blank();

      ui.line(ui.dim(`  top ${Math.min(topN, report.topNotes.length)} surfaced notes`));
      for (const n of report.topNotes) {
        ui.line(
          `  ${ui.dim(ui.BULLET)} ${ui.text(n.slug.padEnd(52))} ${ui.dim(`${n.count}× · avg rank ${n.avgRank}`)}`,
        );
      }
      ui.blank();

      if (report.deadWeight === null) {
        ui.line(
          ui.dim(
            `  dead weight: suppressed — ${report.total} quer${report.total === 1 ? "y" : "ies"} logged, ${MIN_DEAD_WEIGHT_SAMPLE} needed before "never surfaced" means unused rather than unasked`,
          ),
        );
      } else {
        ui.line(
          ui.dim(
            `  dead weight: ${report.deadWeight.length} of ${allSlugs.length} notes never surfaced`,
          ),
        );
        for (const slug of report.deadWeight.slice(0, topN)) {
          ui.line(`  ${ui.dim(ui.BULLET)} ${ui.muted(slug)}`);
        }
        if (report.deadWeight.length > topN) {
          ui.line(ui.dim(`  … ${report.deadWeight.length - topN} more (\`vir queries --json\` for all)`));
        }
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
    const parsed = parseSession(
      found.path,
      found.hash,
      projectNameFor(found.path, cfg.claudeProjectsDir),
    );
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
  .description("Install the scheduled daemon (first run at the next interval)")
  .option("--run-now", "Also kick off one run immediately after installing")
  .action(
    runAction(async (opts: { runNow?: boolean }) => {
      const cfg = loadConfig();
      await installDaemon(cfg, { runNow: opts.runNow });
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
          const result = applyPlan(p);
          // A file that could not be updated is a failed sync, not a warning.
          if (!result.ok) process.exitCode = 1;
          ui.row(
            result.ok ? ui.success(ui.CHECK) : ui.errorColor(ui.CROSS),
            ui.text(
              result.ok || result.reason === undefined
                ? collapseHome(p.target)
                : `${collapseHome(p.target)} — ${result.reason}`,
            ),
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
  .option("--yes", "Skip the cost confirmation prompt")
  .action(
    runAction(dedupeCommand),
  );

program
  .command("lint")
  .description(
    "Run orphan, stray-file, legacy-Related, staleness, and contradiction checks on the vault",
  )
  .option("--orphans", "Run only the orphan check (free)")
  .option("--strays", "Run only the stray-file check (free)")
  .option(
    "--legacy-related",
    "Run only the check for pre-0.12.0 Related sections holding content (free)",
  )
  .option(
    "--fix",
    "Move retitle-duplicate strays into archived/ (other strays are left alone), and move legacy Related content into ## Details",
  )
  .option("--stale", "Run only the staleness check (free)")
  .option("--contradictions", "Run only the contradiction check (Haiku tokens)")
  .option("--yes", "Skip the cost confirmation for the contradiction check")
  .action(
    runAction(lintCommand),
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
    runAction(summarizeCommand),
  );

program
  .command("embed")
  .description("Generate embeddings for distilled notes")
  .option("--force", "Regenerate even if embedding already exists")
  .option(
    "--setup",
    "Install the local embedding provider (fastembed + bge-small) on demand",
  )
  .option("--yes", "Skip the --setup disk-cost confirmation")
  .action(
    runAction(embedCommand),
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
    const t0 = Date.now();
    const outcome = await searchWithOutcome(cfg, db, question, limit);
    recordQueryEvent({
      logQueries: cfg.logQueries,
      source: "cli",
      query: question,
      type: "all",
      hits: outcome.hits,
      search: outcome,
      latencyMs: Date.now() - t0,
    });
    const results = buildQueryResults(outcome.hits, vaultRoot(cfg), cfg.topicsDir);
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

      // The label must reflect what actually served the results, so it can
      // only be printed AFTER the search — the old up-front isOllamaAvailable
      // label claimed "embeddings" even when the embed call failed and TF-IDF
      // served the hits.
      const sp = ui.spinner("searching vault").start();
      let outcome;
      const t0 = Date.now();
      try {
        outcome = await searchWithOutcome(cfg, db, question, 8);
        sp.stop();
      } catch (err) {
        sp.fail(ui.errorColor((err as Error).message));
        return;
      }
      recordQueryEvent({
        logQueries: cfg.logQueries,
        source: "cli",
        query: question,
        type: "all",
        hits: outcome.hits,
        search: outcome,
        latencyMs: Date.now() - t0,
      });
      const hits = outcome.hits;
      if (outcome.degraded) {
        ui.row(
          ui.warn(ui.WARN_GLYPH),
          ui.text(
            `embedding search failed — results are TF-IDF fallback (${outcome.embedError})`,
          ),
        );
      } else if (outcome.noProvider) {
        // A supported mode with a one-line pointer, not a warning — different
        // state than a failed provider, different fix.
        ui.line(ui.dim("no embedding provider — using keyword search"));
        ui.line(
          ui.dim("  semantic search: `vir embed --setup` (one command, ~1 min, 233 MB), or install Ollama"),
        );
      }
      if (outcome.excludedMismatched > 0) {
        ui.row(
          ui.warn(ui.WARN_GLYPH),
          ui.text(
            `${outcome.excludedMismatched} note(s) embedded under a different model were excluded — run \`vir embed --force\` to re-embed them`,
          ),
        );
      }

      if (hits.length === 0) {
        ui.row(ui.warn(ui.WARN_GLYPH), ui.text("no documents matched"));
        return;
      }

      const answer = await synthesize(cfg, question, hits);
      ui.blank();
      console.log(ui.text(ui.wrap(answer.trim(), 60)));
      ui.blank();

      const method = outcome.method;
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
        via: {
          value: outcome.degraded
            ? "tfidf (embeddings failed)"
            : outcome.noProvider
              ? "tfidf (no provider)"
              : method,
          color: outcome.degraded ? ui.warn : ui.accent,
        },
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
    runAction(composeCommand),
  );

const projectsCmd = program
  .command("projects")
  .description("Per-project distillation decisions: table + include/exclude");

projectsCmd
  .option("--json", "Machine-readable output")
  .action(
    runAction(async (opts: { json?: boolean }) => {
      const cfg = loadConfig();
      const rows = gatherProjectsReport(cfg);
      if (opts.json === true) {
        process.stdout.write(
          JSON.stringify(
            rows.map(({ pendingPaths: _pendingPaths, ...r }) => r),
            null,
            2,
          ) + "\n",
        );
        return;
      }
      ui.header("projects");
      ui.blank();
      if (rows.length === 0) {
        ui.line(ui.dim("  no projects found under the Claude projects dir"));
        return;
      }
      const nameW = Math.min(
        Math.max(...rows.map((r) => r.name.length), 7),
        44,
      );
      ui.line(
        ui.dim(
          `  ${"project".padEnd(nameW)}  decision   sessions  distilled  pending  excluded  est. pending`,
        ),
      );
      for (const r of rows) {
        const decision =
          r.decision === "include"
            ? ui.success("include  ")
            : r.decision === "exclude"
              ? ui.dim("exclude  ")
              : ui.warn("undecided");
        const nestedParts = [
          ...(r.workflowSessions > 0 ? [`+${r.workflowSessions} workflow`] : []),
          ...(r.sidechainSessions > 0
            ? [`+${r.sidechainSessions} sidechain`]
            : []),
          ...(r.agentSessions > 0 ? [`+${r.agentSessions} agent`] : []),
        ];
        const nestedNote =
          nestedParts.length > 0 ? ui.dim(`  (${nestedParts.join(", ")})`) : "";
        ui.line(
          `  ${ui.text(r.name.padEnd(nameW))}  ${decision}  ${String(r.sessions).padStart(8)}  ${String(r.distilled).padStart(9)}  ${String(r.pending).padStart(7)}  ${String(r.excluded).padStart(8)}  ${r.pending > 0 ? ui.warn(ui.formatUsd(r.estPendingCost).padStart(12)) : ui.dim("—".padStart(12))}${nestedNote}`,
        );
      }
      const pending = rows.filter(
        (r) => r.decision === "undecided" && r.pending > 0,
      );
      if (pending.length > 0) {
        ui.blank();
        ui.line(
          ui.dim(
            `  ${pending.length} project(s) undecided — vir projects include|exclude <name>, or answer the prompt on the next interactive vir run`,
          ),
        );
      }
    }),
  );

async function cmdProjectDecision(
  name: string,
  decision: "include" | "exclude",
): Promise<void> {
  const cfg = loadConfig();
  const rows = gatherProjectsReport(cfg);
  const known = rows.find((r) => r.name === name);
  if (!known) {
    console.error(
      chalk.red(
        `unknown project '${name}' — seen projects: ${rows.map((r) => r.name).join(", ") || "(none)"}`,
      ),
    );
    process.exitCode = 1;
    return;
  }
  persistProjectDecisions({ [name]: decision });
  ui.row(
    ui.success(ui.CHECK),
    ui.text(
      decision === "include"
        ? `${name} will be distilled from the next run (${known.pending} session(s) pending)`
        : `${name} excluded — forward-looking only; already-distilled notes stay in the vault`,
    ),
  );
}

projectsCmd
  .command("include <name>")
  .description("Track a project's sessions from now on")
  .action(runAction(async (name: string) => cmdProjectDecision(name, "include")));

projectsCmd
  .command("exclude <name>")
  .description("Stop tracking a project (existing notes are untouched)")
  .action(runAction(async (name: string) => cmdProjectDecision(name, "exclude")));

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
  .option(
    "--force",
    "Also retry retry-exhausted sessions (3+ consecutive failed distills)",
  )
  .action(
    runAction(
      async (opts: { dryRun?: boolean; yes?: boolean; force?: boolean }) => {
        const cfg = loadConfig();
        await runReconcile(cfg, {
          dryRun: opts.dryRun,
          yes: opts.yes,
          force: opts.force,
        });
      },
    ),
  );

program
  .command("review")
  .description("Walk through new distilled notes and approve/edit/reject")
  .option("--all", "Review all notes, including verified ones")
  .option("--project <slug>", "Filter by project")
  .option("--limit <n>", "Max notes to review in this session", "50")
  .option("--restore <note>", "Move one rejected note back out of .rejected/")
  .option("--audited", "Walk notes vir audit flagged, worst first")
  .option("--approve <path>", "Approve one note (needs --json)")
  .option("--reject <path>", "Reject one note into .rejected/ (needs --json)")
  .option("--json", "Non-interactive: print the --audited queue or one action's result as JSON")
  .action(
    runAction(async (opts: ReviewCliOptions & ReviewJsonOptions & { json?: boolean }) => {
      if (opts.json) {
        runReviewJson(opts);
        return;
      }
      if (opts.approve !== undefined || opts.reject !== undefined) {
        throw new Error("--approve and --reject need --json (the terminal loop asks per note)");
      }
      await withPipelineLock(() => runReview(opts));
    }),
  );

program
  .command("audit")
  .description("Have a model judge every note (keep/verify/merge/reject) for vir review")
  .option("--project <name>", "Only this project's notes")
  .option("--limit <n>", "Audit at most N notes this run")
  .option("--all", "Re-audit notes that already have a fresh verdict")
  .option("--model <m>", "haiku | sonnet | a full model id (default: models.distill)")
  .option("--dry-run", "Show notes, batches and est. cost, exit before any LLM call")
  .option("--yes", "Skip the cost confirmation prompt")
  .option("--apply-rejects", "Move notes with a fresh reject verdict to .rejected/ (no model call; undo with vir review --restore)")
  .action(
    runAction(auditCommand),
  );

program
  .command("prune")
  .description("Demote agent-derived notes to .rejected/ (dry run by default)")
  .option("--apply", "Actually demote (default is a dry run)")
  .option("--restore", "Restore every pruned note to its exact prior state")
  .action(
    runAction(async (opts: { apply?: boolean; restore?: boolean }) => {
      await pruneCommand(opts);
    }),
  );

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

program
  .command("notifications")
  .description("Allow vir's desktop notifications (macOS) and send a test one")
  .action(
    runAction(async () => {
      setupNotifications({ test: true });
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
  vir_project_summary  synthesized per-project summary
  vir_compose          cached synthesized topic page (vir compose)`,
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

// Safety net for anything that escapes the per-action `runAction` wrapper (e.g.
// commander-internal rejections before the action handler is reached). Set
// `process.exitCode` instead of calling `process.exit` so buffered stdout/stderr
// can drain before the process exits.
program.parseAsync(argv).catch((err: unknown) => {
  console.error(chalk.red((err as Error).message ?? String(err)));
  process.exitCode = 1;
});
