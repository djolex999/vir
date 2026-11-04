import { loadConfig } from "../config.js";
import { dayOf } from "../journal/render.js";
import {
  ingestJournal,
  journalDays,
  loadJournalSessions,
  renderJournalDay,
  writeJournalDay,
} from "../journal/run.js";
import { StateDb } from "../state/db.js";
import * as ui from "../ui/display.js";
import { withPipelineLock } from "./guards.js";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface JournalOptions {
  since?: string;
  all?: boolean;
  stdout?: boolean;
  tz?: string;
}

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function cmdJournal(date: string | undefined, opts: JournalOptions): Promise<void> {
  const timeZone = opts.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const fail = (msg: string): void => {
    ui.row(ui.warn(ui.WARN_GLYPH), ui.text(msg));
    process.exitCode = 1;
  };
  if (!validTimeZone(timeZone)) return fail(`unknown time zone: ${timeZone}`);
  for (const d of [date, opts.since]) {
    if (d !== undefined && !DAY_RE.test(d)) return fail(`expected YYYY-MM-DD, got ${d}`);
  }
  if ([date !== undefined, opts.since !== undefined, opts.all === true].filter(Boolean).length > 1) {
    return fail("use one of: a date, --since, --all");
  }

  await withPipelineLock(async () => {
    const cfg = loadConfig();
    const db = new StateDb();
    try {
      const ingest = ingestJournal(cfg, db);
      const sessions = loadJournalSessions(cfg, db);
      const today = dayOf(new Date().toISOString(), timeZone) ?? "";
      const all = journalDays(sessions, timeZone);
      const days = opts.all === true
        ? all
        : opts.since !== undefined
          ? all.filter((d) => d >= (opts.since as string))
          : [date ?? today];

      let written = 0;
      let unchanged = 0;
      for (const day of days) {
        const body = renderJournalDay(sessions, db, day, timeZone);
        if (body === null) continue;
        if (opts.stdout === true) {
          process.stdout.write(body);
          continue;
        }
        if (writeJournalDay(cfg, day, body) === "written") written += 1;
        else unchanged += 1;
      }
      if (opts.stdout === true) return;
      ui.row(
        ui.success(ui.CHECK),
        ui.text(`${written} day(s) written, ${unchanged} unchanged · ${ingest.parsed} of ${ingest.scanned} transcript(s) parsed`),
      );
      if (ingest.failed > 0) ui.row(ui.warn(ui.WARN_GLYPH), ui.text(`${ingest.failed} transcript(s) could not be read`));
      if (written + unchanged === 0) ui.row(ui.dim(ui.BULLET), ui.dim(`no activity for ${date ?? today}`));
    } finally {
      db.close();
    }
  });
}
