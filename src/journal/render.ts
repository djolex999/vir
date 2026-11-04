import { makeSlug } from "../pipeline/slug.js";
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
}

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

export function shortSession(sessionId: string): string {
  return sessionId.slice(0, 8);
}

interface TaskState {
  subject: string;
  status: TaskStatus;
  blockedBy: Set<string>;
  touched: boolean;
  completedToday: boolean;
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
      });
      continue;
    }
    const t = tasks.get(e.taskId);
    if (!t) continue;
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
      p = { project, sessions: 0, done: [], inProgress: [], decisions: [], blocked: [], open: [] };
      byProject.set(project, p);
    }
    return p;
  };
  const shas = new Set<string>();
  const notesByPath = new Map<string, string[]>();
  for (const d of decisions) {
    notesByPath.set(d.path, [...(notesByPath.get(d.path) ?? []), d.topic]);
  }

  for (const s of sessions) {
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

    const tasks = replayTasks(s, day, timeZone);
    const short = shortSession(s.sessionId);
    for (const [id, t] of tasks) {
      if (!t.touched) continue;
      const pointer = `(task ${short}#${id})`;
      if (t.status === "completed") {
        if (t.completedToday) p.done.push(`${t.subject} ${pointer}`);
        continue;
      }
      if (t.status === "deleted") continue;
      const blockers = [...t.blockedBy].filter((b) => {
        const blocker = tasks.get(b);
        return blocker?.status !== "completed" && blocker?.status !== "deleted";
      });
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

const SECTIONS: Array<[string, keyof Pick<ProjectDay, "done" | "inProgress" | "decisions" | "blocked" | "open">]> = [
  ["Done", "done"],
  ["In progress", "inProgress"],
  ["Decisions", "decisions"],
  ["Blocked", "blocked"],
  ["Open", "open"],
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
    out.push("", `## ${p.project}`, "", `${p.sessions} session${p.sessions === 1 ? "" : "s"}`);
    for (const [title, key] of SECTIONS) {
      const items = p[key];
      if (items.length === 0) continue;
      out.push("", `**${title}**`, ...items.map((i) => `- ${i}`));
    }
  }
  return `${out.join("\n")}\n`;
}
