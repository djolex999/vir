import { describe, expect, it } from "vitest";
import type { DreamNote } from "./select.js";
import { DreamParseError, buildDreamPrompt, parseDreamResponse } from "./prompt.js";

const note = (index: number, text: string): DreamNote => ({
  index,
  row: {
    path: `/p/${index}.jsonl`,
    sessionId: `s${index}`,
    startedAt: null,
    category: "gotcha",
    topic: `t${index}`,
    project: "vir",
    confidence: 0.8,
    content: text,
    lesson: null,
  },
  ref: `gotchas/t${index}`,
  status: "unchecked",
  surfaced: 0,
  text,
  full: true,
});

const entry = '{"claim":"c","source":1,"quote":"q","kind":"trap","also":[2]}';
const reply = `{"overview":"o","sections":[{"heading":"Deploy","entries":[${entry}]}],"conflicts":[{"a":1,"b":2,"about":"x"}],"gaps":["g"]}`;

describe("buildDreamPrompt", () => {
  it("numbers notes as [n] with their text and states the rules", () => {
    const p = buildDreamPrompt("vir", [note(1, "first body"), note(2, "second body")]);
    expect(p).toContain("[1]");
    expect(p).toContain("first body");
    expect(p).toContain("[2]");
    expect(p).toContain("second body");
    expect(p).toContain('"conflicts"');
    expect(p).toMatch(/group by area/i);
    expect(p).toMatch(/also/);
    expect(p).toMatch(/never state anything that is not in a note/i);
    expect(p).toMatch(/conflicts/);
  });
});

describe("parseDreamResponse", () => {
  it("parses JSON wrapped in prose", () => {
    const r = parseDreamResponse(`Here:\n${reply}\nDone.`);
    expect(r.overview).toBe("o");
    expect(r.sections[0]?.entries[0]).toEqual({ claim: "c", source: 1, quote: "q", kind: "trap", also: [2] });
    expect(r.conflicts).toEqual([{ a: 1, b: 2, about: "x" }]);
    expect(r.gaps).toEqual(["g"]);
  });

  it("defaults missing arrays and an unknown kind", () => {
    const r = parseDreamResponse(
      '{"overview":"o","sections":[{"heading":"H","entries":[{"claim":"c","source":3,"quote":"q","kind":"musing"}]}]}',
    );
    expect(r.sections[0]?.entries[0]).toEqual({ claim: "c", source: 3, quote: "q", kind: "rule", also: [] });
    expect(r.conflicts).toEqual([]);
    expect(r.gaps).toEqual([]);
  });

  it("drops entries without a claim or a numeric source", () => {
    const r = parseDreamResponse(
      `{"overview":"o","sections":[{"heading":"H","entries":[${entry},{"claim":"x"},{"source":2,"quote":"q"}]}]}`,
    );
    expect(r.sections[0]?.entries).toHaveLength(1);
  });

  it("throws DreamParseError on no JSON or zero entries", () => {
    expect(() => parseDreamResponse("I could not do it.")).toThrow(DreamParseError);
    expect(() => parseDreamResponse('{"overview":"o","sections":[]}')).toThrow(DreamParseError);
  });
});
