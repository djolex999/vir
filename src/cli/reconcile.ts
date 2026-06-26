import chalk from "chalk";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { Config } from "../config.js";
import { readCostLog } from "../cost/log.js";
import { computeCost } from "../cost/pricing.js";
import { Distiller, normalizeModelName, resolveModelShorthand } from "../pipeline/distiller.js";
import { scoreSession } from "../pipeline/filter.js";
import { parseSession } from "../pipeline/parser.js";
import { scrub } from "../pipeline/scrubber.js";
import { filterToolCalls } from "../pipeline/toolCallFilter.js";
import { VaultWriter } from "../pipeline/writer.js";
import { deriveSessionId, StateDb, type SessionRow } from "../state/db.js";
import * as ui from "../ui/display.js";

export interface ReconcileOptions {
  dryRun?: boolean;
  yes?: boolean;
}

// Cost-estimate constants must stay in sync with run.ts's dry-run estimator —
// transcripts tokenize denser than the chars/4 house heuristic, ~chars/3, and
// classify/distill output medians come from real cost.log calibration.
const CHARS_PER_TOKEN = 3;
const CLASSIFY_OUTPUT_TOKENS = 350;
const DISTILL_OUTPUT_TOKENS = 4500;

// Pure selector for unit tests. Mirrors the SQL filter in
// db.listReconcileTargets exactly: skipped=0 (we tried to distill) AND
// content is null-or-empty (no usable output landed).
//
// Both shapes share one cause — pre-0.7.2 the Kie-200-with-body-error path
// silently produced an empty distill string; errored runs landed as null.
// Reconcile retries either.
export function selectReconcileTargets(rows: SessionRow[]): SessionRow[] {
  return rows.filter(
    (r) => r.skipped === 0 && (r.content === null || r.content === ""),
  );
}

export interface ReconcileTargetSummary {
  path: string;
  sessionId: string;
  hadCostRecord: boolean;
  estimatedCost: number;
}

// Build the per-target summary (cost estimate + collateral flag) without doing
// any network work. Used by both the dry-run report and the live confirmation.
export function summarizeReconcileTargets(
  cfg: Config,
  targets: SessionRow[],
  costSessionIds: Set<string>,
  forceDistillModel?: string,
): {
  rows: ReconcileTargetSummary[];
  totalCost: number;
  collateralCount: number;
} {
  const classifyModel = normalizeModelName(cfg.models.classify, cfg.provider);
  const distillModel = normalizeModelName(
    resolveModelShorthand(forceDistillModel ?? cfg.models.distill),
    cfg.provider,
  );
  let totalCost = 0;
  let collateralCount = 0;
  const rows: ReconcileTargetSummary[] = [];

  for (const t of targets) {
    const sessionId = deriveSessionId(t.path);
    const hadCostRecord = costSessionIds.has(sessionId);
    if (hadCostRecord) collateralCount += 1;

    let estimatedCost = 0;
    if (existsSync(t.path)) {
      try {
        const parsed = parseSession(t.path, t.hash);
        const classifyIn = Math.ceil(
          scrub(parsed.rawSummary).length / CHARS_PER_TOKEN,
        );
        const distillIn = Math.ceil(
          scrub(
            filterToolCalls(parsed.transcriptText, cfg.filterToolCalls).filtered,
          ).length / CHARS_PER_TOKEN,
        );
        estimatedCost =
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
      } catch {
        // Bad jsonl now — we'll still attempt retry, but skip the estimate.
      }
    }
    totalCost += estimatedCost;
    rows.push({
      path: t.path,
      sessionId,
      hadCostRecord,
      estimatedCost,
    });
  }
  return { rows, totalCost, collateralCount };
}

async function confirmReconcile(targetCount: number, totalCost: number): Promise<boolean> {
  ui.box(
    [
      `${ui.text(String(targetCount))} ${ui.dim("sessions to retry")}`,
      `${ui.dim("estimated:")} ${ui.warn(ui.formatUsd(totalCost))}`,
    ],
    { title: "reconcile cost estimate" },
  );
  const rl = createInterface({ input: stdin, output: stdout });
  const ans = (await rl.question(ui.muted("continue? (y/n) ")))
    .trim()
    .toLowerCase();
  rl.close();
  return ans === "y" || ans === "yes";
}

