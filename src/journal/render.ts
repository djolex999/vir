import { makeSlug, sessionSuffix } from "../pipeline/slug.js";
import type { JournalEvent, TaskStatus } from "./events.js";

export interface JournalSession {
  path: string;
  sessionId: string;
  project: string;
  startedAt: string | null;
  endedAt: string | null;
  events: JournalEvent[];
}

export interface DecisionNote {
  path: string; // transcript path; joins to JournalSession
  topic: string;
}

export interface ProjectDay {
  project: string;
  sessions: number;
  done: string[];
  inProgress: string[];
  decisions: string[];
  blocked: string[];
  open: string[];
  carried: string[];
}

// A loop left open stops carrying once nothing in its session has touched it
// for this many days. Past that it is abandoned, not in flight.
export const CARRY_DAYS = 7;

// The calendar day an instant falls on in `timeZone`. Never UTC math: a 00:30
// Belgrade commit belongs to that local day, not the previous UTC one.
export function dayOf(iso: string, timeZone: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

// Calendar arithmetic on YYYY-MM-DD labels that dayOf already produced in
// the right zone. The labels are dates, not instants, so UTC here is safe.
function dayNumber(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1) / 86_400_000;
}

export function daysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

interface TaskState {
  subject: string;
  status: TaskStatus;
  blockedBy: Set<string>;
  touched: boolean;
  completedToday: boolean;
  createdDay: string;
  lastAt: string;
  lastDay: string;
}

// One project's tasks as they stood at the end of `day`.
function replayTasks(session: JournalSession, day: string, timeZone: string): Map<string, TaskState> {
  const tasks = new Map<string, TaskState>();
  for (const e of session.events) {
    if (e.kind === "commit") continue;
    const eventDay = dayOf(e.at, timeZone);
    if (eventDay === null || eventDay > day) continue;
    const today = eventDay === day;
    if (e.kind === "task_created") {
      tasks.set(e.taskId, {
        subject: e.subject,
        status: "pending",
        blockedBy: new Set(),
        touched: today,
        completedToday: false,
        createdDay: eventDay,
        lastAt: e.at,
        lastDay: eventDay,
      });
      continue;
    }
    const t = tasks.get(e.taskId);
    if (!t) continue;
    t.lastAt = e.at;
    t.lastDay = eventDay;
    if (e.subject !== undefined) t.subject = e.subject;
    if (e.addBlockedBy) for (const b of e.addBlockedBy) t.blockedBy.add(b);
    if (e.status !== undefined) {
      t.status = e.status;
      t.completedToday = today && e.status === "completed";
    }
    if (today) t.touched = true;
  }
  return tasks;
}

function openBlockers(t: TaskState, tasks: Map<string, TaskState>): string[] {
  return [...t.blockedBy].filter((b) => {
    const blocker = tasks.get(b);
    return blocker?.status !== "completed" && blocker?.status !== "deleted";
  });
}

