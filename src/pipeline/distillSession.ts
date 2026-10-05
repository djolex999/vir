import type { Config } from "../config.js";
import type { SessionRow, StateDb } from "../state/db.js";
import { scoreSession } from "./filter.js";
import { scrub } from "./scrubber.js";
import { filterToolCalls } from "./toolCallFilter.js";
import type { DistilledNote, ParsedSession } from "./types.js";

// The part of distilling one session that `vir run` and `vir reconcile`
// share: heuristic filter, scrub + tool filter, the paid distill, write,
// record. Each caller keeps its own gates before this (project, cache, retry
// bound, ...), its own counters and UI, and its own error policy (run records
// the error; reconcile leaves the row for the next pass).

// Distill input ceiling: ~150k tokens at the ~3 chars/token transcripts run
// at (the same cap projects.ts's estimator assumes). Above it a single session
// can exceed the model's context, fail every attempt and get parked.
export const MAX_DISTILL_INPUT_CHARS = 450_000;
// Of the kept text: the opening (task, context) and a larger share of the
// end, where decisions and outcomes land.
const HEAD_SHARE = 0.3;

// Trims an oversized transcript to MAX_DISTILL_INPUT_CHARS, keeping its start
// and end with a marker where the middle was cut. Returns null when it fits.
export function trimTranscript(text: string): string | null {
  if (text.length <= MAX_DISTILL_INPUT_CHARS) return null;
  const head = Math.floor(MAX_DISTILL_INPUT_CHARS * HEAD_SHARE);
  const tail = MAX_DISTILL_INPUT_CHARS - head;
  const omitted = text.length - head - tail;
  return (
    text.slice(0, head) +
    `\n\n[… ${omitted} characters of this transcript omitted to fit the model's context …]\n\n` +
    text.slice(text.length - tail)
  );
}

export type DistillOutcome =
  | { kind: "filtered"; keptNote: boolean }
  | { kind: "deferred" }
  | { kind: "low-confidence"; keptNote: boolean }
  | { kind: "distilled"; note: DistilledNote; written: string[] };

export interface DistillDeps {
  cfg: Config;
  db: StateDb;
  distiller: {
    run(
      parsed: ParsedSession,
      scrubbedSummary: string,
      scrubbedContent: string,
    ): Promise<DistilledNote | null>;
  };
  writer: {
    write(parsed: ParsedSession, note: DistilledNote): Promise<string[]>;
    flushPendingEmbeddings(): void;
  };
  // Called at the paid-call boundary; false defers the session with nothing
  // recorded, so it re-enters on the next run (the claude-cli batch cap).
  beforePaidCall?: () => boolean;
  // Receives the tool-filter savings line when it is worth reporting.
  log?: (msg: string) => void;
}

// A row that holds a note, served or hidden only by a failed re-distill's
// error. A filter or low-confidence skip of new bytes must keep that note:
// keepNote records the bytes as seen and serves the note again, where a plain
// skipped=1 record would hide it from every DB-backed reader.
function holdsNote(row: SessionRow | undefined): boolean {
  return (
    row !== undefined &&
    row.skipped === 0 &&
    row.content !== null &&
    row.content !== ""
  );
}

function skip(
  db: StateDb,
  target: { path: string; hash: string },
): boolean {
  if (holdsNote(db.getByPath(target.path))) {
    db.keepNote(target.path, target.hash);
    return true;
  }
  db.record({
    path: target.path,
    hash: target.hash,
    skipped: true,
    notePaths: [],
  });
  return false;
}

export async function distillOneSession(
  parsed: ParsedSession,
  target: { path: string; hash: string },
  deps: DistillDeps,
): Promise<DistillOutcome> {
  const { cfg, db } = deps;

  if (!scoreSession(parsed, cfg.filterThreshold).passes) {
    return { kind: "filtered", keptNote: skip(db, target) };
  }

  const scrubbedSummary = scrub(parsed.rawSummary);
  const toolFilter = filterToolCalls(parsed.transcriptText, cfg.filterToolCalls);
  if (
    deps.log &&
    (toolFilter.tokensSaved > 1000 || toolFilter.skillResultsStripped > 0)
  ) {
    const skills =
      toolFilter.skillResultsStripped > 0
        ? `, ${toolFilter.skillResultsStripped} skill loads`
        : "";
    deps.log(
      `filtered ${toolFilter.toolCallsStripped} tool results${skills}, saved ~${toolFilter.tokensSaved} tokens`,
    );
  }
  let scrubbedContent = scrub(toolFilter.filtered);
  const trimmed = trimTranscript(scrubbedContent);
  if (trimmed !== null) {
    deps.log?.(
      `trimmed ${parsed.sessionId.slice(0, 8)} from ${scrubbedContent.length} to ${MAX_DISTILL_INPUT_CHARS} chars to fit the model's context`,
    );
    scrubbedContent = trimmed;
  }

  // Everything above is free bookkeeping; the distill is the paid call.
  if (deps.beforePaidCall && !deps.beforePaidCall()) {
    return { kind: "deferred" };
  }

  const note = await deps.distiller.run(parsed, scrubbedSummary, scrubbedContent);
  if (!note) {
    return { kind: "low-confidence", keptNote: skip(db, target) };
  }

  const written = await deps.writer.write(parsed, note);
  db.record({
    path: target.path,
    hash: target.hash,
    skipped: false,
    notePaths: written,
    content: note.markdown,
    category: note.classification.category,
    topic: note.classification.topic,
    project: note.classification.project,
    confidence: note.classification.confidence,
    startedAt: parsed.startedAt,
    entrypoint: parsed.entrypoint,
  });
  deps.writer.flushPendingEmbeddings();
  return { kind: "distilled", note, written };
}
