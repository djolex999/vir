import { createHash } from "node:crypto";

export type AuditVerdict = "keep" | "verify" | "merge" | "reject";

export const AUDIT_VERDICTS: readonly AuditVerdict[] = [
  "keep",
  "verify",
  "merge",
  "reject",
];

// A verdict is only valid for the exact text it judged. Readers compare this
// hash with the current `content` column instead of trusting a timestamp.
export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
