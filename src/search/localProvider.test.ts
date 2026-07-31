import { describe, expect, it } from "vitest";
import {
  LOCAL_MAX_CHARS,
  LocalProvider,
  buildSetupPlan,
  type FastembedEngine,
} from "./localProvider.js";

function recordingEngine(): { engine: FastembedEngine; docCalls: string[]; queryCalls: string[] } {
  const docCalls: string[] = [];
  const queryCalls: string[] = [];
  const engine: FastembedEngine = {
    embedBatch: async (texts) => {
      docCalls.push(...texts);
      return texts.map(() => [0.1, 0.2]);
    },
    queryEmbed: async (text) => {
      queryCalls.push(text);
      return [0.3, 0.4];
    },
  };
  return { engine, docCalls, queryCalls };
}

describe("LocalProvider", () => {
  it("describes itself: name, model, dimensions, input cap", () => {
    const p = new LocalProvider();
    expect(p.name).toBe("local");
    expect(p.modelName).toBe("bge-small-en-v1.5");
    expect(p.dimensions).toBe(384);
    expect(p.maxInputChars).toBe(LOCAL_MAX_CHARS);
    expect(p.provenance()).toEqual({ model: "bge-small-en-v1.5", dim: 384 });
  });

  it("honors maxInputChars on docs and records the truncation", async () => {
    const { engine, docCalls } = recordingEngine();
    const p = new LocalProvider(async () => engine);
    const result = await p.embedDoc("x".repeat(5000));
    expect(result.embedding).toEqual([0.1, 0.2]);
    expect(result.truncated).toBe(true);
    expect(result.sentChars).toBe(LOCAL_MAX_CHARS);
    expect(docCalls[0]?.length).toBe(LOCAL_MAX_CHARS);
  });

  it("sends short docs untruncated", async () => {
    const { engine } = recordingEngine();
    const p = new LocalProvider(async () => engine);
    const result = await p.embedDoc("short note");
    expect(result.truncated).toBe(false);
    expect(result.sentChars).toBe("short note".length);
  });

  it("routes queries through queryEmbed (bge prefixes queries differently)", async () => {
    const { engine, queryCalls } = recordingEngine();
    const p = new LocalProvider(async () => engine);
    expect(await p.embedQuery("auth gotchas")).toEqual([0.3, 0.4]);
    expect(queryCalls).toEqual(["auth gotchas"]);
  });
});

describe("buildSetupPlan", () => {
  it("states disk cost before any action", () => {
    const plan = buildSetupPlan(false, false);
    const text = plan.lines.join("\n");
    expect(text).toMatch(/233 MB/);
    expect(text).toMatch(/128 MB/);
    expect(plan.needsInstall).toBe(true);
  });

  it("skips the install step when the package is already present", () => {
    const plan = buildSetupPlan(true, false);
    expect(plan.needsInstall).toBe(false);
    expect(plan.lines.join("\n")).toMatch(/already installed/);
  });
});
