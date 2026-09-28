import { describe, expect, it } from "vitest";
import { extractJsonArray } from "./json.js";

describe("extractJsonArray", () => {
  it("parses a reply that is exactly a JSON array", () => {
    expect(extractJsonArray('[{"a":1}]')).toEqual([{ a: 1 }]);
  });

  it("parses a JSON array inside a ```json fence, ignoring surrounding prose", () => {
    const reply = 'Sure, here you go:\n\n```json\n[{"a":1},{"a":2}]\n```\n\nLet me know if you need more.';
    expect(extractJsonArray(reply)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  // M2: a bracketed preamble (an earlier "[" the model wrote in prose) breaks
  // the plain greedy regex, which spans from the FIRST "[" to the LAST "]" —
  // here that would swallow the mismatched brackets and fail to parse. The
  // fenced block must be tried first and rescue this case.
  it("parses a fenced array even when the reply has an earlier bracketed preamble", () => {
    const reply = 'Note: the array [1, 2, 3] from the transcript does not apply here.\n\n```json\n[{"fact":1,"verdict":"stated","why":"x"}]\n```';
    expect(extractJsonArray(reply)).toEqual([{ fact: 1, verdict: "stated", why: "x" }]);
  });

  it("falls back to the greedy bracket match when there is no fence", () => {
    const reply = 'The result is [{"a":1}] as requested.';
    expect(extractJsonArray(reply)).toEqual([{ a: 1 }]);
  });

  it("returns undefined for a reply with no JSON array at all", () => {
    expect(extractJsonArray("I cannot help with that")).toBeUndefined();
  });
});
