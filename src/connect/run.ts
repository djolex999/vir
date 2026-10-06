import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import { acquireLock, releaseLock } from "../pipeline/lock.js";
import { vaultRoot } from "../search/retriever.js";
import { embedNoteWithProvider, type EmbeddingProvider } from "../search/provider.js";
import { thresholdsFor } from "../search/thresholds.js";
import type { StateDb } from "../state/db.js";
import { clusterLessons } from "./cluster.js";
import { embedLessons } from "./embed.js";
import { collectLessons } from "./extract.js";
import { matchCandidate } from "./identity.js";
import { insightSlug, writeInsightFile } from "./insightFile.js";
import { rankCandidates, recurrence } from "./qualify.js";
import type { InsightEvidence, InsightRow, Lesson } from "./types.js";
import { buildVerifyPrompt, parseVerdict, validateVerdict, type ValidatedRule } from "./verify.js";

const VERIFY_OUTPUT_TOKENS = 600;

export interface ConnectDeps {
  provider: EmbeddingProvider | null;
  llm: (prompt: string) => Promise<string>;
  model: string;
  // Dollar estimate for one call, or null when the provider/model is unpriced.
  estimateCostUsd: (inputTokens: number, outputTokens: number) => number | null;
  now: () => Date;
  lockPath?: string;
}

export interface ConnectSummary {
  lessons: number;
  clusters: number;
  candidates: number;
  deferred: number;
  proposed: number;
  updated: number;
  unchanged: number;
  skippedRejected: number;
  unverified: number;
  llmFailures: number;
  additionsFlagged: number;
  llmCalls: number;
  estCostUsd: number | null;
  keptRatios: Array<[number, number]>;
}

function emptySummary(): ConnectSummary {
  return {
    lessons: 0, clusters: 0, candidates: 0, deferred: 0, proposed: 0, updated: 0, unchanged: 0,
    skippedRejected: 0, unverified: 0, llmFailures: 0, additionsFlagged: 0, llmCalls: 0,
    estCostUsd: null, keptRatios: [],
  };
}

function evidenceOf(v: ValidatedRule): InsightEvidence[] {
  return v.evidence.map((e) => ({
    sessionId: e.lesson.sessionId,
    citeSlug: e.lesson.citeSlug,
    project: e.lesson.project,
    date: e.lesson.noteDate,
    quote: e.quote,
  }));
}

function reconsider(cfg: Config, db: StateDb, slug: string, now: Date): ConnectSummary {
  const row = db.getInsightBySlug(slug);
  if (row === null) throw new Error(`no rule with slug ${slug}`);
  // Spec §9: the way back for a rejected or declined rule — never a silent
  // demotion of one the owner accepted and promoted.
  if (row.status !== "rejected" && row.promotion !== "declined") {
    throw new Error(`only a rejected or declined rule can be reconsidered — ${slug} is ${row.status}`);
  }
  const next: InsightRow = {
    ...row,
    status: "proposed",
    promotion: "none",
    evidenceChanged: false,
    pending: null,
    updatedAt: now.toISOString(),
  };
  db.upsertInsight(next);
  writeInsightFile(vaultRoot(cfg), next);
  return emptySummary();
}

