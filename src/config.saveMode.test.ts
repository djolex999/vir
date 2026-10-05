import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "./config.js";

// The API keys must never sit in a file anyone else can read, not even for
// the instant between writing config.json and tightening its mode.
const writes = vi.hoisted(() => [] as Array<{ path: string; mode: unknown }>);

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    writeFileSync: ((...args: Parameters<typeof real.writeFileSync>) => {
      const opts = args[2];
      writes.push({
        path: String(args[0]),
        mode: typeof opts === "object" && opts !== null ? opts.mode : undefined,
      });
      return real.writeFileSync(...args);
    }) as typeof real.writeFileSync,
  };
});

afterEach(() => {
  writes.length = 0;
});

describe("saveConfig", () => {
  it("creates every file holding the keys owner-only (0600) from the first byte", async () => {
    const { saveConfig } = await import("./config.js");
    saveConfig({
      vaultPath: "/tmp/v",
      outputDir: "vir",
      claudeProjectsDir: "/tmp/p",
      provider: "anthropic",
      anthropicApiKey: "sk-ant-secret",
      models: { classify: "claude-haiku-4-5-20251001", distill: "claude-sonnet-5" },
    } as unknown as Config);
    const configWrites = writes.filter((w) => w.path.includes("config.json"));
    expect(configWrites.length).toBeGreaterThan(0);
    for (const w of configWrites) expect(w.mode).toBe(0o600);
  });
});
