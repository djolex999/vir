import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyDeadLink, deadLinkCheck, dropRemovedLinks, fixDeadLinks, repairRelated, type DeadLink } from "./deadLinks.js";

let vault: string;
const cfg = (): { vaultPath: string; outputDir: string } => ({ vaultPath: vault, outputDir: "vir" });
const put = (rel: string, text: string): void => {
  const full = join(vault, "vir", rel);
  mkdirSync(full.slice(0, full.lastIndexOf("/")), { recursive: true });
  writeFileSync(full, text);
};
const note = (topic: string, related: string[], extra = ""): string =>
  `---\ntopic: "${topic}"\naliases:\n  - "${topic}"\n---\nProject: [[growthq]]\nCategory: [[pattern]]\n\n## Summary\nx${extra}\n\n## Related\n\n${related.map((r) => `- ${r}`).join("\n")}\n`;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "vir-deadlinks-"));
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("classifyDeadLink", () => {
  const live = new Map([
    ["aaaa1111", ["new-title-aaaa1111"]],
    ["bbbb2222", ["one-bbbb2222", "two-bbbb2222"]],
  ]);
  it("repoints when exactly one live note shares the session suffix", () => {
    expect(classifyDeadLink("old-title-aaaa1111", live)).toEqual({ kind: "retitled", replacement: "new-title-aaaa1111" });
  });
  it("calls it removed when no live note has the suffix", () => {
    expect(classifyDeadLink("gone-cccc3333", live).kind).toBe("removed");
  });
  it("leaves ambiguous and suffix-less targets unknown", () => {
    expect(classifyDeadLink("x-bbbb2222", live).kind).toBe("unknown");
    expect(classifyDeadLink("codemap", live).kind).toBe("unknown");
  });
});

describe("deadLinkCheck", () => {
  it("finds retitled and removed targets, and skips hubs, aliases, live notes and code", () => {
    put("patterns/new-title-aaaa1111.md", note("new-title", []));
    put(".rejected/gone-cccc3333.md", note("gone", []));
    put("patterns/linker-dddd4444.md",
      note("linker", [
        "[[old-title-aaaa1111|old-title]]",
        "[[gone-cccc3333|gone]]",
        "[[new-title-aaaa1111|new-title]]",
        "[[new-title]]",
      ], "\n```\n[[inside-code-eeee5555]]\n```"),
    );

    const r = deadLinkCheck(cfg());

    expect(r.dead.map((d) => [d.target, d.kind])).toEqual([
      ["old-title-aaaa1111", "retitled"],
      ["gone-cccc3333", "removed"],
    ]);
    expect(r.dead[0]?.replacement).toBe("new-title-aaaa1111");
  });

  it("resolves a link to a file elsewhere in the Obsidian vault", () => {
    writeFileSync(join(vault, "my-own-note.md"), "mine");
    put("patterns/linker-dddd4444.md", note("linker", ["[[my-own-note]]"]));
    expect(deadLinkCheck(cfg()).dead).toEqual([]);
  });
});

describe("dropRemovedLinks", () => {
  const dead = (line: number, target: string, kind: DeadLink["kind"]): DeadLink =>
    ({ relPath: "p.md", line, target, kind, replacement: null });

  it("drops bullets whose target is gone and never touches retitled or unknown links", () => {
    const text = [
      "## Related",
      "",
      "- [[old-title-aaaa1111|old-title]]",
      "- [[gone-cccc3333|gone]]",
      "- [[codemap]]",
    ].join("\n");
    const r = dropRemovedLinks(text, [
      dead(3, "old-title-aaaa1111", "retitled"),
      dead(4, "gone-cccc3333", "removed"),
      dead(5, "codemap", "unknown"),
    ]);
    expect(r.text).toBe(["## Related", "", "- [[old-title-aaaa1111|old-title]]", "- [[codemap]]"].join("\n"));
    expect(r.removed).toBe(1);
  });

  it("turns an inline removed link into its label", () => {
    const r = dropRemovedLinks("See [[gone-cccc3333|the gone note]] for why.", [dead(1, "gone-cccc3333", "removed")]);
    expect(r.text).toBe("See the gone note for why.");
  });
});

describe("repairRelated", () => {
  const dead = (line: number, target: string, kind: DeadLink["kind"]): DeadLink =>
    ({ relPath: "p.md", line, target, kind, replacement: null });
  const text = [
    "## Summary",
    "See [[gone-cccc3333|the gone note]].",
    "",
    "## Related",
    "",
    "- [[live-one-aaaa1111|live-one]]",
    "- [[old-title-bbbb2222|old-title]]",
    "- [[gone-cccc3333|gone]]",
  ].join("\n");

  it("keeps live links, drops dead bullets, and fills their slots with new neighbors", () => {
    const r = repairRelated(
      text,
      [dead(2, "gone-cccc3333", "removed"), dead(7, "old-title-bbbb2222", "retitled"), dead(8, "gone-cccc3333", "removed")],
      "self-dddd4444",
      [
        { slug: "live-one-aaaa1111", topic: "live-one" },
        { slug: "self-dddd4444", topic: "self" },
        { slug: "near-eeee5555", topic: "near" },
        { slug: "nearer-ffff6666", topic: "nearer" },
        { slug: "third-11112222", topic: "third" },
      ],
    );
    expect(r.text).toBe([
      "## Summary",
      "See the gone note.",
      "",
      "## Related",
      "",
      "- [[live-one-aaaa1111|live-one]]",
      "- [[near-eeee5555|near]]",
      "- [[nearer-ffff6666|nearer]]",
    ].join("\n"));
    expect(r).toMatchObject({ removed: 3, added: 2 });
  });

  it("still drops dead bullets when there are no neighbors to add", () => {
    const r = repairRelated(text, [dead(8, "gone-cccc3333", "removed")], "self-dddd4444", []);
    expect(r.text.endsWith("- [[old-title-bbbb2222|old-title]]")).toBe(true);
    expect(r).toMatchObject({ removed: 1, added: 0 });
  });
});

describe("fixDeadLinks", () => {
  it("repairs session notes in place, drops gone links elsewhere, and reports what is left", async () => {
    put("patterns/new-title-aaaa1111.md", note("new-title", []));
    put("patterns/linker-dddd4444.md", note("linker", ["[[new-title-aaaa1111|new-title]]", "[[old-title-aaaa1111|old-title]]"]));
    put("topics/auth.md", "# auth\n\n- [[gone-cccc3333|gone]]\n- [[codemap]]\n");
    put("patterns/near-eeee5555.md", note("near", []));
    const asked: string[] = [];

    const s = await fixDeadLinks(cfg(), deadLinkCheck(cfg()), (rel) => {
      asked.push(rel);
      return [{ slug: "near-eeee5555", topic: "near" }];
    });

    expect(asked).toEqual(["patterns/linker-dddd4444.md"]);
    const linker = readFileSync(join(vault, "vir/patterns/linker-dddd4444.md"), "utf8");
    expect(linker).toContain("- [[new-title-aaaa1111|new-title]]\n- [[near-eeee5555|near]]");
    expect(linker).not.toContain("old-title");
    expect(readFileSync(join(vault, "vir/topics/auth.md"), "utf8")).toBe("# auth\n\n- [[codemap]]\n");
    // codemap in a topic page has no session id: reported, never guessed at.
    expect(s).toEqual({ repaired: 1, removed: 2, added: 1, left: 1 });
  });
});
