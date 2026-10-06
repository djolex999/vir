import { homedir } from "node:os";
import { applyPlan, planRules, planUpdates, renderRuleHunk, type PlanItem } from "../claude/updater.js";
import type { Config } from "../config.js";
import { writeInsightFile } from "../connect/insightFile.js";
import type { InsightRow } from "../connect/types.js";
import { vaultRoot } from "../search/retriever.js";
import type { StateDb } from "../state/db.js";
import * as ui from "../ui/display.js";

export interface SyncOptions {
  project?: string;
  globalOnly?: boolean;
  dryRun?: boolean;
  force?: boolean;
}

export interface SyncIo {
  isTTY: boolean;
  ask: (question: string) => Promise<string>;
  print: (line: string) => void;
  box?: (lines: string[], title: string) => void;
}

function collapseHome(p: string): string {
  const h = homedir();
  return p.startsWith(h) ? "~" + p.slice(h.length) : p;
}

export function renderPlanLines(p: PlanItem): string[] {
  if (!p.exists) return [ui.dim("no CLAUDE.md found — would be skipped")];
  const lines: string[] = [];
  for (const e of p.diff.added) lines.push(`${ui.success("+")} ${ui.text(e.slug)}`);
  for (const u of p.diff.upgraded) {
    lines.push(
      `${ui.info(ui.UP_ARROW)} ${ui.text(u.slug)}  ${ui.dim(`${u.oldConf.toFixed(2)}${ui.ARROW}${u.newConf.toFixed(2)}`)}`,
    );
  }
  for (const r of p.diff.removed) lines.push(`${ui.warn("-")} ${ui.text(r.slug)}`);
  for (const r of p.diff.rulesAdded) lines.push(`${ui.success("+")} ${ui.text(`rule: ${r.rule}`)}`);
  for (const r of p.diff.rulesRemoved) lines.push(`${ui.warn("-")} ${ui.text(`rule: ${r.rule}`)}`);
  if (p.diff.unchanged.length > 0) {
    lines.push(`${ui.dim("~")} ${ui.dim(`${p.diff.unchanged.length} entries unchanged`)}`);
  }
  if (lines.length === 0) lines.push(ui.dim("no changes"));
  return lines;
}

function setPromotion(cfg: Config, db: StateDb, row: InsightRow, promotion: InsightRow["promotion"]): void {
  const next = { ...row, promotion, updatedAt: new Date().toISOString() };
  db.upsertInsight(next);
  writeInsightFile(vaultRoot(cfg), next);
}

const yes = (a: string): boolean => ["y", "yes"].includes(a.trim().toLowerCase());
const no = (a: string): boolean => ["n", "no"].includes(a.trim().toLowerCase());

// Update the VIR blocks in CLAUDE.md files. Connect-pass rules are promoted
// one at a time, only on an interactive "y", and recorded as promoted only
// after their CLAUDE.md write succeeds — so DB and file never disagree.
export async function runSyncClaude(cfg: Config, db: StateDb, opts: SyncOptions, io: SyncIo): Promise<void> {
  const planOpts = { project: opts.project, globalOnly: opts.globalOnly === true };
  const interactive = opts.force !== true && opts.dryRun !== true && io.isTTY;
  const pending = planRules(db, planOpts);
  const approved = new Map<string, { target: string; row: InsightRow }>();

  if (interactive) {
    for (const c of pending) {
      io.print(renderRuleHunk(c));
      const answer = await io.ask(`add this rule to ${collapseHome(c.target)}? (y / n / s=skip for now) `);
      if (yes(answer)) approved.set(c.insight.id, { target: c.target, row: c.insight });
      else if (no(answer)) setPromotion(cfg, db, c.insight, "declined");
    }
  } else if (pending.length > 0) {
    io.print(`${pending.length} rule(s) awaiting your approval: run vir sync-claude in a terminal`);
  }

  const plans = planUpdates(cfg, db, planOpts, new Set(approved.keys()));
  if (plans.length === 0) {
    io.print("nothing to plan");
    return;
  }
  for (const p of plans) {
    const lines = renderPlanLines(p);
    if (io.box) io.box(lines, collapseHome(p.target));
    else for (const l of [collapseHome(p.target), ...lines]) io.print(l);
  }
  if (opts.dryRun === true) {
    io.print("run without --dry-run to apply");
    return;
  }
  const proceed = opts.force === true || yes(await io.ask("apply these changes? (y/n) "));
  if (!proceed) {
    io.print("aborted");
    return;
  }
  for (const p of plans) {
    if (!p.exists) {
      io.print(`skipped ${collapseHome(p.target)}`);
      continue;
    }
    const result = applyPlan(p);
    if (!result.ok) process.exitCode = 1;
    io.print(
      result.ok || result.reason === undefined
        ? `${result.ok ? ui.CHECK : ui.CROSS} ${collapseHome(p.target)}`
        : `${ui.CROSS} ${collapseHome(p.target)} — ${result.reason}`,
    );
    if (!result.ok) continue;
    for (const { target, row } of approved.values()) {
      if (target === p.target) setPromotion(cfg, db, row, "promoted");
    }
  }
}
