import json
from pathlib import Path
from typing import Literal, TypedDict, cast

from .paths import EVAL_RUNS_DIR

# Mirrors RunRecord in eval/run.ts (version 1), the source of truth.
# JSON.stringify writes NaN as null, so floats the TS side can leave NaN are
# `float | None` here.

RANKED_CLASSES = ("real", "identifier", "conceptual")
COMPARISON_CLASSES = (*RANKED_CLASSES, "all-ranked")
Metric = Literal["ndcg", "recall", "mrr"]
METRICS: tuple[Metric, ...] = ("ndcg", "recall", "mrr")

# Functional syntax because "class" is a Python keyword.
PerQuery = TypedDict(
    "PerQuery",
    {
        "queryId": str,
        "class": str,
        "ndcg": float | None,
        "recall": float | None,
        "mrr": float | None,
        "unjudged": float,
        "contamination": float,
    },
)


class ClassAggregate(TypedDict):
    n: int
    ndcg: float | None
    recall: float | None
    mrr: float | None
    unjudged: float
    contamination: float


class GarbageRates(TypedDict):
    n: int
    anyHit: float | None
    viaEmbedding: float | None
    viaFallback: float | None


class ArmReport(TypedDict):
    id: str
    label: str
    byClass: dict[str, ClassAggregate]
    garbage: GarbageRates
    perQuery: list[PerQuery]


class StoredCI(TypedDict):
    n: int
    meanDiff: float | None
    lo: float | None
    hi: float | None
    crossesZero: bool


Comparison = TypedDict(
    "Comparison",
    {"a": str, "b": str, "class": str, "metric": Metric, "ci": StoredCI},
)


class GitInfo(TypedDict):
    sha: str
    dirty: bool
    branch: str


class Inputs(TypedDict):
    queriesHash: str
    labelsHash: str
    rubricHash: str
    queryCount: int
    labelCount: int


class RunRecord(TypedDict):
    version: int
    ts: str
    git: GitInfo
    k: int
    seed: int
    bootstrapRounds: int
    baselineArm: str
    inputs: Inputs
    arms: list[ArmReport]
    comparisons: list[Comparison]
    armConfigs: dict[str, dict[str, object]]


class RunRecordError(Exception):
    pass


_TOP_KEYS = ("version", "ts", "git", "k", "seed", "bootstrapRounds", "baselineArm", "inputs", "arms", "comparisons", "armConfigs")
_PER_QUERY_KEYS = ("queryId", "class", "ndcg", "recall", "mrr", "unjudged", "contamination")
_VALID_CLASSES = (*RANKED_CLASSES, "garbage")


def _require_keys(obj: object, keys: tuple[str, ...], where: str) -> dict[str, object]:
    if not isinstance(obj, dict):
        raise RunRecordError(f"{where}: expected an object, got {type(obj).__name__}")
    d = cast(dict[str, object], obj)
    missing = [k for k in keys if k not in d]
    if missing:
        raise RunRecordError(f"{where}: missing {', '.join(missing)}")
    return d


def parse_run(raw: object, source: str) -> RunRecord:
    """Shape-check a decoded run record at the boundary, then trust the types."""
    top = _require_keys(raw, _TOP_KEYS, source)
    if top["version"] != 1:
        raise RunRecordError(f"{source}: run record version {top['version']!r}, this tool reads version 1 only")
    arms = top["arms"]
    if not isinstance(arms, list):
        raise RunRecordError(f"{source}: arms is not a list")
    for i, arm_obj in enumerate(cast(list[object], arms)):
        arm = _require_keys(arm_obj, ("id", "byClass", "perQuery"), f"{source} arms[{i}]")
        per_query = arm["perQuery"]
        if not isinstance(per_query, list):
            raise RunRecordError(f"{source} arms[{i}].perQuery is not a list")
        for j, pq_obj in enumerate(cast(list[object], per_query)):
            pq = _require_keys(pq_obj, _PER_QUERY_KEYS, f"{source} arms[{i}].perQuery[{j}]")
            if pq["class"] not in _VALID_CLASSES:
                raise RunRecordError(f"{source} arms[{i}].perQuery[{j}]: unknown class {pq['class']!r}")
    comparisons = top["comparisons"]
    if not isinstance(comparisons, list):
        raise RunRecordError(f"{source}: comparisons is not a list")
    for i, c_obj in enumerate(cast(list[object], comparisons)):
        c = _require_keys(c_obj, ("a", "b", "class", "metric", "ci"), f"{source} comparisons[{i}]")
        if c["metric"] not in METRICS:
            raise RunRecordError(f"{source} comparisons[{i}]: unknown metric {c['metric']!r}")
    return cast(RunRecord, top)


def load_run(path: Path) -> RunRecord:
    try:
        raw: object = json.loads(path.read_text(encoding="utf8"))
    except FileNotFoundError:
        raise RunRecordError(f"no run record at {path}") from None
    except json.JSONDecodeError as e:
        raise RunRecordError(f"{path}: not valid JSON ({e})") from None
    return parse_run(raw, str(path))


def list_runs(runs_dir: Path = EVAL_RUNS_DIR) -> list[Path]:
    """Run records oldest first; file names are ISO timestamps, so name order is time order."""
    if not runs_dir.is_dir():
        return []
    return sorted(p for p in runs_dir.iterdir() if p.suffix == ".json")


def resolve_run(arg: str | None, runs_dir: Path = EVAL_RUNS_DIR, *, from_end: int = 1) -> Path:
    """A path, a bare file name in the runs dir, or (None) the from_end-th newest run."""
    if arg is not None:
        p = Path(arg)
        if p.exists():
            return p
        candidate = runs_dir / (arg if arg.endswith(".json") else f"{arg}.json")
        if candidate.exists():
            return candidate
        raise RunRecordError(f"no run record {arg!r} (looked at {p} and {candidate})")
    runs = list_runs(runs_dir)
    if len(runs) < from_end:
        raise RunRecordError(f"need {from_end} run record(s) in {runs_dir}, found {len(runs)}; run `npm run eval -- run` first")
    return runs[-from_end]


def arm_by_id(record: RunRecord, arm_id: str) -> ArmReport | None:
    return next((a for a in record["arms"] if a["id"] == arm_id), None)
