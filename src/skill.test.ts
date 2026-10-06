import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// skills/vir/SKILL.md tells other agents which vir commands, flags and MCP
// tools to use. A renamed flag would silently break every installed copy, so
// pin each reference to the real CLI and MCP definitions.
const ROOT = join(import.meta.dirname, "..");
const skill = readFileSync(join(ROOT, "skills", "vir", "SKILL.md"), "utf8");
const cliSource = readFileSync(join(ROOT, "src", "cli.ts"), "utf8");
const mcpSource = readFileSync(join(ROOT, "src", "mcp", "server.ts"), "utf8");

// Text of one top-level command's definition: from its .command("name…") to
// the next .command( call.
function commandBlock(name: string): string | null {
  const start = cliSource.search(new RegExp(`\\.command\\("${name}[ "]`));
  if (start === -1) return null;
  const next = cliSource.indexOf(".command(", start + 1);
  return cliSource.slice(start, next === -1 ? undefined : next);
}

// Every `vir <command> …` invocation inside inline code or code fences (prose
// like "if vir is installed" is not an invocation).
function codeSegments(): string[] {
  const fences = [...skill.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
  const withoutFences = skill.replace(/```[\s\S]*?```/g, "");
  const inline = [...withoutFences.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] ?? "");
  return [...fences, ...inline];
}

function invocations(): Array<{ command: string; flags: string[]; text: string }> {
  const out: Array<{ command: string; flags: string[]; text: string }> = [];
  const code = codeSegments().join("\n");
  for (const m of code.matchAll(/(?:^|[\s;&|(])vir ([a-z][a-z-]*)([^\n;&|]*)/gm)) {
    const command = m[1] ?? "";
    const rest = m[2] ?? "";
    const flags = [...rest.matchAll(/(?:^|\s)(--[a-z][a-z-]*)/g)].map((f) => f[1] ?? "");
    out.push({ command, flags, text: `vir ${command}${rest}` });
  }
  return out;
}

describe("skills/vir/SKILL.md", () => {
  it("has the frontmatter `npx skills add` requires", () => {
    const fm = skill.match(/^---\n([\s\S]*?)\n---\n/);
    expect(fm).not.toBeNull();
    expect(fm?.[1]).toMatch(/^name: vir$/m);
    expect(fm?.[1]).toMatch(/^description: .{40,}/m);
  });

  it("references at least the query command", () => {
    expect(invocations().some((i) => i.command === "query")).toBe(true);
  });

  it("only names vir commands and flags the CLI defines", () => {
    for (const inv of invocations()) {
      const block = commandBlock(inv.command);
      expect(block, `unknown command in: ${inv.text}`).not.toBeNull();
      for (const flag of inv.flags) {
        expect(block, `unknown flag ${flag} in: ${inv.text}`).toContain(`"${flag}`);
      }
    }
  });

  it("only names MCP tools the server registers", () => {
    const tools = [...new Set([...skill.matchAll(/\bvir_[a-z_]+\b/g)].map((m) => m[0]))];
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(mcpSource, `unknown MCP tool ${tool}`).toContain(`"${tool}"`);
    }
  });
});
