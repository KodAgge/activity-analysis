"""Recurring routes: which runs follow the same path, and where each stands.

`analysis.routes` decides what a route is - traces resampled to 200 points by
distance, grouped by complete linkage, at least three runs - and what an
eligible run on one is, restated in `docs/reference/derived-layer.md`'s
"Route eligibility follows the records rule" and derived in
`docs/reference/math/routes.md`. This router computes none of that: every
field below is a stored column, or the `rank = 1` row of `route_runs`, the
same split every other endpoint in this file keeps.

`GET /api/routes/{route_id}` names the runs oldest first, which is how the
athlete built the route rather than how it stands today; the current record
is the `rank = 1` run, served on `GET /api/routes` and inside the detail's own
`RouteSummary` alike.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from activity_analysis.api import queries
from activity_analysis.api.deps import CursorDep
from activity_analysis.api.models import RouteDetail, RouteRun, RouteSummary

router = APIRouter(tags=["routes"])


@router.get("/api/routes")
def routes(cur: CursorDep) -> list[RouteSummary]:
    """Every recurring route, most runs first and then by name."""
    return [RouteSummary(**row) for row in queries.routes(cur)]


@router.get("/api/routes/{route_id}")
def route(cur: CursorDep, route_id: str) -> RouteDetail:
    """One route's runs, oldest first, with the route's own summary.

    A route's id is the earliest run's `activity_id`, but this takes whatever
    id `GET /api/routes` handed back rather than assuming that shape, and 404s
    for one the store does not know.
    """
    summary = queries.route(cur, route_id)
    if summary is None:
        raise HTTPException(status_code=404, detail=f"no such route: {route_id}")
    return RouteDetail(
        route=RouteSummary(**summary),
        reference_activity_id=summary["reference_activity_id"],
        runs=[RouteRun(**row) for row in queries.route_runs(cur, route_id)],
    )
