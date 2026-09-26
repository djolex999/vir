import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { rejectNote, setFrontmatter } from "../cli/review.js";
import { LOCK_PATH, acquireLock, releaseLock } from "../pipeline/lock.js";
import { makeSlug } from "../pipeline/slug.js";
import { REJECTED_DIR } from "../pipeline/vaultDirs.js";
import { CATEGORY_DIR } from "../pipeline/writer.js";
import { noteIsVerified } from "./run.js";
import type { AuditRow, DistilledRow, StateDb } from "../state/db.js";

export interface ApplyRejectsSummary {
  moved: number;
  // The row serves but its note file is not where the writer would put it.
  missingFile: number;
  // `.rejected/` already holds a file of that name; it is not ours to overwrite.
  collision: number;
  // A human already approved this note (`verified: true`) — a human verdict
  // outranks a model one, exactly like `runAudit` skipping verified rows.
  verified: number;
}

// Only fresh reject verdicts. verify and merge mean editing text, which stays
// with a human; a stale verdict judged text the note no longer has.
export function selectRejectsToApply(
  rows: DistilledRow[],
  audits: AuditRow[],
  project?: string,
): DistilledRow[] {
  const rejected = new Set(
    audits.filter((a) => a.fresh && a.verdict === "reject").map((a) => a.path),
  );
  return rows.filter(
    (r) => rejected.has(r.path) && (project === undefined || r.project === project),
  );
}

export function applyAuditRejects(
  db: StateDb,
  vaultRoot: string,
  opts: { project?: string; now?: string; lockPath?: string } = {},
): ApplyRejectsSummary {
  const now = opts.now ?? new Date().toISOString();
  // A concurrent `vir run` may be rewriting these very notes.
  acquireLock(opts.lockPath ?? LOCK_PATH);
  try {
    const summary: ApplyRejectsSummary = { moved: 0, missingFile: 0, collision: 0, verified: 0 };
    for (const row of selectRejectsToApply(db.listDistilled(), db.listAudits(), opts.project)) {
      const file = join(vaultRoot, CATEGORY_DIR[row.category], `${makeSlug(row.topic, row.sessionId)}.md`);
      if (!existsSync(file)) {
        summary.missingFile += 1;
        continue;
      }
      // `vir review` approve/edit stamps `verified` on the file only — the DB
      // verdict stays fresh, so this is the one place the file's own state
      // must override a stale-but-fresh reject verdict.
      if (noteIsVerified(vaultRoot, row)) {
        summary.verified += 1;
        continue;
      }
      if (existsSync(join(vaultRoot, REJECTED_DIR, basename(file)))) {
        summary.collision += 1;
        continue;
      }
      const dest = rejectNote(file, vaultRoot, now);
      // Tells a later reader (and `vir review --restore`) that no human made this call.
      writeFileSync(dest, setFrontmatter(readFileSync(dest, "utf8"), { rejected_by: "audit" }));
      db.markRejected(row.sessionId, now);
      summary.moved += 1;
    }
    return summary;
  } finally {
    releaseLock(opts.lockPath ?? LOCK_PATH);
  }
}
