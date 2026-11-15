import { contentHash } from "../audit/types.js";
import { kebab, noteRef } from "../pipeline/slug.js";
import type { NoteStatus } from "../search/noteStatus.js";
import type { NoteUsage } from "../search/noteUsage.js";
import type { DistilledRow } from "../state/db.js";

// `vir dream` input: one project's notes, most useful first, within a token
// budget. Notes past the budget still go in, shortened to topic + lesson (or
// the start of the note), so the page can still cite them.

export interface DreamNote {
  // 1-based, in prompt order: the number the model cites.
  index: number;
  row: DistilledRow;
  ref: string;
  status: NoteStatus;
  surfaced: number;
  text: string;
  full: boolean;
}

export interface DreamSelection {
  notes: DreamNote[];
  excludedFlagged: number;
  // Full content length of every selected note: the page/source ratio's base.
  sourceChars: number;
}

const SHORT_CHARS = 300;

export function selectDreamNotes(
  rows: DistilledRow[],
  projectSlug: string,
  opts: {
    flagged: Set<string>;
    isVerified: (r: DistilledRow) => boolean;
    statusOf: (r: DistilledRow) => NoteStatus;
    usage: ReadonlyMap<string, NoteUsage>;
    budgetTokens: number;
  },
): DreamSelection {
  let excludedFlagged = 0;
  const kept: { row: DistilledRow; ref: string; surfaced: number }[] = [];
  for (const row of rows) {
    if (kebab(row.project) !== projectSlug) continue;
    if (opts.flagged.has(row.path) && !opts.isVerified(row)) {
      excludedFlagged += 1;
      continue;
    }
    const ref = noteRef(row);
    kept.push({ row, ref, surfaced: opts.usage.get(ref)?.surfaced ?? 0 });
  }
  kept.sort(
    (a, b) =>
      b.surfaced - a.surfaced ||
      b.row.confidence - a.row.confidence ||
      (b.row.startedAt ?? "").localeCompare(a.row.startedAt ?? ""),
  );

  let usedTokens = 0;
  let sourceChars = 0;
  const notes = kept.map(({ row, ref, surfaced }, i): DreamNote => {
    sourceChars += row.content.length;
    const tokens = Math.ceil(row.content.length / 4);
    const full = usedTokens + tokens <= opts.budgetTokens;
    let text = row.content;
    if (full) usedTokens += tokens;
    else text = `${row.topic}: ${row.lesson ?? row.content.slice(0, SHORT_CHARS)}`;
    return { index: i + 1, row, ref, status: opts.statusOf(row), surfaced, text, full };
  });
  return { notes, excludedFlagged, sourceChars };
}

// What a page was built from. Equal hash: the page is current, skip the call.
export function dreamInputHash(notes: DreamNote[]): string {
  const lines = notes
    .map((n) => `${n.row.path}\t${contentHash(n.row.content)}\t${n.status}`)
    .sort();
  return contentHash(lines.join("\n"));
}
