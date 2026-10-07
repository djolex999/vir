import { describe, expect, it } from "vitest";
import { buildSources, scanLabel } from "./registry.js";

describe("scanLabel", () => {
  it("names every configured source", () => {
    expect(scanLabel(buildSources({ claudeProjectsDir: "/a" }))).toBe("scanning Claude Code");
    expect(scanLabel(buildSources({ claudeProjectsDir: "/a", codexSessionsDir: "/b" }))).toBe("scanning Claude Code + Codex");
  });
});
