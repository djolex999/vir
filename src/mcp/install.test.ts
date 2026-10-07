import { describe, expect, it } from "vitest";
import { codexInstallSnippet, installToCodex } from "./install.js";

describe("vir mcp install --target codex", () => {
  it("prints the Codex MCP config without touching any file", () => {
    const out: string[] = [];
    installToCodex((s) => out.push(s));
    const text = out.join("\n");
    expect(text).toContain('[mcp_servers.vir]\ncommand = "vir"\nargs = ["mcp"]');
    expect(text).toContain("~/.codex/config.toml");
  });

  // Verified 2026-10-07 (codex-cli 0.160.1): writes exactly the block above.
  it("offers Codex's own CLI as the one-liner", () => {
    expect(codexInstallSnippet()).toContain("codex mcp add vir -- vir mcp");
    expect(codexInstallSnippet()).not.toMatch(/unverified/i);
  });
});
