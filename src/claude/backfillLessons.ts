import type { Classification } from "../pipeline/types.js";
import { kebab } from "../pipeline/slug.js";
import { SubscriptionLimitError } from "../pipeline/subscription.js";
import type { DistilledRow, StateDb } from "../state/db.js";

export interface LessonSource {
  lesson(session: { sessionId: string }, markdown: string, cls: Classification): Promise<string | null>;
}

export interface BackfillResult {
  written: number;
  none: number;
  failed: number;
  // Set when a subscription limit stopped the run; the rest stay NULL.
  stoppedBy: SubscriptionLimitError | null;
}

// Gotchas distilled before the lesson call existed (lesson IS NULL). Only
// gotchas: they are all CLAUDE.md shows. A row asked once and answered NONE
// holds "" and is not asked again.
export function lessonlessGotchas(db: StateDb, project?: string): DistilledRow[] {
  return db
    .listDistilled()
    .filter((r) => r.category === "gotcha" && r.lesson === null)
    .filter((r) => project === undefined || kebab(r.project) === project);
}

// One lesson call per row over the stored note, the same call a fresh distill
// makes (the stored topic is the note's title). A failed call leaves the row
// NULL for the next run; a subscription limit stops the run.
export async function backfillLessons(
  db: StateDb,
  source: LessonSource,
  rows: DistilledRow[],
  onRow: (row: DistilledRow, lesson: string | null, error: Error | null) => void = () => {},
): Promise<BackfillResult> {
  const result: BackfillResult = { written: 0, none: 0, failed: 0, stoppedBy: null };
  for (const row of rows) {
    let lesson: string | null;
    try {
      lesson = await source.lesson({ sessionId: row.sessionId }, row.content, {
        category: row.category,
        topic: row.topic,
        project: row.project,
        confidence: row.confidence,
        themes: [],
      });
    } catch (err) {
      if (err instanceof SubscriptionLimitError) {
        result.stoppedBy = err;
        return result;
      }
      result.failed += 1;
      onRow(row, null, err as Error);
      continue;
    }
    db.setLesson(row.path, lesson ?? "");
    if (lesson === null) result.none += 1;
    else result.written += 1;
    onRow(row, lesson, null);
  }
  return result;
}
