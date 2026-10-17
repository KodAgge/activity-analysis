"""The VO2max series, by both methods.

Two estimators live on one chart because they answer the same question from
different evidence: the heart rate method reads sustained intensity from
ordinary running, VDOT reads it from the best efforts the extractor found.
Each is smoothed over a trailing calendar window and only the trend is
claimed; the level is a model output, and the chart has to say so.

Nothing is computed here. `fitness_series` holds both estimates and both
smoothed columns per activity, written by `analysis/fitness.py` at recompute
time, and this route projects it; see `queries.fitness`. `device` is a
projection of the canonical `device_vo2max` table, Garmin's own VO2max by day.
"""

from __future__ import annotations

from fastapi import APIRouter

from activity_analysis.api import queries
from activity_analysis.api.deps import CursorDep
from activity_analysis.api.models import DeviceVo2maxPoint, Fitness, FitnessPoint

router = APIRouter(tags=["fitness"])


@router.get("/api/fitness")
def fitness(cur: CursorDep) -> Fitness:
    """Both VO2max estimates per contributing activity, oldest first."""
    return Fitness(
        items=[FitnessPoint.model_validate(row) for row in queries.fitness(cur)],
        device=[DeviceVo2maxPoint.model_validate(row) for row in queries.device_vo2max(cur)],
    )
