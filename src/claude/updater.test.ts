import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPlan, VIR_END, VIR_START, type PlanItem } from "./updater.js";

const BLOCK = `${VIR_START}\nfresh vir content\n${VIR_END}`;

function plan(target: string): PlanItem {
  return {
    target,
    exists: true,
    hasBlock: true,
    lastUpdated: null,
    newBlock: BLOCK,
    diff: { added: 0, removed: 0 } as PlanItem["diff"],
    scope: "global",
  };
}

// applyPlan rewrites a file the user owns and edits by hand. Every case below
// is a file a human could plausibly produce, and the failure mode for three of
// them was silent destruction of their prose.
describe("applyPlan marker handling", () => {
  let dir: string;
  let target: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vir-claudemd-"));
    target = join(dir, "CLAUDE.md");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("replaces a well-formed block in place", () => {
    writeFileSync(target, `intro\n\n${VIR_START}\nold\n${VIR_END}\n\noutro\n`);

    expect(applyPlan(plan(target)).ok).toBe(true);

    const out = readFileSync(target, "utf8");
    expect(out).toContain("intro");
    expect(out).toContain("outro");
    expect(out).toContain("fresh vir content");
    expect(out).not.toContain("old");
  });

  it("appends when the file has no block at all", () => {
    writeFileSync(target, "just my notes\n");

    expect(applyPlan(plan(target)).ok).toBe(true);
    expect(readFileSync(target, "utf8")).toContain("fresh vir content");
  });

  it("refuses an orphan START rather than appending a second block", () => {
    // Appending here is what sets up the deletion: the NEXT sync would slice
    // from this orphan START to the appended block's END, taking the user's
    // prose in between with it.
    const before = `notes\n${VIR_START}\nhand-mangled\n\nmore of my prose\n`;
    writeFileSync(target, before);

    const result = applyPlan(plan(target));

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/marker/i);
    expect(readFileSync(target, "utf8")).toBe(before);
  });

  it("refuses when END comes before START instead of duplicating the gap", () => {
    const before = `notes\n${VIR_END}\nmy prose\n${VIR_START}\ntail\n`;
    writeFileSync(target, before);

    const result = applyPlan(plan(target));

    expect(result.ok).toBe(false);
    expect(readFileSync(target, "utf8")).toBe(before);
  });

  it("collapses duplicate blocks instead of leaving the second behind", () => {
    writeFileSync(
      target,
      `top\n${VIR_START}\nfirst\n${VIR_END}\nmiddle\n${VIR_START}\nsecond\n${VIR_END}\nend\n`,
    );

    expect(applyPlan(plan(target)).ok).toBe(true);

    const out = readFileSync(target, "utf8");
    expect(out.match(new RegExp(VIR_START, "g"))).toHaveLength(1);
    expect(out).toContain("top");
    expect(out).toContain("middle");
    expect(out).toContain("end");
    expect(out).not.toContain("second");
  });

  it("ignores markers inside a fenced code block", () => {
    // A CLAUDE.md that documents vir's own markers must not be edited at them.
    const before = [
      "here is how vir marks its block:",
      "",
      "```markdown",
      VIR_START,
      "example",
      VIR_END,
      "```",
      "",
    ].join("\n");
    writeFileSync(target, before);

    expect(applyPlan(plan(target)).ok).toBe(true);

    const out = readFileSync(target, "utf8");
    expect(out).toContain("```markdown");
    expect(out).toContain("example");
    expect(out).toContain("fresh vir content");
    // The fenced example survives untouched and the real block was appended.
    expect(out.indexOf("fresh vir content")).toBeGreaterThan(out.indexOf("```"));
  });
});
