"""Every run's distribution values, for the frontend to bucket in the browser.

Nothing is computed here, or in `queries.distributions`: every field is a
stored column from `activities`, `activity_metrics` or `activity_efficiency`,
joined and ordered, the same split every other endpoint in this file keeps.

No query parameters, unlike every other list endpoint in this API. The view
needs every run at once - to fix the axis over the whole history before any
variable is drawn, to switch which variable is plotted without a round trip,
and to list the runs behind a clicked bucket - so a `from`/`to` or a `limit`
here would just move the aggregation the frontend does into a second request
per interaction. Measured on 2026-09-28 at 324 runs and 17 fields: 151 KB of
JSON, 26 KB gzipped as served, which is what makes serving the whole table
defensible.
"""

from __future__ import annotations

from fastapi import APIRouter

from activity_analysis.api import queries
from activity_analysis.api.deps import CursorDep
from activity_analysis.api.models import DistributionReferences, DistributionRun, Distributions

router = APIRouter(tags=["distributions"])


@router.get("/api/distributions")
def distributions(cur: CursorDep) -> Distributions:
    """Every running activity's distribution values, oldest first."""
    fit, rows = queries.distributions(cur)
    shared = fit or {}
    return Distributions(
        references=DistributionReferences(median_mps=shared.get("ref_median_mps")),
        runs=[DistributionRun.model_validate(row) for row in rows],
    )
