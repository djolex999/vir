#!/usr/bin/env node
import confirm from "@inquirer/confirm";
import input from "@inquirer/input";
import select from "@inquirer/select";
import chalk from "chalk";
import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, argv, exit } from "node:process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
import { summarizeAll, summarizeProject } from "./pipeline/summarizer.js";
import {
  embeddingForNote,
  isOllamaAvailable,
} from "./search/embedder.js";
import { search } from "./search/retriever.js";
import { synthesize } from "./search/synthesizer.js";
import { runMcpServer } from "./mcp/server.js";
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
import * as ui from "./ui/display.js";
import { VaultWriter } from "./pipeline/writer.js";
import { runDoctor } from "./diagnostics/doctor.js";

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
  .action(async () => {
    await cmdInit();
  });

program
  .command("run")
  .description("Run pipeline once")
  .option("--full", "Re-process all sessions, ignoring state cache")
  .option("--daemon", "Quiet output, write to daemon log file")
  .option(
    "--rewrite-only",
    "Skip scan/filter/LLM; re-render stored notes from SQLite",
  )
  .option("--yes", "Skip the cost confirmation prompt")
  .action(
    async (opts: {
      full?: boolean;
      daemon?: boolean;
      rewriteOnly?: boolean;
      yes?: boolean;
    }) => {
      const cfg = loadConfig();
      const daemon = opts.daemon === true;
      const rewriteOnly = opts.rewriteOnly === true;
      const skipPrompt = opts.yes === true || daemon || rewriteOnly;
      await runPipeline(cfg, {
        full: opts.full,
        quiet: daemon,
        logToFile: daemon,
        rewriteOnly,
        onConfirm: skipPrompt
          ? undefined
          : async (newCount) => confirmCostIfNeeded(cfg, newCount),
      });
    },
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

const schedule = program
  .command("schedule")
  .description("Manage the background daemon (launchd / systemd / cron)");
schedule
  .command("install")
  .description("Install + start the scheduled daemon")
  .action(async () => {
    const cfg = loadConfig();
    await installDaemon(cfg);
    const ds = await daemonStatus();
    console.log(
      chalk.green(
        `installed via ${ds.method}: ${ds.configPath ?? "(no path)"} (active=${ds.active})`,
      ),
    );
  });
schedule
  .command("uninstall")
  .description("Stop + remove the scheduled daemon")
  .action(async () => {
    const before = await daemonStatus();
    await uninstallDaemon();
    if (before.installed) {
      console.log(
        chalk.green(`removed ${before.configPath ?? before.method} daemon`),
      );
    } else {
      console.log(chalk.yellow("no vir daemon found"));
    }
  });

program
  .command("sync-claude [project]")
  .description("Update Vir blocks in CLAUDE.md files (global + per-project)")
  .option("--dry-run", "Show diff only, never write")
  .option("--force", "Apply without confirmation")
  .option("--global", "Only update ~/.claude/CLAUDE.md")
  .action(
    async (
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
    },
  );

program
  .command("dedupe")
  .description("Interactive duplicate detection + merge")
  .action(async () => {
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
  });

program
  .command("lint")
  .description("Run orphan, staleness, and contradiction checks on the vault")
  .option("--orphans", "Run only the orphan check (free)")
  .option("--stale", "Run only the staleness check (free)")
  .option("--contradictions", "Run only the contradiction check (Haiku tokens)")
  .action(
    async (opts: {
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
    },
  );

program
  .command("summarize [project]")
  .description("Generate or regenerate a project knowledge summary")
  .option("--all", "Regenerate summaries for every project with notes")
  .action(async (project: string | undefined, opts: { all?: boolean }) => {
    const cfg = loadConfig();
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
        console.error(chalk.red("usage: vir summarize <project> | --all"));
        exit(1);
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
  });

program
  .command("embed")
  .description("Generate Ollama embeddings for distilled notes")
  .option("--force", "Regenerate even if embedding already exists")
  .action(async (opts: { force?: boolean }) => {
    const cfg = loadConfig();
    ui.header("embed");
    ui.blank();
    if (!(await isOllamaAvailable())) {
      ui.row(ui.errorColor(ui.CROSS), ui.text("Ollama not running"));
      ui.line(ui.dim("  brew install ollama"));
      ui.line(ui.dim("  ollama pull nomic-embed-text"));
      ui.line(ui.dim("  ollama serve"));
      exit(1);
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

      if (target.length === 0) {
        ui.row(ui.success(ui.CHECK), ui.text("all notes already embedded"));
        return;
      }

      const sp = ui.spinner(`embedding notes (0/${target.length})`).start();
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
        sp.text = ui.dim(`embedding notes (${embedded}/${target.length})`);
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
  });

program
  .command("query <question>")
  .description("Search the vault: embedding/TF-IDF retrieval + Claude synthesis")
  .action(async (question: string) => {
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
  });

program
  .command("status")
  .description("Show processing status + knowledge base breakdown")
  .action(async () => {
    const cfg = configExists() ? loadConfig() : null;
    if (!cfg) {
      ui.header("status");
      ui.row(ui.warn(ui.WARN_GLYPH), ui.text("not configured — run `vir init`"));
      return;
    }
    const db = new StateDb();
    const knowledge = db.getStats();
    db.close();
    const ds = await daemonStatus();

    ui.header("status");
    ui.blank();
    renderKnowledge(knowledge);
    ui.blank();
    renderDaemon(ds, cfg.cadenceHours);
  });

program
  .command("doctor")
  .description("Run diagnostic checks on Vir installation")
  .action(runDoctor);

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
  vir_recent_notes     most recently distilled notes
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
  .action(runMcp);

mcpCmd
  .command("install")
  .description("Register Vir with Claude Code")
  .option("--scope <scope>", "user or project", "user")
  .action(async (opts: { scope: string }) => {
    await installToClaudeCode(opts.scope as "user" | "project");
  });

mcpCmd
  .command("uninstall")
  .description("Unregister Vir from Claude Code")
  .action(async () => {
    await uninstallFromClaudeCode();
  });

mcpCmd
  .command("status")
  .description("Check Vir MCP registration")
  .action(async () => {
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
  });

// Backwards compat: `vir mcp` with no subcommand runs the server. The MCP
// registration (`claude mcp add vir vir mcp`) invokes exactly this, so it must
// keep launching the stdio server — don't change it to print help.
mcpCmd.action(runMcp);

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

  const parsed = ConfigSchema.safeParse({
    vaultPath,
    outputDir,
    claudeProjectsDir,
    cadenceHours,
    provider,
    anthropicApiKey,
    kieApiKey,
    filterThreshold,
    filterToolCalls: existing?.filterToolCalls,
    models: { classify: classifyModel, distill: distillModel },
  });

  if (!parsed.success) {
    console.error(chalk.red("invalid config:"));
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
    }
    exit(1);
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

program.parseAsync(argv).catch((err: unknown) => {
  console.error(chalk.red((err as Error).message ?? String(err)));
  exit(1);
});
