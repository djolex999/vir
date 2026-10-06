import select from "@inquirer/select";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import { collectLessons } from "../connect/extract.js";
import { INSIGHTS_RULES_DIR, parseRuleEdit, writeInsightFile } from "../connect/insightFile.js";
import { MIN_SESSIONS } from "../connect/qualify.js";
import { ruleText } from "../connect/text.js";
import type { InsightRow } from "../connect/types.js";
import { embedNoteWithProvider, resolveActiveProviderCached } from "../search/provider.js";
import { vaultRoot } from "../search/retriever.js";
import type { StateDb } from "../state/db.js";
import * as ui from "../ui/display.js";
import { openInEditor } from "./review.js";

export type InsightAction = "accept" | "reject" | "accept-additions" | "keep";

export interface InsightReviewDeps {
  // Rule embedding for retrieval; null when no provider is available (the rule
  // is still accepted and served by the TF-IDF path).
  embed: (text: string) => Promise<number[] | null>;
  providerModel: string | null;
  now: () => Date;
}

function load(db: StateDb, slug: string): InsightRow {
  const row = db.getInsightBySlug(slug);
  if (row === null) throw new Error(`no rule with slug ${slug}`);
  return row;
}

function save(db: StateDb, cfg: Config, row: InsightRow): InsightRow {
  db.upsertInsight(row);
  writeInsightFile(vaultRoot(cfg), row);
  return row;
}

async function accept(db: StateDb, cfg: Config, row: InsightRow, deps: InsightReviewDeps): Promise<InsightRow> {
  const next = save(db, cfg, { ...row, status: "accepted", updatedAt: deps.now().toISOString() });
  const vec = await deps.embed(`${next.rule}\n${next.why}`);
  if (vec !== null && deps.providerModel !== null) {
    db.setInsightEmbedding(next.id, vec, { model: deps.providerModel, dim: vec.length });
  }
  return next;
}

export async function applyInsightAction(
  db: StateDb,
  cfg: Config,
  slug: string,
  action: InsightAction,
  deps: InsightReviewDeps,
): Promise<InsightRow> {
  const row = load(db, slug);
  const now = deps.now().toISOString();
  switch (action) {
    case "accept":
      return accept(db, cfg, row, deps);
    case "reject":
      return save(db, cfg, {
        ...row,
        status: "rejected",
        promotion: row.promotion === "promoted" ? "declined" : row.promotion,
        evidenceChanged: false,
        pending: null,
        updatedAt: now,
      });
    case "accept-additions": {
      const add = row.pending ?? [];
      const evidence = [...row.evidence, ...add];
      const sessions = [...new Set([...row.memberSessionIds, ...add.map((e) => e.sessionId)])];
      const dates = evidence.map((e) => e.date).filter((d) => Number.isFinite(Date.parse(d))).sort();
      return save(db, cfg, {
        ...row,
        evidence,
        memberSessionIds: sessions,
        sessions: sessions.length,
        sources: [...new Set(evidence.map((e) => e.citeSlug))],
        firstSeen: dates[0] ?? row.firstSeen,
        lastSeen: dates[dates.length - 1] ?? row.lastSeen,
        evidenceChanged: false,
        pending: null,
        updatedAt: now,
      });
    }
    case "keep":
      return save(db, cfg, { ...row, evidenceChanged: false, pending: null, updatedAt: now });
  }
}

// The owner edits only the **Rule:** and **Why:** lines; the DB stays the
// source of truth and the file is re-rendered from it.
export async function applyInsightEdit(
  db: StateDb,
  cfg: Config,
  slug: string,
  editedRaw: string,
  deps: InsightReviewDeps,
): Promise<InsightRow> {
  const row = load(db, slug);
  const parsed = parseRuleEdit(editedRaw);
  if (parsed === null) throw new Error("edited file has no **Rule:** line — nothing changed");
  return accept(db, cfg, { ...row, rule: parsed.rule, why: parsed.why || row.why }, deps);
}

