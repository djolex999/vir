import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import type { DistilledRow, StateDb } from "../state/db.js";
import {
  callLLM,
  maybeAnthropicClient,
  normalizeModelName,
  resolveModelShorthand,
  withRateLimitRetry,
} from "./distiller.js";
import {
  buildSummaryPrompt,
  countByCategory,
  type ProjectCounts,
} from "./summarizer.js";

// Period summaries are a DERIVED artifact: regenerable files only. They are
// never embedded and never recorded in SQLite — embedding or tabling them would
// pollute retrieval with summaries-of-notes. Hence no DB table, no maybeEmbed,
// and the retriever excludes this directory from its TF-IDF walk.
export const SUMMARIES_SUBDIR = "summaries";

const MS_PER_DAY = 86_400_000;

// Synthesis output budget (matches the project summarizer's maxTokens).
const PERIOD_MAX_TOKENS = 1500;
// Dry-run estimate only — house chars/4 heuristic, never billing.
const CHARS_PER_TOKEN = 4;
const PERIOD_OUTPUT_TOKENS = 1200;

export type PeriodKind = "week" | "month";

// offset 0 = the current period, 1 = the previous one, etc.
export interface Period {
  kind: PeriodKind;
  offset: number;
}

// Half-open [start, end) UTC window. All boundary math is in UTC so windows are
// deterministic across machine timezones and line up with the note `date`
// frontmatter (which is the UTC calendar date of `startedAt`).
export interface PeriodRange {
  start: Date;
  end: Date;
}

export interface PeriodSummaryResult {
  slug: string;
  path: string;
  relPath: string;
  label: string;
  noteCount: number;
  counts: ProjectCounts;
  rangeStart: string; // YYYY-MM-DD inclusive
  rangeEnd: string; // YYYY-MM-DD inclusive
}

// ── pure date helpers (unit-tested in periodSummary.test.ts) ──────────────────

// ISO 8601 week-numbering: weeks start Monday; week 1 is the week containing the
// year's first Thursday. The week-year can differ from the calendar year at
// boundaries (late Dec / early Jan), which is why it is returned separately.
export function isoWeek(date: Date): { weekYear: number; week: number } {
  const d = utcMidnight(date);
  const dayNum = d.getUTCDay() || 7; // Sun(0) → 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // pivot to this week's Thursday
  const weekYear = d.getUTCFullYear();
  const yearStart = Date.UTC(weekYear, 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / MS_PER_DAY + 1) / 7);
  return { weekYear, week };
}

export function periodRange(period: Period, now: Date): PeriodRange {
  if (period.kind === "week") {
    const start = isoWeekStart(now);
    start.setUTCDate(start.getUTCDate() - period.offset * 7);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 7);
    return { start, end };
  }
  // month — Date.UTC normalizes month under/overflow (e.g. month -1 → prev Dec).
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - period.offset, 1));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  return { start, end };
}

// `date` must be a date WITHIN the target period (typically `range.start`); the
// period's offset is already baked into it. Mirrors composeRelPath/articleRelPath.
export function periodSlug(period: Period, date: Date): string {
  if (period.kind === "week") {
    const { weekYear, week } = isoWeek(date);
    return `week-${weekYear}-W${pad2(week)}`;
  }
  return `month-${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}`;
}

export function periodRelPath(slug: string, dir: string = SUMMARIES_SUBDIR): string {
  return join(dir, `${slug}.md`);
}

export function periodLabel(period: Period, range: PeriodRange): string {
  const start = ymd(range.start);
  const end = ymd(inclusiveEnd(range));
  const id =
    period.kind === "week"
      ? (() => {
          const { weekYear, week } = isoWeek(range.start);
          return `${weekYear}-W${pad2(week)}`;
        })()
      : `${range.start.getUTCFullYear()}-${pad2(range.start.getUTCMonth() + 1)}`;
  return `${id} (${start} to ${end})`;
}

