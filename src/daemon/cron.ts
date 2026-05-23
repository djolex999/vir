import { spawnSync } from "node:child_process";
import { DAEMON_LOG_PATH } from "../config.js";

// Marker comment that tags Vir's crontab line so we can find/replace/remove it
// without touching the user's other entries.
export const VIR_CRON_MARKER = "# vir-cli";

export interface InstallOpts {
  nodePath: string;
  cliPath: string;
  cadenceHours: number;
}

export interface CronStatus {
  installed: boolean;
  active: boolean;
  cadenceHours: number | null;
  configPath: string | null;
}

// Cron hour fields are integers 0–23; clamp fractional/oversized cadences so
// `*/N` stays a valid expression. (systemd handles fractional hours; cron does
// not.)
export function cronHourInterval(cadenceHours: number): number {
  return Math.min(23, Math.max(1, Math.round(cadenceHours)));
}

export function generateCronLine(cadenceHours: number, command: string): string {
  const h = cronHourInterval(cadenceHours);
  return `0 */${h} * * * ${command} ${VIR_CRON_MARKER}`;
}

// POSIX-shell single-quote a path so spaces/special chars in node/cli/log paths
// survive crontab's `/bin/sh -c` execution. Embedded single quotes close, escape,
// reopen ('\'').
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function parseCronCadence(line: string): number | null {
  // Hour field is the second whitespace-delimited token; expect "*/N".
  const fields = line.trim().split(/\s+/);
  const hourField = fields[1];
  if (!hourField) return null;
  const m = hourField.match(/^\*\/(\d+)$/);
  return m && m[1] ? Number(m[1]) : null;
}

export function removeVirLines(crontab: string): string {
  return crontab
    .split("\n")
    .filter((l) => !l.includes(VIR_CRON_MARKER))
    .join("\n");
}

// Append `line` to `base`, normalizing trailing whitespace so the result is a
// well-formed crontab (one entry per line, single trailing newline).
function appendLine(base: string, line: string): string {
  const trimmed = base.replace(/\n+$/, "");
  return trimmed === "" ? `${line}\n` : `${trimmed}\n${line}\n`;
}

export function isCronAvailable(): boolean {
  return spawnSync("which", ["crontab"], { encoding: "utf8" }).status === 0;
}

// crontab -l exits non-zero ("no crontab for user") when none exists — treat
// that as an empty crontab rather than an error.
function readCrontab(): string {
  const res = spawnSync("crontab", ["-l"], { encoding: "utf8" });
  if (res.status === 0 && typeof res.stdout === "string") return res.stdout;
  return "";
}

function writeCrontab(content: string): void {
  const res = spawnSync("crontab", ["-"], { input: content, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`crontab write failed: ${(res.stderr ?? "").trim()}`);
  }
}

export function install(opts: InstallOpts): void {
  // --daemon gives quiet output + file logging; the redirect still captures any
  // stderr/crash output cron would otherwise mail to the user.
  const command =
    `${shellQuote(opts.nodePath)} ${shellQuote(opts.cliPath)} run --daemon ` +
    `>> ${shellQuote(DAEMON_LOG_PATH)} 2>&1`;
  const line = generateCronLine(opts.cadenceHours, command);
  const cleaned = removeVirLines(readCrontab());
  writeCrontab(appendLine(cleaned, line));
}

export function uninstall(): void {
  const cleaned = removeVirLines(readCrontab()).replace(/\n+$/, "");
  // Leave a (possibly empty) crontab rather than removing cron entirely.
  writeCrontab(cleaned === "" ? "" : `${cleaned}\n`);
}

export function status(): CronStatus {
  const virLine = readCrontab()
    .split("\n")
    .find((l) => l.includes(VIR_CRON_MARKER));
  if (!virLine) {
    return { installed: false, active: false, cadenceHours: null, configPath: null };
  }
  // A present cron line runs on schedule — there is no separate active state.
  return {
    installed: true,
    active: true,
    cadenceHours: parseCronCadence(virLine),
    configPath: "crontab (user)",
  };
}
