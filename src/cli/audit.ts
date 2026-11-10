import confirm from "@inquirer/confirm";
import { loadConfig, type Config } from "../config.js";
import {
  loadEvidence,
  runGround,
  selectGroundRows,
  type GroundOptions,
  type GroundSummary,
} from "../audit/ground.js";
import { buildSources } from "../sources/registry.js";
import { checkTranscriptsAfterRun } from "../audit/afterRun.js";
import { appendRunLog } from "../pipeline/run.js";
import {
  callLLM,
  maybeAnthropicClient,
  normalizeModelName,
  resolveModelShorthand,
  withRateLimitRetry,
} from "../pipeline/distiller.js";
import { applyAuditRejects, previewRejects } from "../audit/apply.js";
import { batchByProject } from "../audit/batch.js";
import {
  noteIsVerified,
  parseLimitOption,
  runAudit,
  selectAuditRows,
} from "../audit/run.js";
import { vaultRoot } from "../search/retriever.js";
import { StateDb, type DistilledRow } from "../state/db.js";
import * as ui from "../ui/display.js";
import { estCostLabel } from "./costLabel.js";
import { withPipelineLock } from "./guards.js";

export async function auditCommand(
  opts: {
        project?: string;
        limit?: string;
        all?: boolean;
        model?: string;
        dryRun?: boolean;
        yes?: boolean;
        applyRejects?: boolean;
        transcript?: boolean;
      },
): Promise<void> {
  if (opts.transcript && opts.applyRejects) {
    ui.header("audit");
    ui.blank();
    ui.row(ui.errorColor(ui.CROSS), ui.text("--transcript and --apply-rejects are separate steps; run one at a time"));
    process.exitCode = 1;
    return;
  }
  const limit = parseLimitOption(opts.limit);
  if (limit === null) {
    ui.header("audit");
    ui.blank();
    ui.row(ui.errorColor(ui.CROSS), ui.text(`--limit must be a positive integer, got "${opts.limit}"`));
    process.exitCode = 1;
    return;
  }

  const cfg = loadConfig();
  const db = new StateDb();
  try {
    const root = vaultRoot(cfg);

    if (opts.applyRejects) {
      const { toMove: targets, verified } = previewRejects(
        db.listDistilled(),
        db.listAudits(),
        (r) => noteIsVerified(root, r),
        opts.project,
      );
      ui.header("audit");
      ui.blank();
      ui.summary({
        rejects: { value: targets.length, color: ui.errorColor },
        "approved, skipped": { value: verified.length, color: verified.length > 0 ? ui.warn : ui.muted },
      });
      for (const r of targets.slice(0, 20)) ui.line(`  ${ui.dim(ui.BULLET)} ${ui.text(r.topic)} ${ui.dim(r.project)}`);
      if (targets.length > 20) ui.line(ui.dim(`  … and ${targets.length - 20} more`));
      ui.divider();
      if (targets.length === 0 || opts.dryRun) {
        if (opts.dryRun) ui.line(ui.dim("  dry run — nothing moved"));
        return;
      }
      if (opts.yes !== true) {
        const proceed = await confirm({ message: `move ${targets.length} notes to .rejected/?`, default: false });
        if (!proceed) {
          ui.line(ui.dim("aborted"));
          return;
        }
      }
      const s = applyAuditRejects(db, root, { project: opts.project });
      ui.summary({
        moved: { value: s.moved, color: ui.info },
        "missing file": { value: s.missingFile, color: ui.muted },
        collision: { value: s.collision, color: s.collision > 0 ? ui.warn : ui.muted },
        verified: { value: s.verified, color: s.verified > 0 ? ui.warn : ui.muted },
      });
      ui.line(ui.dim("  undo any of them with `vir review --restore <note>`"));
      return;
    }

    const auditOpts = { project: opts.project, limit, all: opts.all };
    const isVerified = (r: DistilledRow): boolean => noteIsVerified(root, r);
    const model = normalizeModelName(
      resolveModelShorthand(opts.model ?? cfg.models.distill),
      cfg.provider,
    );

    if (opts.transcript) {
      await transcriptCheck(cfg, db, auditOpts, isVerified, model, opts);
      return;
    }

    const picked = selectAuditRows(db.listDistilled(), db.listAudits(), auditOpts, isVerified);
    const batches = batchByProject(picked.rows);
    const inputTokens = Math.ceil(
      picked.rows.reduce((n, r) => n + r.content.length, 0) / 4 + batches.length * 600,
    );
    const outputTokens = picked.rows.length * 60;
    const estCost = estCostLabel(cfg, model, inputTokens, outputTokens);

    ui.header("audit");
    ui.blank();
    ui.summary({
      notes: { value: picked.rows.length, color: ui.info },
      batches: { value: batches.length, color: ui.info },
      "already audited": { value: picked.skippedFresh, color: ui.muted },
      verified: { value: picked.skippedVerified, color: ui.muted },
      model: { value: model, color: ui.accent },
      "est. cost": { value: estCost, color: ui.warn },
    });
    ui.divider();
    if (picked.rows.length === 0) {
      ui.row(ui.success(ui.CHECK), ui.text("nothing to audit"));
      return;
    }
    if (opts.dryRun) {
      ui.line(ui.dim("  dry run — no model calls made"));
      return;
    }
    if (opts.yes !== true) {
      const proceed = await confirm({ message: `audit ${picked.rows.length} notes with ${model} (~${estCost})?`, default: true });
      if (!proceed) {
        ui.line(ui.dim("aborted"));
        return;
      }
    }

    const client = maybeAnthropicClient(cfg);
    // Judging writes verdicts to the DB: hold the lock like every other
    // writer (--apply-rejects takes it itself).
    let summary: Awaited<ReturnType<typeof runAudit>> | undefined;
    await withPipelineLock(async () => {
      const sp = ui.spinner(`auditing ${batches.length} batches`).start();
      try {
        summary = await runAudit(db, auditOpts, {
          isVerified,
          llm: (prompt) =>
            withRateLimitRetry(() =>
              callLLM(cfg, client, {
                prompt,
                model,
                maxTokens: 4000,
                cost: { stage: "audit" },
              }),
            ),
        });
        sp.stop();
      } catch (err) {
        sp.fail(ui.errorColor((err as Error).message));
        process.exitCode = 1;
      }
    });
    if (summary === undefined) return;

    ui.summary({
      audited: { value: summary.audited, color: ui.info },
      keep: { value: summary.byVerdict.keep, color: ui.success },
      verify: { value: summary.byVerdict.verify, color: ui.warn },
      merge: { value: summary.byVerdict.merge, color: ui.warn },
      reject: { value: summary.byVerdict.reject, color: ui.errorColor },
      unanswered: { value: summary.unanswered, color: ui.muted },
      "failed batches": { value: summary.failedBatches, color: summary.failedBatches > 0 ? ui.errorColor : ui.muted },
    });
    ui.line(ui.dim("  nothing was moved — walk the flagged notes with `vir review --audited`"));
    if (summary.failedBatches > 0) process.exitCode = 1;
  } finally {
    db.close();
  }

}

