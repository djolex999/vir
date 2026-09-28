import type { AuditRow } from "../../src/state/db.js";

// The frozen reject set is what `vir audit --apply-rejects` would actually
// move: fresh reject verdicts, minus notes a human approved — apply.ts skips
// those, so ablating them would test a removal that can never happen.
export function rejectsToTest(audits: readonly AuditRow[], isVerified: (sessionId: string) => boolean): string[] {
  return audits
    .filter((a) => a.fresh && a.verdict === "reject" && !isVerified(a.sessionId))
    .map((a) => a.sessionId)
    .sort();
}
