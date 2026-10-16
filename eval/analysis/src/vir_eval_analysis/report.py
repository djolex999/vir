# matplotlib's own stubs type **kwargs as Unknown on most Axes/Figure methods;
# strict mode stays on for everything else in this file.
# pyright: reportUnknownMemberType=false
from dataclasses import dataclass
from pathlib import Path

import pandas as pd
from matplotlib.axes import Axes
from matplotlib.figure import Figure

from .paths import ANALYSIS_DIR
from .bootstrap import is_detectable
from .record import COMPARISON_CLASSES, METRICS, RANKED_CLASSES, Comparison, RunRecord, arm_by_id

# The README's rule for `real`: report-only below 20 queries. Applied to every
# class here, since the CIs at that size are too wide to rank arms on.
MIN_RANKABLE_N = 20

CLASS_COLORS = {"real": "#d1495b", "identifier": "#00798c", "conceptual": "#edae49"}
DETECTABLE = "#00798c"
NOT_DETECTABLE = "#9aa0a6"


@dataclass(frozen=True)
class ReportFiles:
    out_dir: Path
    summary: Path
    forest: Path
    per_query: Path


def run_slug(record: RunRecord) -> str:
    # Same file-name rule as eval/run.ts uses for the run record itself.
    return record["ts"].replace(":", "-").replace(".", "-")


def per_query_frame(record: RunRecord) -> pd.DataFrame:
    """Long form: one row per (arm, query) with each metric's delta vs the baseline arm."""
    base = arm_by_id(record, record["baselineArm"])
    if base is None:
        raise ValueError(f"baseline arm {record['baselineArm']} is not in the run record")
    base_by_id = {q["queryId"]: q for q in base["perQuery"]}
    rows: list[dict[str, object]] = []
    for a in record["arms"]:
        if a["id"] == base["id"]:
            continue
        for q in a["perQuery"]:
            if q["class"] not in RANKED_CLASSES:
                continue
            b = base_by_id.get(q["queryId"])
            row: dict[str, object] = {"arm": a["id"], "queryId": q["queryId"], "class": q["class"]}
            for m in METRICS:
                va = q[m]
                vb = b[m] if b is not None else None
                row[m] = None if va is None or vb is None else va - vb
            rows.append(row)
    return pd.DataFrame(rows, columns=["arm", "queryId", "class", *METRICS])


def class_table(record: RunRecord) -> pd.DataFrame:
    rows: list[dict[str, object]] = []
    for a in record["arms"]:
        for cls in COMPARISON_CLASSES:
            agg = a["byClass"][cls]
            rows.append({"arm": a["id"], "class": cls, "n": agg["n"], **{m: agg[m] for m in METRICS}})
    return pd.DataFrame(rows)


def _cell(x: object) -> str:
    if isinstance(x, float):
        return "n/a" if x != x else f"{x:.3f}"
    return "n/a" if x is None else str(x)


def _md_table(df: pd.DataFrame) -> list[str]:
    cols = [str(c) for c in df.columns]
    lines = ["| " + " | ".join(cols) + " |", "|" + "---|" * len(cols)]
    for values in df.itertuples(index=False, name=None):
        lines.append("| " + " | ".join(_cell(v) for v in values) + " |")
    return lines


def _forest_cell(ax: Axes, comps: list[Comparison], title: str) -> None:
    labels = [f"{c['a']} vs {c['b']}" for c in comps]
    for y, c in enumerate(comps):
        ci = c["ci"]
        if ci["meanDiff"] is None or ci["lo"] is None or ci["hi"] is None:
            continue
        color = DETECTABLE if is_detectable(ci) else NOT_DETECTABLE
        ax.plot([ci["lo"], ci["hi"]], [y, y], color=color, linewidth=2)
        ax.plot([ci["meanDiff"]], [y], marker="o", color=color)
    ax.axvline(0, color="#333333", linewidth=0.8)
    ax.set_yticks(range(len(comps)), labels, fontsize=7)
    ax.invert_yaxis()
    ns = sorted({c["ci"]["n"] for c in comps})
    ax.set_title(f"{title}  (n={', '.join(str(n) for n in ns)})", fontsize=9)
    ax.tick_params(axis="x", labelsize=7)


