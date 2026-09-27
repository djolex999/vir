import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cacheKey, createCache } from "./cache.js";

describe("result cache", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vir-ucache-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("computes once, then returns the stored value", async () => {
    const cache = createCache(dir);
    let calls = 0;
    const compute = async (): Promise<string> => {
      calls += 1;
      return "answer";
    };
    expect(await cache.cached(["grade", "m", "p"], compute)).toEqual({ value: "answer", hit: false });
    expect(await cache.cached(["grade", "m", "p"], compute)).toEqual({ value: "answer", hit: true });
    expect(calls).toBe(1);
  });

  // A prompt edit must invalidate exactly the affected results.
  it("misses when any key part changes", async () => {
    const cache = createCache(dir);
    await cache.cached(["grade", "m", "p1"], async () => "a");
    expect(cache.has(["grade", "m", "p1"])).toBe(true);
    expect(cache.has(["grade", "m", "p2"])).toBe(false);
  });

  // A subscription limit mid-call must leave nothing half-written behind.
  it("stores nothing when compute throws", async () => {
    const cache = createCache(dir);
    await expect(
      cache.cached(["mine", "m", "p"], async () => {
        throw new Error("limit");
      }),
    ).rejects.toThrow("limit");
    expect(cache.has(["mine", "m", "p"])).toBe(false);
  });

  it("keys differ for ['ab','c'] and ['a','bc']", () => {
    expect(cacheKey(["ab", "c"])).not.toBe(cacheKey(["a", "bc"]));
  });

  it("creates its directory on first write", async () => {
    const nested = join(dir, "x", "y");
    const cache = createCache(nested);
    await cache.cached(["k"], async () => 1);
    expect(existsSync(nested)).toBe(true);
  });
});
