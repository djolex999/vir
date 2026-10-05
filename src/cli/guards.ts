import confirm from "@inquirer/confirm";
import {
  acquireLock,
  LOCK_PATH,
  LockHeldError,
  releaseLock,
} from "../pipeline/lock.js";
import * as ui from "../ui/display.js";

// Runs a command that writes notes or the DB while holding the pipeline lock,
// so it cannot race a daemon `vir run`. A held lock is reported and exits 1,
// the same as `vir run` and `vir reconcile`.
export async function withPipelineLock(
  fn: () => Promise<void>,
  lockPath: string = LOCK_PATH,
): Promise<void> {
  try {
    acquireLock(lockPath);
  } catch (err) {
    if (err instanceof LockHeldError) {
      ui.row(ui.warn(ui.WARN_GLYPH), ui.text(err.message));
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  try {
    await fn();
  } finally {
    releaseLock(lockPath);
  }
}

// Gate for a paid LLM step. --yes proceeds; a terminal asks; with no terminal
// (cron, scripts) the step is skipped with a note rather than hanging on a
// prompt or spending without consent.
export async function confirmPaidStep(
  message: string,
  opts: {
    yes?: boolean;
    interactive?: boolean;
    ask?: (message: string) => Promise<boolean>;
  } = {},
): Promise<boolean> {
  if (opts.yes === true) return true;
  const interactive = opts.interactive ?? process.stdin.isTTY === true;
  if (!interactive) {
    ui.line(ui.dim(`  skipped: ${message} (pass --yes to run without a prompt)`));
    return false;
  }
  const ask =
    opts.ask ?? ((m: string) => confirm({ message: m, default: true }));
  return ask(message);
}
