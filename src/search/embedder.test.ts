import { describe, expect, it } from "vitest";
import { EmbedderError, embedText, embeddingForNote } from "./embedder.js";

// Fake Ollama: 500s with the real context-length message when the prompt
// exceeds `limit` chars, otherwise returns a fixed embedding. Mirrors the
// observed failure shape — nomic served at num_ctx 2048 rejects ~8k+ chars.
function fakeOllama(limit: number, calls: string[] = []) {
  return async (_url: string | URL, init?: { body?: string }) => {
    const prompt = (JSON.parse(init?.body ?? "{}") as { prompt: string }).prompt;
    calls.push(prompt);
    if (prompt.length > limit) {
      return {
        ok: false,
        status: 500,
        json: async () => ({ error: "the input length exceeds the context length" }),
        text: async () => '{"error":"the input length exceeds the context length"}',
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ embedding: [0.1, 0.2, 0.3] }),
      text: async () => "",
    };
  };
}

describe("embedText truncation", () => {
  it("embeds a 9k-char note by truncating to the model limit", async () => {
    const result = await embedText("x".repeat(9000), fakeOllama(8192));
    expect(result.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(result.truncated).toBe(true);
    expect(result.sentChars).toBeLessThanOrEqual(8192);
  });

  it("sends short text untouched and records no truncation", async () => {
    const calls: string[] = [];
    const result = await embedText("short note", fakeOllama(8192, calls));
    expect(result.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(result.truncated).toBe(false);
    expect(result.sentChars).toBe("short note".length);
    expect(calls).toEqual(["short note"]);
  });

  it("halves and retries when the char cap still exceeds the token limit", async () => {
    const calls: string[] = [];
    const result = await embedText("y".repeat(9000), fakeOllama(4000, calls));
    expect(result.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(result.truncated).toBe(true);
    expect(result.sentChars).toBeLessThanOrEqual(4096);
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("EmbedderError kinds", () => {
  it("marks a non-context 500 as kind http and does not retry it", async () => {
    const calls: string[] = [];
    const brokenOllama = async (_url: string | URL, init?: { body?: string }) => {
      calls.push((JSON.parse(init?.body ?? "{}") as { prompt: string }).prompt);
      return {
        ok: false,
        status: 500,
        json: async () => ({ error: "model runner has unexpectedly stopped" }),
        text: async () => '{"error":"model runner has unexpectedly stopped"}',
      };
    };
    const err = await embedText("hello", brokenOllama).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmbedderError);
    expect((err as EmbedderError).kind).toBe("http");
    expect(calls.length).toBe(1);
  });

  it("marks a fetch rejection as kind network", async () => {
    const deadOllama = async () => {
      throw new TypeError("fetch failed");
    };
    const err = await embedText("hello", deadOllama).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmbedderError);
    expect((err as EmbedderError).kind).toBe("network");
  });

  it("marks an unrecoverable context overflow as kind context-limit", async () => {
    // Text already at the retry floor that still overflows: no retry possible.
    const err = await embedText("z".repeat(400), fakeOllama(100)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EmbedderError);
    expect((err as EmbedderError).kind).toBe("context-limit");
  });
});

describe("embeddingForNote logging", () => {
  it("records a truncation in the log instead of silently dropping text", async () => {
    const logged: string[] = [];
    const vec = await embeddingForNote(
      "x".repeat(9000),
      (msg) => logged.push(msg),
      fakeOllama(8192),
    );
    expect(vec).toEqual([0.1, 0.2, 0.3]);
    expect(logged.length).toBe(1);
    expect(logged[0]).toMatch(/truncated/);
    expect(logged[0]).toMatch(/9000/);
  });

  it("logs distinguishable messages for context-limit vs network failures", async () => {
    const contextLogged: string[] = [];
    // Overflows even at the retry floor: every attempt is a context error.
    await embeddingForNote(
      "z".repeat(400),
      (msg) => contextLogged.push(msg),
      fakeOllama(100),
    );
    const networkLogged: string[] = [];
    await embeddingForNote(
      "hello",
      (msg) => networkLogged.push(msg),
      async () => {
        throw new TypeError("fetch failed");
      },
    );
    expect(contextLogged.join(" ")).toMatch(/context-limit/);
    expect(networkLogged.join(" ")).toMatch(/network/);
  });

  it("still returns null on failure without a log callback", async () => {
    const vec = await embeddingForNote("hello", undefined, async () => {
      throw new TypeError("fetch failed");
    });
    expect(vec).toBeNull();
  });
});
