import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { DAEMON_LOG_PATH, ensureVirDir, type Config } from "../config.js";
import { StateDb } from "../state/db.js";
import * as ui from "../ui/display.js";
import { Distiller } from "./distiller.js";
import { scoreSession } from "./filter.js";
import { parseSession } from "./parser.js";
import { scanSessions } from "./scanner.js";
import { scrub } from "./scrubber.js";
import { summarizeProject } from "./summarizer.js";
import type { DistilledNote, ParsedSession } from "./types.js";
import { kebab, VaultWriter } from "./writer.js";

export interface RunOptions {
  full?: boolean;
  quiet?: boolean;
  logToFile?: boolean;
  rewriteOnly?: boolean;
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
      opts.rewriteOnly
        ? "run  --rewrite-only"
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

  const distiller = new Distiller(cfg);
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
  if (interactive) {
    ui.line(
      ui.dim(
        `  ${discovered.length} files found  ·  ${cached} cached  ·  ${preflightNew} new`,
      ),
    );
    ui.blank();
  }
  fileLog(
    `preflight: found=${discovered.length} cached=${cached} new=${preflightNew}`,
  );
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
      const scrubbedContent = scrub(
        parsed.assistantText + "\n\n" + parsed.userText,
      );

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

  fileLog(
    `vir run done — scanned=${summary.scanned} new=${summary.scanned - summary.alreadyProcessed} distilled=${summary.distilled} skipped=${summary.skippedByFilter} lowConf=${summary.lowConfidence} errored=${summary.errored}`,
  );

  if (interactive) {
    ui.blank();
    ui.divider();
    ui.summary({
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
    });
    ui.divider();
  }

  db.close();
  return summary;
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
  };
  const note: DistilledNote = {
    classification: {
      category: row.category,
      topic: row.topic,
      project: row.project,
      confidence: row.confidence,
    },
    markdown: row.content,
  };
  return writer.write(parsed, note);
}

// macOS notification via osascript. Uses spawnSync (no shell, no injection).
// Embedded values are escaped for AppleScript's string literal rules.
function notify(title: string, message: string): void {
  if (process.platform !== "darwin") return;
  try {
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
  } catch {
    // notification failure must never crash the pipeline
  }
}

function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
