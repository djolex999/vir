import type { RawDream, RawEntry } from "./prompt.js";
import type { DreamNote } from "./select.js";

// Everything the page may trust is decided here, in code: an entry survives
// only if its quote is really in its source note, its label comes from that
// note's check status, and the page stays within its size caps.

export interface DreamEntry extends RawEntry {
  confirmed: boolean;
  ref: string;
  alsoRefs: string[];
  surfaced: number;
}

export interface DreamPage {
  overview: string;
  sections: { heading: string; entries: DreamEntry[] }[];
  conflicts: { a: string; b: string; about: string }[];
  gaps: string[];
}

export interface DreamStats {
  kept: number;
  // Entries thrown out: bad source number or a quote not in the note.
  dropped: number;
  // Valid entries removed to fit the caps.
  cut: number;
  cited: number;
  coverage: number;
  confirmed: number;
  ratio: number;
}

export const MAX_ENTRIES = 40;
export const MAX_BODY_BYTES = 12_000;
export const MAX_RATIO = 0.35;

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

export function validateDream(
  raw: RawDream,
  notes: DreamNote[],
  sourceChars: number,
  measure: (page: DreamPage) => number,
): { page: DreamPage; stats: DreamStats } {
  const byIndex = new Map(notes.map((n) => [n.index, n]));
  const normalized = new Map(notes.map((n) => [n.index, norm(n.row.content)]));
  let dropped = 0;
  let position = 0;
  const sections = raw.sections.map((s) => ({
    heading: s.heading,
    entries: s.entries.flatMap((e): (DreamEntry & { position: number })[] => {
      const src = byIndex.get(e.source);
      const quote = norm(e.quote);
      if (src === undefined || quote === "" || !(normalized.get(e.source) ?? "").includes(quote)) {
        dropped += 1;
        return [];
      }
      const alsoRefs = [...new Set(e.also)]
        .filter((i) => i !== e.source)
        .flatMap((i) => {
          const n = byIndex.get(i);
          return n === undefined ? [] : [n.ref];
        });
      const confirmed = src.status === "verified" || src.status === "transcript-supported";
      position += 1;
      return [{ ...e, confirmed, ref: src.ref, alsoRefs, surfaced: src.surfaced, position }];
    }),
  }));

  const conflicts = raw.conflicts.flatMap((c) => {
    const a = byIndex.get(c.a);
    const b = byIndex.get(c.b);
    if (a === undefined || b === undefined || a === b) return [];
    return [{ a: a.ref, b: b.ref, about: c.about }];
  });

  const build = (): DreamPage => ({
    overview: raw.overview,
    sections: sections
      .filter((s) => s.entries.length > 0)
      .map((s) => ({ heading: s.heading, entries: s.entries.map(({ position: _p, ...rest }) => rest) })),
    conflicts,
    gaps: raw.gaps,
  });

  // Cut the weakest entry until the page fits: unconfirmed before confirmed,
  // least retrieved first, later entries before earlier ones.
  const fits = (page: DreamPage, count: number): boolean => {
    if (count > MAX_ENTRIES) return false;
    const bytes = measure(page);
    if (bytes > MAX_BODY_BYTES) return false;
    return sourceChars <= 0 || bytes / sourceChars <= MAX_RATIO;
  };
  let cut = 0;
  let page = build();
  let count = sections.reduce((n, s) => n + s.entries.length, 0);
  while (count > 0 && !fits(page, count)) {
    let worst: { s: number; i: number } | null = null;
    let worstKey: [number, number, number] | null = null;
    sections.forEach((s, si) =>
      s.entries.forEach((e, ei) => {
        const key: [number, number, number] = [Number(e.confirmed), e.surfaced, -e.position];
        if (
          worstKey === null ||
          key[0] < worstKey[0] ||
          (key[0] === worstKey[0] && (key[1] < worstKey[1] || (key[1] === worstKey[1] && key[2] < worstKey[2])))
        ) {
          worstKey = key;
          worst = { s: si, i: ei };
        }
      }),
    );
    if (worst === null) break;
    const { s, i } = worst;
    sections[s]?.entries.splice(i, 1);
    cut += 1;
    count -= 1;
    page = build();
  }

  const kept = page.sections.flatMap((s) => s.entries);
  const cited = new Set(kept.flatMap((e) => [e.ref, ...e.alsoRefs])).size;
  const bytes = measure(page);
  return {
    page,
    stats: {
      kept: kept.length,
      dropped,
      cut,
      cited,
      coverage: notes.length > 0 ? cited / notes.length : 0,
      confirmed: kept.filter((e) => e.confirmed).length,
      ratio: sourceChars > 0 ? bytes / sourceChars : 0,
    },
  };
}
