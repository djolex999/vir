import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TokenUsage } from "./distiller.js";

// Neutral spawn cwd is a CORRECTNESS requirement, not a preference: `claude -p`
// run from a project directory loads that project's CLAUDE.md into context,
// silently injecting the user's project instructions into every distill prompt.
// ~/.vir is guaranteed to exist (config lives there) and carries no CLAUDE.md.
// Deliberately not injectable — no config or call-site path may change it.
const CLAUDE_CLI_CWD = join(homedir(), ".vir");

// Generous by design: the API path's slowest observed distill was 437s, and a
// stalled subprocess would otherwise hang the daemon forever (the callKie
// AbortController lesson).
export const CLAUDE_CLI_TIMEOUT_MS = 600_000;

// Stamped the first time the docs-sourced limit regex actually matches a real
// envelope. `vir doctor` reports it so the user learns when the (unverified)
// pattern has been confirmed against reality.
export const CLAUDE_CLI_LIMIT_MARKER_PATH = join(
  homedir(),
  ".vir",
  "claude-cli-limit.confirmed",
);

// A subscription limit is a WALL that persists for hours — the polar opposite
// of a transient 429. isRetryable must treat it as non-retryable, and the run
// loop halts on it without burning the per-session attempt counter.
export class ClaudeCliLimitError extends Error {
  constructor(
    readonly kind: "session" | "weekly" | "opus",
    readonly resetsAt: string | null,
  ) {
    super(
      `Claude Code ${kind} limit reached` +
        (resetsAt ? ` — resets ${resetsAt}` : "") +
        ". Distillation halted; unprocessed sessions will be picked up next run.",
    );
    this.name = "ClaudeCliLimitError";
  }
}

// Every other claude-cli failure: carries the exit code and (when the envelope
// parsed) the API status so isRetryable can reason about it.
export class ClaudeCliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly apiErrorStatus: number | null = null,
  ) {
    super(message);
    this.name = "ClaudeCliError";
  }
}

// The full arg set is fixed: print mode, pinned model, JSON envelope (the only
// parseable failure surface), and --no-session-persistence so vir never writes
// transcripts into ~/.claude/projects — no self-scanning, no disk bloat,
// regardless of the user's agentTranscripts setting. Signature takes ONLY the
// model: there is deliberately no options path that could omit a flag.
export function buildClaudeCliArgs(model: string): string[] {
  return [
    "-p",
    "--model",
    model,
    "--output-format",
    "json",
    "--no-session-persistence",
  ];
}

// DOCS-SOURCED AND UNVERIFIED against a real limit hit (documented shapes:
// "You've hit your session limit · resets 3:45pm" / weekly / Opus). Treated as
// the known weak point: anything that does NOT match falls through to ordinary
// failure handling, and the raw envelope is logged once per run so the first
// real hit leaves evidence to verify this regex against.
const LIMIT_RE =
  /You've hit your (session|weekly|Opus) limit(?:\s*[·:—-]\s*resets\s*(.+?))?\s*$/im;

export function parseLimitMessage(
  text: string,
): { kind: "session" | "weekly" | "opus"; resetsAt: string | null } | null {
  const m = LIMIT_RE.exec(text);
  if (!m) return null;
  const kind = m[1]!.toLowerCase() as "session" | "weekly" | "opus";
  return { kind, resetsAt: m[2]?.trim() ?? null };
}

export interface CliEnvelope {
  is_error: boolean;
  result: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  api_error_status?: number;
}

export function parseCliEnvelope(stdout: string): CliEnvelope | null {
  try {
    const o = JSON.parse(stdout) as Record<string, unknown>;
    if (typeof o !== "object" || o === null) return null;
    return {
      is_error: Boolean(o.is_error),
      result: typeof o.result === "string" ? o.result : "",
      ...(typeof o.usage === "object" && o.usage !== null
        ? { usage: o.usage as CliEnvelope["usage"] }
        : {}),
      ...(typeof o.api_error_status === "number"
        ? { api_error_status: o.api_error_status }
        : {}),
    };
  } catch {
    return null;
  }
}

// Once-per-run gate for raw-envelope evidence logging (process-scoped — one
// vir run is one process). Exported reset is for tests only.
let rawEnvelopeLogged = false;
export function resetRawEnvelopeLogGate(): void {
  rawEnvelopeLogged = false;
}

