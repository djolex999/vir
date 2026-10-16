import argparse
import sys
from collections.abc import Callable, Sequence
from typing import cast

from .diff import NotComparable, diff_runs, render_diff
from .paths import ANALYSIS_DIR, EVAL_RUNS_DIR
from .record import RunRecordError, list_runs, load_run, resolve_run
from .report import run_slug, write_report
from .verify import verify


def _cmd_runs(_: argparse.Namespace) -> int:
    runs = list_runs()
    if not runs:
        print(f"no run records in {EVAL_RUNS_DIR}; run `npm run eval -- run` first")
        return 0
    for p in runs:
        r = load_run(p)
        g = r["git"]
        print(f"{p.stem}  git {g['sha'][:7]}{'+dirty' if g['dirty'] else ''}  queries {r['inputs']['queriesHash']}  labels {r['inputs']['labelsHash']}  arms {len(r['arms'])}")
    return 0


def _cmd_verify(args: argparse.Namespace) -> int:
    path = resolve_run(args.run)
    record = load_run(path)
    mismatches = verify(record)
    total = len(record["comparisons"])
    if not mismatches:
        print(f"{path.name}: all {total} stored CIs reproduced exactly by the Python port")
        return 0
    print(f"{path.name}: {len(mismatches)} of {total} stored CIs NOT reproduced", file=sys.stderr)
    for m in mismatches[:20]:
        c = m.comparison
        print(f"  #{m.index} {c['a']} vs {c['b']} {c['class']} {c['metric']}: stored {c['ci']}  recomputed {m.recomputed}", file=sys.stderr)
    return 1


def _cmd_diff(args: argparse.Namespace) -> int:
    old_path = resolve_run(args.old, from_end=2)
    new_path = resolve_run(args.new, from_end=1)
    if old_path.resolve() == new_path.resolve():
        raise RunRecordError(f"old and new are the same run record ({old_path.name})")
    old = load_run(old_path)
    new = load_run(new_path)
    if old["ts"] > new["ts"]:
        old, new = new, old
    text = render_diff(diff_runs(old, new))
    ANALYSIS_DIR.mkdir(parents=True, exist_ok=True)
    out = ANALYSIS_DIR / f"diff_{run_slug(old)}__{run_slug(new)}.md"
    out.write_text(text, encoding="utf8")
    print(text)
    print(f"diff → {out}")
    return 0


def _cmd_report(args: argparse.Namespace) -> int:
    path = resolve_run(args.run)
    files = write_report(load_run(path))
    print(f"report for {path.name} → {files.out_dir}")
    for f in (files.summary, files.forest, files.per_query):
        print(f"  {f.name}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="eval:analyze",
        description="Analyze retrieval eval run records in ~/.vir/eval/runs. Reads them, never writes them; output goes to ~/.vir/eval/analysis.",
    )
    sub = p.add_subparsers(dest="command", required=True)
    sub.add_parser("runs", help="list run records").set_defaults(fn=_cmd_runs)
    v = sub.add_parser("verify", help="recompute every stored CI with the Python port; exit 1 on any mismatch")
    v.add_argument("run", nargs="?", help="run file name or path (default: newest)")
    v.set_defaults(fn=_cmd_verify)
    d = sub.add_parser("diff", help="per-arm, per-class change between two runs with paired bootstrap CIs")
    d.add_argument("old", nargs="?", help="older run (default: second newest)")
    d.add_argument("new", nargs="?", help="newer run (default: newest)")
    d.set_defaults(fn=_cmd_diff)
    r = sub.add_parser("report", help="summary.md + forest.png + per_query.png for one run")
    r.add_argument("run", nargs="?", help="run file name or path (default: newest)")
    r.set_defaults(fn=_cmd_report)
    return p


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    fn = cast(Callable[[argparse.Namespace], int], args.fn)
    try:
        return fn(args)
    except (RunRecordError, NotComparable) as e:
        print(f"eval:analyze: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
