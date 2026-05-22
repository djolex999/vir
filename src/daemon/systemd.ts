import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Thrown by install() when systemctl is absent so the platform router
// (daemon/index.ts) can fall back to cron.
export class SystemdNotAvailableError extends Error {
  constructor() {
    super("systemctl not found");
    this.name = "SystemdNotAvailableError";
  }
}

// User mode only — never touch /etc/systemd/system.
const SYSTEMD_USER_DIR = join(homedir(), ".config", "systemd", "user");
const SERVICE_PATH = join(SYSTEMD_USER_DIR, "vir.service");
const TIMER_PATH = join(SYSTEMD_USER_DIR, "vir.timer");
const TIMER_UNIT = "vir.timer";

export interface InstallOpts {
  nodePath: string;
  cliPath: string;
  cadenceHours: number;
}

export interface SystemdStatus {
  installed: boolean;
  active: boolean;
  cadenceHours: number | null;
  configPath: string | null;
}

export function isSystemdAvailable(): boolean {
  return spawnSync("which", ["systemctl"], { encoding: "utf8" }).status === 0;
}

function systemctl(args: string[]): {
  code: number;
  stdout: string;
  stderr: string;
} {
  const res = spawnSync("systemctl", args, { encoding: "utf8" });
  return {
    code: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

// %h is systemd's user-home specifier — keeps the unit portable across users.
export function renderService(opts: {
  nodePath: string;
  cliPath: string;
}): string {
  return `[Unit]
Description=Vir Claude Code session distillation

[Service]
Type=oneshot
ExecStart=${opts.nodePath} ${opts.cliPath} run --yes
StandardOutput=append:%h/.vir/daemon.log
StandardError=append:%h/.vir/daemon.log
`;
}

export function renderTimer(cadenceHours: number): string {
  const h = Math.max(1, Math.round(cadenceHours));
  return `[Unit]
Description=Run Vir every ${h} hours

[Timer]
OnBootSec=5min
OnUnitActiveSec=${h}h

[Install]
WantedBy=timers.target
`;
}

export function parseTimerCadence(timer: string): number | null {
  const m = timer.match(/OnUnitActiveSec=(\d+)h/);
  return m && m[1] ? Number(m[1]) : null;
}

export function install(opts: InstallOpts): void {
  if (!isSystemdAvailable()) throw new SystemdNotAvailableError();
  if (!existsSync(SYSTEMD_USER_DIR)) {
    mkdirSync(SYSTEMD_USER_DIR, { recursive: true });
  }
  writeFileSync(
    SERVICE_PATH,
    renderService({ nodePath: opts.nodePath, cliPath: opts.cliPath }),
  );
  writeFileSync(TIMER_PATH, renderTimer(opts.cadenceHours));

  const reload = systemctl(["--user", "daemon-reload"]);
  if (reload.code !== 0) {
    throw new Error(`systemctl daemon-reload failed: ${reload.stderr.trim()}`);
  }
  const enable = systemctl(["--user", "enable", "--now", TIMER_UNIT]);
  if (enable.code !== 0) {
    throw new Error(`systemctl enable failed: ${enable.stderr.trim()}`);
  }
}

export function uninstall(): void {
  if (!isSystemdAvailable()) return;
  systemctl(["--user", "disable", "--now", TIMER_UNIT]);
  if (existsSync(SERVICE_PATH)) rmSync(SERVICE_PATH);
  if (existsSync(TIMER_PATH)) rmSync(TIMER_PATH);
  systemctl(["--user", "daemon-reload"]);
}

export function status(): SystemdStatus {
  if (!existsSync(TIMER_PATH)) {
    return { installed: false, active: false, cadenceHours: null, configPath: null };
  }
  const isActive = systemctl(["--user", "is-active", TIMER_UNIT]);
  let cadenceHours: number | null = null;
  try {
    cadenceHours = parseTimerCadence(readFileSync(TIMER_PATH, "utf8"));
  } catch {
    // unreadable timer — leave cadence null
  }
  return {
    installed: true,
    active: isActive.stdout.trim() === "active",
    cadenceHours,
    configPath: TIMER_PATH,
  };
}
