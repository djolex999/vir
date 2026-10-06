import type { Lesson } from "./types.js";

export const MIN_SESSIONS = 3;
export const MIN_SPAN_DAYS = 7;
const DAY_MS = 86_400_000;

export interface Recurrence {
  sessions: string[];
  firstSeen: string;
  lastSeen: string;
  projects: string[];
  spanDays: number;
}

// Each session counts once, dated by its earliest parseable note date. A
// session with no parseable date still counts toward sessions but not the span.
export function recurrence(members: Lesson[]): Recurrence {
  const earliest = new Map<string, number | null>();
  for (const m of members) {
    const t = Date.parse(m.noteDate);
    const prev = earliest.get(m.sessionId);
    if (prev === undefined) earliest.set(m.sessionId, Number.isFinite(t) ? t : null);
    else if (Number.isFinite(t) && (prev === null || t < prev)) earliest.set(m.sessionId, t);
  }
  const times = [...earliest.values()].filter((t): t is number => t !== null);
  const first = times.length > 0 ? Math.min(...times) : null;
  const last = times.length > 0 ? Math.max(...times) : null;
  const projects = [...new Set(members.map((m) => m.project).filter((p) => p.length > 0))].sort();
  return {
    sessions: [...earliest.keys()],
    firstSeen: first === null ? "" : new Date(first).toISOString(),
    lastSeen: last === null ? "" : new Date(last).toISOString(),
    projects,
    spanDays: first === null || last === null ? 0 : (last - first) / DAY_MS,
  };
}

export function qualifies(r: Recurrence): boolean {
  return r.sessions.length >= MIN_SESSIONS && r.spanDays >= MIN_SPAN_DAYS;
}

export function rankCandidates(
  clusters: Lesson[][],
): Array<{ members: Lesson[]; rec: Recurrence }> {
  return clusters
    .map((members) => ({ members, rec: recurrence(members) }))
    .filter((c) => qualifies(c.rec))
    .sort(
      (a, b) =>
        b.rec.sessions.length - a.rec.sessions.length ||
        b.rec.spanDays - a.rec.spanDays ||
        b.rec.projects.length - a.rec.projects.length,
    );
}
