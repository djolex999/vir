import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectClaudePath } from "./updater.js";

let home: string;
let prevHome: string | undefined;

function claudeMd(...parts: string[]): string {
  const dir = join(home, ...parts);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "CLAUDE.md");
  writeFileSync(p, "# x\n");
  return p;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "vir-projpath-"));
  prevHome = process.env.HOME;
  process.env.HOME = home;
});
afterEach(() => {
  process.env.HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe("projectClaudePath", () => {
  it("finds a project whose folder name slugs to the project slug (pripremi.rs → pripremi-rs)", () => {
    const p = claudeMd("projects", "pripremi.rs");
    expect(projectClaudePath("pripremi-rs")).toBe(p);
  });

  it("matches slugged names under ~/code and ~/dev too", () => {
    const p = claudeMd("code", "My App");
    expect(projectClaudePath("my-app")).toBe(p);
  });

  it("still prefers the exact canonical folder", () => {
    claudeMd("projects", "pripremi.rs");
    const exact = claudeMd("projects", "pripremi-rs");
    expect(projectClaudePath("pripremi-rs")).toBe(exact);
  });

  it("keeps the suffixed-folder match (<slug>-web)", () => {
    const p = claudeMd("projects", "growthq-web");
    expect(projectClaudePath("growthq")).toBe(p);
  });

  it("falls back to the canonical path when nothing exists", () => {
    expect(projectClaudePath("nope")).toBe(join(home, "projects", "nope", "CLAUDE.md"));
  });
});
