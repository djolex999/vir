import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Codex session ids are `rollout-<ts>-<uuid>`: their first 8 chars are always
// "rollout-". Every short id shown or logged must go through sessionSuffix
// (slug.ts), which takes the uuid's tail for Codex and the head for Claude.
const RAW_SLICE = /[sS]ession(?:Id)?(?:\([^)]*\))?\.slice\(0,\s*8\)/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
  });
}

describe("short session ids", () => {
  it("never take a raw 8-char slice of a session id", () => {
    const root = join(import.meta.dirname, "..");
    const offenders = sourceFiles(root)
      .filter((f) => !f.endsWith(join("pipeline", "slug.ts")))
      .flatMap((f) =>
        readFileSync(f, "utf8")
          .split("\n")
          .flatMap((line, i) => (RAW_SLICE.test(line) ? [`${f.slice(root.length + 1)}:${i + 1}`] : [])),
      );
    expect(offenders).toEqual([]);
  });
});
