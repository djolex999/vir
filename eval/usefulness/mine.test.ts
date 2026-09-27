import { describe, expect, it } from "vitest";
import { buildMinerPrompt, distinctiveTokens, selectCandidates, validateMined, type Candidate } from "./mine.js";

const cand = (over: Partial<Candidate>): Candidate => ({
  path: "/p/a.jsonl", project: "vir", sessionId: "s1", startedAt: "2026-09-10T00:00:00.000Z",
  category: "session", agent: false, ...over,
});

describe("selectCandidates", () => {
  const notes = new Map([["vir", ["2026-09-01T00:00:00.000Z"]], ["late", ["2026-09-20T00:00:00.000Z"]]]);

  it("keeps a human session in a project with an earlier note", () => {
    expect(selectCandidates([cand({})], notes)).toHaveLength(1);
  });
  it("drops sidechain, workflow and SDK-agent transcripts", () => {
    expect(selectCandidates([cand({ category: "sidechain" }), cand({ category: "workflow" }), cand({ agent: true })], notes)).toEqual([]);
  });
  it("drops sessions with no earlier note in their project, and sessions with no start time", () => {
    expect(selectCandidates([cand({ project: "late" }), cand({ project: "none" }), cand({ startedAt: null })], notes)).toEqual([]);
  });
});

describe("distinctiveTokens", () => {
  it("picks backticked terms, code-like identifiers and multi-digit numbers", () => {
    const t = distinctiveTokens("`servingGate()` in db.ts filters rows; listAudits caps at 40000 chars");
    expect(t).toEqual(expect.arrayContaining(["servingGate()", "db.ts", "listAudits", "40000"]));
  });
});

describe("validateMined", () => {
  const transcript = "we decided listAudits must use servingGate so rejected rows never serve. chose Paddle over Stripe for Kosovo.";

  it("keeps a well-formed item whose evidence is in the transcript", () => {
    const reply = JSON.stringify([{
      question: "How are rejected rows kept out of the audit list?",
      facts: ["listAudits uses servingGate", "rejected rows never serve"],
      evidence: ["listAudits must use servingGate", "rejected rows never serve"],
    }]);
    const r = validateMined(reply, transcript);
    expect(r.items).toHaveLength(1);
    expect(r.drops).toEqual({ unparsed: 0, "fact-count": 0, "answer-in-question": 0, "bad-evidence": 0 });
  });

  it("drops an item with fewer than 2 or more than 4 facts", () => {
    const one = { question: "q?", facts: ["a"], evidence: ["servingGate"] };
    const five = { question: "q?", facts: ["a", "b", "c", "d", "e"], evidence: ["x", "x", "x", "x", "x"] };
    expect(validateMined(JSON.stringify([one, five]), transcript).drops["fact-count"]).toBe(2);
  });

  // Ruling R2: a question may name its subject; it may not already contain every distinctive token of a fact.
  it("drops an item whose question already carries a fact's distinctive tokens", () => {
    const leaky = { question: "Does listAudits use servingGate?", facts: ["listAudits uses servingGate", "rejected rows never serve"], evidence: ["servingGate", "never serve"] };
    const fine = { question: "How does listAudits keep rejected rows out?", facts: ["listAudits uses servingGate", "rejected rows never serve"], evidence: ["servingGate", "never serve"] };
    const r = validateMined(JSON.stringify([leaky, fine]), transcript);
    expect(r.items.map((i) => i.question)).toEqual(["How does listAudits keep rejected rows out?"]);
    expect(r.drops["answer-in-question"]).toBe(1);
  });

  it("drops an item whose evidence is not in the transcript (whitespace/case-insensitive)", () => {
    const bad = { question: "Which billing provider?", facts: ["Paddle", "because Kosovo"], evidence: ["chose  PADDLE over stripe", "invented quote"] };
    expect(validateMined(JSON.stringify([bad]), transcript).drops["bad-evidence"]).toBe(1);
  });

  it("counts an unparseable reply once and returns no items", () => {
    const r = validateMined("I cannot help", transcript);
    expect(r.items).toEqual([]);
    expect(r.drops.unparsed).toBe(1);
  });

  it("accepts an empty array (nothing to learn) with no drops", () => {
    expect(validateMined("[]", transcript)).toEqual({
      items: [], drops: { unparsed: 0, "fact-count": 0, "answer-in-question": 0, "bad-evidence": 0 },
    });
  });
});

describe("buildMinerPrompt", () => {
  it("carries the project, the transcript and the no-answer rule", () => {
    const p = buildMinerPrompt("vir", "TRANSCRIPT-BODY");
    expect(p).toContain("project: vir");
    expect(p).toContain("TRANSCRIPT-BODY");
    expect(p).toContain("must not contain the answer");
  });
});
