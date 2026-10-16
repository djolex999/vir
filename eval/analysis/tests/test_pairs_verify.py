import copy

import pytest

from factory import arm, pq, record, two_arm_record
from vir_eval_analysis.pairs import paired_diffs
from vir_eval_analysis.record import RunRecordError
from vir_eval_analysis.verify import verify


def test_paired_diffs_follows_a_order_and_skips_nulls_and_garbage() -> None:
    a = [pq("x", "real", 0.9), pq("y", "real", None), pq("g", "garbage", 1.0), pq("z", "identifier", 0.5)]
    b = [pq("z", "identifier", 0.25), pq("x", "real", 0.4), pq("y", "real", 0.1), pq("g", "garbage", 0.0)]
    assert paired_diffs(a, b, "real", "ndcg") == [0.5]
    assert paired_diffs(a, b, "all-ranked", "ndcg") == [0.5, 0.25]
    assert paired_diffs(a, b, "conceptual", "ndcg") == []


def test_paired_diffs_skips_queries_missing_from_b() -> None:
    assert paired_diffs([pq("only-a", "real", 1.0)], [], "real", "ndcg") == []


def test_verify_passes_on_a_consistent_record() -> None:
    assert verify(two_arm_record()) == []


def test_verify_flags_a_tampered_ci() -> None:
    r = two_arm_record()
    bad = copy.deepcopy(r)
    bad["comparisons"][3]["ci"]["hi"] = 0.123456
    mismatches = verify(bad)
    assert [m.index for m in mismatches] == [3]


def test_verify_is_order_sensitive_like_the_shared_rng() -> None:
    # Swapping two comparisons changes which draws each gets; a port that
    # ignored order would still "pass".
    a = arm("a", [pq(f"q{i}", "real", i / 10) for i in range(6)])
    b = arm("b", [pq(f"q{i}", "real", (5 - i) / 10) for i in range(6)])
    r = record([b, a], baseline="b")
    swapped = copy.deepcopy(r)
    swapped["comparisons"][0], swapped["comparisons"][1] = swapped["comparisons"][1], swapped["comparisons"][0]
    assert verify(r) == []
    assert verify(swapped) != []


def test_verify_rejects_a_comparison_naming_a_missing_arm() -> None:
    r = two_arm_record()
    r["comparisons"][0]["a"] = "ghost"
    with pytest.raises(RunRecordError, match="ghost"):
        verify(r)
