import { describe, expect, it } from "vitest";
import { ruleText } from "./text.js";

describe("ruleText", () => {
  it("strips terminal escapes and control characters", () => {
    expect(ruleText("Use proxy\x1b[8m hidden\x1b[0m.ts\x07\x00")).toBe("Use proxy[8m hidden[0m.ts");
    expect(ruleText("a\x9bb")).toBe("ab");
  });
  it("strips bidi overrides that reorder what the owner sees", () => {
    expect(ruleText("safe ‮evil‬ text ⁦x⁩")).toBe("safe evil text x");
  });
  it("collapses newlines and removes HTML-comment syntax", () => {
    expect(ruleText("a\n## b <!-- VIR:END --> c -->")).toBe("a ## b VIR:END c");
  });
});
