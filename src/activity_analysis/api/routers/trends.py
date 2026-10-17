"""Normalised efficiency trends, one point per activity.

Raw average heart rate over time mostly measures how fast the athlete
happened to run that day. Run-average speed varies enough across this
athlete's history that, through heart rate's slope against speed, the
session-to-session noise is about 1.1 times a real year's fitness change. This
endpoint serves the counterfactual instead: what heart rate and cadence
would have been at each of three fixed reference paces.

Nothing is computed here. `activity_efficiency` and `athlete_fit` are written
by the efficiency pass at recompute time and projected by `queries.trends`;
on a store where that pass has not run, both are empty and this serves an
empty list with null references rather than an error.
"""

from __future__ import annotations

from fastapi import APIRouter

from activity_analysis.api import queries
from activity_analysis.api.deps import CursorDep
from activity_analysis.api.models import ReferencePacesOut, TrendPoint, Trends

router = APIRouter(tags=["trends"])


@router.get("/api/trends")
def trends(cur: CursorDep) -> Trends:
    """Heart rate and cadence at the three reference paces, per activity, oldest first."""
    fit, rows = queries.trends(cur)
    shared = fit or {}
    return Trends(
        references=ReferencePacesOut(
            slow_mps=shared.get("ref_slow_mps"),
            median_mps=shared.get("ref_median_mps"),
            fast_mps=shared.get("ref_fast_mps"),
        ),
        hr_slope_shared_bpm_per_mps=shared.get("hr_slope_shared_bpm_per_mps"),
        cadence_slope_shared_spm_per_mps=shared.get("cadence_slope_shared_spm_per_mps"),
        items=[TrendPoint.model_validate(row) for row in rows],
    )
