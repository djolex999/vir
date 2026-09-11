import { describe, expect, it } from "vitest";
import {
  distillFailureCheck,
  failureNotice,
  type DistillFailureState,
} from "./distillFailures.js";

const NOW = Date.parse("2026-09-11T12:00:00.000Z");
const DAY = 86_400_000;
const state = (over: Partial<DistillFailureState> = {}): DistillFailureState => ({
  total: 0,
  recoverable: 0,
  lastFailureAt: null,
  worstDay: null,
  ...over,
});

// This check exists because 15 sessions died in one `fetch failed` window on
// 2026-06-11 and nobody noticed for three months. By the time anyone looked,
// Claude Code had deleted the transcripts and the knowledge was gone for good.
// The daemon runs unattended: if a bad afternoon is not surfaced somewhere the
// user actually looks, it becomes permanent loss.
describe("distillFailureCheck", () => {
  it("says nothing when there have been no failures", () => {
    expect(distillFailureCheck(state(), NOW)).toBeNull();
  });

  it("FAILS on recent failures — this is the window where recovery is possible", () => {
    const r = distillFailureCheck(
      state({
        total: 15,
        recoverable: 15,
        lastFailureAt: new Date(NOW - 2 * DAY).toISOString(),
        worstDay: { date: "2026-09-09", count: 15 },
      }),
      NOW,
    );

    expect(r?.status).toBe("fail");
    expect(r?.detail).toContain("15");
    expect(r?.detail).toContain("vir reconcile");
  });

  it("names the cluster, because one bad window is the signal", () => {
    const r = distillFailureCheck(
      state({
        total: 18,
        recoverable: 3,
        lastFailureAt: new Date(NOW - 1 * DAY).toISOString(),
        worstDay: { date: "2026-09-10", count: 15 },
      }),
      NOW,
    );

    expect(r?.detail).toContain("2026-09-10");
    expect(r?.detail).toContain("15");
  });

  // Old but still retryable: the transcripts have not expired yet, so this is
  // a warning with an action, not an alarm.
  it("WARNS when failures are old but still recoverable", () => {
    const r = distillFailureCheck(
      state({
        total: 9,
        recoverable: 9,
        lastFailureAt: new Date(NOW - 30 * DAY).toISOString(),
        worstDay: { date: "2026-08-12", count: 9 },
      }),
      NOW,
    );

    expect(r?.status).toBe("warn");
    expect(r?.detail).toContain("vir reconcile");
  });

  // Nothing to do: the transcripts are gone, so reconcile cannot help. Say so
  // plainly instead of showing a red row that implies pending work forever.
  it("reports unrecoverable failures as ok, with no call to action", () => {
    const r = distillFailureCheck(
      state({
        total: 28,
        recoverable: 0,
        lastFailureAt: "2026-07-07T10:00:00.000Z",
        worstDay: { date: "2026-06-11", count: 15 },
      }),
      NOW,
    );

    expect(r?.status).toBe("ok");
    expect(r?.detail).toContain("28");
    expect(r?.detail).toContain("unrecoverable");
    expect(r?.detail).not.toContain("vir reconcile");
  });

  it("counts recoverable separately from the total", () => {
    const r = distillFailureCheck(
      state({
        total: 29,
        recoverable: 1,
        lastFailureAt: new Date(NOW - 40 * DAY).toISOString(),
        worstDay: { date: "2026-06-11", count: 15 },
      }),
      NOW,
    );

    expect(r?.detail).toContain("1");
    expect(r?.detail).toContain("29");
  });
});

// Doctor only helps someone who runs doctor. The daemon runs unattended, so a
// bad window needs to reach the user the day it happens — that is the whole
// difference between "reconcile recovers it" and "the transcript expired".
describe("failureNotice", () => {
  it("says nothing when a run had no errors", () => {
    expect(failureNotice(0)).toBeNull();
  });

  it("names the count and the recovery command", () => {
    const n = failureNotice(15);
    expect(n?.title).toContain("vir");
    expect(n?.message).toContain("15");
    expect(n?.message).toContain("vir reconcile");
  });

  it("is singular for one failure", () => {
    expect(failureNotice(1)?.message).toContain("1 session");
    expect(failureNotice(1)?.message).not.toContain("1 sessions");
  });
})