def forest_figure(record: RunRecord) -> Figure:
    """Every stored comparison CI, rows = class, columns = metric. Plots the
    TS harness's numbers as stored; recomputes nothing."""
    fig = Figure(figsize=(14, 12), layout="constrained")
    axes = fig.subplots(len(COMPARISON_CLASSES), len(METRICS), squeeze=False)
    for i, cls in enumerate(COMPARISON_CLASSES):
        for j, metric in enumerate(METRICS):
            comps = [c for c in record["comparisons"] if c["class"] == cls and c["metric"] == metric]
            _forest_cell(axes[i][j], comps, f"{cls} · {metric}")
    fig.suptitle(f"paired bootstrap 95% CI (A − B), run {record['ts']}; grey = crosses zero or n < 2")
    return fig


def per_query_figure(frame: pd.DataFrame, record: RunRecord) -> Figure:
    """nDCG@k delta vs baseline per query: where an arm wins or loses, not just its mean."""
    arms = list(dict.fromkeys(str(a) for a in frame["arm"]))
    fig = Figure(figsize=(max(6.0, 1.6 * len(arms) + 2), 5), layout="constrained")
    ax = fig.subplots()
    for x, arm_id in enumerate(arms):
        sub = frame[(frame["arm"] == arm_id) & frame["ndcg"].notna()]
        for k, (cls, delta) in enumerate(zip(sub["class"], sub["ndcg"], strict=True)):
            # Deterministic jitter so reruns produce the same picture.
            jitter = ((k * 37) % 21 - 10) / 50
            ax.plot([x + jitter], [float(delta)], marker="o", linestyle="", markersize=4, alpha=0.75, color=CLASS_COLORS.get(str(cls), "#555555"))
    ax.axhline(0, color="#333333", linewidth=0.8)
    ax.set_xticks(range(len(arms)), arms)
    ax.set_ylabel(f"nDCG@{record['k']} − {record['baselineArm']}")
    for cls, color in CLASS_COLORS.items():
        ax.plot([], [], marker="o", linestyle="", color=color, label=cls)
    ax.legend(fontsize=8, loc="best")
    ax.set_title(f"per-query nDCG delta vs baseline, run {record['ts']}", fontsize=10)
    return fig


def summary_markdown(record: RunRecord) -> str:
    g = record["git"]
    inp = record["inputs"]
    lines = [
        f"# eval run {record['ts']}",
        "",
        f"git {g['sha'][:7]}{'+dirty' if g['dirty'] else ''} ({g['branch']}) · k={record['k']} · seed {record['seed']} · "
        f"{inp['queryCount']} queries · {inp['labelCount']} labels · baseline `{record['baselineArm']}`",
        "",
        "## per arm, per class",
        "",
        *_md_table(class_table(record)),
        "",
    ]
    base = arm_by_id(record, record["baselineArm"])
    small = [cls for cls in COMPARISON_CLASSES if base is not None and base["byClass"][cls]["n"] < MIN_RANKABLE_N]
    if small:
        lines += [
            f"**Small samples:** {', '.join(f'{c} (n={base['byClass'][c]['n']})' for c in small if base is not None)} "
            f"are below {MIN_RANKABLE_N} queries. Treat them as report-only and do not rank arms on them.",
            "",
        ]
    detectable = [c for c in record["comparisons"] if is_detectable(c["ci"])]
    lines.append(f"## detectable differences ({len(detectable)} of {len(record['comparisons'])} comparisons)")
    lines.append("")
    if not detectable:
        lines.append("None: every comparison CI crosses zero.")
    for c in detectable:
        ci = c["ci"]
        winner = c["a"] if (ci["meanDiff"] or 0) > 0 else c["b"]
        lines.append(f"- {c['a']} vs {c['b']} · {c['class']} · {c['metric']}: Δ {_cell(ci['meanDiff'])} [{_cell(ci['lo'])}, {_cell(ci['hi'])}] n={ci['n']} → {winner} better")
    lines += ["", "Charts: `forest.png` (every comparison CI), `per_query.png` (per-query nDCG delta vs baseline)."]
    return "\n".join(lines) + "\n"


def write_report(record: RunRecord, out_root: Path = ANALYSIS_DIR) -> ReportFiles:
    out_dir = out_root / run_slug(record)
    out_dir.mkdir(parents=True, exist_ok=True)
    files = ReportFiles(out_dir, out_dir / "summary.md", out_dir / "forest.png", out_dir / "per_query.png")
    files.summary.write_text(summary_markdown(record), encoding="utf8")
    forest_figure(record).savefig(files.forest, dpi=120)
    per_query_figure(per_query_frame(record), record).savefig(files.per_query, dpi=120)
    return files
