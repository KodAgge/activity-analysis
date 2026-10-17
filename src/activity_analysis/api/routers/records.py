"""Personal records, one per distance.

Separate from the activity browser because it answers a different question.
The browser answers "what did I do"; this answers "what am I actually capable
of at this distance, and when did that happen" - which is the question the
incumbents answer worst, and the reason it gets a view of its own rather
than a filter on the list. Both exist: `GET /api/activities?has_pr=true`
narrows the browser to the runs that set records, and this names the records
themselves.

Nothing here decides what a record *is*. That belongs to the analysis layer
and is already computed: `activity_tags` carries a `pr` row per distance a
run set a record at, including the first eligible effort at that distance,
under the eligibility rule in docs/reference/derived-layer.md.
This module restates that rule in SQL to find the current holder - see
`queries.records` for why, and for the measurement that shows what ignoring
it would print.
"""

from __future__ import annotations

from fastapi import APIRouter

from activity_analysis.api import queries
from activity_analysis.api.deps import CursorDep
from activity_analysis.api.models import Record, Records

router = APIRouter(tags=["records"])


@router.get("/api/records")
def records(cur: CursorDep) -> Records:
    """The best eligible effort at each extracted distance, shortest first.

    Ordered by distance rather than by time so the list reads as a ladder,
    which is also the order a reader compares paces down.

    A distance with no eligible effort is absent rather than present and
    null. There is nothing to say about it: the extractor never found the
    distance, or every effort at it was on a treadmill or crossed a jump in
    the recorded distance that the measured speed does not confirm. The
    ladder therefore holds a distance only once an activity has covered one,
    which on the real store is nineteen of the twenty-two extracted
    distances; 30 km, 35 km and the marathon are absent because no run has
    covered them, and each appears the day one does.
    """
    return Records(items=[Record.model_validate(row) for row in queries.records(cur)])
