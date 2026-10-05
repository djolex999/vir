import { describe, expect, it } from "vitest";
import { scrub } from "./scrubber.js";

describe("scrub false positives", () => {
  it("leaves kebab-case identifiers containing 'sk-' untouched", () => {
    const input =
      "see risk-management-strategy-2026-plan and task-refactor-the-parser-module";
    expect(scrub(input)).toBe(input);
  });

  it("leaves prose containing 'bearer' untouched", () => {
    const input = "the bearer of bad news arrived";
    expect(scrub(input)).toBe(input);
  });

  it("does not eat across newlines after 'Bearer'", () => {
    const input = "header ends with Bearer\nnextline-token-here";
    expect(scrub(input)).toContain("nextline-token-here");
  });
});

describe("scrub true positives still redact", () => {
  it("redacts a real OpenAI-style key", () => {
    const out = scrub("key=sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z");
    expect(out).toContain("[REDACTED_OPENAI_KEY]");
    expect(out).not.toContain("sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z");
  });

  it("redacts a real Anthropic key", () => {
    const out = scrub('ANTHROPIC_API_KEY="sk-ant-api03-Ab3dEf6hIj9kLm2nOp5q"');
    expect(out).toContain("[REDACTED_ANTHROPIC_KEY]");
  });

  it("redacts a real Authorization bearer token", () => {
    const out = scrub("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def");
    expect(out).toContain("Bearer [REDACTED_TOKEN]");
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });
});

describe("scrub — other users' home paths", () => {
  it("collapses Linux /home/<user>/... paths like macOS /Users/...", () => {
    expect(scrub("see /home/alice/projects/app/src/index.ts")).toBe("see ~/index.ts");
    expect(scrub("open /Users/bob/work/notes.md")).toBe("open ~/notes.md");
    // A bare home dir collapses the same way as before (to its basename).
    expect(scrub("in /Users/bob and /home/alice")).toBe("in ~/bob and ~/alice");
  });

  it("leaves system paths and a bare /home alone", () => {
    expect(scrub("ran /usr/bin/node in /home")).toBe("ran /usr/bin/node in /home");
  });
});
