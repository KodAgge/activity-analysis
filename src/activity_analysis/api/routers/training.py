"""The estimated threshold heart rate and the training load.

Nothing is computed here but the zone edges. `threshold_readings`, `run_load`,
`zone_time_estimated`, `hr_histogram`, `training_load` and
`training_load_weekly` are written by `recompute`; this route projects them.
The edges are the stored estimate times the fixed zone fractions of
`analysis/threshold.py`, applied on read so the fractions live in one place.
"""

from __future__ import annotations

from datetime import date
from typing import Annotated

from fastapi import APIRouter, Query

from activity_analysis.analysis.threshold import zone_boundaries
from activity_analysis.api import queries
from activity_analysis.api.deps import CursorDep
from activity_analysis.api.models import (
    LoadDay,
    LoadWeek,
    RunLoad,
    Threshold,
    ThresholdNow,
    TrainingLoad,
)

router = APIRouter(tags=["training"])


@router.get("/api/threshold")
def threshold(cur: CursorDep) -> Threshold:
    """The threshold in force at the newest run, and its zone edges."""
    now = queries.threshold_now(cur)
    current = (
        None
        if now is None
        else ThresholdNow(
            lthr_bpm=now["lthr_bpm"],
            boundaries_bpm=zone_boundaries(now["lthr_bpm"]),
        )
    )
    return Threshold(current=current)


@router.get("/api/training-load")
def training_load(
    cur: CursorDep,
    start: Annotated[
        date | None,
        Query(alias="from", description="Inclusive lower bound, a local calendar date."),
    ] = None,
    end: Annotated[
        date | None,
        Query(alias="to", description="Inclusive upper bound, a local calendar date."),
    ] = None,
    runs: Annotated[
        bool,
        Query(
            description="False leaves `runs` empty, for a client that reads only the "
            "daily and weekly series: the runs' heart rate histograms are most of the body."
        ),
    ] = True,
) -> TrainingLoad:
    """Daily load and per-run load within inclusive local dates, both optional."""
    return TrainingLoad(
        days=[LoadDay.model_validate(r) for r in queries.load_days(cur, since=start, through=end)],
        weeks=[
            LoadWeek.model_validate(r) for r in queries.load_weeks(cur, since=start, through=end)
        ],
        runs=(
            [RunLoad.model_validate(r) for r in queries.run_loads(cur, since=start, through=end)]
            if runs
            else []
        ),
    )
