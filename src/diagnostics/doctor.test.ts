import { describe, expect, it } from "vitest";
import {
  agentTranscriptsCheck,
  backupCheck,
  daemonCheck,
  ollamaCheck,
  pendingProjectsCheck,
} from "./doctor.js";

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

describe("backupCheck", () => {
  const NOW = Date.parse("2026-07-30T12:00:00Z");

  it("emits no row when no backup job is configured", () => {
    expect(backupCheck(false, null, NOW)).toBeNull();
  });

  it("warns when configured but never succeeded", () => {
    expect(backupCheck(true, null, NOW)?.status).toBe("warn");
  });

  it("ok within 48h, warn past it", () => {
    const fresh = "2026-07-29T12:00:00Z"; // 24h
    const stale = "2026-07-27T12:00:00Z"; // 72h
    expect(backupCheck(true, fresh, NOW)?.status).toBe("ok");
    const r = backupCheck(true, stale, NOW);
    expect(r?.status).toBe("warn");
    expect(r?.detail).toContain("72h");
  });
});

describe("daemonCheck — old-label migration awareness", () => {
  it("an old-label job reads installed-but-stale, never not-installed", () => {
    const r = daemonCheck(true, true, "launchd", 3, "lab.growthq.vir");
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("lab.growthq.vir");
    expect(r.detail).toMatch(/schedule install/);
    expect(r.detail).not.toContain("not installed");
  });

  it("no stale label → behavior unchanged", () => {
    expect(daemonCheck(true, true, "launchd", 3, null).status).toBe("ok");
  });
});

describe("pendingProjectsCheck — undecided is a decision with a deadline", () => {
  const NOW2 = Date.parse("2026-07-30T12:00:00Z");

  it("ok when every project is decided", () => {
    const r = pendingProjectsCheck(0, 0, null, NOW2);
    expect(r.status).toBe("ok");
  });

  it("warns with counts, oldest transcript age, and the ~30-day prune deadline", () => {
    const oldest = "2026-07-05T12:00:00Z"; // 25 days old
    const r = pendingProjectsCheck(14, 3, oldest, NOW2);
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("14");
    expect(r.detail).toContain("3");
    expect(r.detail).toContain("25d");
    expect(r.detail).toMatch(/30 day/);
    expect(r.detail).toMatch(/vir projects/);
  });

  it("warns even without a readable mtime", () => {
    const r = pendingProjectsCheck(2, 1, null, NOW2);
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("2");
  });
});

describe("agentTranscriptsCheck — informational, never a warning", () => {
  it("reports the skip count and entrypoints seen", () => {
    const r = agentTranscriptsCheck({ "sdk-py": 66, "sdk-ts": 1 });
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("67");
    expect(r.detail).toContain("sdk-py");
    expect(r.detail).toContain("sdk-ts");
  });

  it("zero skips reads as none", () => {
    const r = agentTranscriptsCheck({});
    expect(r.status).toBe("ok");
    expect(r.detail).toMatch(/none/i);
  });
});