export async function runReconcile(
  cfg: Config,
  opts: ReconcileOptions = {},
): Promise<void> {
  const db = new StateDb();
  try {
    ui.header(opts.dryRun ? "reconcile  --dry-run" : "reconcile");
    ui.blank();

    const targets = db.listReconcileTargets();
    if (targets.length === 0) {
      ui.row(
        ui.success(ui.CHECK),
        ui.text("nothing to reconcile — every session has content"),
      );
      return;
    }

    // Build the set of session IDs that already have any distill cost record,
    // so we can report "false-cost collateral" — sessions we paid for but got
    // no content from.
    const costSessionIds = new Set<string>();
    for (const r of readCostLog()) {
      if (r.stage === "distill" && r.session && r.estimated_cost_usd > 0) {
        costSessionIds.add(r.session);
      }
    }

    const { rows, totalCost, collateralCount } = summarizeReconcileTargets(
      cfg,
      targets,
      costSessionIds,
    );

    for (const r of rows) {
      const id = r.sessionId.slice(0, 8);
      const marker = r.hadCostRecord ? ui.warn("$") : ui.dim(" ");
      ui.line(
        `  ${ui.dim(ui.BULLET)} ${marker} ${ui.text(id.padEnd(10))}  ${ui.dim(`est ${ui.formatUsd(r.estimatedCost)}`)}`,
      );
    }
    ui.blank();
    ui.divider();
    ui.summary({
      recoverable: { value: rows.length, color: ui.info },
      "est. retry cost": { value: ui.formatUsd(totalCost), color: ui.warn },
      "false-cost collateral": {
        value: collateralCount,
        color: collateralCount > 0 ? ui.warn : ui.dim,
      },
    });
    ui.divider();

    if (opts.dryRun) {
      ui.line(
        ui.dim(
          "  dry run — nothing retried. Collateral count = sessions we paid for but got no content from.",
        ),
      );
      return;
    }

    if (opts.yes !== true) {
      const proceed = await confirmReconcile(rows.length, totalCost);
      if (!proceed) {
        ui.line(ui.dim("aborted"));
        return;
      }
    }

    const writer = new VaultWriter(cfg, db);
    const distiller = new Distiller(cfg);
    let recovered = 0;
    let stillFailed = 0;
    let missingFile = 0;

    for (const t of targets) {
      if (!existsSync(t.path)) {
        missingFile += 1;
        ui.row(
          ui.warn(ui.WARN_GLYPH),
          ui.text(`missing on disk — skipped: ${t.path.slice(-60)}`),
        );
        continue;
      }
      // Bypass the SHA-256 processed-cache check intentionally — these rows
      // are cached but we know their stored content is empty, so we want a
      // forced retry. Parse, score, distill, then update the row in place.
      try {
        const parsed = parseSession(t.path, t.hash);
        const score = scoreSession(parsed, cfg.filterThreshold);
        if (!score.passes) {
          // The filter rejects this now — record as skipped so a future
          // reconcile pass doesn't keep retrying it.
          db.record({
            path: t.path,
            hash: t.hash,
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
        const scrubbedContent = scrub(toolFilter.filtered);
        const note = await distiller.run(
          parsed,
          scrubbedSummary,
          scrubbedContent,
        );
        if (!note) {
          // Low confidence — record as skipped so we don't keep retrying.
          db.record({
            path: t.path,
            hash: t.hash,
            skipped: true,
            notePaths: [],
          });
          continue;
        }
        const written = await writer.write(parsed, note);
        db.record({
          path: t.path,
          hash: t.hash,
          skipped: false,
          notePaths: written,
          content: note.markdown,
          category: note.classification.category,
          topic: note.classification.topic,
          project: note.classification.project,
          confidence: note.classification.confidence,
          startedAt: parsed.startedAt,
        });
        recovered += 1;
        ui.categoryRow(
          note.classification.category,
          note.classification.topic,
        );
        // Same pacing as run.ts — let the provider breathe between calls.
        await new Promise((r) => setTimeout(r, 2000));
      } catch (err) {
        // A retry that fails again must leave the row as-is (content still
        // null/empty) so the next reconcile pass can catch it. Do NOT mark
        // it processed-with-empty.
        stillFailed += 1;
        const msg = (err as Error).message ?? String(err);
        ui.row(
          ui.errorColor(ui.CROSS),
          ui.text(`retry failed: ${deriveSessionId(t.path).slice(0, 8)} — ${msg}`),
        );
      }
    }

    ui.blank();
    ui.divider();
    ui.summary({
      recovered: { value: recovered, color: ui.success },
      "still failed": {
        value: stillFailed,
        color: stillFailed > 0 ? ui.errorColor : ui.dim,
      },
      "missing file": {
        value: missingFile,
        color: missingFile > 0 ? ui.warn : ui.dim,
      },
    });
    ui.divider();

    // Surface "still failed" via a non-zero exit so the caller (or a CI
    // harness running reconcile periodically) knows recovery is incomplete.
    // The wrapper in cli.ts treats `process.exitCode = 1` as the failure
    // signal; we DON'T throw because the partial recovery is real progress.
    if (stillFailed > 0) {
      process.exitCode = 1;
      ui.line(
        chalk.dim(
          `  ${stillFailed} session(s) still failed — re-run \`vir reconcile\` after the underlying cause is fixed`,
        ),
      );
    }
  } finally {
    db.close();
  }
}
