import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ResultCache {
  cached<T>(parts: readonly string[], compute: () => Promise<T>): Promise<{ value: T; hit: boolean }>;
  has(parts: readonly string[]): boolean;
}

// NUL-joined so ["ab","c"] and ["a","bc"] never collide.
export function cacheKey(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

// Every eval model call goes through here: a subscription limit mid-run is
// expected, and a re-run must pay only for what is missing.
export function createCache(dir: string): ResultCache {
  const fileFor = (parts: readonly string[]): string => {
    const k = cacheKey(parts);
    return join(dir, k.slice(0, 2), `${k}.json`);
  };
  return {
    has: (parts) => existsSync(fileFor(parts)),
    async cached<T>(parts: readonly string[], compute: () => Promise<T>) {
      const f = fileFor(parts);
      if (existsSync(f)) {
        return { value: (JSON.parse(readFileSync(f, "utf8")) as { value: T }).value, hit: true };
      }
      const value = await compute();
      mkdirSync(dirname(f), { recursive: true });
      // Write-then-rename: an interrupted write never leaves a readable half entry.
      const tmp = `${f}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ value }));
      renameSync(tmp, f);
      return { value, hit: false };
    },
  };
}
