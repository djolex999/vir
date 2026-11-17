import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../config.js";
import { DEFAULT_DRIFT_TZ, runDrift, writeDriftReport, writeReportFile } from "../drift/run.js";
import { NO_DRIFT, renderDrift } from "../drift/render.js";
import { driftCount } from "../drift/types.js";
import * as ui from "../ui/display.js";
import { withPipelineLock } from "./guards.js";

// `vir drift [path]`: where a repo's docs no longer match its code.
// Deterministic only: no model call, so no cost prompt.

export interface DriftCliOptions {
  doc?: string[];
  only?: string;
  stdout?: boolean;
  json?: boolean;
  report?: string;
  tz?: string;
}

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function driftCommand(path: string | undefined, opts: DriftCliOptions): Promise<void> {
  const target = resolve(path ?? process.cwd());
  const timeZone = opts.tz ?? DEFAULT_DRIFT_TZ;
  const fail = (msg: string): void => {
    ui.row(ui.errorColor(ui.CROSS), ui.text(msg));
    process.exitCode = 1;
  };
  if (!existsSync(target) || !statSync(target).isDirectory()) return fail(`not a directory: ${target}`);
  if (!validTimeZone(timeZone)) return fail(`unknown time zone: ${timeZone}`);

  const report = runDrift(target, {
    docs: (opts.doc ?? []).map((d) => resolve(d)),
    ...(opts.only !== undefined ? { only: opts.only } : {}),
    timeZone,
  });
  if (report.docs.length === 0) return fail(`no CLAUDE.md or README.md found in ${report.root}`);
  const body = renderDrift(report);

  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  if (opts.stdout === true) {
    process.stdout.write(body);
    return;
  }

  const cfg = loadConfig();
  const written: { latest: string; dated: string }[] = [];
  await withPipelineLock(async () => {
    written.push(writeDriftReport(cfg, report, body));
  });
  const paths = written[0];
  // Lock held by a running `vir run`: withPipelineLock already said so.
  if (paths === undefined) return;
  if (opts.report !== undefined) writeReportFile(resolve(opts.report), body);

  ui.header("drift");
  ui.blank();
  const total = driftCount(report);
  for (const d of report.docs) {
    const from = d.source !== undefined ? ui.dim(` (from ${d.source})`) : "";
    const icon = d.items.length === 0 ? ui.success(ui.CHECK) : ui.warn(ui.WARN_GLYPH);
    ui.row(icon, ui.text(`${d.doc}${from}`), ui.dim(`${d.items.length} drifted of ${d.checked} claim(s)`));
  }
  if (report.undocumented.length > 0) {
    ui.row(ui.warn(ui.WARN_GLYPH), ui.text("undocumented"), ui.dim(`${report.undocumented.length + report.undocumentedMore} item(s)`));
  }
  ui.blank();
  ui.row(total === 0 ? ui.success(ui.CHECK) : ui.muted(ui.ARROW), ui.text(total === 0 ? NO_DRIFT : `${total} difference(s)`));
  ui.row(ui.muted(ui.BULLET), ui.dim(paths.dated));
  if (opts.report !== undefined) ui.row(ui.muted(ui.BULLET), ui.dim(resolve(opts.report)));
}
