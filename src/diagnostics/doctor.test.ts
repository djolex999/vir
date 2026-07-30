import { describe, expect, it } from "vitest";
import { daemonCheck, ollamaCheck } from "./doctor.js";

// The doctor Ollama check must be probe-based, not reachability-based: a
// daemon that answers /api/tags while embed() throws (model deleted, legacy
// endpoint removed, scheduler wedged) is NOT healthy — that state silently
// downgrades every query to TF-IDF while doctor said "semantic search
// enabled". `probedModel` is the result of a one-shot embed("ping"): the
// model id on success, null on any failure.

describe("ollamaCheck", () => {
  it("reachable + successful probe → ok, naming the probed model", () => {
    const r = ollamaCheck(true, "nomic-embed-text");
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("nomic-embed-text");
  });

  it("reachable but embed probe failed → must NOT report healthy", () => {
    const r = ollamaCheck(true, null);
    expect(r.status).not.toBe("ok");
    expect(r.detail).toMatch(/probe|embed/i);
  });

  it("unreachable → warn (Ollama is optional)", () => {
    expect(ollamaCheck(false, null).status).toBe("warn");
  });
});

// "Not installed" and "installed but down" are different actions for the user
// (install vs investigate why it died) — collapsing them into one ok/warn is
// the same false-signal class as the reachability-only Ollama check.
describe("daemonCheck", () => {
  it("not installed → warn naming the install command", () => {
    const r = daemonCheck(false, false, null, null);
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("schedule install");
  });

  it("installed but not running → warn, distinct from not-installed", () => {
    const r = daemonCheck(true, false, "launchd", 3);
    expect(r.status).toBe("warn");
    expect(r.detail).toMatch(/not running|inactive/i);
    expect(r.detail).not.toContain("run vir schedule install");
  });

  it("installed and active → ok, naming method and cadence", () => {
    const r = daemonCheck(true, true, "launchd", 3);
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("launchd");
    expect(r.detail).toContain("3h");
  });
});
