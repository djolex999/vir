import type { Config } from "../config.js";
import {
  classifyTranscript,
  estimateSessionCost,
  groupByProject,
  readTranscriptHead,
  sniffAgentEntrypoint,
  type ProjectGroup,
} from "../pipeline/projects.js";
import { normalizeModelName } from "../pipeline/distiller.js";
import { scanSessions } from "../pipeline/scanner.js";
import { StateDb } from "../state/db.js";

export interface SessionMetaRow {
  path: string;
  hash: string;
  skipped: number;
  skipReason: string | null;
  hasContent: number;
}

export interface ProjectReportRow {
  name: string;
  decision: "include" | "exclude" | "undecided";
  sessions: number;
  distilled: number;
  pending: number;
  excluded: number;
  estPendingCost: number;
  // Transcript paths behind the `pending` count — doctor stats their mtimes
  // to surface the oldest undecided transcript's age.
  pendingPaths: string[];
  // Nested agent-internal transcripts under this project, filtered by the
  // transcript-category gate (workflowTranscripts: exclude). Counted
  // separately — never part of `sessions`/`pending` — so they stay visible
  // without polluting the decidable spend.
  workflowSessions: number;
  sidechainSessions: number;
  // Top-level SDK-launched agent transcripts (agentTranscripts: exclude) —
  // its own count, separate from the nested workflow/sidechain categories.
  agentSessions: number;
}

// Aggregate the scan (every project seen on disk) against DB state into the
// `vir projects` table. Pure — the command wires in scan/DB/config and an
// estimator; classification per session:
//   distilled        row with content (skipped=0)
//   pending          recorded "project-pending", or unseen under an
//                    undecided project (it WILL pend on the next run)
//   excluded         recorded "project-excluded", or unseen under an
//                    excluded project
//   neither          heuristic-filter skips, errors, unseen under include
export function buildProjectsReport(
  groups: ProjectGroup[],
  meta: SessionMetaRow[],
  decisions: Record<string, "include" | "exclude">,
  estCost: (sizeBytes: number) => number,
  nested?: Map<
    string,
    { workflow: number; sidechain: number; agent?: number }
  >,
): ProjectReportRow[] {
  const byPath = new Map(meta.map((m) => [m.path, m]));
  const rows: ProjectReportRow[] = [];
  for (const g of groups) {
    const decision = decisions[g.name] ?? "undecided";
    const nestedCounts = nested?.get(g.name);
    const row: ProjectReportRow = {
      name: g.name,
      decision,
      sessions: g.sessions.length,
      distilled: 0,
      pending: 0,
      excluded: 0,
      estPendingCost: 0,
      pendingPaths: [],
      workflowSessions: nestedCounts?.workflow ?? 0,
      sidechainSessions: nestedCounts?.sidechain ?? 0,
      agentSessions: nestedCounts?.agent ?? 0,
    };
    for (const s of g.sessions) {
      const m = byPath.get(s.path);
      if (m && m.skipped === 0 && m.hasContent === 1) {
        row.distilled += 1;
        continue;
      }
      const reason = m?.skipReason ?? null;
      if (reason === "project-pending" || (!m && decision === "undecided")) {
        row.pending += 1;
        row.estPendingCost += estCost(s.size);
        row.pendingPaths.push(s.path);
      } else if (
        reason === "project-excluded" ||
        (!m && decision === "exclude")
      ) {
        row.excluded += 1;
      }
    }
    rows.push(row);
  }
  rows.sort(
    (a, b) => b.estPendingCost - a.estPendingCost || a.name.localeCompare(b.name),
  );
  return rows;
}

// Side-effectful gather for `vir projects` and doctor: scan the transcripts
// dir, read DB status, apply config decisions. Opens its own StateDb unless
// one is passed in.
export function gatherProjectsReport(cfg: Config): ProjectReportRow[] {
  const found = scanSessions(cfg.claudeProjectsDir);
  // Partition out nested agent-internal transcripts (unless the knob says
  // include) so they annotate the table instead of counting as sessions.
  let inScope = found;
  const nested = new Map<
    string,
    { workflow: number; sidechain: number; agent: number }
  >();
  const filteredOut: typeof found = [];
  const catByPath = new Map<string, "workflow" | "sidechain" | "agent">();
  if (cfg.workflowTranscripts !== "include") {
    inScope = [];
    for (const s of found) {
      const cat = classifyTranscript(s.path, cfg.claudeProjectsDir);
      if (cat === "session") inScope.push(s);
      else {
        filteredOut.push(s);
        catByPath.set(s.path, cat);
      }
    }
  }
  // Top-level SDK-launched agents — same partition, its own category/knob.
  if (cfg.agentTranscripts !== "include") {
    const stillHuman: typeof found = [];
    for (const s of inScope) {
      if (sniffAgentEntrypoint(readTranscriptHead(s.path)) !== null) {
        filteredOut.push(s);
        catByPath.set(s.path, "agent");
      } else {
        stillHuman.push(s);
      }
    }
    inScope = stillHuman;
  }
  for (const g of groupByProject(filteredOut, cfg.claudeProjectsDir).values()) {
    const counts = { workflow: 0, sidechain: 0, agent: 0 };
    for (const s of g.sessions) {
      counts[catByPath.get(s.path) ?? "sidechain"] += 1;
    }
    nested.set(g.name, counts);
  }
  const groups = [...groupByProject(inScope, cfg.claudeProjectsDir).values()];
  // A project whose transcripts are ALL nested would vanish from the table —
  // keep it visible with an empty session group.
  for (const name of nested.keys()) {
    if (!groups.some((g) => g.name === name)) {
      groups.push({ name, sessions: [], totalBytes: 0 });
    }
  }
  const db = new StateDb();
  let meta;
  try {
    meta = db.listSessionMeta();
  } finally {
    db.close();
  }
  const classifyId = normalizeModelName(cfg.models.classify, cfg.provider);
  const distillId = normalizeModelName(cfg.models.distill, cfg.provider);
  return buildProjectsReport(
    groups,
    meta,
    cfg.projects,
    (size) =>
      estimateSessionCost(
        cfg.provider,
        classifyId,
        distillId,
        size,
        cfg.pricing,
        cfg.kieTopUpTier,
      ),
    nested,
  );
}
