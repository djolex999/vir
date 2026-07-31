import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { DAEMON_LOG_PATH, ensureVirDir, type Config } from "../config.js";
import { StateDb } from "../state/db.js";
import * as ui from "../ui/display.js";
import {
  Distiller,
  maybeAnthropicClient,
  normalizeModelName,
  probeProvider,
  resolveModelShorthand,
} from "./distiller.js";
import { computeCost } from "../cost/pricing.js";
import { scoreSession } from "./filter.js";
import { parseSession } from "./parser.js";
import { scanSessions } from "./scanner.js";
import { scanArticles } from "./articleReader.js";
import { distillArticle } from "./articleDistiller.js";
import { parsePdf, scanPdfs } from "./pdfReader.js";
import { distillPdf } from "./pdfDistiller.js";
import {
  classifyTranscript,
  decideProject,
  groupByProject,
  estimateSessionCost,
  readTranscriptHead,
  sniffAgentEntrypoint,
  type ProjectDecision,
  type RunProjectFlags,
} from "./projects.js";
import type { SessionRow, SkipReason } from "../state/db.js";

// A row that holds a successfully distilled note. Neither filter may
// overwrite one: flipping it to skipped=1 would silently hide the note from
// listDistilled/embeddings/rewrite — a semi-prune, and both filters are
// forward-looking only. (Excluding stops FUTURE distills; it never touches
// what already exists.)
function isDistilledRow(row: SessionRow | undefined): boolean {
  return (
    row !== undefined &&
    row.skipped === 0 &&
    row.error === null &&
    row.content !== null &&
    row.content !== ""
  );
}
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
  // Distill only PDFs, skipping the session and article pipelines.
  pdfsOnly?: boolean;
  // Override models.distill for this run only (full id or "haiku"/"sonnet").
  forceDistillModel?: string;
  // Estimate per-session cost after filtering, print a table, and exit before
  // any LLM call. Skips the cost-confirmation prompt.
  dryRun?: boolean;
  // Called after the scan with the count of sessions that will be distilled.
  // Return false to abort cleanly. If omitted, the run always proceeds —
  // daemon callers rely on this default.
  onConfirm?: (newCount: number) => Promise<boolean>;
  // One-off project scoping for this run only — never persisted to config.
  onlyProjects?: string[];
  excludeProjects?: string[];
  // Called once when undecided projects hold new sessions; returns the
  // decisions to apply (the callback owns persisting them to config). When
  // omitted — the daemon path — the run NEVER prompts: pending sessions get
  // their "project-pending" DB row and a notification fires instead. A prompt
  // on the daemon path would hang holding the lock or silently default a
  // spend decision, so prompting only exists behind this injection point.
  onUndecidedProjects?: (
    pending: PendingProjectInfo[],
  ) => Promise<Record<string, "include" | "exclude">>;
}

export interface PendingProjectInfo {
  name: string;
  sessionCount: number;
  totalBytes: number;
  estCost: number;
}

export interface RunSummary {
  scanned: number;
  alreadyProcessed: number;
  skippedByFilter: number;
  distilled: number;
  lowConfidence: number;
  errored: number;
  // Sessions skipped by the project filter, before any paid call.
  projectExcluded: number;
  projectPending: number;
  flagSkipped: number;
  // Nested agent-internal transcripts skipped by the category filter
  // (workflowTranscripts: exclude) — also before any paid call.
  workflowSkipped: number;
  sidechainSkipped: number;
  // Top-level SDK-launched agent transcripts (agentTranscripts: exclude).
  agentSkipped: number;
  rewritten: number;
  notesWritten: string[];
  articlesScanned: number;
  articlesDistilled: number;
  articlesSkipped: number;
  articlesErrored: number;
  pdfsScanned: number;
  pdfsDistilled: number;
  pdfsSkipped: number;
  pdfsErrored: number;
}