export function buildDay(
  sessions: JournalSession[],
  decisions: DecisionNote[],
  day: string,
  timeZone: string,
): ProjectDay[] {
  const byProject = new Map<string, ProjectDay>();
  const entry = (project: string): ProjectDay => {
    let p = byProject.get(project);
    if (!p) {
      p = { project, sessions: 0, done: [], inProgress: [], decisions: [], blocked: [], open: [], carried: [] };
      byProject.set(project, p);
    }
    return p;
  };
  const shas = new Set<string>();
  const notesByPath = new Map<string, string[]>();
  for (const d of decisions) {
    notesByPath.set(d.path, [...(notesByPath.get(d.path) ?? []), d.topic]);
  }

  // Every session that could hold a task still open today: started by the
  // end of `day` and seen within the carry window.
  const replays: Array<{ s: JournalSession; tasks: Map<string, TaskState> }> = [];
  let anyActive = false;
  for (const s of sessions) {
    const days = [s.startedAt, s.endedAt, ...s.events.map((e) => e.at)]
      .map((at) => (at === null ? null : dayOf(at, timeZone)))
      .filter((d): d is string => d !== null);
    if (days.length === 0) continue;
    const first = days.reduce((a, b) => (a < b ? a : b));
    const last = days.reduce((a, b) => (a > b ? a : b));
    if (first > day || daysBetween(last, day) > CARRY_DAYS) continue;
    replays.push({ s, tasks: replayTasks(s, day, timeZone) });
    if (days.includes(day)) anyActive = true;
  }
  // The journal has a file only for days something happened.
  if (!anyActive) return [];

  // The latest touch of each subject per project, through the end of `day`.
  // A resumed session replays its tasks into a new transcript, and a new
  // session often re-plans the same step: the later copy is the live one.
  const latestTouch = new Map<string, number>();
  for (const { s, tasks } of replays) {
    for (const t of tasks.values()) {
      const key = `${s.project}\0${t.subject}`;
      const at = Date.parse(t.lastAt);
      if (at > (latestTouch.get(key) ?? -Infinity)) latestTouch.set(key, at);
    }
  }

  const carried = new Map<string, Array<{ age: number; line: string }>>();
  for (const { s, tasks } of replays) {
    const short = sessionSuffix(s.sessionId);
    for (const [id, t] of tasks) {
      if (t.touched || t.status === "completed" || t.status === "deleted") continue;
      if (daysBetween(t.lastDay, day) > CARRY_DAYS) continue;
      if ((latestTouch.get(`${s.project}\0${t.subject}`) ?? -Infinity) > Date.parse(t.lastAt)) continue;
      const blockers = openBlockers(t, tasks);
      const state =
        blockers.length > 0
          ? `waiting on ${blockers.map((b) => `#${b}`).join(", ")}`
          : t.status === "in_progress"
            ? "in progress"
            : "not started";
      const age = daysBetween(t.createdDay, day);
      const list = carried.get(s.project) ?? [];
      list.push({ age, line: `${t.subject} (task ${short}#${id}), ${state}, open ${age} day${age === 1 ? "" : "s"}` });
      carried.set(s.project, list);
    }
  }
  for (const [project, list] of carried) {
    // Oldest first; the line breaks ties so the order never depends on input order.
    list.sort((a, b) => b.age - a.age || (a.line < b.line ? -1 : a.line > b.line ? 1 : 0));
    entry(project).carried.push(...list.map((c) => c.line));
  }

  for (const { s, tasks } of replays) {
    const active = [s.startedAt, s.endedAt, ...s.events.map((e) => e.at)].some(
      (at) => at !== null && dayOf(at, timeZone) === day,
    );
    if (!active) continue;
    const p = entry(s.project);
    p.sessions += 1;

    // A resumed session replays its history into a new transcript, so one
    // commit can appear twice. The sha is the identity.
    for (const e of s.events) {
      if (e.kind !== "commit" || dayOf(e.at, timeZone) !== day) continue;
      const key = `${s.project}:${e.sha}`;
      if (shas.has(key)) continue;
      shas.add(key);
      p.done.push(`${e.message} (commit ${e.sha.slice(0, 7)})`);
    }

    const short = sessionSuffix(s.sessionId);
    for (const [id, t] of tasks) {
      if (!t.touched) continue;
      const pointer = `(task ${short}#${id})`;
      if (t.status === "completed") {
        if (t.completedToday) p.done.push(`${t.subject} ${pointer}`);
        continue;
      }
      if (t.status === "deleted") continue;
      const blockers = openBlockers(t, tasks);
      if (blockers.length > 0) {
        p.blocked.push(`${t.subject} ${pointer}, waiting on ${blockers.map((b) => `#${b}`).join(", ")}`);
      } else if (t.status === "in_progress") {
        p.inProgress.push(`${t.subject} ${pointer}`);
      } else {
        p.open.push(`${t.subject} ${pointer}`);
      }
    }

    // A decision belongs to the day its session ended, when the note exists.
    if (s.endedAt !== null && dayOf(s.endedAt, timeZone) === day) {
      for (const topic of notesByPath.get(s.path) ?? []) {
        p.decisions.push(`[[${makeSlug(topic, s.sessionId)}]]`);
      }
    }
  }
  return [...byProject.values()].sort((a, b) => a.project.localeCompare(b.project));
}

type Section = "done" | "inProgress" | "decisions" | "blocked" | "open" | "carried";
const SECTIONS: Array<[string, keyof Pick<ProjectDay, Section>]> = [
  ["Done", "done"],
  ["In progress", "inProgress"],
  ["Decisions", "decisions"],
  ["Blocked", "blocked"],
  ["Open", "open"],
  ["Carried over", "carried"],
];

export function renderDay(day: string, projects: ProjectDay[]): string {
  const out = [
    "---",
    "type: journal",
    `date: ${day}`,
    "generated: vir journal",
    "---",
    "",
    `# ${day}`,
    "",
    "Generated from session transcripts. Edits here are overwritten.",
  ];
  for (const p of projects) {
    out.push("", `## ${p.project}`, "", p.sessions === 0 ? "no sessions" : `${p.sessions} session${p.sessions === 1 ? "" : "s"}`);
    for (const [title, key] of SECTIONS) {
      const items = p[key];
      if (items.length === 0) continue;
      out.push("", `**${title}**`, ...items.map((i) => `- ${i}`));
    }
  }
  return `${out.join("\n")}\n`;
}
