"""Training volume, zone distribution, streaks and consistency.

Weekly and monthly buckets key on the local date rather than the UTC instant:
a run belongs to the week the athlete ran it in, not the week UTC was in at
the time.
"""

from __future__ import annotations

from datetime import UTC, date, datetime

from fastapi import APIRouter

from activity_analysis.analysis import consistency as consistency_module
from activity_analysis.api import queries
from activity_analysis.api.deps import CursorDep
from activity_analysis.api.models import (
    Consistency,
    Overview,
    PeriodBucket,
    Streak,
    ZoneTotal,
)

router = APIRouter(tags=["overview"])


def _today() -> date:
    """Today, for the streak window.

    The athlete's own clock is the honest reference, and the server runs on
    the athlete's machine, so the system date is that clock.
    """
    return datetime.now(tz=UTC).astimezone().date()


@router.get("/api/overview")
def overview(cur: CursorDep) -> Overview:
    today = _today()
    # One window for the whole response. streak and consistency drop weeks
    # after the current one because a device clock can be wrong; the buckets
    # and the date range are bounded by the same Sunday so that no two fields
    # here describe different stretches of the athlete's history.
    through = consistency_module.week_end(today)

    local_dates = queries.run_local_dates(cur, through=through)
    weeks = consistency_module.week_starts(local_dates)
    streak = consistency_module.streak(weeks, today=today)
    active = consistency_module.consistency(weeks, today=today)

    return Overview(
        weeks=[
            PeriodBucket(**bucket)
            for bucket in queries.volume_by_period(cur, "week", through=through, today=today)
        ],
        months=[
            PeriodBucket(**bucket)
            for bucket in queries.volume_by_period(cur, "month", through=through, today=today)
        ],
        zones=[ZoneTotal(**zone) for zone in queries.zone_totals(cur, through=through)],
        zone_boundaries_bpm=queries.current_zone_boundaries(cur),
        streak=Streak(
            current_weeks=streak.current_weeks,
            longest_weeks=streak.longest_weeks,
            longest_ended_week=streak.longest_ended_week,
        ),
        consistency=Consistency(
            weeks_considered=active.weeks_considered,
            weeks_with_a_run=active.weeks_with_a_run,
        ),
        first_run_local_date=local_dates[0] if local_dates else None,
        last_run_local_date=local_dates[-1] if local_dates else None,
        last_activity_local_date=queries.last_activity_local_date(cur, through=through),
    )
