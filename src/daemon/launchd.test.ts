import { describe, expect, it } from "vitest";
import { renderPlist } from "./launchd.js";

describe("renderPlist", () => {
  const opts = {
    nodePath: "/usr/local/bin/node",
    cliPath: "/x/dist/cli.js",
    intervalSeconds: 14400,
    logPath: "/x/daemon.log",
  };

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