// Per-document distill cost estimate for the article/PDF dry-run paths. Both run
// a Haiku classify + Sonnet distill with input bounded by the distiller's 24k
// char cap, so this is an accurate per-item figure (papers/long articles hit the
// cap). chars/3 matches the calibrated density used elsewhere in dry-run. Pure.
export function estimatePerDocDistillCost(
  cfg: Config,
  classifyModel: string,
  distillModel: string,
): number {
  const CPT = 3;
  return (
    computeCost(
      cfg.provider,
      classifyModel,
      Math.ceil(3000 / CPT),
      200,
      cfg.pricing,
      cfg.kieTopUpTier,
    ) +
    computeCost(
      cfg.provider,
      distillModel,
      Math.ceil(24_000 / CPT),
      1500,
      cfg.pricing,
      cfg.kieTopUpTier,
    )
  );
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
    projectExcluded: 0,
    projectPending: 0,
    flagSkipped: 0,
    workflowSkipped: 0,
    sidechainSkipped: 0,
    agentSkipped: 0,
    rewritten: 0,
    notesWritten: [],
    articlesScanned: 0,
    articlesDistilled: 0,
    articlesSkipped: 0,
    articlesErrored: 0,
    pdfsScanned: 0,
    pdfsDistilled: 0,
    pdfsSkipped: 0,
    pdfsErrored: 0,
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
            : opts.pdfsOnly
              ? "run  --pdfs-only"
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
    if (opts.dryRun) {
      if (interactive) {
        ui.blank();
        ui.divider();
        ui.summary({
          "would rewrite": { value: rows.length, color: ui.info },
        });
        ui.divider();
        ui.line(ui.dim("  dry run — no notes rewritten, no index regenerated"));
      }
      fileLog(`dry-run rewrite-only: would rewrite ${rows.length} notes`);
      db.close();
      return summary;
    }
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
    if (opts.dryRun) {
      dryRunDocPhase(cfg, db, opts, "article", interactive, fileLog);
      db.close();
      return summary;
    }
    await runArticlePhase(cfg, db, writer, summary, fileLog, interactive);
    await runEmbeddingSweep(db, writer, fileLog, interactive);
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

  // --pdfs-only: skip the session AND article pipelines.
  if (opts.pdfsOnly) {
    if (!cfg.pdfsDir) {
      if (interactive) {
        ui.row(
          ui.warn(ui.WARN_GLYPH),
          ui.text("pdfsDir is not set — nothing to distill"),
        );
      }
      fileLog("pdfs-only run but pdfsDir is unset");
      db.close();
      return summary;
    }
    if (opts.dryRun) {
      dryRunDocPhase(cfg, db, opts, "pdf", interactive, fileLog);
      db.close();
      return summary;
    }
    await runPdfPhase(cfg, db, writer, summary, fileLog, interactive);
    await runEmbeddingSweep(db, writer, fileLog, interactive);
    if (interactive) {
      ui.blank();
      ui.divider();
      ui.summary({
        pdfs: { value: summary.pdfsScanned, color: ui.info },
        distilled: { value: summary.pdfsDistilled, color: ui.success },
        skipped: { value: summary.pdfsSkipped, color: ui.warn },
        errored: {
          value: summary.pdfsErrored,
          color: summary.pdfsErrored > 0 ? ui.errorColor : ui.dim,
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

  // ── transcript-category filter (SCAN phase, upstream of projects) ────────
  // Nested workflow/sidechain transcripts are agent-internal execution, not
  // user knowledge — with the default "exclude" they're gated out before
  // grouping, so they never count as project sessions, pending spend, or
  // paid work. Rows are recorded (never silent) except under --dry-run,
  // which must stay side-effect free.
  let sessionsInScope = discovered;
  if (cfg.workflowTranscripts !== "include") {
    sessionsInScope = [];
    for (const s of discovered) {
      const cat = classifyTranscript(s.path, cfg.claudeProjectsDir);
      if (cat === "session") {
        sessionsInScope.push(s);
        continue;
      }
      const reason: SkipReason =
        cat === "workflow" ? "workflow-transcript" : "sidechain-transcript";
      if (cat === "workflow") summary.workflowSkipped += 1;
      else summary.sidechainSkipped += 1;
      if (!opts.dryRun) {
        const existing = db.getByPath(s.path);
        if (
          !isDistilledRow(existing) &&
          (existing?.hash !== s.hash || existing?.skip_reason !== reason)
        ) {
          db.record({
            path: s.path,
            hash: s.hash,
            skipped: true,
            notePaths: [],
            skipReason: reason,
          });
        }
      }
    }
    const filtered = summary.workflowSkipped + summary.sidechainSkipped;
    if (filtered > 0) {
      const msg = `${filtered} agent-internal transcript(s) excluded (${summary.workflowSkipped} workflow, ${summary.sidechainSkipped} sidechain) — workflowTranscripts: exclude`;
      if (interactive) ui.line(ui.dim(`  ${msg}`));
      fileLog(msg);
    }
  }

  // ── agent-transcript filter (SCAN phase, its own knob) ───────────────────
  // Top-level SDK-launched harness agents (review/verify) — detected by the
  // first user line's entrypoint starting with "sdk". Head-read only; a
  // truncated or unreadable head falls through to the parser backstop below,
  // still before any paid call.
  if (cfg.agentTranscripts !== "include") {
    const stillHuman: typeof sessionsInScope = [];
    for (const s of sessionsInScope) {
      const entrypoint = sniffAgentEntrypoint(readTranscriptHead(s.path));
      if (entrypoint === null) {
        stillHuman.push(s);
        continue;
      }
      summary.agentSkipped += 1;
      if (!opts.dryRun) {
        const existing = db.getByPath(s.path);
        if (
          !isDistilledRow(existing) &&
          (existing?.hash !== s.hash ||
            existing?.skip_reason !== "agent-transcript")
        ) {
          db.record({
            path: s.path,
            hash: s.hash,
            skipped: true,
            notePaths: [],
            skipReason: "agent-transcript",
            entrypoint,
          });
        }
      }
    }
    sessionsInScope = stillHuman;
    if (summary.agentSkipped > 0) {
      const msg = `${summary.agentSkipped} SDK-launched agent transcript(s) excluded — agentTranscripts: exclude`;
      if (interactive) ui.line(ui.dim(`  ${msg}`));
      fileLog(msg);
    }
  }

  // ── project filter (SCAN phase — before any paid call) ───────────────────
  // Decisions live in cfg.projects; absent = undecided, a real visible state.
  // Filtering here is load-bearing: classify is a paid Haiku call per new
  // session, so excluded/pending sessions must never reach the distiller.
  const projectFlags: RunProjectFlags = {
    only: opts.onlyProjects,
    excludeProject: opts.excludeProjects,
  };
  const projectGroups = groupByProject(sessionsInScope, cfg.claudeProjectsDir);
  const projectOf = new Map<string, string>();
  for (const group of projectGroups.values()) {
    for (const s of group.sessions) projectOf.set(s.path, group.name);
  }
  let projectDecisions: Record<string, "include" | "exclude"> = {
    ...cfg.projects,
  };
  const decisionFor = (path: string): ProjectDecision =>
    decideProject(projectOf.get(path) ?? "", projectDecisions, projectFlags);

  // Undecided projects holding NEW sessions are a spend decision with a
  // deadline (Claude Code prunes transcripts at ~30 days). Interactive
  // callers inject onUndecidedProjects and get asked once; the daemon path
  // records pending rows and notifies instead — it must never prompt.
  const classifyModelId = normalizeModelName(cfg.models.classify, cfg.provider);
  const distillModelId = normalizeModelName(
    resolveModelShorthand(opts.forceDistillModel ?? cfg.models.distill),
    cfg.provider,
  );
  const pendingProjects: PendingProjectInfo[] = [];
  for (const group of projectGroups.values()) {
    if (decideProject(group.name, projectDecisions, projectFlags) !== "pending")
      continue;
    const fresh = group.sessions.filter(
      (s) => opts.full === true || !db.isProcessed(s.path, s.hash),
    );
    if (fresh.length === 0) continue;
    const totalBytes = fresh.reduce((sum, s) => sum + s.size, 0);
    pendingProjects.push({
      name: group.name,
      sessionCount: fresh.length,
      totalBytes,
      estCost: fresh.reduce(
        (sum, s) =>
          sum +
          estimateSessionCost(
            cfg.provider,
            classifyModelId,
            distillModelId,
            s.size,
            cfg.pricing,
            cfg.kieTopUpTier,
          ),
        0,
      ),
    });
  }
  if (pendingProjects.length > 0 && opts.onUndecidedProjects && !opts.dryRun) {
    const answers = await opts.onUndecidedProjects(
      pendingProjects.sort((a, b) => b.estCost - a.estCost),
    );
    projectDecisions = { ...projectDecisions, ...answers };
  }

  // Precompute how many sessions actually need LLM work so the CLI can show
  // an accurate cost confirmation before we hit the API. Also surfaces the
  // found/cached/new breakdown so a fresh DB never silently looks like a
  // stale-cache no-op (the symptom of the state.db → vir.db rename bug).
  let preflightNew = 0;
  let preflightFiltered = 0;
  for (const found of sessionsInScope) {
    if (decisionFor(found.path) !== "include") {
      preflightFiltered += 1;
      continue;
    }
    if (opts.full || !db.isProcessed(found.path, found.hash)) preflightNew += 1;
  }
  const cached = sessionsInScope.length - preflightNew - preflightFiltered;
  // Notes distilled but never embedded (write-time Ollama outage) — surfaced so
  // a retrieval blind spot is visible, not silent. Counts all three embeddable
  // layers (sessions + topics + articles) so the preflight matches exactly what
  // the end-of-run sweep back-fills. The sweep heals them when Ollama is up.
  const pendingEmbedding =
    db.listEmbeddingTargets().length +
    db.listTopicEmbeddingTargets().length +
    db.listArticleEmbeddingTargets().length +
    db.listPdfEmbeddingTargets().length;
  if (interactive) {
    ui.line(
      ui.dim(
        `  ${discovered.length} files found  ·  ${cached} cached  ·  ${preflightNew} new` +
          (preflightFiltered > 0
            ? `  ·  ${preflightFiltered} project-filtered`
            : "") +
          (pendingEmbedding > 0
            ? `  ·  ${pendingEmbedding} pending embedding`
            : ""),
      ),
    );
    ui.blank();
  }
  fileLog(
    `preflight: found=${discovered.length} cached=${cached} new=${preflightNew} projectFiltered=${preflightFiltered} pendingEmbedding=${pendingEmbedding}`,
  );

  // 0.14.0 changed the default provider to anthropic (claude-sonnet-5). A kie
  // config keeps working exactly as configured — someone's config is not ours
  // to change — but surface the default change once per interactive run so
  // users who only ever accepted the old init default know the ground moved.
  if (interactive && cfg.provider === "kie") {
    ui.line(
      ui.dim(
        "  Note: the default provider is now anthropic (claude-sonnet-5). Your 'kie' setting is unchanged — run vir init to switch.",
      ),
    );
    ui.blank();
  }

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
    const classifyModel = classifyModelId;
    const distillModel = distillModelId;
    const CLASSIFY_OUTPUT_TOKENS = 350;
    const DISTILL_OUTPUT_TOKENS = 4500;
    const CHARS_PER_TOKEN = 3;
    let totalCost = 0;
    let estimated = 0;
    let filteredOut = 0;
    let dryExcluded = 0;
    let dryPending = 0;
    for (const found of sessionsInScope) {
      // Project-filtered sessions are outside the estimate: they will not be
      // distilled as things stand. Counted separately so they're never a
      // silent omission from the preview.
      const decision = decisionFor(found.path);
      if (decision !== "include") {
        if (decision === "exclude") dryExcluded += 1;
        else if (decision === "pending") dryPending += 1;
        continue;
      }
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
          cfg.kieTopUpTier,
        ) +
        computeCost(
          cfg.provider,
          distillModel,
          distillIn,
          DISTILL_OUTPUT_TOKENS,
          cfg.pricing,
          cfg.kieTopUpTier,
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
      const dryStats: Record<string, ui.SummaryStat> = {
        sessions: { value: estimated, color: ui.info },
        "filtered out": { value: filteredOut, color: ui.dim },
      };
      if (dryExcluded > 0) {
        dryStats.excluded = { value: dryExcluded, color: ui.dim };
      }
      if (dryPending > 0) {
        dryStats.undecided = { value: dryPending, color: ui.warn };
      }
      if (summary.workflowSkipped + summary.sidechainSkipped > 0) {
        dryStats.workflow = {
          value: summary.workflowSkipped + summary.sidechainSkipped,
          color: ui.dim,
        };
      }
      if (summary.agentSkipped > 0) {
        dryStats.agent = { value: summary.agentSkipped, color: ui.dim };
      }
      dryStats["est. total"] = { value: ui.formatUsd(totalCost), color: ui.warn };
      ui.summary(dryStats);
      ui.divider();
      if (dryPending > 0) {
        ui.line(
          ui.dim(
            `  ${dryPending} session(s) in undecided projects — run vir projects to include/exclude them`,
          ),
        );
      }
      ui.line(
        ui.dim(
          "  estimates assume typical output sizes; actuals may vary ±30%",
        ),
      );
    }
    // PDFs are estimated separately: papers exceed the 24k-char distill cap, so
    // the per-PDF input is the cap (an accurate figure, not just an upper bound).
    // No text extraction here — only count new PDFs by their cheap byte hash.
    if (cfg.pdfsDir && cfg.distillPdfs) {
      const newPdfs = scanPdfs(cfg.pdfsDir).filter(
        (f) => opts.full || !db.isPdfProcessed(f.filePath, f.hash),
      ).length;
      if (newPdfs > 0) {
        const perPdf = estimatePerDocDistillCost(cfg, classifyModel, distillModel);
        if (interactive) {
          ui.line(
            ui.dim(
              `  ${newPdfs} new PDF(s): ~${ui.formatUsd(perPdf)} each (input capped at 24k chars) → ~${ui.formatUsd(perPdf * newPdfs)}`,
            ),
          );
        }
        fileLog(
          `dry-run: newPdfs=${newPdfs} perPdf=${ui.formatUsd(perPdf)} estTotal=${ui.formatUsd(perPdf * newPdfs)}`,
        );
      }
    }
    fileLog(
      `dry-run: sessions=${estimated} filtered=${filteredOut} excluded=${dryExcluded} pending=${dryPending} estTotal=${ui.formatUsd(totalCost)}`,
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

  // One cheap probe before the loop: a provider-wide outage should be ONE
  // clear failure, not N sessions each burning full retry chains and
  // attempt-counter increments. Skipped when there is nothing to distill.
  if (preflightNew > 0) {
    try {
      await probeProvider(cfg, maybeAnthropicClient(cfg));
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      fileLog(`provider preflight failed: ${msg}`);
      if (interactive) {
        ui.row(
          ui.errorColor(ui.CROSS),
          ui.text(`provider ${cfg.provider} unreachable — ${msg}`),
        );
      }
      db.close();
      throw new Error(
        `provider ${cfg.provider} unreachable (preflight probe failed): ${msg}`,
      );
    }
  }

  for (const found of sessionsInScope) {
    try {
      // Project filter FIRST — before the cache check and long before any
      // paid call. Every config-driven skip gets its DB row and reason;
      // one-off flag skips record nothing (they say nothing about state).
      const decision = decisionFor(found.path);
      if (decision === "flag-skip") {
        summary.flagSkipped += 1;
        continue;
      }
      if (decision === "exclude" || decision === "pending") {
        const reason =
          decision === "exclude" ? "project-excluded" : "project-pending";
        if (decision === "exclude") summary.projectExcluded += 1;
        else summary.projectPending += 1;
        const existing = db.getByPath(found.path);
        if (
          !isDistilledRow(existing) &&
          (existing?.hash !== found.hash || existing?.skip_reason !== reason)
        ) {
          db.record({
            path: found.path,
            hash: found.hash,
            skipped: true,
            notePaths: [],
            skipReason: reason,
          });
        }
        continue;
      }

      if (!opts.full && db.isProcessed(found.path, found.hash)) {
        summary.alreadyProcessed += 1;
        continue;
      }

      // Retry bound: MAX_DISTILL_ATTEMPTS consecutive failures park the
      // session — even under --full — so the daemon can't burn money on a
      // persistently failing transcript. `vir reconcile --force` is the only
      // way back in (it resets the counter on success).
      if (db.retryExhausted(found.path)) {
        summary.alreadyProcessed += 1;
        fileLog(`retry-exhausted, skipping: ${found.path}`);
        continue;
      }

      const parsed = parseSession(found.path, found.hash);

      // Parser backstop for the transcript-category filter: a sidechain by
      // CONTENT (isSidechain in the JSONL) that structural detection missed
      // — e.g. a future layout change — still stops before any paid call.
      if (cfg.workflowTranscripts !== "include" && parsed.isSidechain) {
        summary.sidechainSkipped += 1;
        // Same no-overwrite rule as the structural gate: a changed transcript
        // whose row already holds a distilled note keeps that note visible.
        if (!isDistilledRow(db.getByPath(found.path))) {
          db.record({
            path: found.path,
            hash: found.hash,
            skipped: true,
            notePaths: [],
            skipReason: "sidechain-transcript",
          });
        }
        fileLog(`sidechain by content, skipping: ${found.path}`);
        continue;
      }

      // Agent-transcript backstop: the SDK launch signature seen by the full
      // parse when the scan-time head sniff missed it (truncated head, field
      // moved). Still pre-classify, so still free.
      if (
        cfg.agentTranscripts !== "include" &&
        typeof parsed.entrypoint === "string" &&
        parsed.entrypoint.startsWith("sdk")
      ) {
        summary.agentSkipped += 1;
        if (!isDistilledRow(db.getByPath(found.path))) {
          db.record({
            path: found.path,
            hash: found.hash,
            skipped: true,
            notePaths: [],
            skipReason: "agent-transcript",
            entrypoint: parsed.entrypoint,
          });
        }
        fileLog(`sdk agent by content, skipping: ${found.path}`);
        continue;
      }

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
        entrypoint: parsed.entrypoint,
      });
      if (interactive) {
        ui.categoryRow(note.classification.category, note.classification.topic);
      }
      fileLog(
        `distilled ${parsed.sessionId.slice(0, 8)} → ${note.classification.category}/${note.classification.topic}`,
      );
      if (note.classification.confidence >= 0.8 && cfg.notifications !== false) {
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
        // recordError, not record: writing the hash on a failed attempt would
        // mark the transcript processed and hide it from every future run.
        db.recordError(found.path, found.hash, msg);
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

  // Surface undecided projects — one log line and (config-gated) one macOS
  // notification. Never a prompt: this is the daemon-safe path. Recomputed
  // post-loop so interactively answered projects don't re-notify.
  if (summary.projectPending > 0) {
    const stillPending = new Set<string>();
    for (const group of projectGroups.values()) {
      if (
        decideProject(group.name, projectDecisions, projectFlags) === "pending"
      ) {
        stillPending.add(group.name);
      }
    }
    const msg = `${summary.projectPending} session(s) across ${stillPending.size} project(s) awaiting include/exclude decision — run vir projects`;
    fileLog(msg);
    if (interactive) ui.line(ui.dim(`  ${msg}`));
    if (cfg.notifications !== false && process.platform === "darwin") {
      notify(
        "vir — projects awaiting decision",
        `${stillPending.size} project(s), ${summary.projectPending} session(s) pending — run vir projects`,
      );
    }
  }

  // Second input source: web articles. Gated on config; a session-only install
  // (no articlesDir) skips this entirely and behaves exactly as before.
  if (cfg.articlesDir && cfg.distillArticles) {
    await runArticlePhase(cfg, db, writer, summary, fileLog, interactive);
  }

  // Third input source: PDFs / papers. Gated identically; an install without
  // pdfsDir skips this entirely (the article pattern, cloned).
  if (cfg.pdfsDir && cfg.distillPdfs) {
    await runPdfPhase(cfg, db, writer, summary, fileLog, interactive);
  }

  // Self-heal: back-fill notes whose write-time embedding silently no-op'd
  // (Ollama down during distill). Without this a transient outage is permanent
  // — the note never enters the embedding-search candidate set.
  await runEmbeddingSweep(db, writer, fileLog, interactive);

  fileLog(
    `vir run done — scanned=${summary.scanned} new=${summary.scanned - summary.alreadyProcessed} distilled=${summary.distilled} skipped=${summary.skippedByFilter} lowConf=${summary.lowConfidence} errored=${summary.errored} projectExcluded=${summary.projectExcluded} projectPending=${summary.projectPending} flagSkipped=${summary.flagSkipped} workflowSkipped=${summary.workflowSkipped} sidechainSkipped=${summary.sidechainSkipped} agentSkipped=${summary.agentSkipped} articles=${summary.articlesDistilled} pdfs=${summary.pdfsDistilled}`,
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
    if (summary.projectExcluded > 0) {
      stats.excluded = { value: summary.projectExcluded, color: ui.dim };
    }
    if (summary.projectPending > 0) {
      stats.undecided = { value: summary.projectPending, color: ui.warn };
    }
    if (summary.workflowSkipped + summary.sidechainSkipped > 0) {
      stats.workflow = {
        value: summary.workflowSkipped + summary.sidechainSkipped,
        color: ui.dim,
      };
    }
    if (summary.agentSkipped > 0) {
      stats.agent = { value: summary.agentSkipped, color: ui.dim };
    }
    if (cfg.articlesDir && cfg.distillArticles) {
      stats.articles = { value: summary.articlesDistilled, color: ui.success };
    }
    if (cfg.pdfsDir && cfg.distillPdfs) {
      stats.pdfs = { value: summary.pdfsDistilled, color: ui.success };
    }
    ui.summary(stats);
    ui.divider();
  }

  db.close();
  return summary;
}

// Best-effort embedding back-fill, shared by the full run AND the --articles-
// only / --pdfs-only shortcuts (so an inline-embed miss self-heals in the same
// invocation rather than waiting for the next full run). A sweep failure must
// never fail the run; when Ollama is down it no-ops and retries next pass.
async function runEmbeddingSweep(
  db: StateDb,
  writer: VaultWriter,
  fileLog: (msg: string) => void,
  interactive: boolean,
): Promise<void> {
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
}

// Dry-run preview for the --articles-only / --pdfs-only shortcuts: count the
// items that WOULD be distilled and show the per-item + total estimated cost,
// then exit. Never makes a provider call — the bug this fixes is that these
// shortcuts used to ignore --dry-run and distill for real.
function dryRunDocPhase(
  cfg: Config,
  db: StateDb,
  opts: RunOptions,
  kind: "article" | "pdf",
  interactive: boolean,
  fileLog: (msg: string) => void,
): void {
  const classifyModel = normalizeModelName(cfg.models.classify, cfg.provider);
  const distillModel = normalizeModelName(
    resolveModelShorthand(opts.forceDistillModel ?? cfg.models.distill),
    cfg.provider,
  );
  const per = estimatePerDocDistillCost(cfg, classifyModel, distillModel);

  let count = 0;
  if (kind === "article" && cfg.articlesDir) {
    count = scanArticles(cfg.articlesDir).filter(
      (a) => opts.full || !db.isArticleProcessed(a.filePath, a.hash),
    ).length;
  } else if (kind === "pdf" && cfg.pdfsDir) {
    count = scanPdfs(cfg.pdfsDir).filter(
      (f) => opts.full || !db.isPdfProcessed(f.filePath, f.hash),
    ).length;
  }

  if (interactive) {
    ui.blank();
    ui.divider();
    ui.summary({
      [kind === "article" ? "articles" : "pdfs"]: {
        value: count,
        color: ui.info,
      },
      "per item": { value: ui.formatUsd(per), color: ui.warn },
      "est. total": { value: ui.formatUsd(per * count), color: ui.warn },
    });
    ui.divider();
    ui.line(
      ui.dim(
        kind === "pdf"
          ? "  dry run — no distillation performed (input capped at 24k chars)"
          : "  dry run — no distillation performed",
      ),
    );
  }
  fileLog(
    `dry-run ${kind}s-only: new=${count} perItem=${ui.formatUsd(per)} estTotal=${ui.formatUsd(per * count)}`,
  );
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
      if (
        distilled.classification.confidence >= 0.8 &&
        cfg.notifications !== false
      ) {
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

// Third input source: PDFs / papers. Mirrors runArticlePhase, but scanPdfs
// returns cheap {path, hash} entries (PDF text extraction is expensive via
// pdf.js) and only files that aren't already processed get parsed — instead of
// extracting the whole directory up front. Each PDF is hashed for idempotency
// and wrapped in its own try/catch so one bad file never aborts the run.
async function runPdfPhase(
  cfg: Config,
  db: StateDb,
  writer: VaultWriter,
  summary: RunSummary,
  fileLog: (msg: string) => void,
  interactive: boolean,
): Promise<void> {
  if (!cfg.pdfsDir) return;

  const scanSpinner = interactive ? ui.spinner("scanning pdfs").start() : null;
  let sources;
  try {
    sources = scanPdfs(cfg.pdfsDir);
  } catch (err) {
    if (scanSpinner) scanSpinner.fail(ui.errorColor("pdf scan failed"));
    fileLog(`pdf scan failed: ${(err as Error).message}`);
    return;
  }
  summary.pdfsScanned = sources.length;
  if (scanSpinner) {
    scanSpinner.succeed(
      ui.text(`scanned ${ui.info(String(sources.length))} ${ui.dim("pdfs")}`),
    );
  }
  fileLog(`scanned ${sources.length} pdfs`);

  for (const src of sources) {
    try {
      if (db.isPdfProcessed(src.filePath, src.hash)) continue;

      // Extraction is heavy and only happens for new files (gated above).
      const parsed = await parsePdf(src.filePath);
      const distilled = await distillPdf(parsed, cfg);
      if (!distilled) {
        summary.pdfsSkipped += 1;
        db.recordPdf({
          path: parsed.filePath,
          hash: parsed.hash,
          skipped: true,
        });
        continue;
      }

      const notePath = await writer.writePdf(parsed, distilled);
      summary.pdfsDistilled += 1;
      summary.notesWritten.push(notePath);
      db.recordPdf({
        path: parsed.filePath,
        hash: parsed.hash,
        skipped: false,
        notePath,
        content: distilled.markdown,
        category: distilled.classification.category,
        title: parsed.title,
        pages: parsed.pageCount,
        confidence: distilled.classification.confidence,
        distilledAt: new Date().toISOString(),
      });
      if (interactive) {
        ui.categoryRow(distilled.classification.category, parsed.title);
      }
      fileLog(
        `distilled pdf → ${distilled.classification.category}/${parsed.title}`,
      );
      if (
        distilled.classification.confidence >= 0.8 &&
        cfg.notifications !== false
      ) {
        notify(`Vir — new ${distilled.classification.category}`, parsed.title);
      }
      await new Promise((r) => setTimeout(r, 2000));
    } catch (err) {
      summary.pdfsErrored += 1;
      const msg = (err as Error).message ?? String(err);
      if (interactive) {
        ui.row(ui.errorColor(ui.CROSS), ui.text(`pdf error: ${msg}`));
      }
      fileLog(`error on pdf ${src.filePath}: ${msg}`);
      try {
        // Record with the source hash so a corrupt PDF isn't retried every run
        // (same idempotency contract as articles).
        db.recordPdf({
          path: src.filePath,
          hash: src.hash,
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
    isSidechain: false,
    entrypoint: null,
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
