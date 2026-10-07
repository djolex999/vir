import { describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";

const calls: Array<{ prompt: string; model: string }> = [];
vi.mock("./codexCli.js", async (orig) => ({
  ...(await orig<typeof import("./codexCli.js")>()),
  callCodexCli: async (opts: { prompt: string; model: string }) => {
    calls.push(opts);
    return { text: "from codex", usage: { input_tokens: 10, output_tokens: 2 } };
  },
}));

const { callLLM } = await import("./distiller.js");

describe("callLLM on provider codex-cli", () => {
  it("routes through codex exec, with no Anthropic client", async () => {
    const cfg = { provider: "codex-cli" } as Config;
    const text = await callLLM(cfg, null, { prompt: "P", model: "default", maxTokens: 10 });
    expect(text).toBe("from codex");
    expect(calls).toEqual([{ prompt: "P", model: "default" }]);
  });
});
