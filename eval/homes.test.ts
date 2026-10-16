import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { ARMS, armById } from "./arms.js";
import { buildArmConfig } from "./homes.js";
import { CONFIG_VERSION } from "../src/config.js";

const raw = {
  vaultPath: "~/Vir",
  outputDir: "vir",
  claudeProjectsDir: "~/.claude/projects",
  articlesDir: "~/Documents/raw",
  provider: "anthropic",
  anthropicApiKey: "sk-ant-secret",
  kieApiKey: "kie-secret",
  retrievalDiversity: 0.3,
  logQueries: true,
  models: { classify: "x", distill: "y" },
};

describe("buildArmConfig", () => {
  it("strips every secret and switches provider to the keyless one", () => {
    const cfg = buildArmConfig(raw, armById("nomic"));
    expect(cfg).not.toHaveProperty("anthropicApiKey");
    expect(cfg).not.toHaveProperty("kieApiKey");
    expect(cfg["provider"]).toBe("claude-cli");
  });

  it("rewrites every path to absolute using the PARENT's home", () => {
    const cfg = buildArmConfig(raw, armById("nomic"));
    const h = homedir();
    expect(cfg["vaultPath"]).toBe(`${h}/Vir`);
    expect(cfg["claudeProjectsDir"]).toBe(`${h}/.claude/projects`);
    expect(cfg["articlesDir"]).toBe(`${h}/Documents/raw`);
  });

  it("sets provider and diversity per arm; MMR off means diversity 0", () => {
    expect(buildArmConfig(raw, armById("tfidf"))["embeddingProvider"]).toBe("none");
    expect(buildArmConfig(raw, armById("tfidf"))["retrievalDiversity"]).toBe(0);
    expect(buildArmConfig(raw, armById("nomic"))["retrievalDiversity"]).toBe(0);
    expect(buildArmConfig(raw, armById("nomic-mmr"))["retrievalDiversity"]).toBe(0.3);
    expect(buildArmConfig(raw, armById("bge-mmr"))["embeddingProvider"]).toBe("local");
  });

  it("never lets an arm write the query log", () => {
    for (const arm of ARMS) {
      expect(buildArmConfig(raw, arm)["logQueries"]).toBe(false);
    }
  });

  it("does not mutate its input", () => {
    const copy = structuredClone(raw);
    buildArmConfig(raw, armById("bge"));
    expect(raw).toEqual(copy);
  });
});

describe("ARMS", () => {
  it("has the five runnable arms with unique ids", () => {
    expect(ARMS.map((a) => a.id)).toEqual([
      "tfidf",
      "nomic",
      "nomic-mmr",
      "bge",
      "bge-mmr",
    ]);
  });
  it("armById throws on an unknown id", () => {
    expect(() => armById("bm25")).toThrow(/unknown arm/);
  });

  it("MMR arms measure the 0.26 default (0.3) whatever the live config says, and are migration-proof", () => {
    const live0 = { ...raw, retrievalDiversity: 0 };
    expect(buildArmConfig(live0, armById("nomic-mmr"))["retrievalDiversity"]).toBe(0.3);
    expect(buildArmConfig(live0, armById("bge"))["retrievalDiversity"]).toBe(0);
    expect(buildArmConfig(raw, armById("nomic-mmr"))["configVersion"]).toBe(CONFIG_VERSION);
  });
});

