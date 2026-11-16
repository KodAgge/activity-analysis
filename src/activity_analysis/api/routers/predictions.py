"""The predictions endpoint.

Two models are served together: one from the best efforts of the last
runs, one calibrated from ordinary running with its own residual band,
because a prediction from a run that was never a race is about 5% wide on a
5 km and is misleading without it.

Insufficient data is a real state with a reason, never an empty list.

Both VDOTs are stored on `fitness_series` at recompute, so the endpoint
reads the newest row and inverts each to a time with
`analysis.fitness.race_predictions`; times are never stored. The one query
feeding it is `queries.latest_prediction_vdots`. This module only validates
what comes back.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query

from activity_analysis.analysis.fitness import (
    MIN_PREDICTION_DISTANCE_M,
    predict_from_ordinary_run,
    race_predictions,
    time_for_vdot,
)
from activity_analysis.api import queries
from activity_analysis.api.deps import CursorDep
from activity_analysis.api.models import PredictionHistory, Predictions

router = APIRouter(tags=["predictions"])

#: The longest distance the history is asked at: a round 100 km, past the
#: marathon so an ultra goal still gets a line, and finite so ``inf`` and
#: ``1e308`` are a 422 rather than a page of infinite times.
MAX_HISTORY_DISTANCE_M = 100_000.0


@router.get("/api/predictions")
def predictions(cur: CursorDep) -> Predictions:
    """Every model's prediction at each distance, or why there are none."""
    return Predictions.model_validate(race_predictions(*queries.latest_prediction_vdots(cur)))


@router.get("/api/predictions/history")
def prediction_history(
    cur: CursorDep,
    distance_m: Annotated[
        float,
        Query(
            ge=MIN_PREDICTION_DISTANCE_M,
            le=MAX_HISTORY_DISTANCE_M,
            description="The race distance to predict, in metres.",
        ),
    ],
) -> PredictionHistory:
    """The prediction at ``distance_m`` after each run, from the stored VDOT series."""
    points = []
    for row in queries.prediction_vdot_history(cur):
        best = row["best_efforts_vdot"]
        ordinary = (
            None
            if row["ordinary_runs_vdot"] is None
            else predict_from_ordinary_run(float(row["ordinary_runs_vdot"]), distance_m)
        )
        points.append(
            {
                "activity_id": row["activity_id"],
                "start_time_utc": row["start_time_utc"],
                "utc_offset_s": row["utc_offset_s"],
                "best_efforts_vdot": best,
                "best_efforts_s": None if best is None else time_for_vdot(distance_m, float(best)),
                "ordinary_runs_s": None if ordinary is None else ordinary.predicted_s,
                "ordinary_runs_low_s": None if ordinary is None else ordinary.low_s,
                "ordinary_runs_high_s": None if ordinary is None else ordinary.high_s,
            }
        )
    return PredictionHistory.model_validate({"distance_m": distance_m, "points": points})
