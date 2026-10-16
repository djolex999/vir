import math
from dataclasses import dataclass

from .bootstrap import BootstrapCI, paired_bootstrap_ci
from .pairs import paired_diffs
from .record import Comparison, RunRecord, RunRecordError, arm_by_id
from .rng import make_rng


@dataclass(frozen=True)
class Mismatch:
    index: int
    comparison: Comparison
    recomputed: BootstrapCI


def _same(stored: float | None, recomputed: float) -> bool:
    # A run record stores NaN as null (JSON.stringify).
    if stored is None or math.isnan(stored):
        return math.isnan(recomputed)
    return stored == recomputed


def recompute_comparisons(record: RunRecord) -> list[BootstrapCI]:
    """Every stored comparison, recomputed from perQuery in stored order with
    one RNG seeded from the record, exactly as runBaseline drew them."""
    rng = make_rng(record["seed"])
    out: list[BootstrapCI] = []
    for c in record["comparisons"]:
        arm_a = arm_by_id(record, c["a"])
        arm_b = arm_by_id(record, c["b"])
        if arm_a is None or arm_b is None:
            raise RunRecordError(f"comparison {c['a']} vs {c['b']} names an arm the record does not carry")
        diffs = paired_diffs(arm_a["perQuery"], arm_b["perQuery"], c["class"], c["metric"])
        out.append(paired_bootstrap_ci(diffs, record["bootstrapRounds"], rng))
    return out


def verify(record: RunRecord) -> list[Mismatch]:
    """Empty list = the Python port reproduces every CI in the record exactly,
    so cross-run CIs from `diff` are computed by the same method."""
    mismatches: list[Mismatch] = []
    for i, (c, ci) in enumerate(zip(record["comparisons"], recompute_comparisons(record), strict=True)):
        s = c["ci"]
        ok = (
            s["n"] == ci["n"]
            and _same(s["meanDiff"], ci["meanDiff"])
            and _same(s["lo"], ci["lo"])
            and _same(s["hi"], ci["hi"])
            and s["crossesZero"] == ci["crossesZero"]
        )
        if not ok:
            mismatches.append(Mismatch(i, c, ci))
    return mismatches
