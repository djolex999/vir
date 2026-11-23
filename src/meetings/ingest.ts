import { createHash } from "node:crypto";
import { kebab } from "../pipeline/slug.js";
import type { MeetingRow, StateDb } from "../state/db.js";
import type { EmbeddingProvider } from "../search/provider.js";
import { embedNoteWithProvider } from "../search/provider.js";

// `vir ingest --source <tool> <file>`: index a meeting note another tool wrote
// (Muninn first) in place. No LLM call and no copy into the vault: the note is
// already a summary, and its file stays the source of truth. vir records it,
// embeds title + summary, and serves it through vir_query as type "meeting".

// Muninn's transcript sits in a collapsed callout; everything from there on is
// left out of the embedding so the vector carries the summary, not 40 minutes
// of speech.
const TRANSCRIPT_MARKERS = ["> [!note]- Transkript", "> [!note]- Transcript"];

export interface ParsedMeeting {
  source: string;
  title: string;
  project: string | null;
  date: string | null;
  embedText: string;
}

export type ParseResult =
  | { ok: true; meeting: ParsedMeeting }
  | { ok: false; reason: string };

// Flat `key: value` frontmatter (the shared core in CONVENTIONS.md). Quoted
// values are unquoted; YAML `null` and empty become null.
function frontmatter(text: string): { fields: Map<string, string | null>; body: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return null;
  const fields = new Map<string, string | null>();
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0 || /^\s/.test(line)) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (val.length >= 2 && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
      val = val.slice(1, -1).replace(/\\"/g, '"');
    }
    fields.set(key, val === "" || val === "null" || val === "~" ? null : val);
  }
  return { fields, body: text.slice(m[0].length) };
}

export function parseMeetingNote(text: string, expectedSource: string): ParseResult {
  const fm = frontmatter(text);
  if (!fm) return { ok: false, reason: "no frontmatter block" };
  const source = fm.fields.get("source") ?? null;
  if (source !== expectedSource) {
    return { ok: false, reason: `frontmatter source is ${source ?? "missing"}, expected ${expectedSource}` };
  }
  const kind = fm.fields.get("kind") ?? null;
  if (kind !== "meeting") {
    return { ok: false, reason: `frontmatter kind is ${kind ?? "missing"}; only meeting notes can be ingested` };
  }
  const title = fm.fields.get("title")?.trim() ?? "";
  if (title.length === 0) return { ok: false, reason: "frontmatter title is missing" };
  const projectRaw = fm.fields.get("project") ?? null;
  const project = projectRaw ? kebab(projectRaw) || null : null;
  let summary = fm.body;
  for (const marker of TRANSCRIPT_MARKERS) {
    const at = summary.indexOf(marker);
    if (at !== -1) summary = summary.slice(0, at);
  }
  const embedText = `${title}\n\n${summary.trim()}`.trim();
  return {
    ok: true,
    meeting: { source, title, project, date: fm.fields.get("date") ?? null, embedText },
  };
}

export type IngestOutcome =
  | { status: "indexed"; title: string; embedded: boolean }
  | { status: "unchanged"; title: string }
  | { status: "rejected"; reason: string };

// One file. `path` must already be absolute. Embedding is best effort: with no
// provider (or a failed call) the row is stored with a NULL vector and the
// daemon's sweep fills it later, so the hand-over still succeeds.
export async function ingestMeeting(
  db: StateDb,
  path: string,
  text: string,
  source: string,
  provider: EmbeddingProvider | null,
  log?: (msg: string) => void,
): Promise<IngestOutcome> {
  const parsed = parseMeetingNote(text, source);
  if (!parsed.ok) return { status: "rejected", reason: parsed.reason };
  const { meeting } = parsed;
  const hash = createHash("sha256").update(text).digest("hex");
  if (db.isMeetingCurrent(path, hash)) return { status: "unchanged", title: meeting.title };
  const row: MeetingRow = {
    path,
    source: meeting.source,
    hash,
    title: meeting.title,
    project: meeting.project,
    date: meeting.date,
    content: meeting.embedText,
  };
  db.recordMeeting(row);
  if (!provider) return { status: "indexed", title: meeting.title, embedded: false };
  const vec = await embedNoteWithProvider(provider, meeting.embedText, log);
  if (!vec) return { status: "indexed", title: meeting.title, embedded: false };
  db.storeMeetingEmbedding(path, vec, provider.provenance());
  return { status: "indexed", title: meeting.title, embedded: true };
}
