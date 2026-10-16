import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { Config } from "../config.js";
import {
  buildAnthropicParams,
  callLLM,
  isRetryable,
  ModelRefusalError,
  normalizeModelName,
  resolveModelShorthand,
} from "./distiller.js";

describe("Haiku 5.5 model ids", () => {
  it("the `haiku` shorthand resolves to Haiku 5.5", () => {
    expect(resolveModelShorthand("haiku")).toBe("claude-haiku-5-5");
  });

  it("Kie keeps serving Haiku 4.5: its endpoint doesn't list 5.5", () => {
    expect(normalizeModelName("claude-haiku-5-5", "kie")).toBe("claude-haiku-4-5");
    expect(normalizeModelName(resolveModelShorthand("haiku"), "kie")).toBe("claude-haiku-4-5");
  });

  it("anthropic and claude-cli pass Haiku 5.5 through unchanged", () => {
    expect(normalizeModelName("claude-haiku-5-5", "anthropic")).toBe("claude-haiku-5-5");
    expect(normalizeModelName("claude-haiku-5-5", "claude-cli")).toBe("claude-haiku-5-5");
  });
});

describe("buildAnthropicParams — thinking off where a model thinks by default", () => {
  it("disables thinking on Haiku 5.5, so a 40-token retitle can't end inside a thinking block", () => {
    const p = buildAnthropicParams({ model: "claude-haiku-5-5", maxTokens: 40, prompt: "P" });
    expect(p.thinking).toEqual({ type: "disabled" });
    expect(p.max_tokens).toBe(40);
    expect(p.messages).toEqual([{ role: "user", content: "P" }]);
  });

  it("leaves other models' requests unchanged", () => {
    for (const model of ["claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-sonnet-4-6"]) {
      expect(buildAnthropicParams({ model, maxTokens: 10, prompt: "P" })).not.toHaveProperty(
        "thinking",
      );
    }
  });
});

describe("callLLM on a refusal", () => {
  const cfg = { provider: "anthropic" } as Config;
  function clientReturning(resp: object): Anthropic {
    return { messages: { create: async () => resp } } as unknown as Anthropic;
  }

  it("throws ModelRefusalError instead of returning empty text", async () => {
    const client = clientReturning({
      stop_reason: "refusal",
      content: [],
      usage: { input_tokens: 10, output_tokens: 0 },
    });
    await expect(
      callLLM(cfg, client, { prompt: "P", model: "claude-haiku-5-5", maxTokens: 40 }),
    ).rejects.toBeInstanceOf(ModelRefusalError);
  });

  it("is not retried: the same prompt gets the same verdict", () => {
    expect(isRetryable(new ModelRefusalError("claude-haiku-5-5"))).toBe(false);
  });

  it("still returns the text of a normal response", async () => {
    const client = clientReturning({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Fix PATH lookup" }],
      usage: { input_tokens: 10, output_tokens: 4 },
    });
    await expect(
      callLLM(cfg, client, { prompt: "P", model: "claude-haiku-5-5", maxTokens: 40 }),
    ).resolves.toBe("Fix PATH lookup");
  });
});
