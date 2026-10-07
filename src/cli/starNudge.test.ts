import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { maybeShowStarNudge, shouldShowStarNudge } from "./starNudge.js";

const base = { interactive: true, distilled: 3, failed: false, markerExists: false };

describe("star nudge", () => {
  it("shows after an interactive run that wrote notes", () => {
    expect(shouldShowStarNudge(base)).toBe(true);
  });

  it("stays quiet for non-interactive, empty, failed, or already-shown runs", () => {
    expect(shouldShowStarNudge({ ...base, interactive: false })).toBe(false);
    expect(shouldShowStarNudge({ ...base, distilled: 0 })).toBe(false);
    expect(shouldShowStarNudge({ ...base, failed: true })).toBe(false);
    expect(shouldShowStarNudge({ ...base, markerExists: true })).toBe(false);
  });

  it("prints once, then the marker suppresses it", () => {
    const marker = join(mkdtempSync(join(tmpdir(), "vir-nudge-")), "first-run-nudge");
    const lines: string[] = [];
    const ctx = { interactive: true, distilled: 2, failed: false };
    maybeShowStarNudge(ctx, (l) => lines.push(l), marker);
    maybeShowStarNudge(ctx, (l) => lines.push(l), marker);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("github.com/djolex999/vir");
    expect(existsSync(marker)).toBe(true);
  });

  it("does not write the marker when it did not print", () => {
    const marker = join(mkdtempSync(join(tmpdir(), "vir-nudge-")), "first-run-nudge");
    maybeShowStarNudge({ interactive: true, distilled: 0, failed: false }, () => {}, marker);
    expect(existsSync(marker)).toBe(false);
  });
});
