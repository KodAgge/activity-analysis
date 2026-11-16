"""The training plans: ``data/plans/`` served read-only.

Every route reads the files ``activity-analysis plan`` wrote and computes
nothing. Like the basemap, the plans are read as files and never through
DuckDB, and the server never writes to them: proposing, accepting and
rejecting stay in the CLI. The context files a version was written from are
not served.
"""

from __future__ import annotations

import re

from fastapi import APIRouter, HTTPException

from activity_analysis.api.deps import PathsDep
from activity_analysis.api.models import PlanDetail, Plans, PlanSummary, PlanVersionEntry
from activity_analysis.plan.models import ID_PATTERN
from activity_analysis.plan.store import PlanStore, PlanStoreError

router = APIRouter(tags=["plans"])

_GOAL_ID = re.compile(ID_PATTERN)


def _unreadable(error: PlanStoreError) -> HTTPException:
    """503, the store being unreadable: a truncated or hand-edited plan file.

    The message names the file, the same convention as the basemap manifest.
    """
    return HTTPException(status_code=503, detail=str(error))


@router.get("/api/plans")
def plans(paths: PathsDep) -> Plans:
    store = PlanStore(paths)
    try:
        items = []
        for index in store.goals():
            # Pending, else accepted, else newest: a rejected revision never
            # described the goal, so its figures are not the goal's.
            shown = store.current(index)
            by_status = {e.status: e.number for e in index.versions}
            items.append(
                PlanSummary(
                    goal_id=index.goal_id,
                    status=index.status,
                    distance_m=shown.goal.distance_m,
                    target_time_s=shown.goal.target_time_s,
                    race_date=shown.goal.race_date,
                    accepted_version=by_status.get("accepted"),
                    pending_version=by_status.get("proposed"),
                )
            )
    except PlanStoreError as error:
        raise _unreadable(error) from error
    return Plans(items=items)


@router.get("/api/plans/{goal_id}")
def plan(goal_id: str, paths: PathsDep) -> PlanDetail:
    """404 for an id that is not a goal id, before any path is built from it."""
    if not _GOAL_ID.fullmatch(goal_id) or not (paths.plan_dir(goal_id) / "index.json").is_file():
        raise HTTPException(status_code=404, detail=f"no plan for goal {goal_id}")
    store = PlanStore(paths)
    try:
        index = store.index(goal_id)
        versions = [
            PlanVersionEntry(
                number=e.number, status=e.status, plan=store.version(goal_id, e.number)
            )
            for e in index.versions
        ]
    except PlanStoreError as error:
        raise _unreadable(error) from error
    return PlanDetail(goal_id=index.goal_id, status=index.status, versions=versions)
