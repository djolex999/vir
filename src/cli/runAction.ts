import chalk from "chalk";

// Single chokepoint every commander action routes through. Two reasons:
//
// 1. Commander silently swallows non-zero exits when an async action handler
//    rejects after a tool call — `vir run` was reporting success while distill
//    calls failed (the silent-success-on-failure that let the Kie-200 bug hide
//    until 0.7.2). Wrapping the handler ensures every thrown error sets a
//    non-zero exit and is logged.
//
// 2. We set `process.exitCode = 1` instead of calling `process.exit(1)`:
//    `process.exit` can truncate buffered stdout/stderr mid-flush; setting
//    exitCode lets the process drain and exit naturally with the right code.
//    The same rule applies to in-handler validation failures — convert any
//    `process.exit(1)` to `process.exitCode = 1; return;`.

export interface RunActionOptions {
  // Override the destination for the error line. Defaults to console.error.
  // Wired primarily for the unit test, so we can assert on the message
  // without intercepting console.error globally.
  logError?: (message: string) => void;
}

export function runAction<Args extends unknown[]>(
  fn: (...args: Args) => Promise<unknown>,
  opts: RunActionOptions = {},
): (...args: Args) => Promise<void> {
  const logError = opts.logError ?? ((m: string) => console.error(chalk.red(m)));
  return async (...args: Args): Promise<void> => {
    try {
      await fn(...args);
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : JSON.stringify(err);
      logError(msg);
      process.exitCode = 1;
    }
  };
}
