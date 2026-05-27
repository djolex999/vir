import { describe, expect, it } from "vitest";
import {
  filterToolCalls,
  renderToolResult,
  renderToolUse,
} from "./toolCallFilter.js";
import type { FilterResult } from "./toolCallFilter.js";

// Build a tool_result block with exactly `n` lines of content, via the same
// renderer the parser uses — so these tests exercise the real grammar.
function resultBlock(name: string, lines: number, isError = false): string {
  const content = Array.from({ length: lines }, (_, i) => `line ${i}`).join(
    "\n",
  );
  return renderToolResult(name, content, isError);
}

describe("filterToolCalls", () => {
  it("'off' returns input unchanged with zero savings", () => {
    const input = `prose\n\n${resultBlock("Bash", 200)}\n\nmore prose`;
    const res = filterToolCalls(input, "off");
    expect(res.filtered).toBe(input);
    expect(res.tokensSaved).toBe(0);
    expect(res.toolCallsStripped).toBe(0);
    expect(res.filteredTokens).toBe(res.originalTokens);
  });

  it("'moderate' strips Bash output > 50 lines into a placeholder", () => {
    const input = resultBlock("Bash", 60);
    const res = filterToolCalls(input, "moderate");
    expect(res.toolCallsStripped).toBe(1);
    expect(res.filtered).toBe("[tool_result: Bash output, 60 lines, stripped]");
    expect(res.filtered).not.toContain("line 0");
  });

  it("'moderate' keeps Bash output <= 50 lines (content preserved)", () => {
    const input = resultBlock("Bash", 50);
    const res = filterToolCalls(input, "moderate");
    expect(res.toolCallsStripped).toBe(0);
    expect(res.filtered).toContain("[tool_result: Bash]");
    expect(res.filtered).toContain("line 49");
    expect(res.filtered).not.toContain("stripped");
  });

  it("'moderate' keeps a large tool_result when is_error is true", () => {
    const input = resultBlock("Bash", 500, true);
    const res = filterToolCalls(input, "moderate");
    expect(res.toolCallsStripped).toBe(0);
    expect(res.filtered).toContain("[tool_result: Bash ERROR]");
    expect(res.filtered).toContain("line 0");
  });

  it("'moderate' keeps a non-large tool regardless of size", () => {
    const input = resultBlock("Edit", 1000);
    const res = filterToolCalls(input, "moderate");
    expect(res.toolCallsStripped).toBe(0);
    expect(res.filtered).toContain("line 999");
  });

  it("'aggressive' strips at 20 lines where 'moderate' keeps", () => {
    const input = resultBlock("Read", 30);
    const aggressive = filterToolCalls(input, "aggressive");
    const moderate = filterToolCalls(input, "moderate");
    expect(aggressive.toolCallsStripped).toBe(1);
    expect(aggressive.filtered).toBe(
      "[tool_result: Read output, 30 lines, stripped]",
    );
    expect(moderate.toolCallsStripped).toBe(0);
    expect(moderate.filtered).toContain("line 29");
  });

  it("counts every stripped block accurately", () => {
    const input = [
      resultBlock("Bash", 100),
      resultBlock("Grep", 80),
      resultBlock("Bash", 5), // small — kept
      resultBlock("Glob", 60),
    ].join("\n\n");
    const res = filterToolCalls(input, "moderate");
    expect(res.toolCallsStripped).toBe(3);
  });

  it("estimates tokens with the chars/4 heuristic", () => {
    const input = "x".repeat(400);
    const res = filterToolCalls(input, "off");
    expect(res.originalTokens).toBe(100);
  });

  it("reports positive tokensSaved when output is stripped", () => {
    const input = resultBlock("Bash", 300);
    const res = filterToolCalls(input, "moderate");
    expect(res.tokensSaved).toBe(res.originalTokens - res.filteredTokens);
    expect(res.tokensSaved).toBeGreaterThan(0);
  });

  it("always preserves tool_use blocks, even next to a stripped result", () => {
    const use = renderToolUse("Bash", JSON.stringify({ command: "make all" }));
    const input = `${use}\n\n${resultBlock("Bash", 100)}`;
    for (const mode of ["moderate", "aggressive"] as const) {
      const res = filterToolCalls(input, mode);
      expect(res.filtered).toContain(use);
      expect(res.filtered).toContain('"command":"make all"');
    }
  });
});

