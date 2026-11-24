import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { kebab } from "../pipeline/slug.js";

// Muninn (a macOS meeting-notes app) hands each finished note to
// `vir ingest --source muninn <file>`. Its notes are already summarized
// Markdown, so ingest copies the summary into the vault as-is: no LLM call.

export const MEETINGS_SUBDIR = "meetings";
export const INGEST_SOURCES = ["muninn"] as const;
export type IngestSource = (typeof INGEST_SOURCES)[number];

export class IngestError extends Error {}

export interface MuninnNote {
  id: string;
  kind: string;
  title: string;
  date: string | null;
  durationMin: number | null;
  people: string[];
  project: string | null;
  language: string | null;
  // Everything after the frontmatter, transcript still included.
  body: string;
}

// Muninn writes flat YAML: quoted strings, bare scalars, `null`, and inline
// JSON-style lists. Anything nested is not part of its format.
function parseScalar(raw: string): string | number | null | string[] {
  const v = raw.trim();
  if (v === "" || v === "null" || v === "~") return null;
  if (v.startsWith("[")) {
    try {
      const parsed = JSON.parse(v) as unknown;
      if (Array.isArray(parsed)) return parsed.map((x) => String(x));
    } catch {
      // fall through: kept as the raw string
    }
    return v;
  }
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    try {
      return JSON.parse(v) as string;
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

export function splitFrontmatter(
  raw: string,
): { fields: Record<string, ReturnType<typeof parseScalar>>; body: string } | null {
  const text = raw.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return null;
  const fields: Record<string, ReturnType<typeof parseScalar>> = {};
  for (const line of (m[1] ?? "").split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0 || /^\s/.test(line)) continue;
    fields[line.slice(0, idx).trim()] = parseScalar(line.slice(idx + 1));
  }
  return { fields, body: text.slice(m[0].length) };
}

function str(v: ReturnType<typeof parseScalar> | undefined): string | null {
  if (v === null || v === undefined || Array.isArray(v)) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

// The id keys the vault note, so it must be safe as part of a file name. Check
// the dangerous characters rather than an expected shape: Muninn ids are slugs
// today, but a non-ASCII or differently cased id is still a valid id.
function checkId(id: string): void {
  if (id.length > 200) throw new IngestError("frontmatter `id` is longer than 200 characters");
  if (/[/\\\0-\x1f\x7f]/.test(id) || id.includes("..")) {
    throw new IngestError("frontmatter `id` contains a path separator, '..' or a control character");
  }
}

export function parseMuninnNote(raw: string): MuninnNote {
  const split = splitFrontmatter(raw);
  if (!split) throw new IngestError("not a Muninn note: no YAML frontmatter");
  const { fields, body } = split;
  if (fields.muninn !== 1) {
    throw new IngestError(
      fields.muninn === undefined
        ? "not a Muninn note: frontmatter has no `muninn: 1`"
        : `unsupported Muninn note version: muninn: ${String(fields.muninn)} (expected 1)`,
    );
  }
  const id = str(fields.id);
  if (!id) throw new IngestError("Muninn note has no frontmatter `id`");
  checkId(id);
  const people = Array.isArray(fields.people) ? fields.people : [];
  const duration = fields.duration_min;
  return {
    id,
    kind: str(fields.kind) ?? "meeting",
    title: str(fields.title) ?? id,
    date: str(fields.date),
    durationMin: typeof duration === "number" ? duration : null,
    people,
    project: str(fields.project),
    language: str(fields.language),
    body,
  };
}

// Muninn puts the raw transcript in a collapsed callout at the end of the note
// (`> [!note]- Transkript`, or `Transcript` in English). The vault copy keeps
// the summary sections only: the transcript is long, noisy speech-to-text that
// would dominate the note's embedding and TF-IDF terms.
const TRANSCRIPT_CALLOUT = /^>\s*\[![a-z]+\][-+]?\s*(transkript|transcript)\b/i;

export function stripTranscript(body: string): { body: string; stripped: boolean } {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => TRANSCRIPT_CALLOUT.test(l));
  if (start === -1) return { body, stripped: false };
  let end = start + 1;
  while (end < lines.length && (lines[end] ?? "").startsWith(">")) end += 1;
  const kept = [...lines.slice(0, start), ...lines.slice(end)];
  return { body: kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n", stripped: true };
}

// File name keyed off the Muninn id (never the title or the source file name),
// so a rerun or a renamed source updates the same vault note. An id that is not
// already a clean slug gets a hash suffix so two ids can't kebab to one file.
export function meetingSlug(id: string): string {
  const base = kebab(id).slice(0, 80);
  if (base === id) return base;
  const suffix = createHash("sha256").update(id).digest("hex").slice(0, 8);
  return base.length > 0 ? `${base}-${suffix}` : `meeting-${suffix}`;
}

export function meetingRelPath(id: string): string {
  return `${MEETINGS_SUBDIR}/${meetingSlug(id)}.md`;
}

function yamlString(s: string): string {
  return JSON.stringify(s);
}

// The vault copy. Deterministic for a given (note, source path, flag): no
// ingest timestamp in the file, so re-ingesting unchanged input leaves the
// stored content equal and the embedding is kept.
export function buildMeetingNote(
  note: MuninnNote,
  sourcePath: string,
  source: IngestSource,
  opts: { withTranscript?: boolean } = {},
): string {
  const fm = [
    "---",
    "type: meeting",
    `source: ${source}`,
    `muninn_id: ${yamlString(note.id)}`,
    `kind: ${yamlString(note.kind)}`,
    `title: ${yamlString(note.title)}`,
  ];
  if (note.date) fm.push(`date: ${yamlString(note.date)}`);
  if (note.durationMin !== null) fm.push(`duration_min: ${note.durationMin}`);
  if (note.people.length > 0) {
    fm.push(`people: [${note.people.map(yamlString).join(", ")}]`);
  }
  if (note.project) fm.push(`project: ${yamlString(note.project)}`);
  if (note.language) fm.push(`language: ${yamlString(note.language)}`);
  fm.push(`source_path: ${yamlString(sourcePath)}`);
  fm.push("---", "");

  const body = opts.withTranscript
    ? note.body.trimEnd() + "\n"
    : stripTranscript(note.body).body;
  const lines = body.replace(/^\n+/, "").split("\n");
  const hasH1 = (lines[0] ?? "").startsWith("# ");
  const heading = hasH1 ? (lines.shift() ?? "") : `# ${note.title}`;
  const sourceName = sourcePath.split("/").pop() ?? sourcePath;
  const label = sourceName.replace(/[[\]]/g, "");
  const meta = [
    note.kind,
    note.date?.slice(0, 10),
    note.durationMin !== null ? `${note.durationMin} min` : null,
    note.people.length > 0 ? `people: ${note.people.join(", ")}` : null,
  ].filter((x): x is string => typeof x === "string" && x.length > 0);

  return (
    fm.join("\n") +
    `${heading}\n\n` +
    `Source: [${label}](${pathToFileURL(sourcePath).href})\n` +
    (meta.length > 0 ? `${meta.join(" · ")}\n` : "") +
    "\n" +
    lines.join("\n").replace(/^\n+/, "").trimEnd() +
    "\n"
  );
}