async function transcriptCheck(
  cfg: Config,
  db: StateDb,
  groundOpts: GroundOptions,
  isVerified: (r: DistilledRow) => boolean,
  model: string,
  opts: { dryRun?: boolean; yes?: boolean },
): Promise<void> {
  const sources = buildSources(cfg);
  const evidence = (path: string): string => loadEvidence(sources, path, cfg.filterToolCalls);
  const picked = selectGroundRows(db.listDistilled(), db.listGrounds(), groundOpts, isVerified);

  // Free: parse each transcript once for the estimate. The text is dropped and
  // read again during the run, so memory stays at one transcript at a time.
  const sp = picked.rows.length > 0 ? ui.spinner(`reading ${picked.rows.length} transcripts`).start() : null;
  let evidenceChars = 0;
  for (const r of picked.rows) evidenceChars += evidence(r.path).length;
  sp?.stop();
  const inputTokens = Math.ceil(
    evidenceChars / 3 + picked.rows.reduce((n, r) => n + r.content.length, 0) / 4 + picked.rows.length * 500,
  );
  const outputTokens = picked.rows.length * 150;
  const estCost = estCostLabel(cfg, model, inputTokens, outputTokens);

  ui.header("audit --transcript");
  ui.blank();
  ui.summary({
    notes: { value: picked.rows.length, color: ui.info },
    "already checked": { value: picked.skippedFresh, color: ui.muted },
    verified: { value: picked.skippedVerified, color: ui.muted },
    "transcript gone": { value: picked.transcriptGone, color: picked.transcriptGone > 0 ? ui.warn : ui.muted },
    model: { value: model, color: ui.accent },
    "est. cost": { value: estCost, color: ui.warn },
  });
  ui.divider();
  if (picked.transcriptGone > 0) {
    ui.line(ui.dim(`  ${picked.transcriptGone} note(s) can no longer be checked: the agent pruned their transcripts`));
  }
  if (picked.rows.length === 0) {
    ui.row(ui.success(ui.CHECK), ui.text("nothing to check"));
    return;
  }
  if (opts.dryRun) {
    ui.line(ui.dim("  dry run — no model calls made"));
    return;
  }
  if (opts.yes !== true) {
    const proceed = await confirm({
      message: `check ${picked.rows.length} notes against their transcripts with ${model} (~${estCost})?`,
      default: true,
    });
    if (!proceed) {
      ui.line(ui.dim("aborted"));
      return;
    }
  }

  const llm = groundLlm(cfg, model);
  let summary: GroundSummary | undefined;
  await withPipelineLock(async () => {
    const run = ui.spinner(`checking ${picked.rows.length} notes`).start();
    try {
      summary = await runGround(db, groundOpts, {
        isVerified,
        evidence,
        onProgress: (done, total) => {
          run.text = ui.dim(`checking notes ${done + 1}/${total}`);
        },
        llm,
      });
      run.stop();
    } catch (err) {
      run.fail(ui.errorColor((err as Error).message));
      process.exitCode = 1;
    }
  });
  if (summary === undefined) return;

  ui.summary({
    checked: { value: summary.checked, color: ui.info },
    supported: { value: summary.supported, color: ui.success },
    unbacked: { value: summary.unbacked, color: summary.unbacked > 0 ? ui.warn : ui.muted },
    contradicted: { value: summary.contradicted, color: summary.contradicted > 0 ? ui.errorColor : ui.muted },
    "sent to review": { value: summary.flagged, color: summary.flagged > 0 ? ui.warn : ui.muted },
    failed: { value: summary.failed, color: summary.failed > 0 ? ui.errorColor : ui.muted },
  });
  ui.line(ui.dim("  nothing was moved — walk the flagged notes with `vir review --audited`"));
  if (summary.failed > 0) process.exitCode = 1;
}

function groundLlm(cfg: Config, model: string): (prompt: string) => Promise<string> {
  const client = maybeAnthropicClient(cfg);
  return (prompt) =>
    withRateLimitRetry(() =>
      callLLM(cfg, client, {
        prompt,
        model,
        maxTokens: 4000,
        cost: { stage: "audit-transcript" },
      }),
    );
}

// Called by `vir run --daemon` after a finished pass, inside its lock. A no-op
// unless config.checkTranscripts is on.
export async function transcriptCheckAfterPass(cfg: Config): Promise<void> {
  if (cfg.checkTranscripts !== true) return;
  const db = new StateDb();
  try {
    const root = vaultRoot(cfg);
    const sources = buildSources(cfg);
    await checkTranscriptsAfterRun(cfg, db, {
      llm: groundLlm(cfg, normalizeModelName(resolveModelShorthand(cfg.models.distill), cfg.provider)),
      isVerified: (r) => noteIsVerified(root, r),
      evidence: (path) => loadEvidence(sources, path, cfg.filterToolCalls),
      log: appendRunLog,
    });
  } finally {
    db.close();
  }
}
