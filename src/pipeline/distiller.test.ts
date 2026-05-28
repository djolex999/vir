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
