import type { DreamNote } from "./select.js";

// The model only selects and groups. Code checks every quote, sets every
// label and renders every link (see validate.ts / render.ts), so nothing the
// model says about confidence or sources is taken on trust.

export type EntryKind = "rule" | "trap" | "decision" | "how-to";

export interface RawEntry {
  claim: string;
  source: number;
  quote: string;
  kind: EntryKind;
  also: number[];
}

export interface RawDream {
  overview: string;
  sections: { heading: string; entries: RawEntry[] }[];
  conflicts: { a: number; b: number; about: string }[];
  gaps: string[];
}

export class DreamParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DreamParseError";
  }
}

const KINDS = new Set<EntryKind>(["rule", "trap", "decision", "how-to"]);

export function buildDreamPrompt(projectName: string, notes: DreamNote[]): string {
  const body = notes.map((n) => `[${n.index}] ${n.row.category}: ${n.row.topic}\n${n.text}`).join("\n\n");
  return `You are building the reference page for the project "${projectName}" from notes distilled out of past coding sessions. An agent will read this page mid-session before working on the project.

Rules:
- Group by area of the project (auth, payments, deploy, data, ...), not by note category.
- One entry per fact. When several notes say the same thing, write it once and list the other note numbers in "also".
- At most 40 entries in total, most important first. Fewer, sharper entries beat many.
- Never mention note numbers in claims, conflicts, gaps or the overview: the reader can't see them. Numbers go only in "source", "also", "a" and "b".
- Prefer facts likely to bite again: rules, traps, decisions and how-tos. Skip one-off narrative.
- Never state anything that is not in a note. Each entry cites one source note by number and copies a "quote" from that note EXACTLY, character for character, at most 200 characters. An entry whose quote is not in its note is thrown away.
- When notes disagree, do not pick a winner: list the pair under "conflicts".
- List under "gaps" important things the notes clearly leave open.
- Claims at most 30 words, headings at most 6 words, overview at most 60 words.

Return only JSON, in this shape:
{"overview": "...",
 "sections": [{"heading": "...",
   "entries": [{"claim": "...", "source": 12, "quote": "...", "kind": "rule|trap|decision|how-to", "also": [3, 7]}]}],
 "conflicts": [{"a": 4, "b": 19, "about": "..."}],
 "gaps": ["..."]}

Notes:

${body}
`;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const ints = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter((x): x is number => typeof x === "number" && Number.isInteger(x)) : [];

export function parseDreamResponse(text: string): RawDream {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new DreamParseError("dream response has no JSON object");
  let raw: unknown;
  try {
    raw = JSON.parse(match[0]);
  } catch {
    throw new DreamParseError("dream response JSON does not parse");
  }
  if (typeof raw !== "object" || raw === null) throw new DreamParseError("dream response is not an object");
  const o = raw as Record<string, unknown>;

  const sections = (Array.isArray(o.sections) ? o.sections : []).flatMap((s) => {
    if (typeof s !== "object" || s === null) return [];
    const sec = s as Record<string, unknown>;
    const entries = (Array.isArray(sec.entries) ? sec.entries : []).flatMap((e): RawEntry[] => {
      if (typeof e !== "object" || e === null) return [];
      const r = e as Record<string, unknown>;
      const claim = str(r.claim);
      if (claim === "" || typeof r.source !== "number" || !Number.isInteger(r.source)) return [];
      const kind = KINDS.has(r.kind as EntryKind) ? (r.kind as EntryKind) : "rule";
      return [{ claim, source: r.source, quote: str(r.quote), kind, also: ints(r.also) }];
    });
    return entries.length > 0 ? [{ heading: str(sec.heading) || "General", entries }] : [];
  });
  if (sections.length === 0) throw new DreamParseError("dream response has no usable entries");

  const conflicts = (Array.isArray(o.conflicts) ? o.conflicts : []).flatMap((c) => {
    if (typeof c !== "object" || c === null) return [];
    const r = c as Record<string, unknown>;
    if (typeof r.a !== "number" || typeof r.b !== "number") return [];
    return [{ a: r.a, b: r.b, about: str(r.about) }];
  });
  const gaps = (Array.isArray(o.gaps) ? o.gaps : []).map(str).filter((g) => g !== "");
  return { overview: str(o.overview), sections, conflicts, gaps };
}
