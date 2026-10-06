import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INSIGHTS_RULES_DIR, insightSlug, parseRuleEdit, renderInsight, writeInsightFile } from "./insightFile.js";
import { sampleInsight } from "./testFixtures.js";

describe("insight files", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "vir-insight-")); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("builds a slug from the rule plus the id prefix", () => {
    expect(insightSlug("Use proxy.ts in Next 16!", "3f9a1c2e-xx")).toBe("use-proxy-ts-in-next-16-3f9a1c2e");
    expect(insightSlug("x".repeat(200), "abcdef12").length).toBeLessThanOrEqual(69);
  });

  it("renders frontmatter, rule, why and evidence", () => {
    const md = renderInsight(sampleInsight());
    expect(md).toMatch(/^---\ntype: insight\n/);
    expect(md).toContain("status: proposed");
    expect(md).toContain("promotion: none");
    expect(md).toContain("verified: false");
    expect(md).toContain('  - "[[note-a]]"');
    expect(md).toContain("**Rule:** Use proxy.ts in Next 16");
    expect(md).toContain("**Why:** middleware.ts is deprecated and warns.");
    expect(md).toContain('- [[note-a]] (growthq, 2026-06-02): "renames middleware"');
    expect(renderInsight(sampleInsight({ status: "accepted" }))).toContain("verified: true");
  });

  it("round-trips rule and why through an edit", () => {
    const md = renderInsight(sampleInsight());
    expect(parseRuleEdit(md)).toEqual({ rule: "Use proxy.ts in Next 16", why: "middleware.ts is deprecated and warns." });
    const edited = md.replace("**Rule:** Use proxy.ts in Next 16", "**Rule:** Always use proxy.ts on Next 16+");
    expect(parseRuleEdit(edited)?.rule).toBe("Always use proxy.ts on Next 16+");
    expect(parseRuleEdit(md.replace(/\*\*Rule:\*\*.*\n/, ""))).toBeNull();
  });

  it("writes atomically and overwrites in place", () => {
    const p1 = writeInsightFile(root, sampleInsight());
    expect(p1).toBe(join(root, INSIGHTS_RULES_DIR, "use-proxy-ts-in-next-16-3f9a1c2e.md"));
    const p2 = writeInsightFile(root, sampleInsight({ status: "accepted" }));
    expect(p2).toBe(p1);
    expect(readFileSync(p1, "utf8")).toContain("status: accepted");
    expect(readdirSync(join(root, INSIGHTS_RULES_DIR))).toEqual(["use-proxy-ts-in-next-16-3f9a1c2e.md"]);
    expect(existsSync(`${p1}.tmp`)).toBe(false);
  });
});

describe("parseRuleEdit sanitizes owner edits", () => {
  it("drops control characters from an edited rule", () => {
    expect(parseRuleEdit("**Rule:** keep \x1b[31mthis\n**Why:** w‮")?.rule).toBe("keep [31mthis");
  });
});
