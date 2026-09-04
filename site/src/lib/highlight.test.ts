import { describe, expect, it } from "vitest";
import { highlightNote } from "./highlight";

describe("highlightNote", () => {
  it("escapes html first", () => {
    expect(highlightNote("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
  });
  it("wraps frontmatter keys only inside the frontmatter block", () => {
    const out = highlightNote("---\ntopic: \"x\"\n---\nbody topic: not a key");
    expect(out).toContain('<span class="fm-key">topic</span>: &quot;x&quot;');
    expect(out).toContain("body topic: not a key");
    expect(out.match(/fm-key/g)?.length).toBe(1);
  });
  it("wraps wikilinks", () => {
    expect(highlightNote("see [[growthq]] now")).toBe(
      'see <span class="wikilink">[[growthq]]</span> now',
    );
  });
  it("wraps markdown headings", () => {
    expect(highlightNote("## Related\n- x")).toBe('<span class="heading">## Related</span>\n- x');
  });
  it("marks the frontmatter fences", () => {
    const out = highlightNote("---\na: 1\n---\n");
    expect(out.match(/<span class="fence">---<\/span>/g)?.length).toBe(2);
  });
});
