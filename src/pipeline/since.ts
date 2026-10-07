import { statSync } from "node:fs";

export function transcriptMtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

// `vir run --since`: keep sessions whose transcript was touched at or after
// the cutoff. The rest are deferred, not skipped — no DB row is written, so a
// later run without --since (or the daemon) still picks them up. An unstat-able
// file is deferred too: it can't be shown to be recent.
export function partitionBySince<T extends { path: string }>(
  sessions: T[],
  cutoffMs: number,
  mtimeOf: (path: string) => number | null = transcriptMtimeMs,
): { recent: T[]; deferred: number } {
  const recent: T[] = [];
  let deferred = 0;
  for (const s of sessions) {
    const mtime = mtimeOf(s.path);
    if (mtime !== null && mtime >= cutoffMs) recent.push(s);
    else deferred += 1;
  }
  return { recent, deferred };
}
