import { describe, expect, it } from "vitest";
import { buildDay, dayOf, renderDay, type JournalSession } from "./render.js";

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
