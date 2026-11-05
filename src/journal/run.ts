import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Config } from "../config.js";
import { buildSources, resolveSource, scanAll } from "../sources/registry.js";
import type { StateDb } from "../state/db.js";
import { parseJournalFile, type JournalEvent } from "./events.js";
import { buildDay, dayOf, renderDay, type JournalSession } from "./render.js";

export const JOURNAL_SUBDIR = "journal";
// Bump when parseJournalLines starts reading something new: the stored hash
// carries it, so transcripts already ingested are parsed again.
// 2: the desktop app's update_plan and wrap_up.
const PARSER_VERSION = 2;

export interface IngestSummary {
  scanned: number;
  parsed: number;
  failed: number;
  skippedExcluded: number;
}

// Copies what transcripts prove into SQLite. Claude Code deletes transcripts
// after about 30 days, and the journal has to outlive them, so a transcript
// that vanished keeps its rows. Unchanged files are not parsed again.
export function ingestJournal(cfg: Config, db: StateDb): IngestSummary {
  const sources = buildSources(cfg).filter((s) => s.id === "claude-code");
  const summary: IngestSummary = { scanned: 0, parsed: 0, failed: 0, skippedExcluded: 0 };
  for (const s of scanAll(sources)) {
    summary.scanned += 1;
    const source = resolveSource(sources, s.path);
    try {
      const project = source.projectName(s.path);
      if (cfg.projects[project] === "exclude") {
        summary.skippedExcluded += 1;
        continue;
      }
      const hash = `v${PARSER_VERSION}:${s.hash}`;
      if (db.journalSessionHash(s.path) === hash) continue;
      const parsed = parseJournalFile(s.path);
      // Agent-internal transcripts did real commits, but their tasks are the
      // agent's own bookkeeping, not the user's work items.
      // The same two knobs `vir run` uses decide what counts as agent-internal.
      const human =
        (cfg.workflowTranscripts === "include" || source.category(s.path) === "session") &&
        (cfg.agentTranscripts === "include" || source.agentEntrypoint(s.path) === null);
      const events: JournalEvent[] = human
        ? parsed.events
        : parsed.events.filter((e) => e.kind === "commit");
      if (!human && events.length === 0) continue;
      db.replaceJournalSession({
        path: s.path,
        hash,
        project,
        sessionId: basename(s.path).replace(/\.jsonl$/, ""),
        startedAt: parsed.startedAt,
        endedAt: parsed.endedAt,
        events,
      });
      summary.parsed += 1;
    } catch {
      // One bad transcript must never stop the run.
      summary.failed += 1;
    }
  }
  return summary;
}

export function loadJournalSessions(cfg: Config, db: StateDb): JournalSession[] {
  return db.listJournalSessions().filter((s) => cfg.projects[s.project] !== "exclude");
}

export function journalDays(sessions: JournalSession[], timeZone: string): string[] {
  const days = new Set<string>();
  for (const s of sessions) {
    for (const at of [s.startedAt, s.endedAt, ...s.events.map((e) => e.at)]) {
      const d = at === null ? null : dayOf(at, timeZone);
      if (d !== null) days.add(d);
    }
  }
  return [...days].sort();
}

export function renderJournalDay(
  sessions: JournalSession[],
  db: StateDb,
  day: string,
  timeZone: string,
): string | null {
  const projects = buildDay(sessions, db.listJournalDecisions(), day, timeZone);
  return projects.length === 0 ? null : renderDay(day, projects);
}

// The journal is a projection: delete the folder and it comes back identical.
export function writeJournalDay(cfg: Config, day: string, body: string): "written" | "unchanged" {
  const dir = join(cfg.vaultPath, cfg.outputDir, JOURNAL_SUBDIR);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${day}.md`);
  if (existsSync(file) && readFileSync(file, "utf8") === body) return "unchanged";
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, file);
  return "written";
}