export function insightQueue(db: StateDb): InsightRow[] {
  const all = db.listInsights();
  const proposed = all
    .filter((r) => r.status === "proposed")
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  const changed = all.filter((r) => r.status === "accepted" && r.evidenceChanged);
  return [...proposed, ...changed];
}

// Derived on display, never stored: an accepted rule whose source notes were
// rejected or deleted until fewer than MIN_SESSIONS remain.
export function isStale(row: InsightRow, liveSessions: Set<string>): boolean {
  return row.memberSessionIds.filter((s) => liveSessions.has(s)).length < MIN_SESSIONS;
}

export interface InsightReviewIo extends InsightReviewDeps {
  ask: (question: string, choices: string[]) => Promise<string>;
  show: (text: string) => void;
  // Opens the file for editing and returns its content afterwards.
  edit: (filePath: string) => Promise<string>;
  liveSessions: () => Set<string>;
}

export async function runReviewInsights(cfg: Config, db: StateDb, io: InsightReviewIo): Promise<number> {
  const queue = insightQueue(db);
  const live = io.liveSessions();
  let acted = 0;
  for (const [i, row] of queue.entries()) {
    const changed = row.status === "accepted";
    io.show(`[${i + 1}/${queue.length}] ${changed ? "accepted rule, new evidence" : "proposed rule"} · ${row.scope} · ${row.sessions} sessions`);
    if (changed && isStale(row, live)) io.show("stale: fewer than 3 of its source sessions still have notes");
    io.show(`Rule: ${ruleText(row.rule)}`);
    io.show(`Why: ${ruleText(row.why)}`);
    for (const e of changed ? (row.pending ?? []) : row.evidence) {
      io.show(`  [[${e.citeSlug}]] (${e.project || "-"}, ${e.date.slice(0, 10)}${e.merged ? ", merged" : ""}): ${JSON.stringify(e.quote)}`);
    }
    const choices = changed ? ["accept-additions", "keep", "reject", "skip"] : ["accept", "edit", "reject", "skip"];
    const answer = await io.ask(changed ? "Add the new evidence?" : "Is this rule true?", choices);
    if (answer === "skip") continue;
    if (answer === "edit") {
      const raw = await io.edit(join(vaultRoot(cfg), INSIGHTS_RULES_DIR, `${row.slug}.md`));
      await applyInsightEdit(db, cfg, row.slug, raw, io);
    } else {
      await applyInsightAction(db, cfg, row.slug, answer as InsightAction, io);
    }
    acted += 1;
  }
  return acted;
}

// Interactive `vir review --insights`: real prompts, $EDITOR, live sessions
// from the vault, and rule embeddings through the active provider.
export async function cmdReviewInsights(cfg: Config, db: StateDb): Promise<void> {
  const provider = await resolveActiveProviderCached(cfg.embeddingProvider);
  ui.header("review  --insights");
  ui.blank();
  if (insightQueue(db).length === 0) {
    ui.line(ui.dim("  no proposed rules — run vir connect to look for some"));
    return;
  }
  const acted = await runReviewInsights(cfg, db, {
    ask: (message, choices) => select({ message, choices: choices.map((value) => ({ name: value, value })) }),
    show: (text) => ui.line(ui.text(text)),
    edit: async (filePath) => {
      if (!openInEditor(filePath)) throw new Error("could not start $EDITOR");
      return readFileSync(filePath, "utf8");
    },
    liveSessions: () => new Set(collectLessons(vaultRoot(cfg)).map((l) => l.sessionId)),
    embed: async (text) => (provider === null ? null : embedNoteWithProvider(provider, text)),
    providerModel: provider?.modelName ?? null,
    now: () => new Date(),
  });
  ui.blank();
  ui.line(ui.dim(`  ${acted} rule(s) decided — accepted rules go to CLAUDE.md only via vir sync-claude`));
}
