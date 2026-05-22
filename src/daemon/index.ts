import { realpathSync } from "node:fs";
import type { Config } from "../config.js";
import * as cron from "./cron.js";
import * as launchd from "./launchd.js";
import * as systemd from "./systemd.js";
import {
  SystemdNotAvailableError,
  SystemdUserBusUnavailableError,
} from "./systemd.js";

export type DaemonMethod = "launchd" | "systemd" | "cron" | "none";

export interface DaemonStatus {
  installed: boolean;
  active: boolean;
  method: DaemonMethod;
  // Parsed from the installed unit/crontab (systemd/cron). null when the
  // platform doesn't expose it (launchd) — callers fall back to config.
  cadenceHours: number | null;
  configPath: string | null;
}

const NONE: DaemonStatus = {
  installed: false,
  active: false,
  method: "none",
  cadenceHours: null,
  configPath: null,
};

// process.execPath is the absolute node binary; argv[1] is this CLI's entry
// (resolved through any npm bin symlink). launchd already relies on this pair;
// systemd/cron reuse it so the scheduled command points at the real install
// location rather than a hardcoded /usr/local/bin guess.
function resolvePaths(): { nodePath: string; cliPath: string } {
  return {
    nodePath: process.execPath,
    cliPath: realpathSync(process.argv[1] ?? ""),
  };
}

function throwUnsupported(platform: string): never {
  if (platform === "win32") {
    throw new Error(
      "Windows not yet supported. Open an issue at github.com/djolex999/vir/issues",
    );
  }
  throw new Error(
    `Platform '${platform}' not supported. Open an issue at github.com/djolex999/vir/issues`,
  );
}

export async function install(cfg: Config): Promise<void> {
  const platform = process.platform;
  if (platform === "darwin") {
    const { nodePath, cliPath } = resolvePaths();
    launchd.installPlist({ nodePath, cliPath, cadenceHours: cfg.cadenceHours });
    return;
  }
  if (platform === "linux") {
    const opts = { ...resolvePaths(), cadenceHours: cfg.cadenceHours };
    // systemd preferred. Fall back to cron when systemctl is missing
    // (SystemdNotAvailableError) OR present-but-no-user-bus
    // (SystemdUserBusUnavailableError — common on WSL/containers). Any other
    // error is a real misconfig and propagates.
    try {
      systemd.install(opts);
      return;
    } catch (err) {
      if (
        !(err instanceof SystemdNotAvailableError) &&
        !(err instanceof SystemdUserBusUnavailableError)
      ) {
        throw err;
      }
    }
    if (cron.isCronAvailable()) {
      cron.install(opts);
      return;
    }
    throw new Error(
      "No daemon backend available.\n" +
        "  - systemd user bus not reachable (common on WSL, containers)\n" +
        "  - cron command not found\n" +
        "  Install one to use vir schedule:\n" +
        "    Ubuntu/Debian/WSL: sudo apt install cron\n" +
        "    Arch: sudo pacman -S cronie",
    );
  }
  throwUnsupported(platform);
}

export async function uninstall(): Promise<void> {
  const platform = process.platform;
  if (platform === "darwin") {
    launchd.uninstallPlist();
    return;
  }
  if (platform === "linux") {
    // Tear down whichever method is present — we don't track which one
    // install() chose, and both teardowns are no-ops when absent.
    if (systemd.isSystemdAvailable()) systemd.uninstall();
    if (cron.isCronAvailable()) cron.uninstall();
    return;
  }
  throwUnsupported(platform);
}

export async function status(): Promise<DaemonStatus> {
  const platform = process.platform;
  if (platform === "darwin") {
    const ds = launchd.daemonStatus();
    return {
      installed: ds.installed,
      active: ds.loaded,
      method: "launchd",
      cadenceHours: null,
      configPath: ds.plistPath,
    };
  }
  if (platform === "linux") {
    if (systemd.isSystemdAvailable()) {
      const s = systemd.status();
      if (s.installed) return { ...s, method: "systemd" };
    }
    if (cron.isCronAvailable()) {
      const c = cron.status();
      if (c.installed) return { ...c, method: "cron" };
    }
    return NONE;
  }
  // Unsupported platforms: report "none" rather than throw so `vir status`
  // can still show the knowledge base.
  return NONE;
}
