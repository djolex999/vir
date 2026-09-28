import { describe, expect, it } from "vitest";
import { buildGraderPrompt, parseGrade, scoreAnswer } from "./grade.js";

describe("parseGrade", () => {
  it("parses one verdict per fact, in fact order", () => {
    const reply = '```json\n[{"fact":2,"verdict":"missing","why":"x"},{"fact":1,"verdict":"stated","why":"y"}]\n```';
    expect(parseGrade(reply, 2)).toEqual(["stated", "missing"]);
  });
  it("rejects a reply that skips or repeats a fact", () => {
    expect(parseGrade('[{"fact":1,"verdict":"stated"}]', 2)).toBeNull();
    expect(parseGrade('[{"fact":1,"verdict":"stated"},{"fact":1,"verdict":"missing"}]', 2)).toBeNull();
  });
  it("rejects an unknown verdict or non-JSON", () => {
    expect(parseGrade('[{"fact":1,"verdict":"maybe"}]', 1)).toBeNull();
    expect(parseGrade("no json here", 1)).toBeNull();
  });
});

describe("scoreAnswer", () => {
  it("computes recall and contradiction as shares of the facts", () => {
    expect(scoreAnswer(["stated", "missing", "contradicted", "stated"])).toEqual({ recall: 0.5, contradiction: 0.25 });
  });
});

describe("buildGraderPrompt", () => {
  it("numbers the facts and includes exactly one answer", () => {
    const p = buildGraderPrompt("Q?", ["f one", "f two"], "THE-ANSWER");
    expect(p).toContain("1. f one");
    expect(p).toContain("2. f two");
    expect(p).toContain("THE-ANSWER");
  });
});
