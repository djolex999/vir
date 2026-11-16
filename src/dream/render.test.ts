import { describe, expect, it } from "vitest";
import { renderBody, renderDreamFile } from "./render.js";
import type { DreamEntry, DreamPage, DreamStats } from "./validate.js";

const entry = (over: Partial<DreamEntry>): DreamEntry => ({
  claim: "Use npm ci --include=dev on Render",
  source: 1,
  quote: "npm ci --include=dev",
  kind: "rule",
  also: [],
  confirmed: false,
  ref: "gotchas/render-build-aaaa1111",
  alsoRefs: [],
  surfaced: 0,
  ...over,
});

const page: DreamPage = {
  overview: "A Serbian exam-prep SaaS.",
  sections: [
    {
      heading: "Deploy",
      entries: [
        entry({}),
        entry({ claim: "Delete empty env vars", ref: "gotchas/env-bbbb2222", confirmed: true, surfaced: 3, kind: "trap", alsoRefs: ["gotchas/env2-cccc3333"] }),
      ],
    },
    { heading: "Payments", entries: [entry({ claim: "Tax mode is baked into a price", ref: "decisions/tax-dddd4444", kind: "decision" })] },
  ],
  conflicts: [],
  gaps: [],
};
const stats: DreamStats = { kept: 3, dropped: 1, cut: 0, cited: 4, coverage: 0.5, confirmed: 1, ratio: 0.123456 };
const file = (over: Partial<Parameters<typeof renderDreamFile>[0]> = {}): string =>
  renderDreamFile({
    projectSlug: "pripremi-rs",
    page,
    stats,
    notes: 8,
    sessions: 6,
    inputHash: "abc",
    model: "claude-sonnet-5",
    generated: "2026-11-16T10:00:00.000Z",
    existingChangelog: ["- 2026-06-30: 78 sessions, 22 patterns, 32 gotchas, 22 decisions, 2 tools"],
    ...over,
  });

describe("renderBody", () => {
  it("every entry line has a wikilink and a label", () => {
    const lines = renderBody(page).split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(3);
    for (const l of lines) {
      expect(l).toMatch(/\[\[[^\]]+\]\]/);
      expect(l).toMatch(/· (confirmed|unconfirmed)/);
    }
  });

  it("puts confirmed entries first and shows retrieval counts", () => {
    const deploy = renderBody(page).split("## Deploy")[1] ?? "";
    expect(deploy.indexOf("Delete empty env vars")).toBeLessThan(deploy.indexOf("Use npm ci"));
    expect(deploy).toContain("retrieved 3×");
    expect(deploy).not.toContain("retrieved 0×");
  });

  it("omits Needs review and Gaps when empty, and lists them when present", () => {
    expect(renderBody(page)).not.toContain("## Needs review");
    expect(renderBody(page)).not.toContain("## Gaps");
    const full = renderBody({
      ...page,
      conflicts: [{ a: "gotchas/a-11111111", b: "gotchas/b-22222222", about: "which port" }],
      gaps: ["No note on backups"],
    });
    expect(full).toContain("## Needs review\n\n- [[gotchas/a-11111111]] and [[gotchas/b-22222222]] disagree: which port");
    expect(full).toContain("## Gaps\n\n- No note on backups");
  });

  it("matches the snapshot", () => {
    expect(renderBody(page)).toMatchSnapshot();
  });
});

describe("renderDreamFile", () => {
  it("frontmatter has the keys in order", () => {
    const fm = file().split("---\n")[1] ?? "";
    expect(fm.split("\n").filter(Boolean).map((l) => l.split(":")[0])).toEqual([
      "project", "generated", "sessions", "kind", "input_hash", "notes", "entries", "confirmed", "ratio", "model",
    ]);
    expect(fm).toContain("kind: dream\n");
    expect(fm).toContain("ratio: 0.12\n");
  });

  it("keeps old changelog lines and prepends today's dream line", () => {
    const out = file();
    expect(out).toContain(
      "## Changelog\n- 2026-11-16: dream, 8 notes, 3 entries (1 confirmed)\n- 2026-06-30: 78 sessions",
    );
    expect(out).toContain("Project: [[pripremi-rs]]");
  });
});
