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
// Below this many entries, gaps, conflicts and the overview are dropped first.
const MIN_KEEP = 3;

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

// Model text is rendered into markdown lines next to code-made links and
// labels. Flatten it to one plain line, strip what could pose as structure
// (wikilinks, label separators, headings, quote markers) and clip it.
function plain(s: string, max: number): string {
  let out = norm(s)
    .replace(/\[\[|\]\]/g, "")
    .replace(/·/g, "-")
    .replace(/#{1,6}\s/g, "")
    .replace(/^[>\-*\s]+/, "")
    .trim();
  if (out.length > max) {
    const cut = out.slice(0, max - 1);
    const space = cut.lastIndexOf(" ");
    out = `${space > max / 2 ? cut.slice(0, space) : cut}…`;
  }
  return out;
}

const LIMITS = { quote: 200, claim: 300, heading: 80, overview: 600, about: 200, gap: 200, gaps: 10, conflicts: 20 };

export function validateDream(
  raw: RawDream,
  notes: DreamNote[],
  sourceChars: number,
  measure: (page: DreamPage) => number,
): { page: DreamPage; stats: DreamStats } {
  const byIndex = new Map(notes.map((n) => [n.index, n]));
  // Check a quote against what the model was shown: a note past the budget
  // was shown as "topic: lesson", and the lesson is not in its content.
  const normalized = new Map(notes.map((n) => [n.index, norm(n.full ? n.row.content : `${n.text}\n${n.row.content}`)]));
  let dropped = 0;
  let position = 0;
  const sections = raw.sections.map((s) => ({
    heading: plain(s.heading, LIMITS.heading) || "General",
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
      const claim = plain(e.claim, LIMITS.claim);
      if (claim === "") {
        dropped += 1;
        return [];
      }
      // Clipping keeps it a substring of the note; the spec caps quotes at 200.
      const clipped = e.quote.trim().slice(0, LIMITS.quote);
      return [{ ...e, claim, quote: clipped, confirmed, ref: src.ref, alsoRefs, surfaced: src.surfaced, position }];
    }),
  }));

  let conflicts = raw.conflicts.flatMap((c) => {
    const a = byIndex.get(c.a);
    const b = byIndex.get(c.b);
    if (a === undefined || b === undefined || a === b) return [];
    return [{ a: a.ref, b: b.ref, about: plain(c.about, LIMITS.about) }];
  }).slice(0, LIMITS.conflicts);
  let overview = plain(raw.overview, LIMITS.overview);
  let gaps = raw.gaps.map((g) => plain(g, LIMITS.gap)).filter((g) => g !== "").slice(0, LIMITS.gaps);

  const build = (): DreamPage => ({
    overview,
    sections: sections
      .filter((s) => s.entries.length > 0)
      .map((s) => ({ heading: s.heading, entries: s.entries.map(({ position: _p, ...rest }) => rest) })),
    conflicts,
    gaps,
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
    // On a small page, uncited text goes before the last few entries.
    if (count <= MIN_KEEP && (gaps.length > 0 || conflicts.length > 0 || overview !== "")) {
      if (gaps.length > 0) gaps = [];
      else if (conflicts.length > 0) conflicts = [];
      else overview = "";
      page = build();
      continue;
    }
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
