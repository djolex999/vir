import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "./config.js";

// config.ts derives VIR_DIR/CONFIG_PATH from os.homedir() at module load, and
// on POSIX homedir() honors $HOME. Point $HOME at a temp dir, then dynamically
// import the module so its paths resolve inside the sandbox — never the real
// ~/.vir.
const ORIGINAL_HOME = process.env.HOME;
let tmpHome: string;
let cfg: typeof import("./config.js");

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), "vir-home-"));
  process.env.HOME = tmpHome;
  cfg = await import("./config.js");
});

afterAll(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  rmSync(tmpHome, { recursive: true, force: true });
});

function sampleConfig(): Config {
  return {
    vaultPath: join(tmpHome, "vault"),
    outputDir: "vir",
    claudeProjectsDir: join(tmpHome, ".claude", "projects"),
    cadenceHours: 3,
    provider: "anthropic",
    anthropicApiKey: "sk-ant-test",
    filterThreshold: 0.4,
    models: {
      classify: "claude-haiku-4-5-20251001",
      distill: "claude-sonnet-4-6",
    },
  };
}

describe("config file permissions", () => {
  it("ensureVirDir creates ~/.vir owner-only (0700)", () => {
    cfg.ensureVirDir();
    const dir = join(tmpHome, ".vir");
    expect(existsSync(dir)).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("saveConfig writes config.json owner read/write only (0600)", () => {
    cfg.saveConfig(sampleConfig());
    const file = join(tmpHome, ".vir", "config.json");
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
