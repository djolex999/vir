import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { DAEMON_LOG_PATH, ensureVirDir, type Config } from "../config.js";
import { StateDb } from "../state/db.js";
import * as ui from "../ui/display.js";
import {
  Distiller,
  normalizeModelName,
  resolveModelShorthand,
} from "./distiller.js";
import { computeCost } from "../cost/pricing.js";
import { scoreSession } from "./filter.js";
import { parseSession } from "./parser.js";
import { scanSessions } from "./scanner.js";
import { scanArticles } from "./articleReader.js";
import { distillArticle } from "./articleDistiller.js";
import { scrub } from "./scrubber.js";
import { summarizeProject } from "./summarizer.js";
import { filterToolCalls } from "./toolCallFilter.js";
import type { DistilledNote, ParsedSession } from "./types.js";
import { kebab, VaultWriter } from "./writer.js";
import { sweepEmbeddings } from "./embeddingSweep.js";

export interface RunOptions {
  full?: boolean;
  quiet?: boolean;
  logToFile?: boolean;
  rewriteOnly?: boolean;
  // Distill only web articles, skipping the Claude Code session pipeline.
  articlesOnly?: boolean;
  // Override models.distill for this run only (full id or "haiku"/"sonnet").
  forceDistillModel?: string;
  // Estimate per-session cost after filtering, print a table, and exit before
  // any LLM call. Skips the cost-confirmation prompt.
  dryRun?: boolean;
  // Called after the scan with the count of sessions that will be distilled.
  // Return false to abort cleanly. If omitted, the run always proceeds —
  // daemon callers rely on this default.
  onConfirm?: (newCount: number) => Promise<boolean>;
}

export interface RunSummary {
  scanned: number;
  alreadyProcessed: number;
  skippedByFilter: number;
  distilled: number;
  lowConfidence: number;
  errored: number;
  rewritten: number;
  notesWritten: string[];
  articlesScanned: number;
  articlesDistilled: number;
  articlesSkipped: number;
  articlesErrored: number;
}

