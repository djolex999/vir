import { existsSync } from "node:fs";
import type { FilterMode } from "../pipeline/toolCallFilter.js";
import { filterToolCalls } from "../pipeline/toolCallFilter.js";
import { scrub } from "../pipeline/scrubber.js";
import { trimTranscript } from "../pipeline/distillSession.js";
import { SubscriptionLimitError } from "../pipeline/subscription.js";
import { resolveSource } from "../sources/registry.js";
import type { SessionSource } from "../sources/types.js";
import type {
  AuditRow,
  DistilledRow,
  GroundRow,
  GroundVerdict,
  StateDb,
} from "../state/db.js";
import { AuditParseError } from "./prompt.js";
import { contentHash } from "./types.js";

// `vir audit --transcript`: check each note against the transcript it was
// distilled from. The plain audit judges note text alone, so it catches
// generic or snapshot notes but not wrong ones; a wrong note is the failure
// that hurts most once it is fed back through search and CLAUDE.md.
// Transcripts are pruned by the agent (Claude Code: ~30 days), so a note can
// only be checked while its transcript still exists.

export interface GroundOptions {
  project?: string;
  limit?: number;
  all?: boolean;
}

export interface GroundSelection {
  rows: DistilledRow[];
  skippedVerified: number;
  skippedFresh: number;
  transcriptGone: number;
}

export function selectGroundRows(
  rows: DistilledRow[],
  grounds: GroundRow[],
  opts: GroundOptions,
  isVerified: (r: DistilledRow) => boolean,
  transcriptExists: (path: string) => boolean = existsSync,
): GroundSelection {
  const fresh = new Set(grounds.filter((g) => g.fresh).map((g) => g.path));
  const out: DistilledRow[] = [];
  let skippedVerified = 0;
  let skippedFresh = 0;
  let transcriptGone = 0;
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
    if (!transcriptExists(r.path)) {
      transcriptGone += 1;
      continue;
    }
    out.push(r);
  }
  // Oldest first: their transcripts are the next the agent prunes, so a
  // --limit (and the daemon's per-pass cap) spends on what is about to be lost.
  out.sort((a, b) => {
    if (a.startedAt === b.startedAt) return 0;
    if (a.startedAt === null) return 1;
    if (b.startedAt === null) return -1;
    return a.startedAt.localeCompare(b.startedAt);
  });
  const limited = opts.limit !== undefined && opts.limit > 0 ? out.slice(0, opts.limit) : out;
  return { rows: limited, skippedVerified, skippedFresh, transcriptGone };
}

// The transcript as the distiller saw it: tool filter, scrub, trim. The same
// steps as distillOneSession, so the check reads the evidence the note came from.
export function loadEvidence(
  sources: SessionSource[],
  path: string,
  filterMode: FilterMode,
): string {
  const parsed = resolveSource(sources, path).parse(path, "");
  const scrubbed = scrub(filterToolCalls(parsed.transcriptText, filterMode).filtered);
  return trimTranscript(scrubbed) ?? scrubbed;
}

export function buildGroundPrompt(note: string, transcript: string): string {
  return `You are checking one note in a developer's knowledge base against the session transcript it was written from. The note is fed back to coding agents as trusted memory, so a claim the transcript does not back is worse than no note.

<transcript>
${transcript}
</transcript>

<note>
${note}
</note>

Go through every factual claim in the note: what was decided and why, what broke and what fixed it, file, function, config and command names, numbers, versions, and the order things happened in. For each, find what the transcript says about it.

- A claim is supported when the transcript states it, or it follows directly from what the transcript shows. Paraphrase and summary are fine.
- A claim is a problem when the transcript contradicts it (a different cause, fix, name, number or outcome), or when nothing in the transcript backs it (an invented detail, a guess written as fact, a fix the session tried that did not work presented as the fix).
- A note is a summary. Skipping failed attempts, dead ends or intermediate errors on the way to the outcome is not a problem. It is a problem only when the note presents as the cause, fix or result something the transcript shows was not.
- Generic advice in the note is not a claim about the session; ignore it here.
- If the transcript has an "omitted" marker, or a tool result is shown truncated or filtered, a claim that could come from the missing part is ok, not unbacked.
- Paths in the transcript may be shortened (home directory as ~). A path that matches up to that shortening is supported.

Reply with JSON only, one finding per claim you looked at closely. Write "transcript" first and decide "status" from it:
{"findings": [{"claim": "the note's claim", "transcript": "what the transcript actually shows", "status": "ok" | "contradicted" | "unbacked"}]}
- ok: supported, a fair summary, borderline, or you corrected yourself while checking. When unsure, ok.
- contradicted: the transcript shows something different.
- unbacked: nothing in the transcript supports it.
Keep each field under 25 words. An empty list means every claim is ok.`;
}

type ProblemStatus = "contradicted" | "unbacked";
const PROBLEM_STATUSES: ReadonlySet<string> = new Set<ProblemStatus>(["contradicted", "unbacked"]);