const DAEMON_LOG = join(homedir(), ".vir", "daemon.log");
function defaultLogRaw(line: string): void {
  try {
    appendFileSync(DAEMON_LOG, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // evidence logging is best-effort
  }
}

function defaultWriteMarker(line: string): void {
  try {
    writeFileSync(CLAUDE_CLI_LIMIT_MARKER_PATH, line + "\n", "utf8");
  } catch {
    // marker is best-effort; the thrown ClaudeCliLimitError is the primary signal
  }
}

type SpawnImpl = (
  cmd: string,
  args: string[],
  opts: { cwd: string },
) => ReturnType<typeof spawn>;

// Injectable for tests ONLY — production callers pass nothing. cwd and the
// arg set are NOT injectable (correctness requirements, see above).
export interface CallClaudeCliTestOpts {
  spawnImpl?: SpawnImpl;
  timeoutMs?: number;
  logRaw?: (line: string) => void;
  writeMarker?: (line: string) => void;
}

export interface ClaudeCliResult {
  text: string;
  usage: TokenUsage | null;
}

export async function callClaudeCli(
  opts: { prompt: string; model: string },
  test: CallClaudeCliTestOpts = {},
): Promise<ClaudeCliResult> {
  const spawnImpl = test.spawnImpl ?? (spawn as unknown as SpawnImpl);
  const timeoutMs = test.timeoutMs ?? CLAUDE_CLI_TIMEOUT_MS;
  const logRaw = test.logRaw ?? defaultLogRaw;
  const writeMarker = test.writeMarker ?? defaultWriteMarker;

  const { stdout, stderr, code } = await runProcess(
    spawnImpl,
    buildClaudeCliArgs(opts.model),
    opts.prompt,
    timeoutMs,
  );

  const envelope = parseCliEnvelope(stdout);
  if (envelope === null) {
    throw new ClaudeCliError(
      `claude -p produced no parseable JSON envelope (exit ${code})` +
        (stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : ""),
      code,
    );
  }

  if (envelope.is_error || code !== 0) {
    // Check the limit pattern on BOTH channels — the docs don't say which one
    // carries it in print mode.
    const limit =
      parseLimitMessage(envelope.result) ?? parseLimitMessage(stderr);
    if (limit) {
      writeMarker(
        `${new Date().toISOString()} ${limit.kind} limit matched: ${envelope.result.trim().slice(0, 200)}`,
      );
      throw new ClaudeCliLimitError(limit.kind, limit.resetsAt);
    }
    // Unrecognized error: leave the raw envelope as evidence (once per run)
    // before ordinary failure handling. If this WAS a limit in a shape the
    // regex missed, the halt-on-unknown policy upstream still fails safe.
    if (!rawEnvelopeLogged) {
      rawEnvelopeLogged = true;
      logRaw(
        `claude-cli unrecognized error envelope (exit ${code}): ${stdout.trim().slice(0, 2000)}`,
      );
    }
    throw new ClaudeCliError(
      `claude -p failed (exit ${code}): ${envelope.result.trim().slice(0, 300) || stderr.trim().slice(0, 300) || "no error text"}`,
      code,
      envelope.api_error_status ?? null,
    );
  }

  const u = envelope.usage;
  const usage =
    u && typeof u.input_tokens === "number" && typeof u.output_tokens === "number"
      ? { input_tokens: u.input_tokens, output_tokens: u.output_tokens }
      : null;
  return { text: envelope.result, usage };
}

function runProcess(
  spawnImpl: SpawnImpl,
  args: string[],
  stdin: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    // Arg array + no shell, same discipline as mcp/install.ts. cwd pinned.
    const child = spawnImpl("claude", args, { cwd: CLAUDE_CLI_CWD });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(
        new ClaudeCliError(
          `claude -p timed out after ${timeoutMs / 1000}s`,
          null,
        ),
      );
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // ENOENT (claude not installed) arrives here, not on close.
      reject(
        new ClaudeCliError(`could not spawn claude: ${err.message}`, null),
      );
    });
    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });

    child.stdin?.write(stdin);
    child.stdin?.end();
  });
}
