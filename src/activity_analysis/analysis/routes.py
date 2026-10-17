"""Recurring routes: which runs followed the same path, and how each compares.

Two runs are the same route when their traces, resampled to 200 points by
distance, stay close on average and nowhere stray far once the first and
last 5% are set aside. The thresholds, and the measurements behind each, are
in docs/reference/math/routes.md.
"""

from __future__ import annotations

import math
from collections import Counter
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal

import numpy as np
import pandas as pd

from activity_analysis.analysis.best_efforts import (
    JUMP_UNCHECKABLE,
    JUMP_UNCONFIRMED,
    JUMP_UNKNOWN,
    jump_reasons,
)
from activity_analysis.config import ANALYSIS_VERSION
from activity_analysis.models import ROUTE_RUN_SCHEMA, ROUTE_SCHEMA, empty_frame

TRACE_POINTS = 200
#: Points set aside at each end before taking the worst point: 5% of the
#: length, where a watch started or stopped at a different spot shows.
TRIM_POINTS = 10
CANDIDATE_START_M = 300.0
CANDIDATE_DISTANCE_FRACTION = 0.15
MAX_MEAN_M = 20.0
MAX_WORST_M = 150.0
MIN_RUNS = 3
#: A run is ``reverse`` only when its point-by-point distance to the earliest
#: run read backwards is under this fraction of its distance read forwards.
REVERSE_FRACTION = 0.5
#: Fewer usable samples than this is no trace.
MIN_SAMPLES = 10
EARTH_RADIUS_M = 6_371_000.0

#: The reason a run cannot set or beat a route record that routes alone have.
#: The three jump reasons are `best_efforts`' own, the strings
#: `api/queries.py`'s `progression` serves for the same causes.
GPX = "GPX-sourced"

Direction = Literal["forward", "reverse"]


def resample_trace(distance_m: np.ndarray, lat: np.ndarray, lon: np.ndarray) -> np.ndarray | None:
    """``TRACE_POINTS`` positions evenly spaced along the odometer, or None."""
    ok = np.isfinite(distance_m) & np.isfinite(lat) & np.isfinite(lon)
    if int(ok.sum()) < MIN_SAMPLES:
        return None
    d = np.maximum.accumulate(distance_m[ok])
    if not d[-1] > d[0]:
        return None
    q = np.linspace(d[0], d[-1], TRACE_POINTS)
    return np.column_stack([np.interp(q, d, lat[ok]), np.interp(q, d, lon[ok])])


def _project(trace: np.ndarray, lat0: float, lon0: float) -> np.ndarray:
    """Metres east and north of ``(lat0, lon0)`` on the plane tangent there."""
    x = np.radians(trace[:, 1] - lon0) * EARTH_RADIUS_M * math.cos(math.radians(lat0))
    y = np.radians(trace[:, 0] - lat0) * EARTH_RADIUS_M
    return np.column_stack([x, y])


@dataclass(frozen=True)
class PairMetrics:
    mean_m: float
    worst_m: float


def pair_metrics(a: np.ndarray, b: np.ndarray) -> PairMetrics:
    """How far apart two traces are, on the plane centred on ``a``'s start."""
    lat0, lon0 = float(a[0, 0]), float(a[0, 1])
    pa, pb = _project(a, lat0, lon0), _project(b, lat0, lon0)
    d = np.hypot(pa[:, None, 0] - pb[None, :, 0], pa[:, None, 1] - pb[None, :, 1])
    a_to_b, b_to_a = d.min(axis=1), d.min(axis=0)
    inner = slice(TRIM_POINTS, TRACE_POINTS - TRIM_POINTS)
    return PairMetrics(
        mean_m=float((a_to_b.mean() + b_to_a.mean()) / 2),
        worst_m=float(max(a_to_b[inner].max(), b_to_a[inner].max())),
    )


def _pointwise_mean_m(pa: np.ndarray, pb: np.ndarray) -> float:
    """Mean distance between point k of one projected trace and point k of the other."""
    return float(np.mean(np.hypot(*(pa - pb).T)))


def is_out_and_back(trace: np.ndarray) -> bool:
    """Whether ``trace`` read backwards lies within ``MAX_MEAN_M`` of itself, point by point.

    On such a route, running it the other way traces the same points in
    nearly the same order, so no run can be told apart by direction.
    """
    p = _project(trace, float(trace[0, 0]), float(trace[0, 1]))
    return _pointwise_mean_m(p, p[::-1]) <= MAX_MEAN_M