export interface GroundProblem {
  claim: string;
  status: ProblemStatus;
  transcript: string;
}

export interface GroundResult {
  verdict: GroundVerdict;
  problems: GroundProblem[];
}

export function parseGroundResponse(text: string): GroundResult {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new AuditParseError("transcript check response has no JSON object");
  let raw: unknown;
  try {
    raw = JSON.parse(match[0]);
  } catch {
    throw new AuditParseError("transcript check response JSON does not parse");
  }
  if (typeof raw !== "object" || raw === null) {
    throw new AuditParseError("transcript check response is not an object");
  }
  const findings = (raw as Record<string, unknown>).findings;
  if (!Array.isArray(findings)) throw new AuditParseError("transcript check response has no findings list");
  // The verdict is derived here, never taken from the model: models list
  // claims they then judge fine, so only a contradicted/unbacked status counts.
  const problems = findings.flatMap((p): GroundProblem[] => {
    if (typeof p !== "object" || p === null) return [];
    const e = p as Record<string, unknown>;
    if (typeof e.status !== "string" || !PROBLEM_STATUSES.has(e.status)) return [];
    const claim = typeof e.claim === "string" ? e.claim.trim() : "";
    const transcript = typeof e.transcript === "string" ? e.transcript.trim() : "";
    return claim === "" ? [] : [{ claim, status: e.status as ProblemStatus, transcript }];
  });
  // Contradictions first: they are what a reviewer acts on.
  problems.sort((a, b) => Number(b.status === "contradicted") - Number(a.status === "contradicted"));
  const verdict: GroundVerdict = problems.some((p) => p.status === "contradicted")
    ? "contradicted"
    : problems.length > 0
      ? "unbacked"
      : "supported";
  return { verdict, problems };
}

export function formatGroundReason(problems: GroundProblem[]): string {
  return problems
    .map((p) => `${p.status}: ${p.claim}${p.transcript === "" ? "" : ` (transcript: ${p.transcript})`}`)
    .join("; ");
}

// Only contradicted notes go to the `vir review --audited` queue: on real notes
// "unbacked" was mostly claims from truncated tool output, while contradictions
// were real errors (a wrong count, a bug that never happened). They go as
// verify, unless a fresh verdict already sends them out (reject or merge).
function shouldFlagForReview(existing: AuditRow | undefined): boolean {
  if (existing === undefined || !existing.fresh) return true;
  return existing.verdict === "keep" || existing.verdict === "verify";
}

export interface GroundDeps {
  llm: (prompt: string) => Promise<string>;
  isVerified: (row: DistilledRow) => boolean;
  evidence: (path: string) => string;
  transcriptExists?: (path: string) => boolean;
  now?: () => string;
  onProgress?: (done: number, total: number) => void;
}

export interface GroundSummary {
  checked: number;
  supported: number;
  unbacked: number;
  contradicted: number;
  // Contradicted notes newly sent to `vir review --audited`.
  flagged: number;
  skippedVerified: number;
  skippedFresh: number;
  transcriptGone: number;
  // Notes whose model reply was unusable. They stay unchecked; the next run retries.
  failed: number;
}

export async function runGround(
  db: StateDb,
  opts: GroundOptions,
  deps: GroundDeps,
): Promise<GroundSummary> {
  const now = deps.now ?? (() => new Date().toISOString());
  const picked = selectGroundRows(
    db.listDistilled(),
    db.listGrounds(),
    opts,
    deps.isVerified,
    deps.transcriptExists,
  );
  const audits = new Map(db.listAudits().map((a) => [a.path, a]));
  const summary: GroundSummary = {
    checked: 0,
    supported: 0,
    unbacked: 0,
    contradicted: 0,
    flagged: 0,
    skippedVerified: picked.skippedVerified,
    skippedFresh: picked.skippedFresh,
    transcriptGone: picked.transcriptGone,
    failed: 0,
  };

  for (const [i, row] of picked.rows.entries()) {
    deps.onProgress?.(i, picked.rows.length);
    let result: GroundResult;
    try {
      result = parseGroundResponse(await deps.llm(buildGroundPrompt(row.content, deps.evidence(row.path))));
    } catch (err) {
      if (err instanceof SubscriptionLimitError) throw err;
      if (!(err instanceof AuditParseError)) throw err;
      summary.failed += 1;
      continue;
    }
    const hash = contentHash(row.content);
    const reason = formatGroundReason(result.problems);
    db.recordGround(row.path, { verdict: result.verdict, reason, contentHash: hash }, now());
    summary.checked += 1;
    summary[result.verdict] += 1;
    if (result.verdict !== "contradicted") continue;
    if (shouldFlagForReview(audits.get(row.path))) {
      db.recordAudit(
        row.path,
        { verdict: "verify", reason: `transcript check: ${reason}`, mergeInto: null, contentHash: hash },
        now(),
      );
      summary.flagged += 1;
    }
  }
  return summary;
}
