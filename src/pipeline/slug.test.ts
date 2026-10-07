import { describe, expect, it } from "vitest";
import { makeSlug, sessionSuffix } from "./slug.js";

describe("sessionSuffix — Codex rollout ids", () => {
  it("takes the uuid's random tail, not the shared 'rollout-' prefix", () => {
    const id = "rollout-2026-05-12T20-35-21-019e1d78-dfaa-79f3-9427-4470d8e621fc";
    expect(sessionSuffix(id)).toBe("d8e621fc");
    expect(makeSlug("Next.js Rejects Port 6666", id)).toBe("next-js-rejects-port-6666-d8e621fc");
  });

  it("leaves Claude session ids unchanged", () => {
    expect(sessionSuffix("0199ba22-b739-7361-8e00-44246f31788b")).toBe("0199ba22");
  });
});
