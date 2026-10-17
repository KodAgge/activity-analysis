"""Every effort at one distance, with its eligibility and record status.

`GET /api/records` names the current holder at each distance. This answers
the question behind it: how the athlete got there, every effort at the
distance in time order, which ones set a record when they happened, and why
a faster one did not count. Eligibility follows the analysis layer's own
rule, so a treadmill effort and one across a jump in the recorded distance
that the measured speed does not confirm appear on the chart but never in
the staircase.

A distance with no effort is absent, never present and empty. On the real
store `30k`, `35k` and `marathon` are that case: the extractor knows all
three but no run has covered them, so each stays a 404 until one does. A
key the extractor does not know at all is a different fact, and also a 404,
because there is nothing to say about it either.

The staircase is computed by the query as a running minimum over eligible
efforts in time order, not read from the `pr` tags, so that the chart and the
tags stay two independent paths to one fact; see `queries.progression` for
the rule and the test that holds them together. The three counts are sums
over the items, evaluated here rather than in a second query so they cannot
disagree with the list they describe.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from activity_analysis.analysis.best_efforts import STANDARD_DISTANCES_M
from activity_analysis.api import queries
from activity_analysis.api.deps import CursorDep
from activity_analysis.api.models import Progression, ProgressionPoint

router = APIRouter(tags=["progression"])


@router.get("/api/progression/{distance_key}")
def progression(cur: CursorDep, distance_key: str) -> Progression:
    """Every effort at one extracted distance, oldest first."""
    if distance_key not in STANDARD_DISTANCES_M:
        raise HTTPException(status_code=404, detail=f"no such distance: {distance_key}")
    items = [ProgressionPoint.model_validate(row) for row in queries.progression(cur, distance_key)]
    if not items:
        raise HTTPException(status_code=404, detail=f"no efforts at {distance_key}")
    return Progression(
        distance_key=distance_key,
        distance_m=STANDARD_DISTANCES_M[distance_key],
        effort_count=len(items),
        eligible_count=sum(item.is_eligible for item in items),
        record_count=sum(item.is_record for item in items),
        items=items,
    )
