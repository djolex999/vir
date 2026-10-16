import math
from collections.abc import Sequence
from typing import TypedDict

from .rng import Rng


class BootstrapCI(TypedDict):
    n: int
    meanDiff: float
    lo: float
    hi: float
    crossesZero: bool


def _left_sum(values: Sequence[float]) -> float:
    # Python 3.12+ sum() uses compensated summation for floats; JS reduce is a
    # plain left fold. Exact parity with the TS numbers needs the plain fold.
    total = 0.0
    for v in values:
        total += v
    return total


def percentile(sorted_values: Sequence[float], p: float) -> float:
    """Nearest-rank percentile, port of eval/metrics/bootstrap.ts percentile."""
    if len(sorted_values) == 0:
        return math.nan
    idx = math.floor(p * (len(sorted_values) - 1))
    return sorted_values[min(len(sorted_values) - 1, max(0, idx))]


def paired_bootstrap_ci(diffs: Sequence[float], rounds: int, rng: Rng) -> BootstrapCI:
    """Port of pairedBootstrapCI. Consumes rng draws in the same order, so a
    shared rng reproduces a whole run's comparisons exactly."""
    n = len(diffs)
    if n == 0:
        return {"n": 0, "meanDiff": math.nan, "lo": math.nan, "hi": math.nan, "crossesZero": True}
    mean_diff = _left_sum(diffs) / n
    if n == 1:
        # One query: a point, not an interval; never a detectable difference.
        return {"n": n, "meanDiff": mean_diff, "lo": mean_diff, "hi": mean_diff, "crossesZero": True}
    means: list[float] = []
    for _ in range(rounds):
        total = 0.0
        for _ in range(n):
            total += diffs[math.floor(rng() * n)]
        means.append(total / n)
    means.sort()
    lo = percentile(means, 0.025)
    hi = percentile(means, 0.975)
    return {"n": n, "meanDiff": mean_diff, "lo": lo, "hi": hi, "crossesZero": lo <= 0 and hi >= 0}


class CIVerdict(TypedDict):
    # The two fields a verdict needs; both BootstrapCI and a stored CI fit it.
    n: int
    crossesZero: bool


def is_detectable(ci: CIVerdict) -> bool:
    """A CI that excludes zero on at least two queries.

    pairedBootstrapCI sets crossesZero at n = 1 itself; the n check also
    covers run records written before that fix, which stored False there.
    """
    return ci["n"] >= 2 and not ci["crossesZero"]
