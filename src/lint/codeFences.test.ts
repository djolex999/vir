import { describe, expect, it } from "vitest";
import { codeLines } from "./codeFences.js";

const flags = (text: string): boolean[] => codeLines(text.split("\n"));

describe("codeLines", () => {
  it("marks a fenced block, its fences included", () => {
    expect(flags("a\n```bash\nx\n```\nb")).toEqual([false, true, true, true, false]);
  });

  it("does not open a fence on a line that starts with inline code", () => {
    // A backtick fence's info string can't contain backticks, so this is a
    // paragraph line, not a fence (seen in a real CLAUDE.md).
    expect(flags("   ```` ```json ```` occasionally.\nprose")).toEqual([false, false]);
    expect(flags("``` `inline` ```\nprose")).toEqual([false, false]);
  });

  it("closes only on a bare fence of the same character, at least as long", () => {
    const text = ["````md", "```", "inside", "~~~", "```` trailing", "````", "out"].join("\n");
    expect(flags(text)).toEqual([true, true, true, true, true, true, false]);
  });

  it("allows backticks in a tilde fence's info string", () => {
    expect(flags("~~~ `x`\ninside\n~~~\nout")).toEqual([true, true, true, false]);
  });

  it("ignores fences indented four spaces or more", () => {
    expect(flags("    ```\nprose")).toEqual([false, false]);
  });

  it("runs an unclosed fence to the end of the file", () => {
    expect(flags("a\n```\nb")).toEqual([false, true, true]);
  });
});
