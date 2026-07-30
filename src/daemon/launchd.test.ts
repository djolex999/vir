import { describe, expect, it, vi } from "vitest";
import {
  LABEL,
  migrateOldLabels,
  PREVIOUS_LABELS,
  renderPlist,
  stalePlists,
} from "./launchd.js";

describe("renderPlist", () => {
  const opts = {
    nodePath: "/usr/local/bin/node",
    cliPath: "/x/dist/cli.js",
    intervalSeconds: 14400,
    logPath: "/x/daemon.log",
  };

  it("uses the current label", () => {
    expect(LABEL).toBe("com.github.djolex999.vir");
    expect(renderPlist(opts)).toContain(
      "<string>com.github.djolex999.vir</string>",
    );
  });

  it("sets RunAtLoad false — installing a schedule must not start a paid job", () => {
    const xml = renderPlist(opts);
    const m = xml.match(/<key>RunAtLoad<\/key>\s*<(true|false)\/>/);
    expect(m?.[1]).toBe("false");
  });

  it("keeps the StartInterval cadence", () => {
    expect(renderPlist(opts)).toContain(
      "<key>StartInterval</key>\n  <integer>14400</integer>",
    );
  });
});

describe("label migration", () => {
  it("PREVIOUS_LABELS records the pre-rename label", () => {
    expect(PREVIOUS_LABELS).toContain("lab.growthq.vir");
  });

  it("stalePlists reports a previous-label plist that exists on disk", () => {
    const exists = (p: string) => p.includes("lab.growthq.vir");
    const stale = stalePlists(exists);
    expect(stale).toHaveLength(1);
    expect(stale[0]?.label).toBe("lab.growthq.vir");
    expect(stale[0]?.path).toContain("lab.growthq.vir.plist");
  });

  it("stalePlists is empty when no old plist is present", () => {
    expect(stalePlists(() => false)).toEqual([]);
  });

  it("migrateOldLabels unloads and removes every stale plist — including the two-plists-both-loaded case a rename creates", () => {
    const unload = vi.fn();
    const remove = vi.fn();
    // Simulate a machine that went through TWO renames: both old plists on
    // disk, both potentially loaded. Install must leave neither behind, or
    // launchd runs the paid job twice per interval.
    const stale = [
      { label: "lab.growthq.vir", path: "/LA/lab.growthq.vir.plist" },
      { label: "org.old.vir", path: "/LA/org.old.vir.plist" },
    ];
    const removed = migrateOldLabels({ stale, unload, remove });
    expect(unload.mock.calls.map((c) => c[0])).toEqual([
      "/LA/lab.growthq.vir.plist",
      "/LA/org.old.vir.plist",
    ]);
    expect(remove.mock.calls.map((c) => c[0])).toEqual([
      "/LA/lab.growthq.vir.plist",
      "/LA/org.old.vir.plist",
    ]);
    expect(removed).toEqual(["lab.growthq.vir", "org.old.vir"]);
  });

  it("migrateOldLabels is a no-op when nothing is stale", () => {
    const unload = vi.fn();
    const remove = vi.fn();
    expect(migrateOldLabels({ stale: [], unload, remove })).toEqual([]);
    expect(unload).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});
