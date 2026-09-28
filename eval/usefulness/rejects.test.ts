import { describe, expect, it } from "vitest";
import type { AuditRow } from "../../src/state/db.js";
import { rejectsToTest } from "./rejects.js";

const audit = (sessionId: string, verdict: AuditRow["verdict"], fresh = true): AuditRow => ({
  path: `/p/${sessionId}.jsonl`, sessionId, verdict, reason: "", mergeInto: null, auditedAt: "x", fresh,
});

describe("rejectsToTest", () => {
  // The eval must ablate exactly what `vir audit --apply-rejects` would move:
  // fresh rejects only, never a note a human approved (apply.ts noteIsVerified).
  it("keeps fresh rejects and drops human-approved ones, sorted", () => {
    const audits = [audit("b", "reject"), audit("a", "reject"), audit("v", "reject"), audit("s", "reject", false), audit("k", "keep")];
    expect(rejectsToTest(audits, (id) => id === "v")).toEqual(["a", "b"]);
  });
});
