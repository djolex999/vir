from pathlib import Path

# Same rule as eval/paths.ts: every data path derives from the home directory
# (which honors HOME) and lives under ~/.vir/eval, never inside the repo.
EVAL_DIR = Path.home() / ".vir" / "eval"
EVAL_RUNS_DIR = EVAL_DIR / "runs"
ANALYSIS_DIR = EVAL_DIR / "analysis"
