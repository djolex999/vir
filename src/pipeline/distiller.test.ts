import { describe, it, expect } from "vitest";
import { HttpError, isRetryable, kieResponseError } from "./distiller.js";

describe("isRetryable", () => {
  it("retries on 429", () => {
    expect(isRetryable(new HttpError(429, "rate limited"))).toBe(true);
  });

  it("retries on 500/502/503/504", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(isRetryable(new HttpError(status, "server error"))).toBe(true);
    }
  });

  it("does not retry on 400/401/403/404", () => {
    for (const status of [400, 401, 403, 404]) {
      expect(isRetryable(new HttpError(status, "client error"))).toBe(false);
    }
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
