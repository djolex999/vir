import { describe, expect, it } from "vitest";
import {
  agentTranscriptsCheck,
  backupCheck,
  daemonCheck,
  embeddingProviderCheck,
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

// backup.last stamps carry the trigger ("<iso> manual|scheduled"); only a
// SCHEDULED success within 48h reads healthy. A manual run proves the script
// works, not that the launchd job runs — it must never silence the warning.
// The last FAIL line from backup.log is surfaced, not left to a file nobody
// reads.
describe("backupCheck", () => {
  const NOW = Date.parse("2026-07-30T12:00:00Z");
  const base = {
    configured: true,
    last: null as string | null,
    lastScheduled: null as string | null,
    lastFail: null as string | null,
  };

  it("emits no row when no backup job is configured", () => {
    expect(backupCheck({ ...base, configured: false }, NOW)).toBeNull();
  });

  it("warns when configured but never succeeded", () => {
    expect(backupCheck(base, NOW)?.status).toBe("warn");
  });

  it("legacy bare-ISO stamp counts as scheduled: ok fresh, warn stale", () => {
    const fresh = { ...base, last: "2026-07-29T12:00:00Z" }; // 24h
    const stale = { ...base, last: "2026-07-27T12:00:00Z" }; // 72h
    expect(backupCheck(fresh, NOW)?.status).toBe("ok");
    const r = backupCheck(stale, NOW);
    expect(r?.status).toBe("warn");
    expect(r?.detail).toContain("72h");
  });

  it("fresh scheduled stamp → ok", () => {
    const r = backupCheck(
      { ...base, last: "2026-07-30T03:30:00Z scheduled", lastScheduled: "2026-07-30T03:30:00Z scheduled" },
      NOW,
    );
    expect(r?.status).toBe("ok");
  });

  it("fresh MANUAL stamp with no scheduled success still warns", () => {
    const r = backupCheck({ ...base, last: "2026-07-30T11:00:00Z manual" }, NOW);
    expect(r?.status).toBe("warn");
    expect(r?.detail).toMatch(/manual/i);
  });

  it("fresh manual + stale scheduled → warn with the scheduled age", () => {
    const r = backupCheck(
      {
        ...base,
        last: "2026-07-30T11:00:00Z manual",
        lastScheduled: "2026-07-27T12:00:00Z scheduled", // 72h
      },
      NOW,
    );
    expect(r?.status).toBe("warn");
    expect(r?.detail).toContain("72h");
    expect(r?.detail).toMatch(/manual/i);
  });

  it("a FAIL newer than the last scheduled success is surfaced verbatim", () => {
    const r = backupCheck(
      {
        ...base,
        last: "2026-07-29T03:30:00Z scheduled",
        lastScheduled: "2026-07-29T03:30:00Z scheduled",
        lastFail: "[2026-07-30T01:30:03Z] FAIL: sqlite dump",
      },
      NOW,
    );
    expect(r?.status).toBe("warn");
    expect(r?.detail).toContain("FAIL: sqlite dump");
  });

  it("a FAIL older than the last scheduled success does not warn", () => {
    const r = backupCheck(
      {
        ...base,
        last: "2026-07-30T03:30:00Z scheduled",
        lastScheduled: "2026-07-30T03:30:00Z scheduled",
        lastFail: "[2026-07-28T01:30:03Z] FAIL: sqlite dump",
      },
      NOW,
    );
    expect(r?.status).toBe("ok");
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

describe("embeddingProviderCheck", () => {
  it("reports the active provider with model and dimension", () => {
    const r = embeddingProviderCheck("ollama", "nomic-embed-text", 768, 0);
    expect(r.status).toBe("ok");
    expect(r.detail).toMatch(/nomic-embed-text/);
    expect(r.detail).toMatch(/768/);
  });

  it("no provider is a warn with both alternatives and their costs", () => {
    const r = embeddingProviderCheck("none", null, null, 0);
    expect(r.status).toBe("warn");
    expect(r.detail).toMatch(/vir embed --setup/);
    expect(r.detail).toMatch(/233 MB/);
    expect(r.detail).toMatch(/[Oo]llama/);
  });

  it("mismatched-model notes surface as an unfinished migration", () => {
    const r = embeddingProviderCheck("local", "bge-small-en-v1.5", 384, 14);
    expect(r.status).toBe("warn");
    expect(r.detail).toMatch(/14/);
    expect(r.detail).toMatch(/different model/);
    expect(r.detail).toMatch(/vir embed --force/);
  });
});
