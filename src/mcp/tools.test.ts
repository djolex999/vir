import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readVirVersion } from "../version.js";
import { VIR_TOOLS } from "./tools.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("MCP tool advertisement", () => {
  // `vir mcp install` printed a hardcoded list that had drifted two tools
  // behind the server. Pin the two together against the source of truth so a
  // new tool can't ship half-announced.
  it("advertises exactly the tools the server registers", () => {
    const src = readFileSync(join(here, "server.ts"), "utf8");
    const registered = [
      ...src.matchAll(/registerTool\(\s*"(vir_[a-z_]+)"/g),
    ].map((m) => m[1]!);

    expect(registered.length).toBeGreaterThan(0);
    expect([...registered].sort()).toEqual([...VIR_TOOLS].sort());
  });
});

describe("readVirVersion", () => {
  it("is what the MCP server reports to clients", () => {
    const src = readFileSync(join(here, "server.ts"), "utf8");
    const init = src.match(/new McpServer\(\{[^}]*\}\)/)?.[0] ?? "";
    expect(init).toContain("readVirVersion()");
    expect(init).not.toMatch(/version:\s*"/);
  });

  it("reports the package version rather than a hardcoded one", () => {
    const pkg = JSON.parse(
      readFileSync(join(here, "..", "..", "package.json"), "utf8"),
    ) as { version: string };
    expect(readVirVersion()).toBe(pkg.version);
  });
});
