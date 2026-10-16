import copy

import pytest

from factory import arm, pq, record, two_arm_record
from vir_eval_analysis.bootstrap import BootstrapCI
from vir_eval_analysis.diff import NotComparable, diff_runs, render_diff, verdict


def test_identical_runs_diff_to_zero_everywhere() -> None:
    r = two_arm_record()
    d = diff_runs(r, copy.deepcopy(r))
    assert d.rows
    for row in d.rows:
        assert row.ci["n"] == 0 or (row.ci["meanDiff"] == 0 and row.ci["crossesZero"])


@pytest.mark.parametrize(
    ("override", "field"),
    [({"queries_hash": "x" * 12}, "queriesHash"), ({"labels_hash": "x" * 12}, "labelsHash"), ({"rubric_hash": "x" * 12}, "rubricHash"), ({"k": 5}, "k ")],
)
def test_refuses_runs_with_different_inputs(override: dict[str, object], field: str) -> None:
    with pytest.raises(NotComparable, match=field):
        diff_runs(two_arm_record(), two_arm_record(**override))


def test_detects_a_consistent_improvement() -> None:
    qs = [f"q{i}" for i in range(12)]
    old = record([arm("x", [pq(q, "real", 0.2 + i / 100) for i, q in enumerate(qs)])], baseline="x")
    new = record([arm("x", [pq(q, "real", 0.6 + i / 100) for i, q in enumerate(qs)])], baseline="x", ts="2026-10-02T00:00:00.000Z")
    d = diff_runs(old, new)
    real_ndcg = next(r for r in d.rows if r.cls == "real" and r.metric == "ndcg")
    assert real_ndcg.ci["n"] == 12
    assert not real_ndcg.ci["crossesZero"]
    assert verdict(real_ndcg.ci) == "new better"


def test_reports_config_changes_dirty_trees_and_one_sided_arms() -> None:
    old = record([arm("x", [pq("q", "real", 0.5)]), arm("gone", [pq("q", "real", 0.5)])], baseline="x", configs={"x": {"retrievalDiversity": 0}, "gone": {}}, dirty=True)
    new = record([arm("x", [pq("q", "real", 0.5)]), arm("added", [pq("q", "real", 0.5)])], baseline="x", configs={"x": {"retrievalDiversity": 0.3}, "added": {}})
    d = diff_runs(old, new)
    assert d.config_changes == {"x": ["retrievalDiversity"]}
    text = "\n".join(d.warnings)
    assert "dirty" in text and "gone only in the old run" in text and "added only in the new run" in text
    assert {r.arm for r in d.rows} == {"x"}


def test_render_has_one_table_row_per_diff_row() -> None:
    d = diff_runs(two_arm_record(), two_arm_record())
    out = render_diff(d)
    assert out.count("\n| base |") + out.count("\n| other |") == len(d.rows)
    assert "n/a" in out  # conceptual on `base` is undefined


def test_verdict_never_calls_a_single_query_a_difference() -> None:
    ci: BootstrapCI = {"n": 1, "meanDiff": 0.4, "lo": 0.4, "hi": 0.4, "crossesZero": False}
    assert verdict(ci) == "n=1"
