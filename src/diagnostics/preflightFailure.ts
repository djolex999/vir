import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CheckStatus } from "../ui/display.js";
import type { FailureNotice } from "./distillFailures.js";

// A failed provider preflight aborts the run before the loop, so it records no
// per-session error rows. That is deliberate (one environmental fact, not N
// session failures), but it also means failureNotice and doctor's
// distill-failures row never see it. From 2026-09-23 every daemon run died on
// an expired claude-cli OAuth session and the only trace was a stack trace in
// daemon.log. This marker is the durable half of the signal: written on a
// failed probe, removed by the next successful one.
export const PREFLIGHT_FAIL_MARKER_PATH = join(
  homedir(),
  ".vir",
  "provider-preflight.failed",
);

// Past this, the marker says more about the daemon not running than about the
// provider — still worth a row, but not a red one.
const RECENT_PREFLIGHT_FAILURE_DAYS = 2;

const NOTICE_MAX_CHARS = 200;

export interface PreflightFailure {
  at: string;
  provider: string;
  message: string;
}

export interface PreflightFailureResult {
  status: CheckStatus;
  label: string;
  detail: string;
}

// Best-effort: the thrown preflight error is the primary signal, and a marker
// write must never replace it with an fs error.
export function recordPreflightFailure(
  f: PreflightFailure,
  path: string = PREFLIGHT_FAIL_MARKER_PATH,
): void {
  try {
    writeFileSync(path, JSON.stringify(f) + "\n", "utf8");
  } catch {
    // marker is best-effort
  }
}

export function clearPreflightFailure(
  path: string = PREFLIGHT_FAIL_MARKER_PATH,
): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // marker is best-effort
  }
}

export function readPreflightFailure(
  path: string = PREFLIGHT_FAIL_MARKER_PATH,
): PreflightFailure | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const { at, provider, message } = raw as Record<string, unknown>;
  if (
    typeof at !== "string" ||
    typeof provider !== "string" ||
    typeof message !== "string"
  ) {
    return null;
  }
  return { at, provider, message };
}

const AUTH_FAILURE = /authenticat|oauth|log ?in|401|unauthori[sz]ed/i;

// Who is logged out, and the one thing the user has to do, when we know it.
function authRemedy(
  provider: string,
  message: string,
): { agent: string; fix: string } | null {
  if (!AUTH_FAILURE.test(message)) return null;
  if (provider === "claude-cli") {
    return { agent: "Claude Code", fix: "run `claude` and `/login`, then `vir run`" };
  }
  if (provider === "codex-cli") {
    return { agent: "Codex", fix: "run `codex login`, then `vir run`" };
  }
  return null;
}

function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

export function preflightFailureNotice(
  provider: string,
  message: string,
): FailureNotice {
  const auth = authRemedy(provider, message);
  const title = `vir — ${provider} unavailable, nothing distilled`;
  if (auth !== null) return { title, message: `${auth.agent} is logged out — ${auth.fix}` };
  return { title, message: truncate(message, NOTICE_MAX_CHARS) };
}

export function preflightFailureCheck(
  f: PreflightFailure | null,
  now: number,
): PreflightFailureResult | null {
  if (f === null) return null;
  const at = Date.parse(f.at);
  const recent =
    !Number.isNaN(at) &&
    (now - at) / 86_400_000 <= RECENT_PREFLIGHT_FAILURE_DAYS;
  const fix = authRemedy(f.provider, f.message)?.fix ?? null;
  return {
    status: recent ? "fail" : "warn",
    label: "provider preflight",
    detail:
      `last run failed ${f.at.slice(0, 16).replace("T", " ")} · ${f.provider} · ${truncate(f.message, 90)}` +
      (fix !== null ? ` — ${fix}` : " — clears on the next successful run"),
  };
}
