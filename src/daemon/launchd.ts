import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DAEMON_LOG_PATH } from "../config.js";

export const LABEL = "com.github.djolex999.vir";
// Every label this daemon has ever shipped under. `vir schedule install`
// unloads + removes any of these it finds before writing the current plist —
// otherwise a rename leaves TWO loaded jobs running the paid pipeline every
// interval. A future rename is one line here (append the outgoing LABEL) plus
// the LABEL change above.
export const PREVIOUS_LABELS: readonly string[] = ["lab.growthq.vir"];
const LAUNCH_AGENTS_DIR = join(homedir(), "Library", "LaunchAgents");
const PLIST_PATH = join(LAUNCH_AGENTS_DIR, `${LABEL}.plist`);

function labelPlistPath(label: string): string {
  return join(LAUNCH_AGENTS_DIR, `${label}.plist`);
}

export interface StalePlist {
  label: string;
  path: string;
}

export function stalePlists(
  exists: (p: string) => boolean = existsSync,
): StalePlist[] {
  return PREVIOUS_LABELS.map((label) => ({
    label,
    path: labelPlistPath(label),
  })).filter((s) => exists(s.path));
}

// Unload + remove every previous-label plist. unload is best-effort per item
// (an on-disk-but-never-loaded plist makes launchctl unload fail — that must
// not keep the file around); remove is what actually prevents the
// double-loaded state.
export function migrateOldLabels(
  deps: {
    stale?: StalePlist[];
    unload?: (path: string) => void;
    remove?: (path: string) => void;
  } = {},
): string[] {
  const stale = deps.stale ?? stalePlists();
  const unload = deps.unload ?? ((p: string) => void launchctl(["unload", p]));
  const remove = deps.remove ?? unlinkSync;
  const removed: string[] = [];
  for (const s of stale) {
    try {
      unload(s.path);
    } catch {
      // not loaded — still remove the file
    }
    remove(s.path);
    removed.push(s.label);
  }
  return removed;
}

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
  <false/>
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

  // A label rename must not leave the old job loaded alongside the new one.
  migrateOldLabels();

  writeFileSync(PLIST_PATH, xml);

  // unload first in case it exists; ignore failure
  launchctl(["unload", PLIST_PATH]);
  const loadRes = launchctl(["load", PLIST_PATH]);
  if (loadRes.code !== 0) {
    throw new Error(`launchctl load failed: ${loadRes.stderr.trim()}`);
  }

  return { plistPath: PLIST_PATH, loaded: true };
}

// Kick off one tick immediately (the job stays on its StartInterval cadence).
export function startNow(): void {
  const res = launchctl(["start", LABEL]);
  if (res.code !== 0) {
    throw new Error(`launchctl start failed: ${res.stderr.trim()}`);
  }
}

export function uninstallPlist(): { removed: boolean } {
  // Old-label plists count as an install worth removing too.
  const migrated = migrateOldLabels();
  if (!existsSync(PLIST_PATH)) return { removed: migrated.length > 0 };
  launchctl(["unload", PLIST_PATH]);
  unlinkSync(PLIST_PATH);
  return { removed: true };
}

export function daemonStatus(): {
  installed: boolean;
  loaded: boolean;
  plistPath: string;
  // Set when the job on this machine is a previous-label install that
  // `vir schedule install` hasn't migrated yet — installed-but-stale, never
  // "not installed".
  staleLabel: string | null;
} {
  let installed = existsSync(PLIST_PATH);
  let staleLabel: string | null = null;
  let checkLabel = LABEL;
  let plistPath = PLIST_PATH;
  if (!installed) {
    const stale = stalePlists()[0];
    if (stale) {
      installed = true;
      staleLabel = stale.label;
      checkLabel = stale.label;
      plistPath = stale.path;
    }
  }
  let loaded = false;
  const res = spawnSync("launchctl", ["list"], { encoding: "utf8" });
  if (res.status === 0 && typeof res.stdout === "string") {
    loaded = res.stdout.includes(checkLabel);
  }
  return { installed, loaded, plistPath, staleLabel };
}
