import { describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import type { SearchHit } from "./retriever.js";

// The eval harness (Task 7, I2) keys its answer cache on the exact prompt
// text synthesize() sends. Extracting that construction into
// buildSynthesisPrompt must leave production output byte-identical — these
// tests prove it two ways: a fixed expected literal, and a live check that
// synthesize() sends exactly what buildSynthesisPrompt() returns.
vi.mock("../pipeline/distiller.js", () => ({
  maybeAnthropicClient: vi.fn(() => null),
  // Echo the prompt back as the "response" so the test can assert on it
  // without a real model call.
  callLLM: vi.fn(async (_cfg: unknown, _client: unknown, opts: { prompt: string }) => opts.prompt),
  normalizeModelName: vi.fn((model: string) => model),
  withRateLimitRetry: vi.fn(async <T,>(fn: () => Promise<T>) => fn()),
}));

import { callLLM } from "../pipeline/distiller.js";
import { buildSynthesisPrompt, synthesize } from "./synthesizer.js";

const cfg = { provider: "anthropic", models: { distill: "m" } } as unknown as Config;
const hits: SearchHit[] = [
  { filePath: "/a.md", title: "Note A", content: "  hello world  ", score: 0.9, method: "embedding" },
  { filePath: "/b.md", title: "Note B", content: "second note", score: 0.5, method: "tfidf" },
];

describe("buildSynthesisPrompt", () => {
  it("produces the exact template synthesize used before extraction", () => {
    const prompt = buildSynthesisPrompt("how does X work?", hits);
    expect(prompt).toBe(
      `You are searching a personal knowledge base of distilled Claude Code session notes. Answer the query directly and concisely using only the provided notes as source.

Query: how does X work?

Notes:
### Note A (score: 0.9)
hello world

---

### Note B (score: 0.5)
second note

Instructions:
- Answer directly, 3-5 sentences max
- Quote the specific note title when citing
- If notes don't contain relevant info, say so clearly
- Do not invent information not present in the notes`,
    );
  });

  it("is exactly what synthesize() sends as the prompt (no drift from the extraction)", async () => {
    const sent = await synthesize(cfg, "how does X work?", hits);
    expect(sent).toBe(buildSynthesisPrompt("how does X work?", hits));
  });

  it("carries a custom stage through to the cost context without changing the prompt", async () => {
    vi.mocked(callLLM).mockClear();
    const sent = await synthesize(cfg, "how does X work?", hits, "eval-usefulness-answer");
    expect(sent).toBe(buildSynthesisPrompt("how does X work?", hits));
    const opts = vi.mocked(callLLM).mock.calls[0]?.[2] as { cost: { stage: string } };
    expect(opts.cost.stage).toBe("eval-usefulness-answer");
  });
});