describe("filterToolCalls tool_use payload bounding", () => {
  const useOf = (name: string, input: object): string =>
    renderToolUse(name, JSON.stringify(input));

  it("truncates a large Write content but keeps file_path intact", () => {
    const input = useOf("Write", {
      file_path: "/src/auth.ts",
      content: "x".repeat(5000),
    });
    const res = filterToolCalls(input, "moderate");
    expect(res.filtered).toContain('"file_path":"/src/auth.ts"');
    expect(res.filtered).toContain(
      "[truncated 5000 chars of content for Write]",
    );
    expect(res.filtered).not.toContain("xxxxx");
  });

  it("truncates a large Edit new_string but keeps file_path + small old_string", () => {
    const input = useOf("Edit", {
      file_path: "/a.ts",
      old_string: "small",
      new_string: "y".repeat(2000),
    });
    const res = filterToolCalls(input, "moderate");
    expect(res.filtered).toContain('"file_path":"/a.ts"');
    expect(res.filtered).toContain('"old_string":"small"');
    expect(res.filtered).toContain(
      "[truncated 2000 chars of new_string for Edit]",
    );
  });

  it("truncates each MultiEdit edit independently", () => {
    const input = useOf("MultiEdit", {
      file_path: "/m.ts",
      edits: [
        { old_string: "a", new_string: "z".repeat(1500) },
        { old_string: "b".repeat(1500), new_string: "c" },
      ],
    });
    const res = filterToolCalls(input, "moderate");
    expect(res.filtered).toContain(
      "[truncated 1500 chars of new_string for MultiEdit]",
    );
    expect(res.filtered).toContain(
      "[truncated 1500 chars of old_string for MultiEdit]",
    );
    expect(res.filtered).toContain('"old_string":"a"');
    expect(res.filtered).toContain('"new_string":"c"');
  });

  it("leaves a small Write unchanged", () => {
    const input = useOf("Write", {
      file_path: "/tiny.ts",
      content: "export const x = 1;",
    });
    const res = filterToolCalls(input, "moderate");
    expect(res.filtered).toBe(input);
    expect(res.filtered).not.toContain("truncated");
  });

  it("never touches tool_use for non-content tools (Read)", () => {
    const input = useOf("Read", { file_path: "/big.ts" });
    const res = filterToolCalls(input, "aggressive");
    expect(res.filtered).toBe(input);
  });

  it("'aggressive' uses tighter content thresholds than 'moderate'", () => {
    const input = useOf("Write", {
      file_path: "/f.ts",
      content: "q".repeat(1500),
    });
    expect(filterToolCalls(input, "moderate").filtered).toContain(
      '"content":"' + "q".repeat(1500),
    );
    expect(filterToolCalls(input, "aggressive").filtered).toContain(
      "[truncated 1500 chars of content for Write]",
    );
  });

  it("'off' truncates no tool_use payloads", () => {
    const input = useOf("Write", {
      file_path: "/f.ts",
      content: "x".repeat(5000),
    });
    const res = filterToolCalls(input, "off");
    expect(res.filtered).toBe(input);
  });
});

describe("filterToolCalls Skill result stripping", () => {
  function skillBlock(skillName: string, bodyLength: number): string {
    const useJson = JSON.stringify({ skill: skillName });
    const body = "s".repeat(bodyLength);
    return (
      renderToolUse("Skill", useJson) +
      "\n\n" +
      renderToolResult("Skill", body, false)
    );
  }

  it("moderate: strips an oversized Skill result and sets skillResultsStripped=1", () => {
    const input = skillBlock("superpowers:brainstorming", 1500);
    const res: FilterResult = filterToolCalls(input, "moderate");
    expect(res.skillResultsStripped).toBe(1);
    expect(res.filtered).toContain("[Skill superpowers:brainstorming loaded]");
    expect(res.filtered).not.toContain("ssss");
  });

  it("off: still strips an oversized Skill result (always runs regardless of mode)", () => {
    const input = skillBlock("superpowers:brainstorming", 1500);
    const res: FilterResult = filterToolCalls(input, "off");
    expect(res.skillResultsStripped).toBe(1);
    expect(res.filtered).toContain("[Skill superpowers:brainstorming loaded]");
    expect(res.filtered).not.toContain("ssss");
  });

  it("small Skill result (<=1000 chars): not stripped, body preserved", () => {
    const input = skillBlock("frontend-design:frontend-design", 500);
    const res: FilterResult = filterToolCalls(input, "moderate");
    expect(res.skillResultsStripped).toBe(0);
    // body content should still be present
    expect(res.filtered).toContain("s".repeat(10));
  });

  it("name fallback: empty input JSON {} with oversized body → placeholder uses 'skill'", () => {
    const use = renderToolUse("Skill", "{}");
    const body = "z".repeat(1500);
    const input = use + "\n\n" + renderToolResult("Skill", body, false);
    const res: FilterResult = filterToolCalls(input, "moderate");
    expect(res.skillResultsStripped).toBe(1);
    expect(res.filtered).toContain("[Skill skill loaded]");
  });

  it("Skill error result is left alone (ERROR tag breaks the match pattern)", () => {
    const useJson = JSON.stringify({ skill: "some-skill" });
    const use = renderToolUse("Skill", useJson);
    const body = "e".repeat(2000);
    const input = use + "\n\n" + renderToolResult("Skill", body, true);
    const res: FilterResult = filterToolCalls(input, "moderate");
    // error result must not be stripped
    expect(res.skillResultsStripped).toBe(0);
    expect(res.filtered).toContain("[tool_result: Skill ERROR]");
    expect(res.filtered).toContain("e".repeat(10));
  });

  it("Skill strip and normal large-Bash strip coexist in same transcript", () => {
    const useJson = JSON.stringify({ skill: "superpowers:brainstorming" });
    const skillInput =
      renderToolUse("Skill", useJson) +
      "\n\n" +
      renderToolResult("Skill", "s".repeat(1500), false);
    const bashInput = renderToolResult("Bash", "line\n".repeat(60), false);
    const input = skillInput + "\n\n" + bashInput;
    const res: FilterResult = filterToolCalls(input, "moderate");
    expect(res.skillResultsStripped).toBe(1);
    expect(res.toolCallsStripped).toBe(1);
    expect(res.filtered).toContain("[Skill superpowers:brainstorming loaded]");
    expect(res.filtered).toContain("Bash output");
    expect(res.filtered).toContain("stripped");
  });

  it("skillResultsStripped is 0 on the off path with a small Skill result", () => {
    const input = skillBlock("init", 200);
    const res: FilterResult = filterToolCalls(input, "off");
    expect(res.skillResultsStripped).toBe(0);
    expect(res.filtered).toContain("s".repeat(10));
  });
});