export async function runPipeline(
  cfg: Config,
  opts: RunOptions = {},
): Promise<RunSummary> {
  ensureVirDir();
  const db = new StateDb();
  const writer = new VaultWriter(cfg, db);

  const summary: RunSummary = {
    scanned: 0,
    alreadyProcessed: 0,
    skippedByFilter: 0,
    distilled: 0,
    lowConfidence: 0,
    errored: 0,
    rewritten: 0,
    notesWritten: [],
    articlesScanned: 0,
    articlesDistilled: 0,
    articlesSkipped: 0,
    articlesErrored: 0,
  };

  const interactive = !opts.quiet;

  // File-only logging — used for the daemon run.log regardless of UI mode.
  const fileLog = (msg: string): void => {
    if (!opts.logToFile) return;
    try {
      appendFileSync(
        DAEMON_LOG_PATH,
        `[${new Date().toISOString()}] ${msg}\n`,
      );
    } catch {
      // ignore log errors
    }
  };

  if (interactive) {
    ui.header(
      opts.dryRun
        ? "run  --dry-run"
        : opts.rewriteOnly
          ? "run  --rewrite-only"
          : opts.articlesOnly
            ? "run  --articles-only"
            : opts.full
              ? "run  --full"
              : "run",
    );
    ui.blank();
  }
  fileLog(
    `vir run start (full=${opts.full ? "true" : "false"} rewriteOnly=${opts.rewriteOnly ? "true" : "false"})`,
  );

  if (opts.rewriteOnly) {
    const rows = db.listDistilled();
    fileLog(`rewrite-only: ${rows.length} distilled sessions in db`);
    if (interactive) {
      const sp = ui.spinner(`rewriting ${rows.length} notes`).start();
      try {
        for (const row of rows) {
          try {
            const written = await rewriteOne(writer, row);
            summary.rewritten += 1;
            summary.notesWritten.push(...written);
          } catch (err) {
            summary.errored += 1;
            fileLog(`error on ${row.path}: ${(err as Error).message}`);
          }
        }
        sp.succeed(ui.text(`rewrote ${summary.rewritten} notes`));
      } catch (err) {
        sp.fail(ui.errorColor((err as Error).message));
        throw err;
      }
    } else {
      for (const row of rows) {
        try {
          const written = await rewriteOne(writer, row);
          summary.rewritten += 1;
          summary.notesWritten.push(...written);
        } catch (err) {
          summary.errored += 1;
          fileLog(`error on ${row.path}: ${(err as Error).message}`);
        }
      }
    }
    // Rewrite mode skips per-note index appends; rebuild index.md once from the
    // db so it reflects every note exactly once (no log.md append).
    try {
      writer.regenerateIndex();
    } catch (err) {
      fileLog(`index regeneration failed: ${(err as Error).message}`);
    }
    fileLog(
      `vir run done — rewriteOnly rewritten=${summary.rewritten} errored=${summary.errored}`,
    );
    if (interactive) {
      ui.blank();
      ui.divider();
      ui.summary({
        rewritten: { value: summary.rewritten, color: ui.success },
        errored: {
          value: summary.errored,
          color: summary.errored > 0 ? ui.errorColor : ui.dim,
        },
      });
      ui.divider();
    }
    db.close();
    return summary;
  }

  // --articles-only: skip the entire session pipeline.
  if (opts.articlesOnly) {
    if (!cfg.articlesDir) {
      if (interactive) {
        ui.row(
          ui.warn(ui.WARN_GLYPH),
          ui.text("articlesDir is not set — nothing to distill"),
        );
      }
      fileLog("articles-only run but articlesDir is unset");
      db.close();
      return summary;
    }
    await runArticlePhase(cfg, db, writer, summary, fileLog, interactive);
    if (interactive) {
      ui.blank();
      ui.divider();
      ui.summary({
        articles: { value: summary.articlesScanned, color: ui.info },
        distilled: { value: summary.articlesDistilled, color: ui.success },
        skipped: { value: summary.articlesSkipped, color: ui.warn },
        errored: {
          value: summary.articlesErrored,
          color: summary.articlesErrored > 0 ? ui.errorColor : ui.dim,
        },
      });
      ui.divider();
    }
    db.close();
    return summary;
  }

  const distiller = new Distiller(cfg, {
    forceDistillModel: opts.forceDistillModel,
  });
  if (interactive && opts.forceDistillModel) {
    ui.line(ui.dim(`  forcing distill model: ${opts.forceDistillModel}`));
    ui.blank();
  }
  fileLog(
    `force-model: ${opts.forceDistillModel ?? "(none)"}`,
  );
  const newPerProject = new Map<string, number>();

  const scanSpinner = interactive
    ? ui.spinner("scanning ~/.claude/projects").start()
    : null;
  let discovered;
  try {
    discovered = scanSessions(cfg.claudeProjectsDir);
  } catch (err) {
    if (scanSpinner) scanSpinner.fail(ui.errorColor("scan failed"));
    fileLog(`scanner failed: ${(err as Error).message}`);
    db.close();
    return summary;
  }
  summary.scanned = discovered.length;
  if (scanSpinner) {
    scanSpinner.succeed(
      ui.text(`scanned ${ui.info(String(discovered.length))} ${ui.dim("jsonl files")}`),
    );
  }
  fileLog(`scanned ${discovered.length} jsonl files`);
  if (interactive) ui.blank();

  // Precompute how many sessions actually need LLM work so the CLI can show
  // an accurate cost confirmation before we hit the API. Also surfaces the
  // found/cached/new breakdown so a fresh DB never silently looks like a
  // stale-cache no-op (the symptom of the state.db → vir.db rename bug).
  let preflightNew = 0;
  for (const found of discovered) {
    if (opts.full || !db.isProcessed(found.path, found.hash)) preflightNew += 1;
  }
  const cached = discovered.length - preflightNew;
  // Notes distilled but never embedded (write-time Ollama outage) — surfaced so
  // a retrieval blind spot is visible, not silent. Counts all three embeddable
  // layers (sessions + topics + articles) so the preflight matches exactly what
  // the end-of-run sweep back-fills. The sweep heals them when Ollama is up.
  const pendingEmbedding =
    db.listEmbeddingTargets().length +
    db.listTopicEmbeddingTargets().length +
    db.listArticleEmbeddingTargets().length;
  if (interactive) {
    ui.line(
      ui.dim(
        `  ${discovered.length} files found  ·  ${cached} cached  ·  ${preflightNew} new` +
          (pendingEmbedding > 0
            ? `  ·  ${pendingEmbedding} pending embedding`
            : ""),
      ),
    );
    ui.blank();
  }
  fileLog(
    `preflight: found=${discovered.length} cached=${cached} new=${preflightNew} pendingEmbedding=${pendingEmbedding}`,
  );

  // Nudge session-only installs toward hybrid routing. interactive is already
  // false under --quiet/--daemon, so this never prints on the daemon path.
  if (interactive && !cfg.models.distillFast) {
    ui.line(
      ui.dim(
        "  Tip: set models.distillFast to route routine sessions to Haiku (~50% cheaper).",
      ),
    );
    ui.blank();
  }

  // --dry-run: estimate per-session cost AFTER filtering but BEFORE any LLM
  // call, then exit. Output sizes + the input divisor are calibrated from real
  // cost.log data (output medians ran ~335 classify / ~4500 distill; code/JSON
  // transcripts tokenize denser than the chars/4 house heuristic, ~chars/3), so
  // the estimate lands in the right ballpark instead of ~5x low. Still rough —
  // deep sessions vary, and low-confidence drops aren't knowable without the LLM.
  if (opts.dryRun) {
    const classifyModel = normalizeModelName(cfg.models.classify, cfg.provider);
    const distillModel = normalizeModelName(
      resolveModelShorthand(opts.forceDistillModel ?? cfg.models.distill),
      cfg.provider,
    );
    const CLASSIFY_OUTPUT_TOKENS = 350;
    const DISTILL_OUTPUT_TOKENS = 4500;
    const CHARS_PER_TOKEN = 3;
    let totalCost = 0;
    let estimated = 0;
    let filteredOut = 0;
    for (const found of discovered) {
      if (!opts.full && db.isProcessed(found.path, found.hash)) continue;
      let parsed: ParsedSession;
      try {
        parsed = parseSession(found.path, found.hash);
      } catch {
        continue;
      }
      if (!scoreSession(parsed, cfg.filterThreshold).passes) {
        filteredOut += 1;
        continue;
      }
      const classifyIn = Math.ceil(
        scrub(parsed.rawSummary).length / CHARS_PER_TOKEN,
      );
      const distillIn = Math.ceil(
        scrub(filterToolCalls(parsed.transcriptText, cfg.filterToolCalls).filtered)
          .length / CHARS_PER_TOKEN,
      );
      const cost =
        computeCost(
          cfg.provider,
          classifyModel,
          classifyIn,
          CLASSIFY_OUTPUT_TOKENS,
          cfg.pricing,
        ) +
        computeCost(
          cfg.provider,
          distillModel,
          distillIn,
          DISTILL_OUTPUT_TOKENS,
          cfg.pricing,
        );
      totalCost += cost;
      estimated += 1;
      if (interactive) {
        const label = `${parsed.projectSlug}/${parsed.sessionId.slice(0, 8)}`;
        ui.line(
          `  ${label.padEnd(42)} ${ui.dim(`${(classifyIn + distillIn).toLocaleString()} in`)}  ${ui.warn(ui.formatUsd(cost))}`,
        );
      }
    }
    if (interactive) {
      ui.blank();
      ui.divider();
      ui.summary({
        sessions: { value: estimated, color: ui.info },
        "filtered out": { value: filteredOut, color: ui.dim },
        "est. total": { value: ui.formatUsd(totalCost), color: ui.warn },
      });
      ui.divider();
      ui.line(
        ui.dim(
          "  estimates assume typical output sizes; actuals may vary ±30%",
        ),
      );
    }
    fileLog(
      `dry-run: sessions=${estimated} filtered=${filteredOut} estTotal=${ui.formatUsd(totalCost)}`,
    );
    db.close();
    return summary;
  }

  if (opts.onConfirm) {
    const proceed = await opts.onConfirm(preflightNew);
    if (!proceed) {
      fileLog("aborted by user at cost prompt");
      db.close();
      return summary;
    }
  }

  for (const found of discovered) {
    try {
      if (!opts.full && db.isProcessed(found.path, found.hash)) {
        summary.alreadyProcessed += 1;
        continue;
      }

      const parsed = parseSession(found.path, found.hash);
      const filter = scoreSession(parsed, cfg.filterThreshold);

      if (!filter.passes) {
        summary.skippedByFilter += 1;
        db.record({
          path: found.path,
          hash: found.hash,
          skipped: true,
          notePaths: [],
        });
        continue;
      }

      const scrubbedSummary = scrub(parsed.rawSummary);
      const toolFilter = filterToolCalls(
        parsed.transcriptText,
        cfg.filterToolCalls,
      );
      if (toolFilter.tokensSaved > 1000 || toolFilter.skillResultsStripped > 0) {
        const skills =
          toolFilter.skillResultsStripped > 0
            ? `, ${toolFilter.skillResultsStripped} skill loads`
            : "";
        const msg = `filtered ${toolFilter.toolCallsStripped} tool results${skills}, saved ~${toolFilter.tokensSaved} tokens`;
        if (interactive) ui.line(ui.dim(`  ${msg}`));
        fileLog(msg);
      }
      const scrubbedContent = scrub(toolFilter.filtered);

      const note = await distiller.run(parsed, scrubbedSummary, scrubbedContent);
      if (!note) {
        summary.lowConfidence += 1;
        db.record({
          path: found.path,
          hash: found.hash,
          skipped: true,
          notePaths: [],
        });
        continue;
      }

      const written = await writer.write(parsed, note);
      summary.distilled += 1;
      summary.notesWritten.push(...written);
      db.record({
        path: found.path,
        hash: found.hash,
        skipped: false,
        notePaths: written,
        content: note.markdown,
        category: note.classification.category,
        topic: note.classification.topic,
        project: note.classification.project,
        confidence: note.classification.confidence,
        startedAt: parsed.startedAt,
      });
      if (interactive) {
        ui.categoryRow(note.classification.category, note.classification.topic);
      }
      fileLog(
        `distilled ${parsed.sessionId.slice(0, 8)} → ${note.classification.category}/${note.classification.topic}`,
      );
      if (note.classification.confidence >= 0.8) {
        notify(
          `Vir — new ${note.classification.category}`,
          `${note.classification.topic} · ${note.classification.project}`,
        );
      }
      const slug = kebab(note.classification.project);
      if (slug.length > 0) {
        newPerProject.set(slug, (newPerProject.get(slug) ?? 0) + 1);
      }
      await new Promise((r) => setTimeout(r, 2000));
    } catch (err) {
      summary.errored += 1;
      const msg = (err as Error).message ?? String(err);
      if (interactive) ui.row(ui.errorColor(ui.CROSS), ui.text(`error: ${msg}`));
      fileLog(`error on ${found.path}: ${msg}`);
      try {
        db.record({
          path: found.path,
          hash: found.hash,
          skipped: false,
          notePaths: [],
          error: msg,
        });
      } catch {
        // ignore record errors
      }
    }
  }

  for (const [slug, count] of newPerProject) {
    if (count < 3) continue;
    try {
      const res = await summarizeProject(cfg, slug, db);
      if (res) {
        if (interactive)
          ui.row(ui.success(ui.CHECK), ui.text(`summarized project/${slug}`));
        fileLog(`summarized project/${slug}`);
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (interactive)
        ui.row(
          ui.errorColor(ui.CROSS),
          ui.text(`summary failed for project/${slug}: ${msg}`),
        );
      fileLog(`summary failed for project/${slug}: ${msg}`);
    }
  }

  // Second input source: web articles. Gated on config; a session-only install
  // (no articlesDir) skips this entirely and behaves exactly as before.
  if (cfg.articlesDir && cfg.distillArticles) {
    await runArticlePhase(cfg, db, writer, summary, fileLog, interactive);
  }

  // Self-heal: back-fill notes whose write-time embedding silently no-op'd
  // (Ollama down during distill). Without this a transient outage is permanent
  // — the note never enters the embedding-search candidate set. Best-effort and
  // wrapped like the rest of run; a sweep failure must never fail the run. When
  // Ollama is still down the sweep no-ops and simply retries next pass.
  try {
    const sweep = await sweepEmbeddings(db);
    if (sweep.ran) {
      if (sweep.embedded > 0 || sweep.errors > 0) {
        fileLog(
          `embedding sweep: backfilled ${sweep.embedded}, ${sweep.errors} errors, ${sweep.pending} pending`,
        );
        if (interactive && sweep.embedded > 0) {
          ui.row(
            ui.success(ui.CHECK),
            ui.text(`backfilled ${sweep.embedded} note embedding(s)`),
          );
        }
      }
    } else if (sweep.pending > 0) {
      // Ollama down: inline maybeEmbed() no-op'd (writer.embedSkipped) and the
      // sweep couldn't run. One traceable line — it retries next run.
      fileLog(
        `embedding skipped, Ollama unavailable — ${sweep.pending} pending (${writer.embedSkipped} this run)`,
      );
      if (interactive) {
        ui.line(
          ui.dim(
            `  embedding skipped (Ollama unavailable) — ${sweep.pending} pending`,
          ),
        );
      }
    }
  } catch (err) {
    fileLog(`embedding sweep failed: ${(err as Error).message}`);
  }

  fileLog(
    `vir run done — scanned=${summary.scanned} new=${summary.scanned - summary.alreadyProcessed} distilled=${summary.distilled} skipped=${summary.skippedByFilter} lowConf=${summary.lowConfidence} errored=${summary.errored} articles=${summary.articlesDistilled}`,
  );

  if (interactive) {
    ui.blank();
    ui.divider();
    const stats: Record<string, ui.SummaryStat> = {
      scanned: { value: summary.scanned, color: ui.info },
      new: {
        value: summary.scanned - summary.alreadyProcessed,
        color: ui.info,
      },
      distilled: { value: summary.distilled, color: ui.success },
      skipped: { value: summary.skippedByFilter, color: ui.warn },
      errored: {
        value: summary.errored,
        color: summary.errored > 0 ? ui.errorColor : ui.dim,
      },
    };
    if (cfg.articlesDir && cfg.distillArticles) {
      stats.articles = { value: summary.articlesDistilled, color: ui.success };
    }
    ui.summary(stats);
    ui.divider();
  }

  db.close();
  return summary;
}

// Distill web articles from cfg.articlesDir into the vault, parallel to the
// session pipeline. Each article is hashed in SQLite for idempotency and
// wrapped in its own try/catch so one bad file never aborts the run.
async function runArticlePhase(
  cfg: Config,
  db: StateDb,
  writer: VaultWriter,
  summary: RunSummary,
  fileLog: (msg: string) => void,
  interactive: boolean,
): Promise<void> {
  if (!cfg.articlesDir) return;

  const scanSpinner = interactive
    ? ui.spinner("scanning articles").start()
    : null;
  let articles;
  try {
    articles = scanArticles(cfg.articlesDir);
  } catch (err) {
    if (scanSpinner) scanSpinner.fail(ui.errorColor("article scan failed"));
    fileLog(`article scan failed: ${(err as Error).message}`);
    return;
  }
  summary.articlesScanned = articles.length;
  if (scanSpinner) {
    scanSpinner.succeed(
      ui.text(
        `scanned ${ui.info(String(articles.length))} ${ui.dim("articles")}`,
      ),
    );
  }
  fileLog(`scanned ${articles.length} articles`);

  for (const article of articles) {
    try {
      if (db.isArticleProcessed(article.filePath, article.hash)) continue;

      const distilled = await distillArticle(article, cfg);
      if (!distilled) {
        summary.articlesSkipped += 1;
        db.recordArticle({
          path: article.filePath,
          hash: article.hash,
          skipped: true,
        });
        continue;
      }

      const notePath = await writer.writeArticle(article, distilled);
      summary.articlesDistilled += 1;
      summary.notesWritten.push(notePath);
      db.recordArticle({
        path: article.filePath,
        hash: article.hash,
        skipped: false,
        notePath,
        content: distilled.markdown,
        category: distilled.classification.category,
        title: article.title,
        url: article.url ?? null,
        author: article.author ?? null,
        published: article.publishedAt ?? null,
        confidence: distilled.classification.confidence,
        distilledAt: new Date().toISOString(),
      });
      if (interactive) {
        ui.categoryRow(distilled.classification.category, article.title);
      }
      fileLog(
        `distilled article → ${distilled.classification.category}/${article.title}`,
      );
      if (distilled.classification.confidence >= 0.8) {
        notify(
          `Vir — new ${distilled.classification.category}`,
          article.title,
        );
      }
      await new Promise((r) => setTimeout(r, 2000));
    } catch (err) {
      summary.articlesErrored += 1;
      const msg = (err as Error).message ?? String(err);
      if (interactive) {
        ui.row(ui.errorColor(ui.CROSS), ui.text(`article error: ${msg}`));
      }
      fileLog(`error on article ${article.filePath}: ${msg}`);
      try {
        db.recordArticle({
          path: article.filePath,
          hash: article.hash,
          skipped: false,
          error: msg,
        });
      } catch {
        // ignore record errors
      }
    }
  }
}

async function rewriteOne(
  writer: VaultWriter,
  row: import("../state/db.js").DistilledRow,
): Promise<string[]> {
  const parsed: ParsedSession = {
    path: row.path,
    hash: "",
    sessionId: row.sessionId,
    projectSlug: row.project,
    startedAt: row.startedAt,
    endedAt: null,
    lineCount: 0,
    toolCallCount: 0,
    filesTouched: [],
    assistantText: "",
    userText: "",
    rawSummary: "",
    transcriptText: "",
  };
  const note: DistilledNote = {
    classification: {
      category: row.category,
      topic: row.topic,
      project: row.project,
      confidence: row.confidence,
      // themes isn't a DB column — a rewrite-only pass carries none, so the
      // writer preserves the existing note's themes block from its frontmatter
      // (like the review fields). A --full re-distill re-emits fresh themes.
      themes: [],
    },
    markdown: row.content,
  };
  return writer.write(parsed, note, "rewrite");
}

// Desktop notification, platform-aware and best-effort. macOS uses osascript;
// Linux uses notify-send when present; every other platform silently skips.
// All paths use spawnSync arg-arrays (no shell, no injection) and the whole
// thing is wrapped so a notification failure never crashes the pipeline.
function notify(title: string, message: string): void {
  try {
    if (process.platform === "darwin") {
      const safeTitle = escapeAppleScript(title);
      const safeMessage = escapeAppleScript(message);
      spawnSync(
        "osascript",
        [
          "-e",
          `display notification "${safeMessage}" with title "${safeTitle}" sound name "Glass"`,
        ],
        { stdio: "ignore" },
      );
    } else if (process.platform === "linux") {
      const which = spawnSync("which", ["notify-send"], { stdio: "ignore" });
      if (which.status === 0) {
        spawnSync("notify-send", [title, message], { stdio: "ignore" });
      }
    }
    // win32 + everything else: no notification mechanism, skip silently.
  } catch {
    // notification failure must never crash the pipeline
  }
}

function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
