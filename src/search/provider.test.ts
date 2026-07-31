import { describe, expect, it } from "vitest";
import { OllamaProvider, resolveEmbeddingProvider } from "./provider.js";

function fakeOllama(limit: number) {
  return async (_url: string | URL, init?: { body?: string }) => {
    const prompt = (JSON.parse(init?.body ?? "{}") as { prompt: string }).prompt;
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

describe("OllamaProvider", () => {
  it("describes itself: name, model, dimensions, input cap", () => {
    const p = new OllamaProvider();
    expect(p.name).toBe("ollama");
    expect(p.modelName).toBe("nomic-embed-text");
    expect(p.dimensions).toBe(768);
    expect(p.maxInputChars).toBe(8192);
    expect(p.provenance()).toEqual({ model: "nomic-embed-text", dim: 768 });
  });

  it("embedDoc truncates oversized input and records it", async () => {
    const p = new OllamaProvider(fakeOllama(8192));
    const result = await p.embedDoc("x".repeat(9000));
    expect(result.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(result.truncated).toBe(true);
  });

  it("embedQuery returns a bare vector", async () => {
    const p = new OllamaProvider(fakeOllama(8192));
    expect(await p.embedQuery("short query")).toEqual([0.1, 0.2, 0.3]);
  });
});

describe("resolveEmbeddingProvider", () => {
  const up = async () => true;
  const down = async () => false;

  it("configured none wins even with Ollama running", async () => {
    const p = await resolveEmbeddingProvider("none", {
      ollamaAvailable: up,
      localInstalled: () => true,
    });
    expect(p).toBeNull();
  });

  it("configured local wins over a running Ollama", async () => {
    const p = await resolveEmbeddingProvider("local", {
      ollamaAvailable: up,
      localInstalled: () => true,
    });
    expect(p?.name).toBe("local");
  });

  it("unconfigured: detects Ollama first", async () => {
    const p = await resolveEmbeddingProvider(undefined, {
      ollamaAvailable: up,
      localInstalled: () => true,
    });
    expect(p?.name).toBe("ollama");
  });

  it("unconfigured: falls back to an installed local provider", async () => {
    const p = await resolveEmbeddingProvider(undefined, {
      ollamaAvailable: down,
      localInstalled: () => true,
    });
    expect(p?.name).toBe("local");
  });

  it("unconfigured: resolves to none when nothing is available", async () => {
    const p = await resolveEmbeddingProvider(undefined, {
      ollamaAvailable: down,
      localInstalled: () => false,
    });
    expect(p).toBeNull();
  });

  it("configured but unusable falls through to detection instead of erroring", async () => {
    const p = await resolveEmbeddingProvider("local", {
      ollamaAvailable: up,
      localInstalled: () => false,
    });
    expect(p?.name).toBe("ollama");
  });
});
