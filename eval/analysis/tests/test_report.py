from pathlib import Path

from factory import arm, pq, record, two_arm_record
from vir_eval_analysis.report import per_query_frame, run_slug, summary_markdown, write_report


def test_per_query_frame_is_delta_vs_baseline_ranked_only() -> None:
    df = per_query_frame(two_arm_record())
    assert set(df["arm"]) == {"other"}
    assert "garbage" not in set(df["class"])
    r1 = df[df["queryId"] == "r1"].iloc[0]
    assert abs(float(r1["ndcg"]) - 0.2) < 1e-12
    # baseline undefined on c1 → no delta
    c1 = df[df["queryId"] == "c1"].iloc[0]
    assert c1["ndcg"] is None or c1["ndcg"] != c1["ndcg"]


def test_summary_flags_small_samples_and_lists_detectable_only() -> None:
    qs = [f"q{i}" for i in range(12)]
    base = arm("base", [pq(q, "real", 0.2) for q in qs])
    better = arm("better", [pq(q, "real", 0.6 + i / 100) for i, q in enumerate(qs)])
    md = summary_markdown(record([base, better], baseline="base"))
    assert "**Small samples:**" in md and "real (n=12)" in md
    assert "better vs base · real · ndcg" in md
    assert "better vs base · conceptual" not in md


def test_summary_says_none_when_nothing_is_detectable() -> None:
    assert "None: every comparison CI crosses zero." in summary_markdown(two_arm_record())


def test_write_report_writes_under_given_root_with_ts_slug(tmp_path: Path) -> None:
    r = two_arm_record(ts="2026-10-01T12:34:56.789Z")
    files = write_report(r, tmp_path)
    assert files.out_dir == tmp_path / "2026-10-01T12-34-56-789Z" == tmp_path / run_slug(r)
    for f in (files.summary, files.forest, files.per_query):
        assert f.is_file() and f.stat().st_size > 0
    assert files.forest.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"


def test_single_query_difference_is_not_reported_as_detectable() -> None:
    # The bootstrap now marks n = 1 as crossing zero; records written before
    # that fix stored False there, and analysis must still not report them.
    r = two_arm_record()
    singles = [c for c in r["comparisons"] if c["ci"]["n"] == 1]
    assert singles and all(c["ci"]["crossesZero"] for c in singles)
    for c in singles:
        c["ci"]["crossesZero"] = False  # legacy record
    assert "identifier" not in summary_markdown(r).split("## detectable")[1]
