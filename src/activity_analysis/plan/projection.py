"""What a plan's planned load is expected to do to fitness, fatigue and form.

``propose`` stamps the result on the version, so the Plan view draws a stored
series and never computes one on read. Each week's planned TRIMP, its zone
minutes times the athlete's TRIMP per minute in each zone, is spread over the
week's days and run through the same recursion ``recompute`` runs on measured
TRIMP, starting from the last measured day. See
docs/reference/math/plan-projection.md.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

import numpy as np
import pandas as pd

from activity_analysis.analysis.consistency import week_start
from activity_analysis.analysis.load import carry_on, weekly_series
from activity_analysis.plan.models import (
    RUNNING_KINDS,
    ExpectedLoad,
    ExpectedLoadWeek,
    LoadPoint,
    PlanDraft,
    planned_trimp,
)

_WEEKDAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


@dataclass(frozen=True)
class Projection:
    """The stamp, or why there is none."""

    expected: ExpectedLoad | None
    reason: str | None


@dataclass(frozen=True)
class _Planned:
    """A plan's planned TRIMP by day after a cut-off, and the weeks it cannot price."""

    by_day: dict[date, float]
    unpriced: list[date]


def planned_days(plan: PlanDraft, per_minute: Sequence[float | None], *, after: date) -> _Planned:
    """Each day's planned TRIMP, for the days after ``after``.

    A week's planned TRIMP goes to its running sessions in proportion to their
    ``planned_duration_s``, equally when any lacks one. A week without running
    sessions, an outline week, spreads it over ``constraints.run_days`` that
    fall in the week, else over all seven days. A day on or before ``after`` is
    measured, so its share is dropped rather than moved onto later days.

    A week that holds a day after ``after`` but has no zone minutes, or minutes
    in a zone without a TRIMP per minute, is unpriced.
    """
    by_day: dict[date, float] = {}
    unpriced: list[date] = []
    run_days = plan.constraints.run_days
    for week in plan.weeks:
        days = [week.start_date + timedelta(days=i) for i in range(7)]
        if days[-1] <= after:
            continue
        minutes = week.planned_zone_minutes
        total = None if minutes is None else planned_trimp(minutes, per_minute)
        if total is None:
            unpriced.append(week.start_date)
            continue
        running = [s for s in week.sessions if s.kind in RUNNING_KINDS]
        shares: list[tuple[date, float]]
        if running:
            durations = [s.planned_duration_s for s in running]
            weights = (
                [float(d) for d in durations if d is not None]
                if all(d is not None for d in durations)
                else [1.0] * len(running)
            )
            shares = [(s.date, w / sum(weights)) for s, w in zip(running, weights, strict=True)]
        else:
            chosen = (
                days if not run_days else [d for d in days if _WEEKDAYS[d.weekday()] in run_days]
            )
            shares = [(d, 1.0 / len(chosen)) for d in chosen]
        for day, share in shares:
            if day > after:
                by_day[day] = by_day.get(day, 0.0) + total * share
    return _Planned(by_day, unpriced)


def _first_day(plan: PlanDraft) -> date | None:
    return min((w.start_date for w in plan.weeks), default=None)


