import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isVerified, type SearchHit } from "./retriever.js";

export const QUERY_LOG_PATH = join(homedir(), ".vir", "queries.jsonl");
// One rotated generation only: at the cap the live file becomes .1 (replacing
// any previous .1) and a fresh live file starts. Two generations bound the log
// at ~2×cap while keeping enough history for `vir queries` to be meaningful.
export const QUERY_LOG_MAX_BYTES = 5 * 1024 * 1024;
// Written (best-effort) whenever a log append fails, so doctor can surface
// "queries are happening but the log isn't being written" — the stderr line
// alone scrolls away, and a silent best-effort is a blind spot.
export const QUERY_LOG_FAIL_MARKER_PATH = join(
  homedir(),
  ".vir",
  "queries.failed",
);

export interface QueryHitRecord {
  slug: string;
  rank: number;
  score: number;
  verified: boolean;
}

export interface QueryLogRecord {
  ts: string;
  source: "cli" | "mcp";
  query: string;
  type: "session" | "article" | "topic" | "pdf" | "all";
  method: "embedding" | "tfidf";
  degraded: boolean;
  degradedReason: string | null;
  provider: { name: string; model: string; dim: number } | null;
  candidates: number;
  excludedModel: number;
  latencyMs: number;
  hits: QueryHitRecord[];
}

// The search-outcome fields a record needs — structurally satisfied by
// retriever.ts's SearchOutcome so call sites pass it straight through.
export interface QuerySearchMeta {
  method: "embedding" | "tfidf";
  degraded: boolean;
  embedError: string | null;
  excludedMismatched: number;
  candidates: number;
  provider: { name: string; model: string; dim: number } | null;
}

export function formatQueryRecord(input: {
  source: "cli" | "mcp";
  query: string;
  type: QueryLogRecord["type"];
  // Passed separately from the outcome because the MCP path post-filters and
  // re-slices hits — the record must show what actually surfaced.
  hits: SearchHit[];
  search: QuerySearchMeta;
  latencyMs: number;
  now: Date;
}): QueryLogRecord {
  return {
    ts: input.now.toISOString(),
    source: input.source,
    query: input.query,
    type: input.type,
    method: input.search.method,
    degraded: input.search.degraded,
    degradedReason: input.search.degraded ? input.search.embedError : null,
    provider: input.search.provider,
    candidates: input.search.candidates,
    excludedModel: input.search.excludedMismatched,
    latencyMs: input.latencyMs,
    hits: input.hits.map((h, i) => ({
      slug: h.title,
      rank: i + 1,
      score: h.score,
      verified: isVerified(h.content),
    })),
  };
}

// The one chokepoint both call sites (CLI query, MCP vir_query) wire through:
// gate on cfg.logQueries, stamp the time, format, append. `append` is
// injectable for tests only — production callers pass nothing.
export function recordQueryEvent(
  event: {
    logQueries: boolean;
    source: "cli" | "mcp";
    query: string;
    type: QueryLogRecord["type"];
    hits: SearchHit[];
    search: QuerySearchMeta;
    latencyMs: number;
  },
  append: (rec: QueryLogRecord) => void = appendQueryLog,
): void {
  if (!event.logQueries) return;
  // Outer guard on the WHOLE logging path (format + append): logging must
  // never throw into a query, no matter what fails. appendQueryLog already
  // reports its own failures on stderr; anything else dies silently here
  // rather than failing the query.
  try {
    append(
      formatQueryRecord({
        source: event.source,
        query: event.query,
        type: event.type,
        hits: event.hits,
        search: event.search,
        latencyMs: event.latencyMs,
        now: new Date(),
      }),
    );
  } catch {
    // best-effort by contract
  }
}

// Injectable for tests only — production callers pass nothing.
export interface AppendQueryLogOpts {
  logPath?: string;
  maxBytes?: number;
  failMarkerPath?: string;
  stderr?: (line: string) => void;
}

// Best-effort by contract: a log write failure must never fail a query. But
// never SILENT — on failure it emits one stderr line (stderr only: on the MCP
// path stdout is the JSON-RPC channel) and stamps the failure marker for
// doctor. It never touches stdout.
export function appendQueryLog(
  rec: QueryLogRecord,
  opts: AppendQueryLogOpts = {},
): void {
  const logPath = opts.logPath ?? QUERY_LOG_PATH;
  const maxBytes = opts.maxBytes ?? QUERY_LOG_MAX_BYTES;
  const stderr =
    opts.stderr ?? ((line: string) => process.stderr.write(line));
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    rotateIfNeeded(logPath, maxBytes);
    appendFileSync(logPath, JSON.stringify(rec) + "\n", "utf8");
  } catch (err) {
    stderr(`vir: query log write failed: ${(err as Error).message}\n`);
    try {
      writeFileSync(
        opts.failMarkerPath ?? QUERY_LOG_FAIL_MARKER_PATH,
        `${rec.ts} ${(err as Error).message}\n`,
        "utf8",
      );
    } catch {
      // marker is itself best-effort — the stderr line already fired
    }
  }
}

function rotateIfNeeded(logPath: string, maxBytes: number): void {
  let size: number;
  try {
    size = statSync(logPath).size;
  } catch {
    return; // no live file yet — nothing to rotate
  }
  // rename replaces any existing .1, so exactly one generation survives.
  if (size >= maxBytes) renameSync(logPath, logPath + ".1");
}

// Reads the rotated generation first, then the live file, so records come back
// in chronological order. Malformed lines and missing files are skipped.
export function readQueryLog(logPath = QUERY_LOG_PATH): QueryLogRecord[] {
  const records: QueryLogRecord[] = [];
  for (const p of [logPath + ".1", logPath]) {
    if (!existsSync(p)) continue;
    let raw: string;
    try {
      raw = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed) as QueryLogRecord);
      } catch {
        // skip malformed lines
      }
    }
  }
  return records;
}
