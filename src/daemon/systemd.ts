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

// Thrown when systemctl is on PATH but the user bus/manager is unreachable —
// the classic WSL/container case. Distinct from SystemdNotAvailableError so the
// router can fall back to cron for both. install() probes for this BEFORE
// writing any unit files.
export class SystemdUserBusUnavailableError extends Error {
  constructor() {
    super("systemd user bus not reachable");
    this.name = "SystemdUserBusUnavailableError";
  }
}

// Decides, from a `systemctl --user …` result, whether the failure is the user
// bus being unreachable. The definitive marker is systemctl's "Failed to
// connect to … bus" message (WSL, containers, no $XDG_RUNTIME_DIR). A non-zero
// exit *without* that marker (e.g. stdout "degraded") means the bus IS
// reachable, so we don't treat it as unavailable.
export function isUserBusUnavailable(probe: {
  code: number;
  stdout: string;
  stderr: string;
}): boolean {
  return /Failed to connect to .*bus/i.test(`${probe.stdout}\n${probe.stderr}`);
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

// systemd splits ExecStart on whitespace; double-quote each path so spaces
// survive, escaping embedded backslashes and quotes per systemd's own rules
// (NOT shell rules — systemd parses the unit, no shell is involved).
export function systemdQuote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
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
ExecStart=${systemdQuote(opts.nodePath)} ${systemdQuote(opts.cliPath)} run --daemon
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

// Turn a failed systemctl result into a typed error: a bus-connection failure
// becomes SystemdUserBusUnavailableError (so the router falls back to cron),
// anything else stays a generic Error (a real misconfig the user should see).
function classifySystemctlError(
  op: string,
  res: { code: number; stdout: string; stderr: string },
): Error {
  if (isUserBusUnavailable(res)) return new SystemdUserBusUnavailableError();
  return new Error(`systemctl ${op} failed: ${res.stderr.trim()}`);
}

function removeUnitFiles(): void {
  if (existsSync(SERVICE_PATH)) rmSync(SERVICE_PATH);
  if (existsSync(TIMER_PATH)) rmSync(TIMER_PATH);
}

export function install(opts: InstallOpts): void {
  if (!isSystemdAvailable()) throw new SystemdNotAvailableError();

  // systemctl can be on PATH while the user bus is unreachable (WSL,
  // containers). Probe before writing anything so we never leave stale unit
  // files behind in that case.
  const probe = systemctl(["--user", "is-system-running"]);
  if (isUserBusUnavailable(probe)) throw new SystemdUserBusUnavailableError();

  if (!existsSync(SYSTEMD_USER_DIR)) {
    mkdirSync(SYSTEMD_USER_DIR, { recursive: true });
  }
  try {
    writeFileSync(
      SERVICE_PATH,
      renderService({ nodePath: opts.nodePath, cliPath: opts.cliPath }),
    );
    writeFileSync(TIMER_PATH, renderTimer(opts.cadenceHours));

    const reload = systemctl(["--user", "daemon-reload"]);
    if (reload.code !== 0) throw classifySystemctlError("daemon-reload", reload);
    const enable = systemctl(["--user", "enable", "--now", TIMER_UNIT]);
    if (enable.code !== 0) throw classifySystemctlError("enable", enable);
  } catch (err) {
    // Partial install — remove the unit files we wrote so a retry (or the cron
    // fallback) starts clean — then re-throw for the router to classify.
    removeUnitFiles();
    throw err;
  }
}

export function uninstall(): void {
  if (!isSystemdAvailable()) return;
  systemctl(["--user", "disable", "--now", TIMER_UNIT]);
  removeUnitFiles();
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
