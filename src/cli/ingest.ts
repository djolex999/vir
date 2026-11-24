import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../config.js";
import {
  buildMeetingNote,
  INGEST_SOURCES,
  IngestError,
  meetingRelPath,
  parseMuninnNote,
  type IngestSource,
} from "../ingest/muninn.js";
import { acquireLock, LOCK_PATH, LockHeldError, releaseLock } from "../pipeline/lock.js";
import { VaultWriter } from "../pipeline/writer.js";
import { StateDb } from "../state/db.js";
import * as ui from "../ui/display.js";

// A Muninn note is a few KB of summary plus a transcript; anything this big is
// not one.
const MAX_INGEST_BYTES = 5 * 1024 * 1024;

export interface IngestOptions {
  source?: string;
  withTranscript?: boolean;
}

export interface IngestResult {
  id: string;
  relPath: string;
  notePath: string;
  status: "created" | "updated" | "unchanged";
  embedding: "embedded" | "kept" | "no-provider" | "failed";
}

function readSource(file: string): { path: string; raw: string } {
  const path = resolve(file);
  if (!/\.md$/i.test(path)) throw new IngestError(`not a Markdown file: ${path}`);
  let size: number;
  try {
    const st = statSync(path);
    if (!st.isFile()) throw new IngestError(`not a file: ${path}`);
    size = st.size;
  } catch (err) {
    if (err instanceof IngestError) throw err;
    throw new IngestError(`cannot read ${path}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
  }
  if (size > MAX_INGEST_BYTES) {
    throw new IngestError(`file is ${Math.round(size / 1024)} KB, over the ${MAX_INGEST_BYTES / 1024 / 1024} MB limit: ${path}`);
  }
  try {
    return { path, raw: readFileSync(path, "utf8") };
  } catch (err) {
    throw new IngestError(`cannot read ${path}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
  }
}

// The work behind `vir ingest`, without the lock or the output line, so tests
// can run it against a temp vault and a real SQLite file. No LLM call: the
// only cost is one local embedding call when a provider is available.
export async function ingestNote(
  file: string,
  source: IngestSource,
  opts: { withTranscript?: boolean },
  deps: { db: StateDb; writer: VaultWriter },
): Promise<IngestResult> {
  const { path, raw } = readSource(file);
  const note = parseMuninnNote(raw);
  const content = buildMeetingNote(note, path, source, {
    withTranscript: opts.withTranscript === true,
  });
  const relPath = meetingRelPath(note.id);
  const prev = deps.db.getMeeting(note.id);
  const notePath = deps.writer.writeMeeting(relPath, content, {
    isNew: prev === null,
    title: note.title,
    kind: note.kind,
    project: note.project,
    date: note.date,
  });
  const { created, contentChanged } = deps.db.recordMeeting({
    id: note.id,
    source,
    sourcePath: path,
    kind: note.kind,
    title: note.title,
    date: note.date,
    project: note.project,
    notePath,
    content,
  });
  const keep = !contentChanged && prev?.hasEmbedding === true;
  const embedding = keep ? "kept" : await deps.writer.embedMeeting(note.id, content);
  return {
    id: note.id,
    relPath,
    notePath,
    status: created ? "created" : contentChanged ? "updated" : "unchanged",
    embedding,
  };
}

const EMBEDDING_LABEL: Record<IngestResult["embedding"], string> = {
  embedded: "embedded",
  kept: "embedding kept",
  "no-provider": "no embedding provider, TF-IDF only",
  failed: "embedding failed, `vir run` or `vir embed` retries it",
};

// Muninn runs this on a background thread after each note and shows stderr in
// its Settings on failure, so: one line on stdout on success, a thrown error
// (runAction prints it to stderr and sets exit code 1) on failure.
export async function ingestCommand(file: string, opts: IngestOptions): Promise<void> {
  const source = opts.source;
  if (source === undefined || !(INGEST_SOURCES as readonly string[]).includes(source)) {
    throw new IngestError(
      `vir ingest: --source must be one of: ${INGEST_SOURCES.join(", ")}` +
        (source === undefined ? "" : ` (got '${source}')`),
    );
  }
  const cfg = loadConfig();
  try {
    acquireLock(LOCK_PATH);
  } catch (err) {
    if (err instanceof LockHeldError) {
      throw new IngestError(
        `vir ingest: vir is busy (pid ${err.pid} holds the pipeline lock); try again when it finishes`,
      );
    }
    throw err;
  }
  const db = new StateDb();
  try {
    const writer = new VaultWriter(cfg, db);
    const r = await ingestNote(file, source as IngestSource, { withTranscript: opts.withTranscript }, { db, writer });
    ui.line(`vir: ${r.status} ${r.relPath} (${EMBEDDING_LABEL[r.embedding]})`);
  } catch (err) {
    if (err instanceof IngestError && !err.message.startsWith("vir ingest:")) {
      throw new IngestError(`vir ingest: ${err.message}`);
    }
    throw err;
  } finally {
    db.close();
    releaseLock(LOCK_PATH);
  }
}
