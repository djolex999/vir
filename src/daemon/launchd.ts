import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DAEMON_LOG_PATH } from "../config.js";

export const LABEL = "lab.growthq.vir";
const LAUNCH_AGENTS_DIR = join(homedir(), "Library", "LaunchAgents");
const PLIST_PATH = join(LAUNCH_AGENTS_DIR, `${LABEL}.plist`);

export function plistPath(): string {
  return PLIST_PATH;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function renderPlist(opts: {
  nodePath: string;
  cliPath: string;
  intervalSeconds: number;
  logPath: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(opts.nodePath)}</string>
    <string>${escapeXml(opts.cliPath)}</string>
    <string>run</string>
    <string>--daemon</string>
  </array>
  <key>StartInterval</key>
  <integer>${opts.intervalSeconds}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(opts.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(opts.logPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
`;
}

function launchctl(args: string[]): { code: number; stderr: string } {
  const res = spawnSync("launchctl", args, { encoding: "utf8" });
  return { code: res.status ?? -1, stderr: res.stderr ?? "" };
}

export function installPlist(opts: {
  nodePath: string;
  cliPath: string;
  cadenceHours: number;
}): { plistPath: string; loaded: boolean } {
  if (!existsSync(LAUNCH_AGENTS_DIR)) {
    mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
  }
  const logDir = dirname(DAEMON_LOG_PATH);
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

  const xml = renderPlist({
    nodePath: opts.nodePath,
    cliPath: opts.cliPath,
    intervalSeconds: Math.max(60, Math.round(opts.cadenceHours * 3600)),
    logPath: DAEMON_LOG_PATH,
  });

  writeFileSync(PLIST_PATH, xml);

  // unload first in case it exists; ignore failure
  launchctl(["unload", PLIST_PATH]);
  const loadRes = launchctl(["load", PLIST_PATH]);
  if (loadRes.code !== 0) {
    throw new Error(`launchctl load failed: ${loadRes.stderr.trim()}`);
  }

  return { plistPath: PLIST_PATH, loaded: true };
}

export function uninstallPlist(): { removed: boolean } {
  if (!existsSync(PLIST_PATH)) return { removed: false };
  launchctl(["unload", PLIST_PATH]);
  unlinkSync(PLIST_PATH);
  return { removed: true };
}

export function daemonStatus(): {
  installed: boolean;
  loaded: boolean;
  plistPath: string;
} {
  const installed = existsSync(PLIST_PATH);
  let loaded = false;
  const res = spawnSync("launchctl", ["list"], { encoding: "utf8" });
  if (res.status === 0 && typeof res.stdout === "string") {
    loaded = res.stdout.includes(LABEL);
  }
  return { installed, loaded, plistPath: PLIST_PATH };
}
