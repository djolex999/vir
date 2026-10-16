import json
from pathlib import Path

import pytest

from factory import two_arm_record
from vir_eval_analysis import cli
from vir_eval_analysis.record import RunRecord


def _write(tmp: Path, r: RunRecord, name: str) -> Path:
    p = tmp / name
    p.write_text(json.dumps(r), encoding="utf8")
    return p


def test_verify_exit_codes(tmp_path: Path) -> None:
    good = _write(tmp_path, two_arm_record(), "good.json")
    bad_record = two_arm_record()
    bad_record["comparisons"][0]["ci"]["lo"] = 9.0
    bad = _write(tmp_path, bad_record, "bad.json")
    assert cli.main(["verify", str(good)]) == 0
    assert cli.main(["verify", str(bad)]) == 1
    assert cli.main(["verify", str(tmp_path / "missing.json")]) == 2


def test_diff_orders_by_ts_and_refuses_incomparable(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.setattr(cli, "ANALYSIS_DIR", tmp_path / "analysis")
    old = _write(tmp_path, two_arm_record(ts="2026-10-01T00:00:00.000Z"), "a.json")
    new = _write(tmp_path, two_arm_record(ts="2026-10-02T00:00:00.000Z"), "b.json")
    assert cli.main(["diff", str(new), str(old)]) == 0
    out = capsys.readouterr().out
    assert "old 2026-10-01T00:00:00.000Z  →  new 2026-10-02T00:00:00.000Z" in out
    assert len(list((tmp_path / "analysis").glob("diff_*.md"))) == 1
    other = _write(tmp_path, two_arm_record(ts="2026-10-03T00:00:00.000Z", labels_hash="z" * 12), "c.json")
    assert cli.main(["diff", str(old), str(other)]) == 2
    assert "not comparable" in capsys.readouterr().err


def test_diff_refuses_the_same_record_twice(tmp_path: Path) -> None:
    p = _write(tmp_path, two_arm_record(), "a.json")
    assert cli.main(["diff", str(p), str(p)]) == 2


def test_rejects_unknown_record_version(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    r = dict(two_arm_record())
    r["version"] = 2
    p = tmp_path / "v2.json"
    p.write_text(json.dumps(r), encoding="utf8")
    assert cli.main(["verify", str(p)]) == 2
    assert "version 1 only" in capsys.readouterr().err
