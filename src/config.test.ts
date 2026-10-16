import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
    topicsDir: "topics",
    claudeProjectsDir: join(tmpHome, ".claude", "projects"),
    cadenceHours: 3,
    provider: "anthropic",
    connectMaxCandidates: 10,
    anthropicApiKey: "sk-ant-test",
    kieTopUpTier: "standard",
    filterThreshold: 0.4,
    distillArticles: true,
    distillPdfs: true,
    filterToolCalls: "moderate",
    retrievalDiversity: 0.3,
    logQueries: true,
    projects: {},
    notifications: true,
    workflowTranscripts: "exclude",
    agentTranscripts: "exclude",
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

  it("saveConfig never leaves the keys in a world-readable file, even one that already was", () => {
    const file = join(tmpHome, ".vir", "config.json");
    cfg.saveConfig(sampleConfig());
    chmodSync(file, 0o644);
    cfg.saveConfig({ ...sampleConfig(), outputDir: "Changed" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toContain("Changed");
    // Written to a 0600 temp file and renamed into place: no temp left behind.
    expect(readdirSync(join(tmpHome, ".vir")).filter((f) => f.startsWith("config.json"))).toEqual(["config.json"]);
  });

  it("saveConfig writes config.json owner read/write only (0600)", () => {
    cfg.saveConfig(sampleConfig());
    const file = join(tmpHome, ".vir", "config.json");
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("provider/model defaults (0.14.0: anthropic + claude-sonnet-5)", () => {
  it("defaults to provider anthropic with distill claude-sonnet-5", async () => {
    const { ConfigSchema } = await import("./config.js");
    const parsed = ConfigSchema.safeParse({
      vaultPath: "/tmp/v",
      outputDir: "vir",
      claudeProjectsDir: "/tmp/p",
      provider: "anthropic",
      anthropicApiKey: "sk-ant-test",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.models.distill).toBe("claude-sonnet-5");
    }
  });
});

describe("provider claude-cli (subscription path, no credential)", () => {
  it("parses with NO api key of any kind — the whole point is zero setup", async () => {
    const { ConfigSchema } = await import("./config.js");
    const parsed = ConfigSchema.safeParse({
      vaultPath: "/tmp/v",
      claudeProjectsDir: "/tmp/p",
      provider: "claude-cli",
    });
    expect(parsed.success).toBe(true);
  });

  it("still requires keys for anthropic and kie", async () => {
    const { ConfigSchema } = await import("./config.js");
    expect(
      ConfigSchema.safeParse({
        vaultPath: "/tmp/v",
        claudeProjectsDir: "/tmp/p",
        provider: "anthropic",
      }).success,
    ).toBe(false);
  });
});

describe("logQueries (retrieval logging to ~/.vir/queries.jsonl)", () => {
  const base = {
    vaultPath: "/tmp/v",
    claudeProjectsDir: "/tmp/p",
    provider: "anthropic",
    anthropicApiKey: "sk-ant-test",
  };

  it("defaults to true so existing configs start accumulating on upgrade", async () => {
    const { ConfigSchema } = await import("./config.js");
    const parsed = ConfigSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.logQueries).toBe(true);
  });

  it("can be disabled explicitly", async () => {
    const { ConfigSchema } = await import("./config.js");
    const parsed = ConfigSchema.safeParse({ ...base, logQueries: false });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.logQueries).toBe(false);
  });
});

describe("projects decision map (three-state: include/exclude/absent=undecided)", () => {
  const base = {
    vaultPath: "/tmp/v",
    outputDir: "vir",
    claudeProjectsDir: "/tmp/p",
    provider: "anthropic",
    anthropicApiKey: "sk-ant-test",
  };

  it("an existing config without the key migrates to {} — every project undecided", async () => {
    const { ConfigSchema } = await import("./config.js");
    const parsed = ConfigSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.projects).toEqual({});
  });

  it("parses include/exclude decisions", async () => {
    const { ConfigSchema } = await import("./config.js");
    const parsed = ConfigSchema.safeParse({
      ...base,
      projects: { vir: "include", scratch: "exclude" },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.projects).toEqual({
        vir: "include",
        scratch: "exclude",
      });
    }
  });

  it("rejects any decision value other than include/exclude", async () => {
    const { ConfigSchema } = await import("./config.js");
    const parsed = ConfigSchema.safeParse({
      ...base,
      projects: { vir: "pending" },
    });
    expect(parsed.success).toBe(false);
  });

  it("workflowTranscripts defaults to exclude and rejects unknown values", async () => {
    const { ConfigSchema } = await import("./config.js");
    const parsed = ConfigSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.workflowTranscripts).toBe("exclude");
    expect(
      ConfigSchema.safeParse({ ...base, workflowTranscripts: "ask" }).success,
    ).toBe(false);
    const inc = ConfigSchema.safeParse({
      ...base,
      workflowTranscripts: "include",
    });
    expect(inc.success).toBe(true);
    if (inc.success) expect(inc.data.workflowTranscripts).toBe("include");
  });

  it("agentTranscripts defaults to exclude (existing installs), rejects unknown values", async () => {
    const { ConfigSchema } = await import("./config.js");
    const parsed = ConfigSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.agentTranscripts).toBe("exclude");
    expect(
      ConfigSchema.safeParse({ ...base, agentTranscripts: "ask" }).success,
    ).toBe(false);
  });

  it("notifications defaults to true", async () => {
    const { ConfigSchema } = await import("./config.js");
    const parsed = ConfigSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.notifications).toBe(true);
  });
});

