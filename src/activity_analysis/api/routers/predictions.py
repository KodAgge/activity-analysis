"""Race predictions, from best efforts and from ordinary runs.

Two models extrapolating from the best recent effort are served together as
a range, which is how far the two extrapolations disagree. The calibrated
prediction from ordinary running carries its own
residual band, because a prediction from a run that was never a race is
about 5% wide on a 5 km and is misleading without it.

Insufficient data is a real state with a reason, never an empty list: the
alternative is extrapolating from a single effort and presenting the result
as a prediction.

The models are evaluated when asked rather than stored. They are closed
forms over a handful of numbers, every one of which is read from the derived
layer under the eligibility rule `records` uses, and "recent" is measured
against the history, which a stored row would freeze at recompute time. The
maths is `analysis.fitness.race_predictions`; the two queries feeding it are
`queries.recent_eligible_efforts` and `queries.latest_hr_vo2max_smoothed`.
This module only validates what comes back.
"""

from __future__ import annotations

from fastapi import APIRouter

from activity_analysis.analysis.fitness import PREDICTION_WINDOW_DAYS, race_predictions
from activity_analysis.api import queries
from activity_analysis.api.deps import CursorDep
from activity_analysis.api.models import Predictions

router = APIRouter(tags=["predictions"])


@router.get("/api/predictions")
def predictions(cur: CursorDep) -> Predictions:
    """Every model's prediction at each distance, or why there are none."""
    return Predictions.model_validate(
        race_predictions(
            queries.recent_eligible_efforts(cur, window_days=PREDICTION_WINDOW_DAYS),
            queries.latest_hr_vo2max_smoothed(cur, window_days=PREDICTION_WINDOW_DAYS),
        )
    )
