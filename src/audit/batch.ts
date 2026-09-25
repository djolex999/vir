import type { DistilledRow } from "../state/db.js";

// ~10k input tokens per call at chars/4. Large enough that a project's
// near-duplicates usually share a batch, small enough to stay well inside
// every provider's context and keep one failure cheap.
export const AUDIT_BATCH_CHARS = 40_000;

export interface AuditBatch {
  project: string;
  rows: DistilledRow[];
}

export function batchByProject(
  rows: DistilledRow[],
  maxChars: number = AUDIT_BATCH_CHARS,
): AuditBatch[] {
  const byProject = new Map<string, DistilledRow[]>();
  for (const r of rows) {
    const list = byProject.get(r.project) ?? [];
    list.push(r);
    byProject.set(r.project, list);
  }
  const out: AuditBatch[] = [];
  for (const project of [...byProject.keys()].sort()) {
    const sorted = (byProject.get(project) ?? []).sort((a, b) =>
      (a.startedAt ?? "").localeCompare(b.startedAt ?? ""),
    );
    let current: DistilledRow[] = [];
    let size = 0;
    for (const r of sorted) {
      const len = r.content.length + r.topic.length;
      if (current.length > 0 && size + len > maxChars) {
        out.push({ project, rows: current });
        current = [];
        size = 0;
      }
      current.push(r);
      size += len;
    }
    if (current.length > 0) out.push({ project, rows: current });
  }
  return out;
}
