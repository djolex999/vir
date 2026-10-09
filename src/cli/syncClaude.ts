import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
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
  // AGENTS.md files that exist get the same block: "also" (default), "off",
  // or "only" (no CLAUDE.md, no rule prompts — promoted rules only).
  agents?: "also" | "off" | "only";
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
  if (!p.exists) return [ui.dim(`no ${basename(p.target)} found — would be skipped`)];
  const lines: string[] = [];
  for (const e of p.diff.added) lines.push(`${ui.success("+")} ${ui.text(e.lesson)}`);
  for (const r of p.diff.removed) lines.push(`${ui.warn("-")} ${ui.text(r.lesson)}`);
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
const skip = (a: string): boolean => ["s", "skip"].includes(a.trim().toLowerCase());

// In a terminal, ask again on an answer we don't understand: a typo must never
// count as a decision about the owner's CLAUDE.md. Capped, and only one try
// without a terminal, so ended or piped input can't loop. An answer that is
// still unreadable is treated as neither yes nor no (skip / abort).
const MAX_TRIES = 5;
async function askUntil(io: SyncIo, question: string, valid: (a: string) => boolean): Promise<string> {
  const tries = io.isTTY ? MAX_TRIES : 1;
  let answer = "";
  for (let i = 0; i < tries; i += 1) {
    answer = await io.ask(question);
    if (valid(answer)) return answer;
    if (i < tries - 1) io.print("please answer with one of the listed letters");
  }
  return answer;
}

// Update the VIR blocks in CLAUDE.md files. Connect-pass rules are promoted
// one at a time, only on an interactive "y", and recorded as promoted only
// after their CLAUDE.md write succeeds — so DB and file never disagree.
export async function runSyncClaude(cfg: Config, db: StateDb, opts: SyncOptions, io: SyncIo): Promise<void> {
  const planOpts = { project: opts.project, globalOnly: opts.globalOnly === true };
  const agents = opts.agents ?? "also";
  const interactive = opts.force !== true && opts.dryRun !== true && io.isTTY;
  // Rules are approved against CLAUDE.md; AGENTS.md only mirrors approved ones.
  const allPending = agents === "only" ? [] : planRules(db, planOpts);
  // A rule for a missing CLAUDE.md can't be written; asking would only repeat
  // every run. Say so once instead.
  const pending = allPending.filter((c) => existsSync(c.target));
  const orphaned = allPending.length - pending.length;
  if (orphaned > 0) {
    io.print(`${orphaned} accepted rule(s) wait for a CLAUDE.md that doesn't exist — create it to be asked`);
  }
  const approved = new Map<string, { target: string; row: InsightRow }>();

  if (interactive) {
    for (const c of pending) {
      io.print(renderRuleHunk(c));
      const answer = await askUntil(
        io,
        `add this rule to ${collapseHome(c.target)}? (y / n / s=skip for now) `,
        (a) => yes(a) || no(a) || skip(a),
      );
      if (yes(answer)) approved.set(c.insight.id, { target: c.target, row: c.insight });
      else if (no(answer)) setPromotion(cfg, db, c.insight, "declined");
    }
  } else if (pending.length > 0) {
    io.print(`${pending.length} rule(s) awaiting your approval: run vir sync-claude in a terminal`);
  }

  const approvedIds = new Set(approved.keys());
  const plans = [
    ...(agents === "only" ? [] : planUpdates(cfg, db, planOpts, approvedIds)),
    ...(agents === "off" ? [] : planUpdates(cfg, db, { ...planOpts, file: "AGENTS.md" }, approvedIds)),
  ];
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
  const proceed =
    opts.force === true || yes(await askUntil(io, "apply these changes? (y/n) ", (a) => yes(a) || no(a)));
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
