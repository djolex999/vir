import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TokenUsage } from "./distiller.js";
import {
  resolveBin,
  runProcess,
  SubscriptionLimitError,
  type SpawnImpl,
} from "./subscription.js";

// Distill through `codex exec` on the user's ChatGPT login: no credential, quota
// not dollars. Experimental. Flag set verified on codex-cli 0.160.1
// (2026-10-07). runProcess pins cwd to ~/.vir so no project AGENTS.md loads; the
// global ~/.codex/AGENTS.md still does (no flag turns it off), the same way
// `claude -p` loads ~/.claude/CLAUDE.md.

export const CODEX_CLI_TIMEOUT_MS = 600_000;

export class CodexCliLimitError extends SubscriptionLimitError {
  constructor(resetsAt: string | null) {
    super(
      "Codex usage limit reached" +
        (resetsAt ? ` — try again ${resetsAt}` : "") +
        ". Distillation halted; unprocessed sessions will be picked up next run.",
      resetsAt,
    );
    this.name = "CodexCliLimitError";
  }
}

export class CodexCliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
  ) {
    super(message);
    this.name = "CodexCliError";
  }
}

// --ephemeral is load-bearing: without it every distill call writes a rollout
// into ~/.codex/sessions, and vir's own Codex source would ingest it. "default"
// leaves the model to Codex. Signature takes ONLY the model: no options path
// can drop a flag.
export function buildCodexCliArgs(model: string): string[] {
  return [
    "exec",
    "--ephemeral",
    "--json",
    "--skip-git-repo-check",
    "-s",
    "read-only",
    "--ignore-user-config",
    ...(model === "default" ? [] : ["-m", model]),
    "-",
  ];
}

export interface CodexJsonlResult {
  text: string;
  usage: TokenUsage | null;
  error: string | null;
}

export function parseCodexJsonl(stdout: string): CodexJsonlResult {
  let text = "";
  let usage: TokenUsage | null = null;
  let error: string | null = null;
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (evt.type === "item.completed") {
      const item = evt.item as { type?: unknown; text?: unknown } | undefined;
      if (item?.type === "agent_message" && typeof item.text === "string") text = item.text;
    } else if (evt.type === "turn.completed") {
      const u = evt.usage as Record<string, unknown> | undefined;
      if (u && typeof u.input_tokens === "number" && typeof u.output_tokens === "number") {
        const reasoning = typeof u.reasoning_output_tokens === "number" ? u.reasoning_output_tokens : 0;
        usage = { input_tokens: u.input_tokens, output_tokens: u.output_tokens + reasoning };
      }
    } else if (evt.type === "turn.failed") {
      const m = (evt.error as { message?: unknown } | undefined)?.message;
      if (typeof m === "string") error = m;
    } else if (evt.type === "error" && error === null && typeof evt.message === "string") {
      error = evt.message;
    }
  }
  return { text, usage, error };
}

// UNVERIFIED against a real limit hit (ChatGPT plan usage limit). A miss falls
// through to CodexCliError, and the raw output is logged once per run so the
// first real hit leaves evidence to check this against.
const LIMIT_RE = /You've hit your usage limit(?:[^\n]*?[Tt]ry again ((?:in|at) [^.\n"]+))?/;

export function parseCodexLimit(text: string): { resetsAt: string | null } | null {
  const m = LIMIT_RE.exec(text);
  if (!m) return null;
  return { resetsAt: m[1]?.trim() ?? null };
}

let rawLogged = false;
export function resetCodexRawLogGate(): void {
  rawLogged = false;
}

const DAEMON_LOG = join(homedir(), ".vir", "daemon.log");
function defaultLogRaw(line: string): void {
  try {
    appendFileSync(DAEMON_LOG, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // evidence logging is best-effort
  }
}

let resolvedCodexBin: string | null = null;

// Injectable for tests ONLY. cwd and the arg set are not.
export interface CallCodexCliTestOpts {
  spawnImpl?: SpawnImpl;
  timeoutMs?: number;
  logRaw?: (line: string) => void;
  codexBin?: string;
}

export async function callCodexCli(
  opts: { prompt: string; model: string },
  test: CallCodexCliTestOpts = {},
): Promise<{ text: string; usage: TokenUsage | null }> {
  const spawnImpl = test.spawnImpl ?? (spawn as unknown as SpawnImpl);
  const logRaw = test.logRaw ?? defaultLogRaw;
  const bin = test.codexBin ?? (resolvedCodexBin ??= resolveBin("codex"));

  const { stdout, stderr, code } = await runProcess(
    spawnImpl,
    bin,
    buildCodexCliArgs(opts.model),
    opts.prompt,
    test.timeoutMs ?? CODEX_CLI_TIMEOUT_MS,
    (m) => new CodexCliError(m.startsWith("timed out") ? `codex exec ${m}` : m, null),
  );

  const r = parseCodexJsonl(stdout);
  if (r.error !== null || code !== 0 || r.text.length === 0) {
    const detail = r.error ?? stderr.trim();
    const limit = parseCodexLimit(detail) ?? parseCodexLimit(stderr);
    if (limit) throw new CodexCliLimitError(limit.resetsAt);
    if (!rawLogged) {
      rawLogged = true;
      logRaw(`codex-cli unrecognized failure (exit ${code}): ${stdout.trim().slice(0, 2000)}`);
    }
    throw new CodexCliError(
      `codex exec failed (exit ${code}): ${detail.slice(0, 300) || "no agent message"}`,
      code,
    );
  }
  return { text: r.text, usage: r.usage };
}
