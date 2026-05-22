/**
 * Registers/unregisters the `vir` MCP server with the Claude Code CLI by
 * shelling out to `claude mcp add|remove|list`. Thin wrapper — Claude Code
 * owns the actual config file; we never write it directly.
 *
 * All output goes through ui/display.ts. spawnSync is always called with an
 * argument array (never a shell string), so server names/paths can't be
 * interpreted by a shell.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import * as ui from "../ui/display.js";

const TOOLS = [
  "vir_query",
  "vir_status",
  "vir_recent_notes",
  "vir_project_summary",
] as const;

function runClaude(args: string[]): SpawnSyncReturns<string> {
  return spawnSync("claude", args, { encoding: "utf8" });
}

// spawnSync sets `.error` with code ENOENT when the binary isn't on PATH.
function claudeMissing(res: SpawnSyncReturns<string>): boolean {
  const err = res.error as NodeJS.ErrnoException | undefined;
  return err?.code === "ENOENT";
}

function printClaudeMissing(): void {
  ui.row(ui.errorColor(ui.CROSS), ui.text("Claude Code CLI not found"));
  ui.line(
    ui.dim("  Install Claude Code first: ") +
      ui.info("https://claude.com/claude-code"),
  );
  ui.line(ui.dim("  Then run: ") + ui.text("vir mcp install"));
}

// True if the `claude` binary is on PATH at all — used by the status command
// to distinguish "not registered" from "CLI not installed" without throwing.
export async function isClaudeAvailable(): Promise<boolean> {
  return !claudeMissing(runClaude(["--version"]));
}

export async function installToClaudeCode(
  scope: "user" | "project" = "user",
): Promise<void> {
  if (scope !== "user" && scope !== "project") {
    ui.row(
      ui.errorColor(ui.CROSS),
      ui.text(`invalid scope '${scope}' — use 'user' or 'project'`),
    );
    return;
  }

  // claude mcp add --scope <scope> <name> <command> [args...]
  const res = runClaude(["mcp", "add", "--scope", scope, "vir", "vir", "mcp"]);
  if (claudeMissing(res)) {
    printClaudeMissing();
    return;
  }
  if ((res.status ?? -1) !== 0) {
    ui.row(
      ui.errorColor(ui.CROSS),
      ui.text("failed to register with Claude Code"),
    );
    const msg = (res.stderr || res.stdout || "").trim();
    if (msg) ui.line(ui.dim("  " + msg.split("\n").join("\n  ")));
    return;
  }

  ui.row(
    ui.success(ui.CHECK),
    ui.text(`registered with Claude Code (scope: ${scope})`),
  );
  ui.blank();
  ui.line(ui.dim("Restart Claude Code to start using these tools:"));
  for (const t of TOOLS) {
    ui.line(`  ${ui.dim(ui.BULLET)} ${ui.text(t)}`);
  }
}

export async function uninstallFromClaudeCode(): Promise<void> {
  const res = runClaude(["mcp", "remove", "vir"]);
  if (claudeMissing(res)) {
    printClaudeMissing();
    return;
  }
  if ((res.status ?? -1) !== 0) {
    // `remove` fails when it was never registered — report, don't crash.
    const msg = (res.stderr || res.stdout || "").trim();
    ui.row(
      ui.warn(ui.WARN_GLYPH),
      ui.text("could not unregister"),
      msg || undefined,
    );
    return;
  }
  ui.row(ui.success(ui.CHECK), ui.text("unregistered from Claude Code"));
}

export async function isInstalled(): Promise<boolean> {
  const res = runClaude(["mcp", "list"]);
  if (claudeMissing(res) || (res.status ?? -1) !== 0) return false;
  // `claude mcp list` prints one server per line as "<name>: <command> ...".
  // Match the `vir` entry on a word boundary so "virtual-x" wouldn't match.
  return /^\s*vir\b/m.test(res.stdout ?? "");
}
