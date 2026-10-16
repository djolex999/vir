import math

from vir_eval_analysis.bootstrap import BootstrapCI, paired_bootstrap_ci
from vir_eval_analysis.pairs import paired_diffs
from vir_eval_analysis.record import COMPARISON_CLASSES, METRICS, ArmReport, ClassAggregate, Comparison, PerQuery, RunRecord, StoredCI
from vir_eval_analysis.rng import make_rng

# Synthetic run records for tests. Never real eval data: the repo is public.


def pq(qid: str, cls: str, ndcg: float | None, recall: float | None = None, mrr: float | None = None) -> PerQuery:
    return {
        "queryId": qid,
        "class": cls,
        "ndcg": ndcg,
        "recall": ndcg if recall is None else recall,
        "mrr": ndcg if mrr is None else mrr,
        "unjudged": 0.0,
        "contamination": 0.0,
    }


def _json_float(x: float) -> float | None:
    return None if math.isnan(x) else x


def _as_stored(ci: BootstrapCI) -> StoredCI:
    # What JSON.stringify leaves of a CI: NaN becomes null.
    return {"n": ci["n"], "meanDiff": _json_float(ci["meanDiff"]), "lo": _json_float(ci["lo"]), "hi": _json_float(ci["hi"]), "crossesZero": ci["crossesZero"]}


def _agg(n: int) -> ClassAggregate:
    return {"n": n, "ndcg": 0.5, "recall": 0.5, "mrr": 0.5, "unjudged": 0.0, "contamination": 0.0}


def arm(arm_id: str, per_query: list[PerQuery]) -> ArmReport:
    by_class = {c: _agg(sum(1 for q in per_query if q["class"] == c)) for c in (*COMPARISON_CLASSES, "garbage")}
    return {
        "id": arm_id,
        "label": arm_id,
        "byClass": by_class,
        "garbage": {"n": 0, "anyHit": None, "viaEmbedding": None, "viaFallback": None},
        "perQuery": per_query,
    }


def record(
    arms: list[ArmReport],
    *,
    baseline: str,
    seed: int = 11,
    rounds: int = 200,
    ts: str = "2026-10-01T00:00:00.000Z",
    queries_hash: str = "q" * 12,
    labels_hash: str = "l" * 12,
    rubric_hash: str = "r" * 12,
    k: int = 8,
    configs: dict[str, dict[str, object]] | None = None,
    dirty: bool = False,
) -> RunRecord:
    """Comparisons are filled the way runBaseline does: each arm vs baseline,
    shared RNG, classes × metrics in order."""
    rng = make_rng(seed)
    by_id = {a["id"]: a for a in arms}
    comparisons: list[Comparison] = []
    for a in arms:
        if a["id"] == baseline:
            continue
        for cls in COMPARISON_CLASSES:
            for metric in METRICS:
                diffs = paired_diffs(a["perQuery"], by_id[baseline]["perQuery"], cls, metric)
                ci = paired_bootstrap_ci(diffs, rounds, rng)
                comparisons.append({"a": a["id"], "b": baseline, "class": cls, "metric": metric, "ci": _as_stored(ci)})
    return {
        "version": 1,
        "ts": ts,
        "git": {"sha": "0" * 40, "dirty": dirty, "branch": "test"},
        "k": k,
        "seed": seed,
        "bootstrapRounds": rounds,
        "baselineArm": baseline,
        "inputs": {"queriesHash": queries_hash, "labelsHash": labels_hash, "rubricHash": rubric_hash, "queryCount": 0, "labelCount": 0},
        "arms": arms,
        "comparisons": comparisons,
        "armConfigs": configs if configs is not None else {a["id"]: {} for a in arms},
    }


def two_arm_record(**kw: object) -> RunRecord:
    base = arm("base", [pq("r1", "real", 0.5), pq("r2", "real", 0.2), pq("i1", "identifier", 1.0), pq("c1", "conceptual", None), pq("g1", "garbage", None)])
    other = arm("other", [pq("r1", "real", 0.7), pq("r2", "real", 0.1), pq("i1", "identifier", 0.9), pq("c1", "conceptual", 0.4), pq("g1", "garbage", None)])
    return record([base, other], baseline="base", **kw)  # pyright: ignore[reportArgumentType]
