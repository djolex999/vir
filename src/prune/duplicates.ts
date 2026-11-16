import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import { makeSlug } from "../pipeline/slug.js";
import type { Category } from "../pipeline/types.js";
import { CATEGORY_DIR } from "../pipeline/writer.js";
import { sessionKeyOf, type StateDb } from "../state/db.js";
import {
  applyPrunePlan,
  countDanglingLinks,
  type PruneApplyResult,
  type PruneIoOptions,
  type PrunePlan,
  type PrunePlanItem,
} from "./prune.js";

// `vir prune --duplicates`: one session distilled under two transcript paths
// (the main checkout's project folder and a `--claude-worktrees-<name>` folder
// the transcript was copied into) serves two notes. Keep one copy per session,
// demote the rest through the prune flow — note to .rejected/, row pruned, so
// it never reaches the paid boundary again and `vir prune --restore` undoes it.

export const sessionKey = sessionKeyOf;

export interface DuplicateCandidate {
  path: string;
  processedAt: string;
  contentLength: number;
  hasAuditVerdict: boolean;
  hasGroundVerdict: boolean;
  hasLesson: boolean;
}

// Which copy stays. A verdict comes first: it is the only human-or-model check
// a copy carries, and a flagged copy (contradicted, reject, verify) must not be
// replaced by an unchecked twin that would slip back into CLAUDE.md. Then a
// lesson (sync-claude already spent a call on it), then the newest distill (the
// longer transcript, usually), then more content. Path breaks a full tie so
// the answer never depends on row order.
export function pickDuplicateWinner<T extends DuplicateCandidate>(rows: T[]): T {
  const score = (r: DuplicateCandidate): number =>
    (r.hasAuditVerdict ? 1 : 0) + (r.hasGroundVerdict ? 1 : 0);
  const sorted = [...rows].sort(
    (a, b) =>
      score(b) - score(a) ||
      Number(b.hasLesson) - Number(a.hasLesson) ||
      b.processedAt.localeCompare(a.processedAt) ||
      b.contentLength - a.contentLength ||
      a.path.localeCompare(b.path),
  );
  const winner = sorted[0];
  if (winner === undefined) throw new Error("pickDuplicateWinner: no rows");
  return winner;
}

export interface DuplicatePlan extends PrunePlan {
  // Sessions with 2+ live copies.
  groups: number;
  // loser path → the path that stays.
  winners: Map<string, string>;
}

export function buildDuplicatePlan(db: StateDb, cfg: Config): DuplicatePlan {
  const bySession = new Map<string, ReturnType<StateDb["listSessionCopies"]>>();
  for (const row of db.listSessionCopies()) {
    const list = bySession.get(row.sessionId) ?? [];
    list.push(row);
    bySession.set(row.sessionId, list);
  }

  const root = join(cfg.vaultPath, cfg.outputDir);
  const notePathOf = (r: { category: Category; topic: string; sessionId: string }): string =>
    join(root, CATEGORY_DIR[r.category] ?? `${r.category}s`, `${makeSlug(r.topic, r.sessionId)}.md`);

  const prune: PrunePlanItem[] = [];
  const winners = new Map<string, string>();
  let groups = 0;
  for (const [sessionId, rows] of [...bySession].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (rows.length < 2) continue;
    groups += 1;
    const winner = pickDuplicateWinner(rows);
    const winnerNote = notePathOf(winner);
    for (const r of rows) {
      if (r.path === winner.path) continue;
      const notePath = notePathOf(r);
      winners.set(r.path, winner.path);
      prune.push({
        path: r.path,
        sessionId,
        slug: makeSlug(r.topic, sessionId),
        notePath,
        // Same topic + category gives both copies one slug, so one file: it is
        // the winner's note too and must stay. Only the row is demoted.
        noteExists: notePath !== winnerNote && existsSync(notePath),
        topic: r.topic,
        project: r.project,
        decision: { action: "prune", reason: "duplicate-session" },
      });
    }
  }

  return {
    prune,
    keep: [],
    alreadyPruned: 0,
    byReason: prune.length > 0 ? { "duplicate-session": prune.length } : {},
    byKeepReason: {},
    danglingLinks: countDanglingLinks(cfg, prune.filter((p) => p.noteExists)),
    groups,
    winners,
  };
}

export function applyDuplicatePlan(
  db: StateDb,
  cfg: Config,
  plan: DuplicatePlan,
  opts: PruneIoOptions = {},
): PruneApplyResult {
  return applyPrunePlan(db, cfg, plan, opts);
}
