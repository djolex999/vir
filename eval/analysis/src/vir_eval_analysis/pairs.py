from .record import Metric, PerQuery


def paired_diffs(a: list[PerQuery], b: list[PerQuery], cls: str, metric: Metric) -> list[float]:
    """Per-query a − b, port of the diff loop in runBaseline (eval/run.ts).

    Order follows `a`, garbage never counts, "all-ranked" takes every ranked
    class, and a query is skipped when either side is undefined (null). The
    order matters: it decides which diffs the shared RNG resamples.
    """
    by_id = {q["queryId"]: q for q in b}
    out: list[float] = []
    for qa in a:
        if cls != "all-ranked" and qa["class"] != cls:
            continue
        if qa["class"] == "garbage":
            continue
        qb = by_id.get(qa["queryId"])
        va = qa[metric]
        vb = qb[metric] if qb is not None else None
        if va is None or vb is None:
            continue
        out.append(va - vb)
    return out
