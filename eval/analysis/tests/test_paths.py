from pathlib import Path

from vir_eval_analysis import paths

# Python twin of eval/noLeak.test.ts: every data path lives under ~/.vir/eval
# and never inside the repo.
REPO_ROOT = Path(__file__).resolve().parents[3]
EVAL_HOME = Path.home() / ".vir" / "eval"


def test_every_path_constant_is_under_vir_eval_and_outside_the_repo() -> None:
    consts = {k: v for k, v in vars(paths).items() if isinstance(v, Path)}
    assert consts
    for name, value in consts.items():
        assert value.is_absolute(), name
        assert value == EVAL_HOME or EVAL_HOME in value.parents, f"{name}={value}"
        assert REPO_ROOT not in value.parents, f"{name} inside repo"
