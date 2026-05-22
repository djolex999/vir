import { describe, it, expect } from "vitest";
import { HttpError, isRetryable } from "./distiller.js";

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