def project_load(
    draft: PlanDraft,
    *,
    load: Sequence[dict[str, Any]],
    per_minute: Sequence[float | None] | None,
    others: Sequence[PlanDraft] = (),
) -> Projection:
    """The expected series from the context's last ``load`` day through the race.

    ``others`` are the other goals' plans still to be run. A day before the
    draft's first week takes the planned TRIMP of the one among them whose span,
    its first week's Monday through its race, holds the day, the soonest race
    first; a day no plan holds is a rest day.
    """
    if per_minute is None:
        return Projection(None, "the context has no TRIMP per minute to price the weeks with")
    if not load:
        return Projection(None, "the context has no measured load to start from")
    last = load[-1]
    anchor = date.fromisoformat(str(last["local_date"]))
    race = draft.goal.race_date
    if race <= anchor:
        return Projection(None, "the race is not after the last measured day")

    own = planned_days(draft, per_minute, after=anchor)
    if own.unpriced:
        return Projection(None, _unpriced("this plan", own.unpriced))
    first = _first_day(draft) or race
    bridges: list[tuple[PlanDraft, date, _Planned]] = []
    for other in sorted(others, key=lambda p: p.goal.race_date):
        start = _first_day(other)
        if start is None or other.goal.race_date <= anchor or start >= first:
            continue
        bridges.append((other, start, planned_days(other, per_minute, after=anchor)))

    days = [anchor + timedelta(days=i) for i in range(1, (race - anchor).days + 1)]
    trimp = np.zeros(len(days))
    bridged: list[str] = []
    for i, day in enumerate(days):
        if day >= first:
            trimp[i] = own.by_day.get(day, 0.0)
            continue
        for other, start, planned in bridges:
            if start <= day <= other.goal.race_date:
                holding = [w for w in planned.unpriced if w <= day < w + timedelta(days=7)]
                if holding:
                    return Projection(None, _unpriced(other.goal.goal_id, holding))
                trimp[i] = planned.by_day.get(day, 0.0)
                if other.goal.goal_id not in bridged:
                    bridged.append(other.goal.goal_id)
                break

    ctl, atl = carry_on(float(last["ctl"]), float(last["atl"]), trimp)
    measured = LoadPoint(local_date=anchor, ctl=last["ctl"], atl=last["atl"], form=last["form"])
    morning = (
        measured
        if len(days) == 1
        else LoadPoint(local_date=days[-2], ctl=ctl[-2], atl=atl[-2], form=float(ctl[-2] - atl[-2]))
    )
    return Projection(
        ExpectedLoad(
            start=measured,
            race_morning=morning,
            weeks=_weeks(load, days, trimp, ctl, atl),
            bridged_from=bridged,
        ),
        None,
    )


def _weeks(
    load: Sequence[dict[str, Any]],
    days: list[date],
    trimp: np.ndarray,
    ctl: np.ndarray,
    atl: np.ndarray,
) -> list[ExpectedLoadWeek]:
    """Weekly means over the projected days and the measured days of the first one's week.

    The first week then means over all its days, as a measured week does,
    rather than over the projected days alone. Each week also carries the
    values it starts from, the end of the Sunday before it, and ends on, the
    end of its Sunday or, in the race week, race morning.
    """
    first_week = week_start(days[0])
    # (day, trimp, ctl, atl): the measured days from the Sunday before the first
    # week, then the projected days.
    rows: list[tuple[date, float, float, float]] = [
        (
            date.fromisoformat(str(row["local_date"])),
            float(row["trimp"]),
            float(row["ctl"]),
            float(row["atl"]),
        )
        for row in load
        if date.fromisoformat(str(row["local_date"])) >= first_week - timedelta(days=1)
    ]
    rows += [
        (d, float(t), float(c), float(a)) for d, t, c, a in zip(days, trimp, ctl, atl, strict=True)
    ]
    points = {d: LoadPoint(local_date=d, ctl=c, atl=a, form=c - a) for d, _, c, a in rows}
    daily = pd.DataFrame(
        [r for r in rows if r[0] >= first_week], columns=["local_date", "trimp", "ctl", "atl"]
    )
    daily["form"] = daily["ctl"] - daily["atl"]
    daily["distance_m"] = 0.0
    weekly = weekly_series(daily)
    morning = days[-1] - timedelta(days=1)
    out: list[ExpectedLoadWeek] = []
    for row in weekly.drop(columns="distance_m").to_dict("records"):
        monday = row["week_start"]
        end = min(monday + timedelta(days=6), morning)
        start = points.get(monday - timedelta(days=1))
        out.append(ExpectedLoadWeek.model_validate({**row, "start": start, "end": points.get(end)}))
    return out


def _unpriced(whose: str, weeks: list[date]) -> str:
    listed = ", ".join(str(w) for w in weeks)
    return (
        f"{whose} has weeks with no planned TRIMP, no zone minutes or minutes in a zone "
        f"without a TRIMP per minute: {listed}"
    )
