import json
from dataclasses import dataclass, field

from .bootstrap import BootstrapCI, is_detectable, paired_bootstrap_ci
from .pairs import paired_diffs
from .record import COMPARISON_CLASSES, METRICS, Metric, RunRecord, arm_by_id
from .rng import make_rng


class NotComparable(Exception):
    """Two runs judged against different queries, labels, rubric or K: their
    numbers measure different things and must not be subtracted."""


@dataclass(frozen=True)
class DiffRow:
    arm: str
    cls: str
    metric: Metric
    old: float | None
    new: float | None
    ci: BootstrapCI


@dataclass(frozen=True)
class RunDiff:
    old_ts: str
    new_ts: str
    rows: list[DiffRow]
    # arm id → top-level config keys whose value changed between the runs
    config_changes: dict[str, list[str]]
    warnings: list[str] = field(default_factory=lambda: list[str]())


def _check_comparable(old: RunRecord, new: RunRecord) -> None:
    mismatched: list[str] = []
    if old["k"] != new["k"]:
        mismatched.append(f"k {old['k']} → {new['k']}")
    for key in ("queriesHash", "labelsHash", "rubricHash"):
        if old["inputs"][key] != new["inputs"][key]:
            mismatched.append(f"{key} {old['inputs'][key]} → {new['inputs'][key]}")
    if mismatched:
        raise NotComparable(
            "runs are not comparable (" + "; ".join(mismatched) + "). "
            "Re-run both against the same query set, labels and rubric."
        )


def _config_changes(old: RunRecord, new: RunRecord, arm_id: str) -> list[str]:
    a = old["armConfigs"].get(arm_id, {})
    b = new["armConfigs"].get(arm_id, {})
    keys = sorted(set(a) | set(b))
    return [k for k in keys if json.dumps(a.get(k), sort_keys=True) != json.dumps(b.get(k), sort_keys=True)]


def diff_runs(old: RunRecord, new: RunRecord) -> RunDiff:
    """Per arm, class and metric: aggregate old/new and a paired bootstrap CI
    on per-query (new − old), same method and RNG discipline as runBaseline,
    seeded from the newer run."""
    _check_comparable(old, new)
    warnings: list[str] = []
    for label, r in (("old", old), ("new", new)):
        if r["git"]["dirty"]:
            warnings.append(f"{label} run {r['ts']} was made from a dirty tree ({r['git']['sha'][:7]}+dirty): its code is not exactly that commit")
    if old["git"]["sha"] == new["git"]["sha"] and not old["git"]["dirty"] and not new["git"]["dirty"]:
        warnings.append("both runs are the same clean commit: any difference is environment (vault, DB, Ollama), not code")
    old_ids = [a["id"] for a in old["arms"]]
    new_ids = [a["id"] for a in new["arms"]]
    for arm_id in old_ids:
        if arm_id not in new_ids:
            warnings.append(f"arm {arm_id} only in the old run; skipped")
    for arm_id in new_ids:
        if arm_id not in old_ids:
            warnings.append(f"arm {arm_id} only in the new run; skipped")

    rng = make_rng(new["seed"])
    rows: list[DiffRow] = []
    config_changes: dict[str, list[str]] = {}
    for arm_new in new["arms"]:
        arm_old = arm_by_id(old, arm_new["id"])
        if arm_old is None:
            continue
        changed = _config_changes(old, new, arm_new["id"])
        if changed:
            config_changes[arm_new["id"]] = changed
        for cls in COMPARISON_CLASSES:
            for metric in METRICS:
                diffs = paired_diffs(arm_new["perQuery"], arm_old["perQuery"], cls, metric)
                rows.append(
                    DiffRow(
                        arm=arm_new["id"],
                        cls=cls,
                        metric=metric,
                        old=arm_old["byClass"][cls][metric],
                        new=arm_new["byClass"][cls][metric],
                        ci=paired_bootstrap_ci(diffs, new["bootstrapRounds"], rng),
                    )
                )
    return RunDiff(old_ts=old["ts"], new_ts=new["ts"], rows=rows, config_changes=config_changes, warnings=warnings)


def _fmt(x: float | None, digits: int = 3) -> str:
    return "  n/a" if x is None or x != x else f"{x:.{digits}f}"


def verdict(ci: BootstrapCI) -> str:
    if ci["n"] == 0:
        return "no data"
    if ci["n"] == 1:
        return "n=1"
    if ci["crossesZero"]:
        return "—"
    return "new better" if ci["meanDiff"] > 0 else "old better"


def render_diff(d: RunDiff) -> str:
    lines = [f"# eval diff  old {d.old_ts}  →  new {d.new_ts}", ""]
    if d.warnings:
        lines += [f"- warning: {w}" for w in d.warnings] + [""]
    if d.config_changes:
        lines.append("## config changes")
        lines += [f"- {arm}: {', '.join(keys)}" for arm, keys in d.config_changes.items()]
        lines.append("")
    lines.append('## per-query paired bootstrap 95% CI on new − old ("—" = no detectable difference; n=1 is never a verdict)')
    lines.append("")
    lines.append("| arm | class | metric | old | new | mean Δ | 95% CI | n | verdict |")
    lines.append("|---|---|---|---|---|---|---|---|---|")
    for r in d.rows:
        ci = r.ci
        lines.append(
            f"| {r.arm} | {r.cls} | {r.metric} | {_fmt(r.old)} | {_fmt(r.new)} | {_fmt(ci['meanDiff'])} "
            f"| [{_fmt(ci['lo'])}, {_fmt(ci['hi'])}] | {ci['n']} | {verdict(ci)} |"
        )
    detectable = [r for r in d.rows if is_detectable(r.ci)]
    lines += ["", f"{len(detectable)} of {len(d.rows)} rows show a detectable difference."]
    return "\n".join(lines) + "\n"