def direction(first: np.ndarray, trace: np.ndarray) -> Direction:
    """``trace``'s direction against ``first``, on the plane centred on ``first``'s start.

    ``reverse`` only when ``first`` read backwards is under
    ``REVERSE_FRACTION`` of the distance to ``first`` read forwards, so a
    near tie stays ``forward``.
    """
    lat0, lon0 = float(first[0, 0]), float(first[0, 1])
    pf, pt = _project(first, lat0, lon0), _project(trace, lat0, lon0)
    forward = _pointwise_mean_m(pf, pt)
    backward = _pointwise_mean_m(pf[::-1], pt)
    return "reverse" if backward < REVERSE_FRACTION * forward else "forward"


@dataclass(frozen=True)
class RunInput:
    activity_id: str
    start_time_utc: pd.Timestamp
    distance_m: float
    locality: str | None
    trace: np.ndarray


@dataclass(frozen=True)
class Route:
    route_id: str
    name: str
    locality: str | None
    #: Oldest first, by ``start_time_utc`` then ``activity_id``.
    run_ids: tuple[str, ...]
    reference_activity_id: str
    median_distance_m: float
    #: Against the earliest run, ``run_ids[0]``, which is also the route id.
    directions: dict[str, Direction]
    #: Each run's link to the reference run; the reference's own is zero.
    metrics: dict[str, PairMetrics]


def _links(runs: list[RunInput]) -> dict[frozenset[str], PairMetrics]:
    """Every candidate pair that passes both distance tests."""
    links: dict[frozenset[str], PairMetrics] = {}
    for i, a in enumerate(runs):
        for b in runs[i + 1 :]:
            longer = max(a.distance_m, b.distance_m)
            if abs(a.distance_m - b.distance_m) > CANDIDATE_DISTANCE_FRACTION * longer:
                continue
            start = _project(b.trace[:1], float(a.trace[0, 0]), float(a.trace[0, 1]))[0]
            if math.hypot(*start) > CANDIDATE_START_M:
                continue
            m = pair_metrics(a.trace, b.trace)
            if m.mean_m <= MAX_MEAN_M and m.worst_m <= MAX_WORST_M:
                links[frozenset((a.activity_id, b.activity_id))] = m
    return links


def _complete_linkage(ids: list[str], links: dict[frozenset[str], PairMetrics]) -> list[list[str]]:
    """Agglomerate while every cross pair links, closest complete distance first.

    ``ids`` arrive in tie-break order, and a strictly smaller distance is
    needed to displace an earlier candidate, so the result does not depend on
    the order the runs were read in.
    """
    clusters = [[i] for i in ids]
    while True:
        best: tuple[float, int, int] | None = None
        for x in range(len(clusters)):
            for y in range(x + 1, len(clusters)):
                worst = 0.0
                for p in clusters[x]:
                    for q in clusters[y]:
                        link = links.get(frozenset((p, q)))
                        if link is None:
                            worst = math.inf
                            break
                        worst = max(worst, link.mean_m)
                    if worst == math.inf:
                        break
                if worst != math.inf and (best is None or worst < best[0]):
                    best = (worst, x, y)
        if best is None:
            return clusters
        _, x, y = best
        clusters[x] = clusters[x] + clusters[y]
        del clusters[y]


def group_routes(runs: list[RunInput]) -> list[Route]:
    ordered = sorted(runs, key=lambda r: (r.start_time_utc, r.activity_id))
    by_id = {r.activity_id: r for r in ordered}
    links = _links(ordered)
    linked = [r.activity_id for r in ordered if any(r.activity_id in k for k in links)]
    clusters = [c for c in _complete_linkage(linked, links) if len(c) >= MIN_RUNS]

    drafts = []
    for members in clusters:
        members = sorted(members, key=lambda i: (by_id[i].start_time_utc, i))

        def summed(i: str, _members: list[str] = members) -> float:
            return sum(links[frozenset((i, j))].mean_m for j in _members if j != i)

        reference = min(members, key=lambda i: (summed(i), by_id[i].start_time_utc, i))
        # Complete linkage put every pair in the cluster through the link
        # test, so the reference has a link to each member.
        metrics = {
            i: PairMetrics(0.0, 0.0) if i == reference else links[frozenset((reference, i))]
            for i in members
        }
        # Direction is measured against the earliest run, the route id, so it
        # holds when later runs move the medoid.
        first = by_id[members[0]].trace
        out_and_back = is_out_and_back(first)
        directions: dict[str, Direction] = {
            i: "forward" if out_and_back else direction(first, by_id[i].trace) for i in members
        }
        places = Counter(by_id[i].locality for i in members if by_id[i].locality)
        locality = min(places, key=lambda p: (-places[p], p)) if places else None
        median = float(np.median([by_id[i].distance_m for i in members]))
        base = f"{locality or 'Route'} {median / 1000:.1f} km"
        drafts.append((base, members, reference, locality, median, directions, metrics))

    counts = Counter(d[0] for d in drafts)
    drafts.sort(key=lambda d: (-len(d[1]), d[1][0]))
    seen: Counter[str] = Counter()
    routes = []
    for base, members, reference, locality, median, directions, metrics in drafts:
        name = base
        if counts[base] > 1:
            name = f"{base} {chr(ord('A') + seen[base])}"
            seen[base] += 1
        routes.append(
            Route(
                route_id=members[0],
                name=name,
                locality=locality,
                run_ids=tuple(members),
                reference_activity_id=reference,
                median_distance_m=median,
                directions=directions,
                metrics=metrics,
            )
        )
    return routes