// Find lessons the user keeps re-learning and propose them as cited rules.
// Paid: at most connectMaxCandidates LLM calls. Never run implicitly.
export async function runConnect(
  cfg: Config,
  db: StateDb,
  opts: { dryRun: boolean; reconsider?: string },
  deps: ConnectDeps,
): Promise<ConnectSummary> {
  acquireLock(deps.lockPath);
  try {
    if (opts.reconsider !== undefined) return reconsider(cfg, db, opts.reconsider, deps.now());
    const provider = deps.provider;
    if (provider === null) throw new Error("clustering needs an embedding provider — run vir embed setup");

    const summary = emptySummary();
    const root = vaultRoot(cfg);
    const lessons = collectLessons(root);
    summary.lessons = lessons.length;
    const vectors = await embedLessons(lessons, db, provider);
    const { connectMinSim, connectCoreSim } = thresholdsFor(provider.modelName);
    const clusters = clusterLessons(lessons, vectors, connectMinSim, connectCoreSim);
    summary.clusters = clusters.length;

    // Free pre-LLM triage: rejected stays rejected, and a known rule with no new
    // session is unchanged — neither earns a paid call.
    const insights = db.listInsights();
    const todo: Array<{ members: Lesson[] }> = [];
    for (const c of rankCandidates(clusters)) {
      const hashes = c.members.map((m) => m.contentHash);
      const pre = matchCandidate({ sessionIds: c.rec.sessions, hashes, ruleVector: null }, insights, new Map(), connectCoreSim);
      if (pre.kind === "skip-rejected") {
        summary.skippedRejected += 1;
        continue;
      }
      if (pre.kind === "accepted-unchanged") {
        summary.unchanged += 1;
        continue;
      }
      if (pre.kind === "update-proposed" || pre.kind === "accepted-additions") {
        // Sessions already flagged as pending additions are known too: the
        // owner hasn't decided on them yet, so asking the model again is waste.
        const known = new Set([
          ...pre.insight.memberSessionIds,
          ...(pre.insight.pending ?? []).map((e) => e.sessionId),
        ]);
        if (c.rec.sessions.every((s) => known.has(s))) {
          summary.unchanged += 1;
          continue;
        }
      }
      todo.push(c);
    }
    summary.candidates = todo.length;
    const batch = todo.slice(0, cfg.connectMaxCandidates);
    summary.deferred = todo.length - batch.length;

    if (opts.dryRun) {
      let total: number | null = 0;
      for (const c of batch) {
        const cost = deps.estimateCostUsd(Math.ceil(buildVerifyPrompt(c.members).length / 4), VERIFY_OUTPUT_TOKENS);
        total = cost === null || total === null ? null : total + cost;
      }
      summary.estCostUsd = total;
      return summary;
    }

    const rejectedVectors = db.getInsightVectors("rejected");
    for (const c of batch) {
      summary.llmCalls += 1;
      let text: string;
      try {
        text = await deps.llm(buildVerifyPrompt(c.members));
      } catch {
        summary.llmFailures += 1;
        continue;
      }
      const verdict = parseVerdict(text);
      const v = verdict === null ? null : validateVerdict(c.members, verdict);
      if (v === null) {
        summary.unverified += 1;
        continue;
      }
      summary.keptRatios.push(v.keptOfTotal);
      const rec = recurrence(v.members);
      const ruleVector = await embedNoteWithProvider(provider, `${v.rule}\n${v.why}`);
      const outcome = matchCandidate(
        { sessionIds: rec.sessions, hashes: v.members.map((m) => m.contentHash), ruleVector },
        db.listInsights(),
        rejectedVectors,
        connectCoreSim,
      );
      const now = deps.now().toISOString();
      const evidence = evidenceOf(v);
      const fields = {
        memberSessionIds: rec.sessions,
        memberHashes: v.members.map((m) => m.contentHash),
        sources: [...new Set(evidence.map((e) => e.citeSlug))],
        evidence,
        sessions: rec.sessions.length,
        projects: rec.projects,
        firstSeen: rec.firstSeen,
        lastSeen: rec.lastSeen,
      };
      if (outcome.kind === "skip-rejected") {
        summary.skippedRejected += 1;
      } else if (outcome.kind === "accepted-unchanged") {
        summary.unchanged += 1;
      } else if (outcome.kind === "accepted-additions") {
        const added = new Set(outcome.addedSessions);
        db.upsertInsight({
          ...outcome.insight,
          evidenceChanged: true,
          pending: evidence.filter((e) => added.has(e.sessionId)),
          updatedAt: now,
        });
        summary.additionsFlagged += 1;
      } else if (outcome.kind === "update-proposed") {
        const next: InsightRow = { ...outcome.insight, ...fields, scope: v.scope, updatedAt: now };
        db.upsertInsight(next);
        writeInsightFile(root, next);
        summary.updated += 1;
      } else {
        const id = randomUUID();
        const row: InsightRow = {
          id,
          slug: insightSlug(v.rule, id),
          insightType: "recurring-rule",
          status: "proposed",
          promotion: "none",
          scope: v.scope,
          rule: v.rule,
          why: v.why,
          ...fields,
          evidenceChanged: false,
          pending: null,
          model: deps.model,
          createdAt: now,
          updatedAt: now,
        };
        db.upsertInsight(row);
        if (ruleVector !== null) {
          db.setInsightEmbedding(id, ruleVector, { model: provider.modelName, dim: ruleVector.length });
        }
        writeInsightFile(root, row);
        summary.proposed += 1;
      }
    }
    return summary;
  } finally {
    releaseLock(deps.lockPath);
  }
}