describe("maskSecret — the ONE redaction helper for secret config values", () => {
  it("renders first 8 + last 5 with an ellipsis, never the full key", async () => {
    const { maskSecret } = await import("./config.js");
    const key = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-abcde5rgAA";
    const masked = maskSecret(key);
    expect(masked).toBe("sk-ant-a…5rgAA");
    expect(masked).not.toContain(key);
    expect(masked.length).toBeLessThan(20);
  });

  it("fully masks short secrets (first8+last5 would leak most of it)", async () => {
    const { maskSecret } = await import("./config.js");
    const masked = maskSecret("shortkey12");
    expect(masked).not.toContain("shortkey12");
    expect(masked).toBe("••••••••••");
  });

  it("empty input stays empty", async () => {
    const { maskSecret } = await import("./config.js");
    expect(maskSecret("")).toBe("");
  });
});

describe("session sources: optional claudeProjectsDir, codexSessionsDir", () => {
  function writeRaw(obj: Record<string, unknown>): void {
    cfg.ensureVirDir();
    writeFileSync(cfg.CONFIG_PATH, JSON.stringify(obj), { mode: 0o600 });
  }

  it("a Claude-only config loads with no codexSessionsDir key", () => {
    writeRaw({ vaultPath: "/v", claudeProjectsDir: "/p", provider: "claude-cli" });
    const loaded = cfg.loadConfig();
    expect(loaded.claudeProjectsDir).toBe("/p");
    expect("codexSessionsDir" in loaded).toBe(false);
  });

  it("a Codex-only config loads with ~ expanded and no claudeProjectsDir key", () => {
    writeRaw({ vaultPath: "/v", codexSessionsDir: "~/.codex/sessions", provider: "claude-cli" });
    const loaded = cfg.loadConfig();
    expect(loaded.codexSessionsDir).toBe(join(tmpHome, ".codex", "sessions"));
    expect("claudeProjectsDir" in loaded).toBe(false);
  });

  it("a config with no session source fails with a clear message", () => {
    const r = cfg.ConfigSchema.safeParse({ vaultPath: "/v", provider: "claude-cli" });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain(
      "configure at least one session source (claudeProjectsDir or codexSessionsDir)",
    );
  });
});

describe("provider codex-cli (ChatGPT subscription, no credential)", () => {
  it("parses with no api key", () => {
    expect(
      cfg.ConfigSchema.safeParse({ vaultPath: "/v", codexSessionsDir: "/c", provider: "codex-cli" }).success,
    ).toBe(true);
  });
});

describe("config migration to version 1 (0.27.0: MMR off by default)", () => {
  it("turns the old persisted default 0.3 into 0 and stamps the version", () => {
    const { json, changed } = cfg.migrateConfigJson({ retrievalDiversity: 0.3 });
    expect(changed).toBe(true);
    expect(json).toEqual({ retrievalDiversity: 0, configVersion: cfg.CONFIG_VERSION });
  });

  it("keeps any other explicit value and still stamps the version", () => {
    expect(cfg.migrateConfigJson({ retrievalDiversity: 0.5 }).json).toEqual({ retrievalDiversity: 0.5, configVersion: 1 });
    expect(cfg.migrateConfigJson({}).json).toEqual({ configVersion: 1 });
  });

  it("never touches a config already at the current version", () => {
    const raw = { retrievalDiversity: 0.3, configVersion: cfg.CONFIG_VERSION };
    const { json, changed } = cfg.migrateConfigJson(raw);
    expect(changed).toBe(false);
    expect(json).toEqual(raw);
  });

  it("does not mutate its input", () => {
    const raw = { retrievalDiversity: 0.3 };
    cfg.migrateConfigJson(raw);
    expect(raw).toEqual({ retrievalDiversity: 0.3 });
  });

  it("loadConfig migrates once and writes it back, so a later deliberate 0.3 sticks", () => {
    cfg.ensureVirDir();
    const path = join(tmpHome, ".vir", "config.json");
    const legacy = { ...sampleConfig(), retrievalDiversity: 0.3 };
    writeFileSync(path, JSON.stringify(legacy), { mode: 0o600 });

    expect(cfg.loadConfig().retrievalDiversity).toBe(0);
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(onDisk["configVersion"]).toBe(cfg.CONFIG_VERSION);
    expect(onDisk["retrievalDiversity"]).toBe(0);
    expect(statSync(path).mode & 0o777).toBe(0o600);

    writeFileSync(path, JSON.stringify({ ...onDisk, retrievalDiversity: 0.3 }), { mode: 0o600 });
    expect(cfg.loadConfig().retrievalDiversity).toBe(0.3);
  });

  it("a config with no retrievalDiversity gets the new default 0", () => {
    cfg.ensureVirDir();
    const path = join(tmpHome, ".vir", "config.json");
    const { retrievalDiversity: _drop, ...rest } = sampleConfig();
    writeFileSync(path, JSON.stringify(rest), { mode: 0o600 });
    expect(cfg.loadConfig().retrievalDiversity).toBe(0);
  });

  it("saveConfig stamps the current version", () => {
    cfg.saveConfig(sampleConfig());
    const onDisk = JSON.parse(readFileSync(join(tmpHome, ".vir", "config.json"), "utf8")) as Record<string, unknown>;
    expect(onDisk["configVersion"]).toBe(cfg.CONFIG_VERSION);
  });
});