// The testable core: distilled notes whose `startedAt` date falls in the window.
// `startedAt` is what listDistilled() exposes AND what the note `date`
// frontmatter shows, so windowing over it keeps a summary self-consistent with
// the dates printed on its source notes. Notes with no/invalid date are dropped.
export function selectNotesInPeriod(
  notes: DistilledRow[],
  period: Period,
  now: Date,
): DistilledRow[] {
  const { start, end } = periodRange(period, now);
  const lo = start.getTime();
  const hi = end.getTime();
  return notes.filter((n) => {
    if (!n.startedAt) return false;
    const t = Date.parse(n.startedAt);
    if (Number.isNaN(t)) return false;
    return t >= lo && t < hi;
  });
}

// ── prompt + cost estimate ───────────────────────────────────────────────────

export function buildPeriodPrompt(
  label: string,
  notes: DistilledRow[],
  counts: ProjectCounts,
): string {
  return buildSummaryPrompt(
    {
      noun: "period",
      heading: `Period: ${label}\nTotal notes: ${counts.total}`,
      overviewHint:
        "what these sessions covered and which themes or projects dominate this period",
    },
    notes,
    counts,
  );
}

export function estimatePeriodCostTokens(prompt: string): {
  inputTokens: number;
  outputTokens: number;
} {
  return {
    inputTokens: Math.ceil(prompt.length / CHARS_PER_TOKEN),
    outputTokens: PERIOD_OUTPUT_TOKENS,
  };
}

// ── orchestration (side-effectful: LLM + file write, no DB/embedding) ─────────

export async function summarizePeriod(
  cfg: Config,
  db: StateDb,
  period: Period,
  opts: { now: Date; model?: string },
): Promise<PeriodSummaryResult | null> {
  const notes = selectNotesInPeriod(db.listDistilled(), period, opts.now);
  if (notes.length === 0) return null;

  const range = periodRange(period, opts.now);
  const slug = periodSlug(period, range.start);
  const label = periodLabel(period, range);
  const counts = countByCategory(notes);
  const prompt = buildPeriodPrompt(label, notes, counts);

  const client = maybeAnthropicClient(cfg);
  const model = normalizeModelName(
    resolveModelShorthand(opts.model ?? cfg.models.distill),
    cfg.provider,
  );

  const body = await withRateLimitRetry(() =>
    callLLM(cfg, client, {
      prompt,
      model,
      maxTokens: PERIOD_MAX_TOKENS,
      cost: { session: slug, project: "summaries", stage: "summarize-period" },
    }),
  );

  const path = writePeriodSummaryFile(cfg, {
    slug,
    period,
    range,
    label,
    counts,
    body: body.trim(),
  });

  return {
    slug,
    path,
    relPath: periodRelPath(slug),
    label,
    noteCount: notes.length,
    counts,
    rangeStart: ymd(range.start),
    rangeEnd: ymd(inclusiveEnd(range)),
  };
}

function writePeriodSummaryFile(
  cfg: Config,
  args: {
    slug: string;
    period: Period;
    range: PeriodRange;
    label: string;
    counts: ProjectCounts;
    body: string;
  },
): string {
  const dir = join(cfg.vaultPath, cfg.outputDir, SUMMARIES_SUBDIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${args.slug}.md`);

  const frontmatter = [
    "---",
    "type: summary",
    `period: ${args.period.kind}`,
    `range_start: ${ymd(args.range.start)}`,
    `range_end: ${ymd(inclusiveEnd(args.range))}`,
    `note_count: ${args.counts.total}`,
    `generated: ${new Date().toISOString()}`,
    "---",
    "",
    `# ${args.label}`,
    "",
  ].join("\n");

  writeFileSync(filePath, `${frontmatter}${args.body}\n`);
  return filePath;
}

// ── tiny UTC formatting helpers ──────────────────────────────────────────────

function utcMidnight(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function isoWeekStart(date: Date): Date {
  const d = utcMidnight(date);
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - (dayNum - 1)); // back to Monday
  return d;
}

function inclusiveEnd(range: PeriodRange): Date {
  return new Date(range.end.getTime() - MS_PER_DAY);
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
