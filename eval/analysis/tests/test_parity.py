import json
import math
from pathlib import Path
from typing import TypedDict, cast

import pytest

from vir_eval_analysis.bootstrap import paired_bootstrap_ci, percentile
from vir_eval_analysis.rng import make_rng

# Fixture generated from the TS code by eval/analysis/golden.ts; the vitest
# side (golden.test.ts) keeps it in step with eval/rng.ts and bootstrap.ts.
FIXTURE = Path(__file__).parent / "fixtures" / "bootstrap_golden.json"


class _RngCase(TypedDict):
    seed: int
    draws: list[float]


class _CI(TypedDict):
    n: int
    meanDiff: float | None
    lo: float | None
    hi: float | None
    crossesZero: bool


class _BootCase(TypedDict):
    diffs: list[float]
    ci: _CI


class _Boot(TypedDict):
    seed: int
    rounds: int
    cases: list[_BootCase]


class _Golden(TypedDict):
    rng: list[_RngCase]
    bootstrap: _Boot


GOLDEN = cast(_Golden, json.loads(FIXTURE.read_text(encoding="utf8")))


def _same(expected: float | None, actual: float) -> bool:
    # null in the fixture is JSON.stringify(NaN).
    return math.isnan(actual) if expected is None else expected == actual


@pytest.mark.parametrize("case", GOLDEN["rng"], ids=lambda c: f"seed={c['seed']}")
def test_rng_matches_ts_bit_for_bit(case: _RngCase) -> None:
    rng = make_rng(case["seed"])
    assert [rng() for _ in case["draws"]] == case["draws"]


def test_bootstrap_matches_ts_with_shared_rng() -> None:
    boot = GOLDEN["bootstrap"]
    rng = make_rng(boot["seed"])
    for i, case in enumerate(boot["cases"]):
        got = paired_bootstrap_ci(case["diffs"], boot["rounds"], rng)
        want = case["ci"]
        assert got["n"] == want["n"], i
        assert _same(want["meanDiff"], got["meanDiff"]), (i, want, got)
        assert _same(want["lo"], got["lo"]), (i, want, got)
        assert _same(want["hi"], got["hi"]), (i, want, got)
        assert got["crossesZero"] == want["crossesZero"], i


def test_fixture_covers_the_edge_cases() -> None:
    ns = [c["ci"]["n"] for c in GOLDEN["bootstrap"]["cases"]]
    assert 0 in ns and 1 in ns and max(ns) >= 41


def test_left_fold_not_compensated_sum() -> None:
    # Python 3.12+ sum() compensates; a plain fold of these differs, and the
    # port must follow the fold the way JS reduce does.
    diffs = [0.1] * 10
    ci = paired_bootstrap_ci(diffs, 1, make_rng(1))
    fold = 0.0
    for d in diffs:
        fold += d
    assert ci["meanDiff"] == fold / 10
    assert fold / 10 != sum(diffs) / 10


def test_percentile_nearest_rank() -> None:
    assert percentile([1.0, 2.0, 3.0, 4.0], 0.5) == 2.0
    assert percentile([5.0], 0.975) == 5.0
    assert math.isnan(percentile([], 0.5))
