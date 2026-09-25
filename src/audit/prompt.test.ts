import { describe, expect, it } from "vitest";
import type { DistilledRow } from "../state/db.js";
import { AuditParseError, buildAuditPrompt, parseAuditResponse } from "./prompt.js";

const row = (topic: string, content: string): DistilledRow => ({
  path: `/p/x/${topic}.jsonl`,
  sessionId: topic,
  startedAt: "2026-05-01",
  category: "gotcha",
  topic,
  project: "vir",
  confidence: 0.9,
  content,
});

describe("buildAuditPrompt", () => {
  it("labels notes n1..nK and carries every body", () => {
    const p = buildAuditPrompt("vir", [row("alpha", "BODY-A"), row("beta", "BODY-B")]);
    expect(p).toContain('<note id="n1" topic="alpha" category="gotcha">');
    expect(p).toContain("BODY-A");
    expect(p).toContain('<note id="n2" topic="beta" category="gotcha">');
    expect(p).toContain("BODY-B");
    expect(p).toContain("project: vir");
  });

  // The ids are prompt-local; a reason that says "dup of n1" means nothing to
  // the human reading it in vir review.
  it("tells the model to name other notes by topic, not id", () => {
    expect(buildAuditPrompt("vir", [row("a", "b")])).toContain("by their topic, never by id");
  });

  // The generic test caught most rejects in the 2026-09-25 manual audit.
  it("puts the would-Claude-already-know-this test first", () => {
    const p = buildAuditPrompt("vir", [row("a", "b")]);
    expect(p.indexOf("already know")).toBeLessThan(p.indexOf("duplicate"));
  });
});

describe("parseAuditResponse", () => {
  it("parses a fenced JSON array", () => {
    const text = '```json\n[{"id":"n1","verdict":"reject","reason":"generic"},' +
      '{"id":"n2","verdict":"merge","reason":"same as n1","merge_into":"n1"}]\n```';
    const m = parseAuditResponse(text, 2);
    expect(m.get("n1")).toEqual({ verdict: "reject", reason: "generic", mergeInto: null });
    expect(m.get("n2")).toEqual({ verdict: "merge", reason: "same as n1", mergeInto: "n1" });
  });

  // A merge needs a target the auditor actually saw; otherwise the human is
  // left with advice they cannot follow.
  it("downgrades a merge with an unknown or self target to verify", () => {
    const m = parseAuditResponse(
      '[{"id":"n1","verdict":"merge","reason":"dup","merge_into":"n9"},' +
        '{"id":"n2","verdict":"merge","reason":"dup","merge_into":"n2"}]',
      2,
    );
    expect(m.get("n1")?.verdict).toBe("verify");
    expect(m.get("n1")?.mergeInto).toBeNull();
    expect(m.get("n2")?.verdict).toBe("verify");
  });

  it("drops entries with an unknown id or verdict and keeps the rest", () => {
    const m = parseAuditResponse(
      '[{"id":"n7","verdict":"keep","reason":"x"},{"id":"n1","verdict":"great","reason":"x"},' +
        '{"id":"n2","verdict":"keep","reason":"specific"}]',
      2,
    );
    expect([...m.keys()]).toEqual(["n2"]);
  });

  it("throws AuditParseError when there is no JSON array at all", () => {
    expect(() => parseAuditResponse("I can't do that", 1)).toThrow(AuditParseError);
    expect(() => parseAuditResponse("[{broken", 1)).toThrow(AuditParseError);
  });
});
