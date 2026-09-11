import type { CheckStatus } from "../ui/display.js";

// A failure is "recent" while Claude Code still holds the transcript (it prunes
// at ~30 days). Inside this window a failed session can still be recovered, so
// it is worth interrupting for; outside it, the answer may already be "too
// late" and the row is informational.
const RECENT_FAILURE_DAYS = 7;

export interface DistillFailureState {
  // Sessions carrying a distill error that never produced a note.
  total: number;
  // Of those, the ones whose transcript is still on disk — the only ones
  // `vir reconcile` can do anything with.
  recoverable: number;
  lastFailureAt: string | null;
  // The single worst day. A cluster is the signal: 15 sessions failing in one
  // afternoon is an outage, whereas 15 spread over a quarter is ordinary noise.
  worstDay: { date: string; count: number } | null;
}

export interface DistillFailureResult {
  status: CheckStatus;
  label: string;
  detail: string;
}

function daysSince(iso: string | null, now: number): number | null {
  if (iso === null) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : (now - t) / 86_400_000;
}

// Surface distill failures where the user actually looks.
//
// The daemon runs unattended every few hours. When a provider outage kills a
// batch, run.ts records an error row per session and moves on — correct
// behaviour, but the only trace is daemon.log, which nobody reads. In this
// vault 15 sessions died in one window and were found three months later, by
// which time the transcripts had expired and the knowledge was unrecoverable.
export function distillFailureCheck(
  s: DistillFailureState,
  now: number,
): DistillFailureResult | null {
  if (s.total === 0) return null;

  const label = "distill failures";
  const age = daysSince(s.lastFailureAt, now);
  const cluster =
    s.worstDay !== null && s.worstDay.count > 1
      ? ` · worst day ${s.worstDay.date} (${s.worstDay.count})`
      : "";
  const lastSeen =
    s.lastFailureAt !== null ? ` · last ${s.lastFailureAt.slice(0, 10)}` : "";

  // Nothing retryable: the transcripts are gone, so reconcile cannot help.
  // Report it plainly rather than showing a red row that implies pending work
  // forever — an alarm nobody can act on is an alarm nobody reads.
  if (s.recoverable === 0) {
    return {
      status: "ok",
      label,
      detail: `${s.total} unrecoverable (transcripts expired)${lastSeen}${cluster}`,
    };
  }

  const recent = age !== null && age <= RECENT_FAILURE_DAYS;
  return {
    status: recent ? "fail" : "warn",
    label,
    detail:
      `${s.recoverable} of ${s.total} still recoverable${lastSeen}${cluster}` +
      ` — run \`vir reconcile\` before the transcripts expire`,
  };
}

export interface FailureNotice {
  title: string;
  message: string;
}

// The same-day half of failure visibility. run.ts already notifies for
// projects awaiting a decision; a run that dropped sessions on the floor is at
// least as worth knowing about, and unlike the doctor row it reaches the user
// without them going looking. Pure so the thresholds are testable — the
// osascript call itself is not.
export function failureNotice(errored: number): FailureNotice | null {
  if (errored <= 0) return null;
  const noun = errored === 1 ? "session" : "sessions";
  return {
    title: "vir — distill failures",
    message: `${errored} ${noun} failed to distill — run \`vir reconcile\` while the transcripts still exist`,
  };
}
