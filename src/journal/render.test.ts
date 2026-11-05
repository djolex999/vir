import { describe, expect, it } from "vitest";
import { buildDay, CARRY_DAYS, dayOf, daysBetween, renderDay, type JournalSession } from "./render.js";

const TZ = "Europe/Belgrade";
const session = (over: Partial<JournalSession>): JournalSession => ({
  path: "/p/abcdef1234.jsonl",
  sessionId: "abcdef1234",
  project: "vir",
  startedAt: "2026-11-04T10:00:00.000Z",
  endedAt: "2026-11-04T11:00:00.000Z",
  events: [],
  ...over,
});

describe("dayOf", () => {
  it("uses the local day, not the UTC one", () => {
    expect(dayOf("2026-11-04T23:30:00.000Z", TZ)).toBe("2026-11-05");
    expect(dayOf("2026-11-04T23:30:00.000Z", "UTC")).toBe("2026-11-04");
    expect(dayOf("garbage", TZ)).toBeNull();
  });
});

describe("buildDay", () => {
  it("sorts tasks into sections, every Done line with a pointer", () => {
    const at = "2026-11-04T10:30:00.000Z";
    const [p] = buildDay(
      [
        session({
          events: [
            { kind: "task_created", at, taskId: "1", subject: "Finished" },
            { kind: "task_updated", at, taskId: "1", status: "completed" },
            { kind: "task_created", at, taskId: "2", subject: "Working" },
            { kind: "task_updated", at, taskId: "2", status: "in_progress" },
            { kind: "task_created", at, taskId: "3", subject: "Waiting" },
            { kind: "task_updated", at, taskId: "3", addBlockedBy: ["2"] },
            { kind: "task_created", at, taskId: "4", subject: "Later" },
            { kind: "task_created", at, taskId: "5", subject: "Dropped" },
            { kind: "task_updated", at, taskId: "5", status: "deleted" },
            { kind: "commit", at, sha: "a1b2c3d4e5", branch: "main", message: "Ship" },
          ],
        }),
      ],
      [{ path: "/p/abcdef1234.jsonl", topic: "Use SQLite" }],
      "2026-11-04",
      TZ,
    );
    expect(p).toEqual({
      project: "vir",
      sessions: 1,
      done: ["Ship (commit a1b2c3d)", "Finished (task abcdef12#1)"],
      inProgress: ["Working (task abcdef12#2)"],
      decisions: ["[[use-sqlite-abcdef12]]"],
      blocked: ["Waiting (task abcdef12#3), waiting on #2"],
      open: ["Later (task abcdef12#4)"],
      carried: [],
    });
  });

  it("shows a past day as it stood then, and carries no untouched task", () => {
    const events: JournalSession["events"] = [
      { kind: "task_created", at: "2026-11-03T10:00:00.000Z", taskId: "1", subject: "Long task" },
      { kind: "task_updated", at: "2026-11-03T11:00:00.000Z", taskId: "1", status: "in_progress" },
      { kind: "task_updated", at: "2026-11-05T10:00:00.000Z", taskId: "1", status: "completed" },
    ];
    const s = session({ startedAt: "2026-11-03T10:00:00.000Z", endedAt: "2026-11-05T10:00:00.000Z", events });
    expect(buildDay([s], [], "2026-11-03", TZ)[0]?.inProgress).toEqual(["Long task (task abcdef12#1)"]);
    expect(buildDay([s], [], "2026-11-04", TZ)).toEqual([]);
    expect(buildDay([s], [], "2026-11-05", TZ)[0]?.done).toEqual(["Long task (task abcdef12#1)"]);
  });

  it("counts a commit replayed into a resumed session once", () => {
    const at = "2026-11-04T10:30:00.000Z";
    const commit = { kind: "commit" as const, at, sha: "a1b2c3d", branch: "main", message: "Ship" };
    const days = buildDay(
      [session({ events: [commit] }), session({ path: "/p/two.jsonl", sessionId: "two", events: [commit] })],
      [],
      "2026-11-04",
      TZ,
    );
    expect(days[0]?.done).toEqual(["Ship (commit a1b2c3d)"]);
    expect(days[0]?.sessions).toBe(2);
  });

  it("renders the same bytes for the same input and omits empty sections", () => {
    const projects = buildDay([session({})], [], "2026-11-04", TZ);
    const body = renderDay("2026-11-04", projects);
    expect(body).toBe(renderDay("2026-11-04", projects));
    expect(body).toContain("## vir\n\n1 session\n");
    expect(body).not.toContain("**Done**");
  });
});

