import { describe, expect, it } from "vitest";
import { jaccard, matchCandidate } from "./identity.js";
import { sampleInsight } from "./testFixtures.js";

const ins = (over: Parameters<typeof sampleInsight>[0]) => sampleInsight(over);

describe("jaccard", () => {
  it("is |A∩B| / |A∪B| over distinct values", () => {
    expect(jaccard(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3);
    expect(jaccard([], [])).toBe(0);
  });
});

describe("matchCandidate", () => {
  const rejected = ins({ id: "r1", status: "rejected", memberSessionIds: ["s1", "s2", "s3"], memberHashes: ["h1", "h2", "h3"] });

  it("keeps a rejection after every member note is rewritten (new hashes, same sessions)", () => {
    const out = matchCandidate({ sessionIds: ["s1", "s2", "s3"], hashes: ["x1", "x2", "x3"], ruleVector: null }, [rejected], new Map(), 0.9);
    expect(out.kind).toBe("skip-rejected");
  });

  it("matches at Jaccard 0.5 and not below", () => {
    const at = matchCandidate({ sessionIds: ["s1", "s2", "s4", "s5"], hashes: [], ruleVector: null }, [ins({ memberSessionIds: ["s1", "s2", "s3"] })], new Map(), 0.9);
    expect(jaccard(["s1", "s2", "s4", "s5"], ["s1", "s2", "s3"])).toBeCloseTo(0.4);
    expect(at.kind).toBe("new");
    const half = matchCandidate({ sessionIds: ["s1", "s2", "s4"], hashes: [], ruleVector: null }, [ins({ memberSessionIds: ["s1", "s2", "s3", "s5"] })], new Map(), 0.9);
    expect(jaccard(["s1", "s2", "s4"], ["s1", "s2", "s3", "s5"])).toBeCloseTo(0.4);
    expect(half.kind).toBe("new");
    const exact = matchCandidate({ sessionIds: ["s1", "s2", "s3", "s4"], hashes: [], ruleVector: null }, [ins({ memberSessionIds: ["s1", "s2"] })], new Map(), 0.9);
    expect(exact.kind).toBe("update-proposed");
  });

  it("breaks a session-overlap tie by content-hash overlap", () => {
    const a = ins({ id: "a", slug: "a", memberSessionIds: ["s1", "s2", "s3"], memberHashes: ["h9"] });
    const b = ins({ id: "b", slug: "b", memberSessionIds: ["s1", "s2", "s3"], memberHashes: ["h1", "h2"] });
    const out = matchCandidate({ sessionIds: ["s1", "s2", "s3"], hashes: ["h1", "h2"], ruleVector: null }, [a, b], new Map(), 0.9);
    expect(out.kind === "update-proposed" && out.insight.id).toBe("b");
  });

  it("matches a rejected rule by rule embedding when sessions don't overlap", () => {
    const out = matchCandidate({ sessionIds: ["t1", "t2", "t3"], hashes: [], ruleVector: [1, 0] }, [rejected], new Map([["r1", [0.99, 0.05]]]), 0.9);
    expect(out.kind).toBe("skip-rejected");
    const far = matchCandidate({ sessionIds: ["t1", "t2", "t3"], hashes: [], ruleVector: [0, 1] }, [rejected], new Map([["r1", [1, 0]]]), 0.9);
    expect(far.kind).toBe("new");
  });

  it("reports accepted rules as unchanged or with additions", () => {
    const accepted = ins({ status: "accepted", memberSessionIds: ["s1", "s2", "s3"] });
    expect(matchCandidate({ sessionIds: ["s1", "s2", "s3"], hashes: [], ruleVector: null }, [accepted], new Map(), 0.9).kind).toBe("accepted-unchanged");
    const more = matchCandidate({ sessionIds: ["s1", "s2", "s3", "s4"], hashes: [], ruleVector: null }, [accepted], new Map(), 0.9);
    expect(more).toMatchObject({ kind: "accepted-additions", addedSessions: ["s4"] });
  });
});
