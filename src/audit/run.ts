import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "../cli/review.js";
import { ClaudeCliLimitError } from "../pipeline/claudeCli.js";
import { makeSlug } from "../pipeline/slug.js";
import { CATEGORY_DIR } from "../pipeline/writer.js";
import type { AuditRow, DistilledRow, StateDb } from "../state/db.js";
import { batchByProject } from "./batch.js";
import { AuditParseError, buildAuditPrompt, parseAuditResponse } from "./prompt.js";
import { AUDIT_VERDICTS, contentHash, type AuditVerdict } from "./types.js";

export interface AuditOptions {
  project?: string;
  limit?: number;
  all?: boolean;
}

export interface AuditDeps {
  llm: (prompt: string) => Promise<string>;
  isVerified: (row: DistilledRow) => boolean;
  now?: () => string;
}

export interface AuditSummary {
  audited: number;
  skippedVerified: number;
  skippedFresh: number;
  // Notes sent to the model that came back without a usable verdict. They stay
  // unaudited, so the next run retries them.
  unanswered: number;
  failedBatches: number;
  byVerdict: Record<AuditVerdict, number>;
}

export function selectAuditRows(
  rows: DistilledRow[],
  audits: AuditRow[],
  opts: AuditOptions,
  isVerified: (r: DistilledRow) => boolean,
): { rows: DistilledRow[]; skippedVerified: number; skippedFresh: number } {
  const fresh = new Set(audits.filter((a) => a.fresh).map((a) => a.path));
  let skippedVerified = 0;
  let skippedFresh = 0;
  const out: DistilledRow[] = [];
  for (const r of rows) {
    if (opts.project !== undefined && r.project !== opts.project) continue;
    if (!opts.all && fresh.has(r.path)) {
      skippedFresh += 1;
      continue;
    }
    if (isVerified(r)) {
      skippedVerified += 1;
      continue;
    }
    out.push(r);
  }
  const limited = opts.limit !== undefined && opts.limit > 0 ? out.slice(0, opts.limit) : out;
  return { rows: limited, skippedVerified, skippedFresh };
}

export function noteIsVerified(vaultRoot: string, row: DistilledRow): boolean {
  const file = join(
    vaultRoot,
    CATEGORY_DIR[row.category],
    `${makeSlug(row.topic, row.sessionId)}.md`,
  );
  if (!existsSync(file)) return false;
  try {
    return parseFrontmatter(readFileSync(file, "utf8")).verified === "true";
  } catch {
    return false;
  }
}

export async function runAudit(
  db: StateDb,
  opts: AuditOptions,
  deps: AuditDeps,
): Promise<AuditSummary> {
  const now = deps.now ?? (() => new Date().toISOString());
  const picked = selectAuditRows(db.listDistilled(), db.listAudits(), opts, deps.isVerified);
  const summary: AuditSummary = {
    audited: 0,
    skippedVerified: picked.skippedVerified,
    skippedFresh: picked.skippedFresh,
    unanswered: 0,
    failedBatches: 0,
    byVerdict: Object.fromEntries(AUDIT_VERDICTS.map((v) => [v, 0])) as Record<AuditVerdict, number>,
  };

  for (const batch of batchByProject(picked.rows)) {
    let parsed: ReturnType<typeof parseAuditResponse>;
    try {
      parsed = parseAuditResponse(
        await deps.llm(buildAuditPrompt(batch.project, batch.rows)),
        batch.rows.length,
      );
    } catch (err) {
      if (err instanceof ClaudeCliLimitError) throw err;
      if (!(err instanceof AuditParseError)) throw err;
      summary.failedBatches += 1;
      continue;
    }
    batch.rows.forEach((row, i) => {
      const v = parsed.get(`n${i + 1}`);
      if (v === undefined) {
        summary.unanswered += 1;
        return;
      }
      const target =
        v.mergeInto === null ? null : batch.rows[Number(v.mergeInto.slice(1)) - 1]?.sessionId ?? null;
      db.recordAudit(
        row.path,
        { verdict: v.verdict, reason: v.reason, mergeInto: target, contentHash: contentHash(row.content) },
        now(),
      );
      summary.audited += 1;
      summary.byVerdict[v.verdict] += 1;
    });
  }
  return summary;
}
