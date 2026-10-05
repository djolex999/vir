import { loadConfig } from "../config.js";
import {
  contradictionCheck,
  orphanCheck,
  stalenessCheck,
} from "../lint/linter.js";
import {
  legacyRelatedCheck,
  migrateLegacyRelated,
} from "../lint/legacyRelated.js";
import { demoteStrays, strayFileCheck } from "../lint/strayFiles.js";
import { StateDb } from "../state/db.js";
import * as ui from "../ui/display.js";
import { VaultWriter } from "../pipeline/writer.js";
import { confirmPaidStep } from "./guards.js";

export async function lintCommand(
  opts: {
        orphans?: boolean;
        strays?: boolean;
        legacyRelated?: boolean;
        fix?: boolean;
        stale?: boolean;
        contradictions?: boolean;
        yes?: boolean;
      },
): Promise<void> {
  const cfg = loadConfig();
  const db = new StateDb();
  try {
    const runAll =
      !opts.orphans &&
      !opts.strays &&
      !opts.legacyRelated &&
      !opts.stale &&
      !opts.contradictions;
    const checks: string[] = [];
    if (runAll || opts.orphans) checks.push("orphans");
    if (runAll || opts.strays) checks.push("strays");
    if (runAll || opts.legacyRelated) checks.push("legacy-related");
    if (runAll || opts.stale) checks.push("stale");
    if (runAll || opts.contradictions) checks.push("contradictions");

    ui.header("lint");
    ui.blank();

    let orphanCount = 0;
    let strayCount = 0;
    let legacyCount = 0;
    let staleCount = 0;
    let contradictionCount = 0;
    let issues = 0;

    if (runAll || opts.orphans) {
      const sp = ui.spinner("checking orphans").start();
      const r = orphanCheck(cfg);
      sp.stop();
      orphanCount = r.orphans.length;
      issues += orphanCount;
      if (orphanCount === 0) {
        ui.row(ui.success(ui.CHECK), `${ui.text("orphans")}  ${ui.dim("none")}`);
      } else {
        ui.row(ui.errorColor(ui.CROSS), `${ui.text("orphans")} ${ui.dim("(" + orphanCount + ")")}`);
        for (const o of r.orphans) {
          console.log(`   ${ui.dim(ui.BULLET)} ${ui.text(ui.shortNotePath(o))}`);
        }
      }
    }

    if (runAll || opts.strays) {
      const sp = ui.spinner("checking stray files").start();
      const r = strayFileCheck(cfg, db);
      sp.stop();
      strayCount = r.strays.length;
      issues += strayCount;
      if (strayCount === 0) {
        ui.row(ui.success(ui.CHECK), `${ui.text("strays")}   ${ui.dim("none")}`);
      } else {
        ui.row(
          ui.errorColor(ui.CROSS),
          `${ui.text("strays")} ${ui.dim("(" + strayCount + " of " + r.scanned + " files)")}`,
        );
        for (const st of r.strays) {
          // The sibling is the whole point: it is what makes a stray safe
          // to demote. An `unknown` stray has none, and gets no advice.
          const note =
            st.liveSibling !== null
              ? ui.dim(`${ui.ARROW} live: ${st.liveSibling}`)
              : ui.warn("only copy — inspect before removing");
          console.log(
            `   ${ui.dim(ui.BULLET)} ${ui.text(ui.shortNotePath(st.relPath))}  ${ui.muted(st.kind)}  ${note}`,
          );
        }
        if (opts.fix) {
          const fixed = demoteStrays(cfg, r);
          strayCount -= fixed.moved;
          issues -= fixed.moved;
          ui.row(
            ui.success(ui.CHECK),
            `${ui.text("strays")} ${ui.dim(`moved ${fixed.moved} to archived/, left ${fixed.left} untouched`)}`,
          );
        }
      }
    }

    if (runAll || opts.legacyRelated) {
      const sp = ui.spinner("checking legacy Related sections").start();
      const r = legacyRelatedCheck(db);
      sp.stop();
      const withContent = r.rows.filter((x) => x.kept > 0);
      legacyCount = r.rows.length;
      issues += legacyCount;
      if (legacyCount === 0) {
        ui.row(ui.success(ui.CHECK), `${ui.text("legacy-related")}  ${ui.dim("none")}`);
      } else {
        const bullets = withContent.reduce((n, x) => n + x.kept, 0);
        ui.row(
          ui.errorColor(ui.CROSS),
          `${ui.text("legacy-related")} ${ui.dim(`(${legacyCount} of ${r.scanned} stored notes; ${withContent.length} hold ${bullets} content bullets a rewrite drops)`)}`,
        );
        if (opts.fix) {
          const fixed = await migrateLegacyRelated(db, new VaultWriter(cfg, db));
          legacyCount -= fixed.migrated;
          issues -= fixed.migrated;
          ui.row(
            ui.success(ui.CHECK),
            `${ui.text("legacy-related")} ${ui.dim(`moved content into ## Details on ${fixed.migrated} rows, re-rendered ${fixed.rewritten} notes`)}`,
          );
          for (const e of fixed.errors) {
            console.log(`   ${ui.dim(ui.BULLET)} ${ui.errorColor(e.path)}  ${ui.muted(e.message)}`);
          }
        } else {
          console.log(`   ${ui.dim(ui.ARROW)} ${ui.muted("vir lint --legacy-related --fix")}`);
        }
      }
    }

    if (runAll || opts.stale) {
      const sp = ui.spinner("checking staleness").start();
      const stale = stalenessCheck(cfg, db);
      sp.stop();
      staleCount = stale.length;
      issues += staleCount;
      if (staleCount === 0) {
        ui.row(ui.success(ui.CHECK), `${ui.text("stale")}    ${ui.dim("none")}`);
      } else {
        ui.row(ui.errorColor(ui.CROSS), `${ui.text("stale")} ${ui.dim("(" + staleCount + ")")}`);
        for (const s of stale) {
          console.log(
            `   ${ui.dim(ui.BULLET)} ${ui.text(ui.shortNotePath(s.relPath))}  ${ui.muted(`${s.ageDays}d`)}  ${ui.dim(`${s.newerSameProjectCount} newer ${s.project} sessions`)}`,
          );
        }
      }
    }

    if (
      (runAll || opts.contradictions) &&
      (await confirmPaidStep(
        `contradiction check makes up to 20 paid calls with ${cfg.models.classify}`,
        { yes: opts.yes },
      ))
    ) {
      const sp = ui.spinner("checking contradictions (haiku)").start();
      const c = await contradictionCheck(cfg, db);
      sp.stop();
      contradictionCount = c.contradictions.length;
      issues += contradictionCount;
      if (contradictionCount === 0) {
        ui.row(
          ui.success(ui.CHECK),
          `${ui.text("contradictions")}  ${ui.dim(`none found in ${c.checked} pairs`)}`,
        );
      } else {
        ui.row(
          ui.errorColor(ui.CROSS),
          `${ui.text("contradictions")} ${ui.dim("(" + contradictionCount + ")")}`,
        );
        for (const x of c.contradictions) {
          console.log(
            `   ${ui.dim(ui.BULLET)} ${ui.text(ui.shortNotePath(x.a))} ${ui.dim("vs")} ${ui.text(ui.shortNotePath(x.b))}`,
          );
          console.log(`     ${ui.muted(x.reason)}`);
        }
      }
    }

    ui.blank();
    ui.divider();
    ui.summary({
      issues: {
        value: issues,
        color: issues > 0 ? ui.errorColor : ui.success,
      },
      orphans: { value: orphanCount, color: ui.muted },
      strays: { value: strayCount, color: ui.muted },
      "legacy-related": { value: legacyCount, color: ui.muted },
      stale: { value: staleCount, color: ui.muted },
      contradictions: { value: contradictionCount, color: ui.muted },
    });
    ui.divider();
  } finally {
    db.close();
  }

}
