import { loadConfig } from "../config.js";
import {
  applyPrunePlan,
  buildPrunePlan,
  restorePruned,
  type PrunePlan,
} from "../prune/prune.js";
import { StateDb } from "../state/db.js";
import * as ui from "../ui/display.js";

export interface PruneCliOptions {
  apply?: boolean;
  restore?: boolean;
  dryRun?: boolean;
}

function renderPlan(plan: PrunePlan): void {
  ui.header("prune — agent-derived notes");
  ui.blank();

  const reasons = Object.entries(plan.byReason).sort((a, b) => b[1] - a[1]);
  if (reasons.length === 0) {
    ui.row(ui.success(ui.CHECK), ui.text("nothing to prune"));
  } else {
    for (const [reason, n] of reasons) {
      ui.row(ui.warn(ui.DIAMOND), ui.text(reason), ui.dim(String(n)));
    }
  }

  ui.blank();
  ui.line(ui.dim("  kept:"));
  for (const [reason, n] of Object.entries(plan.byKeepReason).sort(
    (a, b) => b[1] - a[1],
  )) {
    // The two report-only buckets are the honest part of this command: no
    // evidence exists to judge them, so they are never touched.
    const note =
      reason === "unclassifiable"
        ? " (no entrypoint, transcript gone — never pruned)"
        : reason === "merge-winner"
          ? " (merge parentage unknown — never pruned)"
          : "";
    ui.line(ui.dim(`    ${reason}: ${n}${note}`));
  }

  ui.blank();
  ui.divider();
  ui.summary({
    "would prune": { value: plan.prune.length, color: ui.warn },
    keep: { value: plan.keep.length, color: ui.info },
    "already pruned": { value: plan.alreadyPruned, color: ui.dim },
    "dangling links": {
      value: plan.danglingLinks,
      color: plan.danglingLinks > 0 ? ui.warn : ui.dim,
    },
  });
  ui.divider();
  if (plan.danglingLinks > 0) {
    ui.line(
      ui.dim(
        `  ${plan.danglingLinks} wikilink(s) in kept notes point at a pruned note — reported, not rewritten`,
      ),
    );
  }
}

export async function pruneCommand(opts: PruneCliOptions): Promise<void> {
  const cfg = await loadConfig();
  const db = new StateDb();
  try {
    if (opts.restore === true) {
      const res = restorePruned(db, cfg);
      ui.header("prune --restore");
      ui.blank();
      ui.summary({
        restored: { value: res.restored, color: ui.success },
        "file missing": {
          value: res.missing,
          color: res.missing > 0 ? ui.warn : ui.dim,
        },
      });
      return;
    }

    const plan = buildPrunePlan(db, cfg);
    renderPlan(plan);

    // Dry run is the default: this command demotes a chunk of the vault, so
    // the destructive-looking path has to be the one you ask for by name.
    if (opts.apply !== true) {
      ui.blank();
      ui.line(ui.dim("  dry run — nothing moved, nothing written"));
      ui.line(ui.dim("  run `vir prune --apply` to demote, `--restore` to undo"));
      return;
    }

    const res = applyPrunePlan(db, cfg, plan);
    ui.blank();
    ui.summary({
      "notes moved": { value: res.moved, color: ui.success },
      "rows marked": { value: res.marked, color: ui.success },
      "state only": {
        value: res.stateOnly,
        color: res.stateOnly > 0 ? ui.warn : ui.dim,
      },
    });
    ui.line(ui.dim("  demoted to .rejected/ — `vir prune --restore` puts them back"));
  } finally {
    db.close();
  }
}
