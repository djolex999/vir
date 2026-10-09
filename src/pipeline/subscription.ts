import type { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

// Shared by the providers that shell out to a coding agent's own CLI and bill
// the user's subscription (quota, never dollars): claude-cli and codex-cli.

export type SubscriptionProvider = "claude-cli" | "codex-cli";

export function isSubscriptionProvider(provider: string): provider is SubscriptionProvider {
  return provider === "claude-cli" || provider === "codex-cli";
}

// A subscription limit is a WALL that persists for hours — the polar opposite
// of a transient 429. isRetryable treats it as non-retryable, and every loop
// that distills halts on it without burning the per-session attempt counter.
export class SubscriptionLimitError extends Error {
  constructor(
    message: string,
    readonly resetsAt: string | null,
  ) {
    super(message);
    this.name = "SubscriptionLimitError";
  }
}

// Neutral spawn cwd is a CORRECTNESS requirement: run from a project directory,
// the agent loads that project's CLAUDE.md / AGENTS.md into every distill
// prompt. ~/.vir always exists (config lives there) and carries neither.
export const SUBSCRIPTION_CLI_CWD = join(homedir(), ".vir");

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Scheduled runs get a minimal PATH (launchd pins a few system dirs, systemd and
// cron set little or none), so a bare binary name that resolves in your shell
// can fail every daemon run. Look on PATH first, then next to the node running
// vir (an nvm/npm global install), the native installers' dirs, then Homebrew
// and /usr/local. Falls back to the bare name, which keeps the not-installed
// error.
export function resolveBin(
  name: string,
  opts: {
    path?: string;
    execDir?: string;
    home?: string;
    exists?: (p: string) => boolean;
  } = {},
): string {
  const exists = opts.exists ?? isExecutable;
  const home = opts.home ?? homedir();
  const dirs = [
    ...(opts.path ?? process.env.PATH ?? "").split(delimiter),
    opts.execDir ?? dirname(process.execPath),
    join(home, ".claude", "local"),
    join(home, ".local", "bin"),
    join(home, ".npm-global", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ].filter((d) => d.length > 0);
  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return name;
}

export type SpawnImpl = (
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv },
) => ReturnType<typeof spawn>;

// Arg array + no shell, cwd pinned. `fail` builds the provider's own error for
// a timeout or a spawn failure (ENOENT = not installed arrives here). `env`
// omitted = inherit the parent's environment (spawn's default).
export function runProcess(
  spawnImpl: SpawnImpl,
  bin: string,
  args: string[],
  stdin: string,
  timeoutMs: number,
  fail: (message: string) => Error,
  env?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(bin, args, {
      cwd: SUBSCRIPTION_CLI_CWD,
      ...(env ? { env } : {}),
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(fail(`timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(fail(`could not spawn ${bin}: ${err.message}`));
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