def _ineligible_reason(gpx: object, grid_reason: str | None, efforts: pd.DataFrame) -> str | None:
    """Why a run cannot set a route record, or None. Unknown counts as ineligible.

    A known jump outranks an unknown one, and the run's own grid outranks its
    efforts, since the grid is what the route record times.
    """
    explicitly_not_gpx = isinstance(gpx, (bool, np.bool_)) and not bool(gpx)
    if not explicitly_not_gpx:
        return GPX
    if grid_reason is not None:
        return grid_reason
    reasons = set(jump_reasons(efforts).dropna())
    for reason in (JUMP_UNCONFIRMED, JUMP_UNCHECKABLE, JUMP_UNKNOWN):
        if reason in reasons:
            return reason
    return None


def route_tables(
    routes: list[Route],
    runs: pd.DataFrame,
    metrics: pd.DataFrame,
    efforts: pd.DataFrame,
    jumped: Mapping[str, str],
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """The ``routes`` and ``route_runs`` rows for ``routes``.

    ``jumped`` maps every run whose whole 1 Hz grid ``grid_jump_reason``
    does not trust to that reason, which catches a jump outside every
    best-effort window.
    """
    starts = runs.set_index("activity_id")["start_time_utc"]
    m = metrics.set_index("activity_id")
    route_rows: list[dict[str, Any]] = []
    run_rows: list[dict[str, Any]] = []
    for route in routes:
        rows: list[dict[str, Any]] = []
        # `run_ids` is oldest first, the order the record staircase walks.
        for aid in route.run_ids:
            distance = float(m["distance_m"].loc[aid])
            elapsed = float(m["elapsed_time_s"].loc[aid])
            reason = _ineligible_reason(
                m["is_gpx_sourced"].loc[aid],
                jumped.get(aid),
                efforts.loc[efforts["activity_id"] == aid],
            )
            rows.append(
                {
                    "route_id": route.route_id,
                    "activity_id": aid,
                    "start_time_utc": pd.Timestamp(starts[aid]),
                    "distance_m": distance,
                    "elapsed_time_s": elapsed,
                    "speed_mps": distance / elapsed,
                    "direction": route.directions[aid],
                    "eligible": reason is None,
                    "ineligible_reason": reason,
                    "rank": None,
                    "is_record": False,
                    "mean_distance_m": route.metrics[aid].mean_m,
                    "worst_distance_m": route.metrics[aid].worst_m,
                    "analysis_version": ANALYSIS_VERSION,
                }
            )
        best = -math.inf
        for r in rows:
            if r["eligible"] and r["speed_mps"] > best:
                r["is_record"] = True
                best = r["speed_mps"]
        eligible = sorted(
            (r for r in rows if r["eligible"]),
            key=lambda r: (-r["speed_mps"], r["start_time_utc"], r["activity_id"]),
        )
        for k, r in enumerate(eligible, start=1):
            r["rank"] = k
        run_rows.extend(rows)
        route_rows.append(
            {
                "route_id": route.route_id,
                "name": route.name,
                "locality": route.locality,
                "run_count": len(rows),
                "reference_activity_id": route.reference_activity_id,
                "median_distance_m": route.median_distance_m,
                "first_run_utc": rows[0]["start_time_utc"],
                "last_run_utc": rows[-1]["start_time_utc"],
                "analysis_version": ANALYSIS_VERSION,
            }
        )
    route_df = pd.DataFrame(route_rows) if route_rows else empty_frame(ROUTE_SCHEMA)
    runs_df = pd.DataFrame(run_rows) if run_rows else empty_frame(ROUTE_RUN_SCHEMA)
    return route_df, runs_df
