import { describe, it, expect } from "vitest";
import {
  callKie,
  HttpError,
  isRetryable,
  KieTimeoutError,
  kieResponseError,
  parseClassification,
  selectDistillModel,
} from "./distiller.js";
import type { Category, Classification } from "./types.js";

describe("isRetryable", () => {
  it("retries on 429", () => {
    expect(isRetryable(new HttpError(429, "rate limited"))).toBe(true);
  });

  it("retries on 500/502/503/504", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(isRetryable(new HttpError(status, "server error"))).toBe(true);
    }
  });

  it("does not retry on 400/401/403", () => {
    for (const status of [400, 401, 403]) {
      expect(isRetryable(new HttpError(status, "client error"))).toBe(false);
    }
  });

  it("does not retry on a genuine 404 (no api_error body envelope)", () => {
    // Wrong endpoint / route gone — body has no `error.type` set.
    expect(isRetryable(new HttpError(404, "Not Found"))).toBe(false);
  });

  it("DOES retry a Kie 404 carrying body `{error: {type: 'api_error'}}`", () => {
    // Kie occasionally returns 404 with an api_error envelope during a
    // transient service hiccup — distinct from a genuine misroute.
    expect(
      isRetryable(new HttpError(404, "Kie 404: api_error", "api_error")),
    ).toBe(true);
  });

  it("does not retry a 404 with some other error.type (treated as genuine)", () => {
    expect(
      isRetryable(new HttpError(404, "not found", "not_found_error")),
    ).toBe(false);
  });

  it("still flags 200-with-in-body-error via kieResponseError (covered in 0.7.2)", () => {
    // Regression: the 0.7.2 kieResponseError path is unaffected by 404
    // handling — it produces an HttpError from a 200 response and the
    // existing status-set check (429 in-body) still flips retry on.
    const err = kieResponseError({ code: 429, msg: "rate limited" });
    expect(isRetryable(err)).toBe(true);
  });

  it("does not retry on non-HTTP errors", () => {
    expect(isRetryable(new Error("network failure"))).toBe(false);
  });
});

describe("kieResponseError", () => {
  // Kie signals errors as HTTP 200 with an in-body `code`, not a non-2xx status.
  it("flags an in-body error code (e.g. 402 insufficient credits)", () => {
    const err = kieResponseError({ code: 402, msg: "Credits insufficient" });
    expect(err).toBeInstanceOf(HttpError);
    expect(err?.status).toBe(402);
    expect(err?.message).toContain("Credits insufficient");
  });

  it("maps an in-body 429 to a retryable HttpError", () => {
    const err = kieResponseError({ code: 429, msg: "rate limited" });
    expect(err?.status).toBe(429);
    expect(isRetryable(err)).toBe(true);
  });

  it("returns null for a success body (no error code)", () => {
    expect(kieResponseError({ content: [{ type: "text", text: "ok" }] })).toBeNull();
    expect(kieResponseError({ code: 200, content: [] })).toBeNull();
  });

  it("flags an error-object body even without a code", () => {
    const err = kieResponseError({ error: { message: "bad request" } });
    expect(err).toBeInstanceOf(HttpError);
    expect(err?.message).toContain("bad request");
  });
});

describe("selectDistillModel", () => {
  const cls = (category: Category): Classification => ({
    category,
    topic: "t",
    project: "p",
    confidence: 0.9,
    themes: [],
  });

  it("returns distill for every session when distillFast is unset (hybrid off)", () => {
    // No surprise quality shift on upgrade — without distillFast, the smart
    // model is used unconditionally, regardless of category or size.
    expect(selectDistillModel(cls("pattern"), 5, { distill: "sonnet" })).toBe(
      "sonnet",
    );
    expect(
      selectDistillModel(cls("decision"), 5_000_000, { distill: "sonnet" }),
    ).toBe("sonnet");
  });

  it("routes a decision-category session to distill even when tiny", () => {
    expect(
      selectDistillModel(cls("decision"), 1, {
        distill: "sonnet",
        distillFast: "haiku",
      }),
    ).toBe("sonnet");
  });

  it("uses distillFast at exactly the threshold (boundary is >, not >=)", () => {
    expect(
      selectDistillModel(cls("pattern"), 100_000, {
        distill: "sonnet",
        distillFast: "haiku",
      }),
    ).toBe("haiku");
  });

  it("forces distill one token over the threshold", () => {
    expect(
      selectDistillModel(cls("pattern"), 100_001, {
        distill: "sonnet",
        distillFast: "haiku",
      }),
    ).toBe("sonnet");
  });

  it("routes a routine, small session to distillFast", () => {
    expect(
      selectDistillModel(cls("tool"), 500, {
        distill: "sonnet",
        distillFast: "haiku",
      }),
    ).toBe("haiku");
  });

  it("respects a custom threshold", () => {
    const models = { distill: "sonnet", distillFast: "haiku", distillThreshold: 10 };
    expect(selectDistillModel(cls("pattern"), 10, models)).toBe("haiku");
    expect(selectDistillModel(cls("pattern"), 11, models)).toBe("sonnet");
  });
});

describe("parseClassification themes", () => {
  it("parses a themes array, trimming and dropping empty entries", () => {
    const c = parseClassification(
      '{"category":"gotcha","topic":"kie 200 body error","themes":[" kie error handling ","retry safety",""]}',
      "vir",
    );
    expect(c.themes).toEqual(["kie error handling", "retry safety"]);
  });

  it("defaults themes to [] when the field is absent", () => {
    const c = parseClassification('{"category":"pattern","topic":"x"}', "vir");
    expect(c.themes).toEqual([]);
  });

  it("defaults themes to [] when themes is malformed (not an array)", () => {
    const c = parseClassification(
      '{"category":"pattern","topic":"x","themes":"not-an-array"}',
      "vir",
    );
    expect(c.themes).toEqual([]);
  });

  it("drops non-string entries from a mixed themes array", () => {
    const c = parseClassification(
      '{"category":"tool","topic":"x","themes":["valid",3,null,"also valid"]}',
      "vir",
    );
    expect(c.themes).toEqual(["valid", "also valid"]);
  });

  it("handles a single theme", () => {
    const c = parseClassification(
      '{"category":"decision","topic":"x","themes":["only one"]}',
      "vir",
    );
    expect(c.themes).toEqual(["only one"]);
  });
});

describe("callKie timeout", () => {
  it("treats a KieTimeoutError as retryable (a stall is transient)", () => {
    expect(isRetryable(new KieTimeoutError(120_000))).toBe(true);
  });

  it("aborts and throws KieTimeoutError when the fetch never resolves", async () => {
    // A fetch that hangs until its AbortSignal fires — mirrors how the real
    // fetch rejects on abort. The timeout must trip and surface a typed error.
    const hangingFetch = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      })) as unknown as typeof fetch;

    const start = Date.now();
    await expect(
      callKie({
        apiKey: "k",
        model: "m",
        maxTokens: 10,
        prompt: "p",
        timeoutMs: 50,
        fetchImpl: hangingFetch,
      }),
    ).rejects.toBeInstanceOf(KieTimeoutError);
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
