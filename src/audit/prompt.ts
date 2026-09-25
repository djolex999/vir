import type { DistilledRow } from "../state/db.js";
import { AUDIT_VERDICTS, type AuditVerdict } from "./types.js";

export class AuditParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditParseError";
  }
}

export interface ParsedVerdict {
  verdict: AuditVerdict;
  reason: string;
  // A label ("n2") within the same batch, only for verdict "merge".
  mergeInto: string | null;
}

// The criteria and their order come from the 2026-09-25 manual audit of the
// reference vault (~/.vir/eval/audit-2026-09-25/): the generic test decided
// most rejects, narration and snapshot-only notes most of the rest. Verdict
// wording revised after the first calibration run sent 76% of notes to verify
// for title and filler polish.
export function buildAuditPrompt(project: string, rows: DistilledRow[]): string {
  const notes = rows
    .map(
      (r, i) =>
        `<note id="n${i + 1}" topic="${r.topic.replace(/"/g, "'")}" category="${r.category}">\n${r.content}\n</note>`,
    )
    .join("\n\n");
  return `You are auditing notes in a developer's knowledge base. The notes were written by a model from Claude Code session transcripts, and they are fed back to Claude through search and CLAUDE.md, so noise actively hurts. Judge each note. Be strict; do not default to keep.

project: ${project}

Apply these tests in order:
1. Would a strong coding model already know this without the note? Generic best practice ("validate input", "use httpOnly cookies") fails even when correct. Only knowledge specific to this project earns a place: its decisions and their reasons, gotchas in this particular setup, config and infra facts, things that cost real debugging time.
2. Is it narration instead of knowledge? "The session scanned the middleware", "no vulnerabilities were found", file-tree walkthroughs.
3. Is it only true on the day it was written? Test counts, commit hashes, branch status, "X is still missing".
4. Is it a duplicate of another note in this batch? Keep the better one and mark the other merge.
5. Does the title (topic) describe what the body actually says? A title that covers only part of the note is not by itself a reason to leave keep.

Verdicts:
- keep: the note carries project-specific knowledge worth retrieving as it is. Some filler, a few generic lines around the specific facts, or a title that covers only part of the note do not make it verify.
- verify: a human has to decide something before this note can be trusted: a claim looks wrong or contradicts another note here, a snapshot ("still missing", a branch or test state) is stated as a lasting fact, or the project-specific part is under about a third of the note. Say exactly what to change.
- merge: a near-duplicate of another note here. Give merge_into as that note's id.
- reject: generic, narration, snapshot-only, or wrong.

Reply with a JSON array only, one entry per note:
[{"id": "n1", "verdict": "keep|verify|merge|reject", "reason": "one concrete sentence", "merge_into": "n2 or null"}]
In "reason", refer to other notes by their topic, never by id: the ids exist only in this message.

${notes}`;
}

export function parseAuditResponse(
  text: string,
  count: number,
): Map<string, ParsedVerdict> {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new AuditParseError("audit response has no JSON array");
  let raw: unknown;
  try {
    raw = JSON.parse(match[0]);
  } catch {
    throw new AuditParseError("audit response JSON does not parse");
  }
  if (!Array.isArray(raw)) throw new AuditParseError("audit response is not an array");

  const ids = new Set(Array.from({ length: count }, (_, i) => `n${i + 1}`));
  const out = new Map<string, ParsedVerdict>();
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === "string" ? e.id : "";
    const verdict = e.verdict;
    if (!ids.has(id) || !(AUDIT_VERDICTS as readonly unknown[]).includes(verdict)) continue;
    const reason = typeof e.reason === "string" ? e.reason.trim() : "";
    const target = typeof e.merge_into === "string" ? e.merge_into : null;
    if (verdict === "merge") {
      const valid = target !== null && ids.has(target) && target !== id;
      out.set(id, valid
        ? { verdict: "merge", reason, mergeInto: target }
        : { verdict: "verify", reason, mergeInto: null });
      continue;
    }
    out.set(id, { verdict: verdict as AuditVerdict, reason, mergeInto: null });
  }
  return out;
}