describe("carried over", () => {
  // A session that ended mid-plan on 2026-11-02, and an unrelated session
  // that makes `day` active.
  const leftOpen = (events: JournalSession["events"], over: Partial<JournalSession> = {}): JournalSession =>
    session({ startedAt: "2026-11-02T10:00:00.000Z", endedAt: "2026-11-02T12:00:00.000Z", events, ...over });
  const today = (day: string, project = "vir"): JournalSession =>
    session({
      path: `/p/today-${day}.jsonl`,
      sessionId: `today${day}`,
      project,
      startedAt: `${day}T09:00:00.000Z`,
      endedAt: `${day}T09:30:00.000Z`,
    });
  const plan: JournalSession["events"] = [
    { kind: "task_created", at: "2026-11-02T10:00:00.000Z", taskId: "1", subject: "Write tests" },
    { kind: "task_updated", at: "2026-11-02T10:05:00.000Z", taskId: "1", status: "completed" },
    { kind: "task_created", at: "2026-11-02T10:00:00.000Z", taskId: "2", subject: "Wire the CLI" },
    { kind: "task_updated", at: "2026-11-02T10:10:00.000Z", taskId: "2", status: "in_progress" },
    { kind: "task_created", at: "2026-11-02T10:00:00.000Z", taskId: "3", subject: "Ship it" },
    { kind: "task_updated", at: "2026-11-02T10:00:00.000Z", taskId: "3", addBlockedBy: ["2"] },
    { kind: "task_created", at: "2026-11-02T10:00:00.000Z", taskId: "4", subject: "Docs" },
    { kind: "task_created", at: "2026-11-02T10:00:00.000Z", taskId: "5", subject: "Dropped" },
    { kind: "task_updated", at: "2026-11-02T11:00:00.000Z", taskId: "5", status: "deleted" },
  ];

  it("carries unfinished tasks from an earlier day with their pointer and age", () => {
    const [p] = buildDay([leftOpen(plan), today("2026-11-04")], [], "2026-11-04", TZ);
    expect(p?.sessions).toBe(1);
    expect(p?.inProgress).toEqual([]);
    expect(p?.carried).toEqual([
      "Docs (task abcdef12#4), not started, open 2 days",
      "Ship it (task abcdef12#3), waiting on #2, open 2 days",
      "Wire the CLI (task abcdef12#2), in progress, open 2 days",
    ]);
    const body = renderDay("2026-11-04", [p!]);
    expect(body).toContain("**Carried over**\n- Docs (task abcdef12#4), not started, open 2 days\n");
  });

  it("does not carry on the day the task was touched", () => {
    const [p] = buildDay([leftOpen(plan)], [], "2026-11-02", TZ);
    expect(p?.carried).toEqual([]);
    expect(p?.inProgress).toEqual(["Wire the CLI (task abcdef12#2)"]);
  });

  it("carries into projects with no session that day, but writes no idle day", () => {
    expect(buildDay([leftOpen(plan)], [], "2026-11-04", TZ)).toEqual([]);
    const days = buildDay([leftOpen(plan), today("2026-11-04", "other")], [], "2026-11-04", TZ);
    expect(days.map((d) => [d.project, d.sessions, d.carried.length])).toEqual([
      ["other", 1, 0],
      ["vir", 0, 3],
    ]);
    expect(renderDay("2026-11-04", days)).toContain("## vir\n\nno sessions\n");
  });

  it("stops carrying once the task is completed or deleted, or its plan replaced", () => {
    const later: JournalSession["events"] = [
      ...plan,
      { kind: "task_updated", at: "2026-11-03T10:00:00.000Z", taskId: "2", status: "completed" },
      { kind: "task_updated", at: "2026-11-03T10:00:00.000Z", taskId: "4", status: "deleted" },
    ];
    const s = leftOpen(later, { endedAt: "2026-11-03T10:00:00.000Z" });
    const [p] = buildDay([s, today("2026-11-04")], [], "2026-11-04", TZ);
    // #3's blocker finished, so it is just not started now.
    expect(p?.carried).toEqual(["Ship it (task abcdef12#3), not started, open 2 days"]);
  });

  it("drops the copy a resumed session or a re-plan touched later", () => {
    const resumed = session({
      path: "/p/resumed.jsonl",
      sessionId: "resumed99",
      startedAt: "2026-11-03T10:00:00.000Z",
      endedAt: "2026-11-03T11:00:00.000Z",
      events: [
        { kind: "task_created", at: "2026-11-03T10:00:00.000Z", taskId: "1", subject: "Wire the CLI" },
        { kind: "task_updated", at: "2026-11-03T10:30:00.000Z", taskId: "1", status: "completed" },
      ],
    });
    const [p] = buildDay([leftOpen(plan), resumed, today("2026-11-04")], [], "2026-11-04", TZ);
    expect(p?.carried.map((c) => c.split(" (")[0])).toEqual(["Docs", "Ship it"]);
  });

  it("stops carrying a task nobody touched for more than CARRY_DAYS days", () => {
    const lastTouch = "2026-11-02";
    const edge = `2026-11-${String(2 + CARRY_DAYS).padStart(2, "0")}`;
    const past = `2026-11-${String(3 + CARRY_DAYS).padStart(2, "0")}`;
    expect(daysBetween(lastTouch, edge)).toBe(CARRY_DAYS);
    expect(buildDay([leftOpen(plan), today(edge)], [], edge, TZ)[0]?.carried).toHaveLength(3);
    expect(buildDay([leftOpen(plan), today(past)], [], past, TZ)[0]?.carried).toEqual([]);
  });

  it("counts days across a DST change and a month end by local calendar", () => {
    expect(daysBetween("2026-10-24", "2026-10-26")).toBe(2);
    expect(daysBetween("2026-10-31", "2026-11-01")).toBe(1);
    // 00:30 Belgrade on 11-03 is still 11-02 in UTC: the local day decides.
    const s = leftOpen([{ kind: "task_created", at: "2026-11-02T23:30:00.000Z", taskId: "1", subject: "Late" }], {
      startedAt: "2026-11-02T23:30:00.000Z",
      endedAt: "2026-11-02T23:30:00.000Z",
    });
    expect(buildDay([s, today("2026-11-04")], [], "2026-11-04", TZ)[0]?.carried).toEqual([
      "Late (task abcdef12#1), not started, open 1 day",
    ]);
  });
});
