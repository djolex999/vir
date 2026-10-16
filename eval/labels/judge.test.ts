import { describe, expect, it } from "vitest";
import { makeRng } from "../rng.js";
import {
  buildJudgePrompt,
  chunkCandidates,
  contentHash,
  labelKey,
  noteExcerpt,
  parseJudgeResponse,
  rubricHash,
} from "./judge.js";

describe("chunkCandidates", () => {
  it("shuffles by seed then splits into chunks of at most `size`", () => {
    const slugs = ["a", "b", "c", "d", "e", "f", "g"];
    const chunks = chunkCandidates(slugs, 3, makeRng(9));
    expect(chunks.map((c) => c.length)).toEqual([3, 3, 1]);
    expect(chunks.flat().sort()).toEqual([...slugs].sort());
    expect(chunkCandidates(slugs, 3, makeRng(9))).toEqual(chunks);
    expect(chunks.flat()).not.toEqual(slugs);
  });
  it("returns [] for no candidates", () => {
    expect(chunkCandidates([], 10, makeRng(1))).toEqual([]);
  });
});

describe("hashes and keys", () => {
  it("rubricHash / contentHash are stable 12-hex prefixes of sha256", () => {
    // sha256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    expect(rubricHash("abc")).toBe("ba7816bf8f01");
    expect(contentHash("abc")).toBe("ba7816bf8f01");
    expect(rubricHash("abd")).not.toBe(rubricHash("abc"));
  });
  it("labelKey binds slug to content hash so an edited note invalidates its label", () => {
    expect(labelKey("gotchas/x-1234abcd", "ba7816bf8f01")).toBe("gotchas/x-1234abcd@ba7816bf8f01");
  });
});

describe("noteExcerpt", () => {
  it("drops frontmatter and truncates to maxChars", () => {
    const raw = "---\ntopic: x\n---\n## Summary\n" + "y".repeat(50);
    const ex = noteExcerpt(raw, 20);
    expect(ex.startsWith("## Summary")).toBe(true);
    expect(ex.length).toBeLessThanOrEqual(20);
  });
});

describe("buildJudgePrompt", () => {
  it("includes rubric, query, every candidate slug and excerpt, and the JSON contract", () => {
    const p = buildJudgePrompt({
      rubric: "RUBRIC TEXT",
      query: "kie 200 error handling retry",
      candidates: [
        { slug: "gotchas/kie-200-x", excerpt: "Kie returns 200 with an error body." },
        { slug: "patterns/other-y", excerpt: "Unrelated." },
      ],
    });
    expect(p).toContain("RUBRIC TEXT");
    expect(p).toContain("kie 200 error handling retry");
    expect(p).toContain("gotchas/kie-200-x");
    expect(p).toContain("Kie returns 200 with an error body.");
    expect(p).toContain("patterns/other-y");
    expect(p).toMatch(/JSON object/);
  });
});

describe("parseJudgeResponse", () => {
  const expected = ["gotchas/kie-200-x", "patterns/other-y"];
  it("maps every expected slug to a 0/1/2 grade", () => {
    const out = parseJudgeResponse(
      '```json\n{"gotchas/kie-200-x": 2, "patterns/other-y": 0}\n```',
      expected,
    );
    expect(out).toEqual({ "gotchas/kie-200-x": 2, "patterns/other-y": 0 });
  });
  it("rejects a missing slug, an unknown slug, or a grade outside 0..2", () => {
    expect(() => parseJudgeResponse('{"gotchas/kie-200-x": 2}', expected)).toThrow(/missing/);
    expect(() =>
      parseJudgeResponse('{"gotchas/kie-200-x": 2, "patterns/other-y": 0, "zzz": 1}', expected),
    ).toThrow(/unknown/);
    expect(() =>
      parseJudgeResponse('{"gotchas/kie-200-x": 3, "patterns/other-y": 0}', expected),
    ).toThrow(/grade/);
  });
});

describe("parseJudgeResponse: shortened slugs", () => {
  const slugs = ["insights/rules/paddle-tax-70c62d63", "gotchas/redis-reconnect-1a2b3c4d"];

  it("maps a slug the judge shortened to its directory-less form when exactly one candidate matches", () => {
    const out = parseJudgeResponse('{"paddle-tax-70c62d63": 0, "gotchas/redis-reconnect-1a2b3c4d": 2}', slugs);
    expect(out).toEqual({ "insights/rules/paddle-tax-70c62d63": 0, "gotchas/redis-reconnect-1a2b3c4d": 2 });
  });

  it("still rejects a key that matches no candidate", () => {
    expect(() => parseJudgeResponse('{"paddle-tax": 0, "gotchas/redis-reconnect-1a2b3c4d": 2}', slugs)).toThrow(/unknown slug: paddle-tax/);
  });

  it("rejects a shortened key that would match two candidates", () => {
    const twins = ["gotchas/same-name-1a2b3c4d", "patterns/same-name-1a2b3c4d"];
    expect(() => parseJudgeResponse('{"same-name-1a2b3c4d": 1}', twins)).toThrow(/ambiguous slug: same-name-1a2b3c4d/);
  });

  it("rejects a shortened key that collides with a full key for the same candidate", () => {
    expect(() =>
      parseJudgeResponse('{"paddle-tax-70c62d63": 0, "insights/rules/paddle-tax-70c62d63": 1, "gotchas/redis-reconnect-1a2b3c4d": 2}', slugs),
    ).toThrow(/graded twice: insights\/rules\/paddle-tax-70c62d63/);
  });
});
