"""The expected fitness, fatigue and form ``propose`` stamps, against analytic answers."""

from __future__ import annotations

import math
from datetime import date, timedelta
from typing import Any

import pytest

from activity_analysis.analysis.load import ATL_TAU_DAYS, CTL_TAU_DAYS
from activity_analysis.plan.models import PlanDraft
from activity_analysis.plan.projection import planned_days, project_load
from tests.test_plan_models import FIRST_MONDAY, RACE_DATE, five_week_draft

ONES = [1.0, 1.0, 1.0, 1.0, 1.0]
SUNDAY_BEFORE = FIRST_MONDAY - timedelta(days=1)


def _load(day: date, ctl: float, atl: float, trimp: float = 0.0) -> dict[str, Any]:
    return {
        "local_date": day.isoformat(),
        "trimp": trimp,
        "ctl": ctl,
        "atl": atl,
        "form": ctl - atl,
    }


def _outline(
    goal_id: str, first_monday: date, weeks: int, race: date, minutes: float = 70.0
) -> PlanDraft:
    """A plan of outline weeks only, ``minutes`` of zone 1 a week, so evenly spread days."""
    base = five_week_draft()
    return PlanDraft.model_validate(
        base.model_dump()
        | {
            "goal": base.goal.model_dump() | {"goal_id": goal_id, "race_date": race},
            "weeks": [
                {
                    "start_date": first_monday + timedelta(weeks=n),
                    "phase": "base",
                    "focus": "Steady",
                    "planned_distance_m": 10000.0,
                    "detailed": False,
                    "planned_zone_minutes": [minutes, 0.0, 0.0, 0.0, 0.0],
                }
                for n in range(weeks)
            ],
        }
    )


def _with_durations(durations: list[float | None]) -> PlanDraft:
    data = five_week_draft().model_dump()
    for session, duration in zip(data["weeks"][0]["sessions"], durations, strict=True):
        session["planned_duration_s"] = duration
    return PlanDraft.model_validate(data)


def test_a_detailed_week_spreads_its_trimp_over_its_runs_by_duration() -> None:
    planned = planned_days(_with_durations([1200.0, 2400.0, 1800.0]), ONES, after=SUNDAY_BEFORE)
    week = {d: t for d, t in planned.by_day.items() if d < FIRST_MONDAY + timedelta(days=7)}
    tue, thu, sat = (FIRST_MONDAY + timedelta(days=n) for n in (1, 3, 5))
    assert week == pytest.approx({tue: 20.0, thu: 40.0, sat: 30.0})


def test_runs_share_equally_when_one_has_no_duration() -> None:
    planned = planned_days(_with_durations([1200.0, None, 1800.0]), ONES, after=SUNDAY_BEFORE)
    first_week = [t for d, t in planned.by_day.items() if d < FIRST_MONDAY + timedelta(days=7)]
    assert first_week == pytest.approx([30.0, 30.0, 30.0])


def test_an_outline_week_spreads_evenly_over_seven_days() -> None:
    planned = planned_days(five_week_draft(), ONES, after=SUNDAY_BEFORE)
    outline = FIRST_MONDAY + timedelta(weeks=3)
    days = [outline + timedelta(days=i) for i in range(7)]
    assert [planned.by_day[d] for d in days] == pytest.approx([90.0 / 7] * 7)


def test_an_outline_week_spreads_over_the_run_days_when_given() -> None:
    draft = five_week_draft(constraints={"runs_per_week": 3, "run_days": ["tue", "thu", "sat"]})
    planned = planned_days(draft, ONES, after=SUNDAY_BEFORE)
    outline = FIRST_MONDAY + timedelta(weeks=3)
    week = {d: t for d, t in planned.by_day.items() if outline <= d < outline + timedelta(days=7)}
    assert week == pytest.approx({outline + timedelta(days=n): 30.0 for n in (1, 3, 5)})


def test_a_measured_day_keeps_its_share_out_of_the_projection() -> None:
    wednesday = FIRST_MONDAY + timedelta(days=2)
    planned = planned_days(five_week_draft(), ONES, after=wednesday)
    first_week = [t for d, t in planned.by_day.items() if d < FIRST_MONDAY + timedelta(days=7)]
    assert sum(first_week) == pytest.approx(60.0)


def test_a_week_with_minutes_in_an_unpriced_zone_is_unpriced() -> None:
    planned = planned_days(five_week_draft(), [1.0, 1.0, 1.0, None, 1.0], after=SUNDAY_BEFORE)
    assert planned.unpriced == [FIRST_MONDAY + timedelta(weeks=n) for n in range(5)]
    result = project_load(
        five_week_draft(),
        load=[_load(SUNDAY_BEFORE, 40.0, 40.0)],
        per_minute=[1.0, 1.0, 1.0, None, 1.0],
    )
    assert result.expected is None
    assert result.reason is not None and str(FIRST_MONDAY) in result.reason


def test_without_planned_load_both_decay_from_the_last_measured_day() -> None:
    result = project_load(
        five_week_draft(), load=[_load(SUNDAY_BEFORE, 42.0, 70.0)], per_minute=[0.0] * 5
    )
    assert result.expected is not None
    morning = result.expected.race_morning
    days = (RACE_DATE - timedelta(days=1) - SUNDAY_BEFORE).days
    assert morning.local_date == RACE_DATE - timedelta(days=1)
    assert morning.ctl == pytest.approx(42.0 * math.exp(-days / CTL_TAU_DAYS))
    assert morning.atl == pytest.approx(70.0 * math.exp(-days / ATL_TAU_DAYS))
    assert morning.form == pytest.approx(morning.ctl - morning.atl)
    assert result.expected.start.ctl == 42.0


def test_a_steady_daily_load_holds_fitness_and_fatigue_where_they_are() -> None:
    draft = _outline("steady", FIRST_MONDAY, 5, RACE_DATE)
    result = project_load(draft, load=[_load(SUNDAY_BEFORE, 10.0, 10.0)], per_minute=ONES)
    assert result.expected is not None
    weeks = result.expected.weeks
    assert [w.week_start for w in weeks] == [FIRST_MONDAY + timedelta(weeks=n) for n in range(5)]
    assert [w.days for w in weeks] == [7, 7, 7, 7, 6]
    assert [w.trimp for w in weeks] == pytest.approx([70.0, 70.0, 70.0, 70.0, 60.0])
    for week in weeks:
        assert (week.ctl_mean, week.atl_mean, week.form_mean) == pytest.approx((10.0, 10.0, 0.0))
    assert result.expected.race_morning.form == pytest.approx(0.0)


def test_the_first_week_means_over_its_measured_days_too() -> None:
    wednesday = FIRST_MONDAY + timedelta(days=2)
    load = [_load(FIRST_MONDAY + timedelta(days=i), 10.0, 10.0, 10.0) for i in range(3)]
    result = project_load(
        _outline("steady", FIRST_MONDAY, 5, RACE_DATE), load=load, per_minute=ONES
    )
    assert result.expected is not None
    first = result.expected.weeks[0]
    assert (first.week_start, first.days, first.trimp) == (FIRST_MONDAY, 7, pytest.approx(70.0))
    assert result.expected.start.local_date == wednesday


def test_a_race_the_day_after_the_last_measured_day_reads_that_day_as_its_morning() -> None:
    result = project_load(
        five_week_draft(), load=[_load(RACE_DATE - timedelta(days=1), 50.0, 40.0)], per_minute=ONES
    )
    assert result.expected is not None
    assert result.expected.race_morning == result.expected.start


@pytest.mark.parametrize(
    ("load", "per_minute"),
    [
        ([_load(RACE_DATE, 50.0, 40.0)], ONES),
        ([], ONES),
        ([_load(SUNDAY_BEFORE, 50.0, 40.0)], None),
    ],
    ids=["race-not-after-the-last-day", "no-load", "no-trimp-per-minute"],
)
def test_nothing_is_projected_without_a_start_a_price_or_days_to_run(
    load: list[dict[str, Any]], per_minute: list[float] | None
) -> None:
    result = project_load(five_week_draft(), load=load, per_minute=per_minute)
    assert result.expected is None
    assert result.reason


# A goal queued behind another: B starts on the Monday after A's race.
A_RACE = RACE_DATE
B_FIRST = A_RACE + timedelta(days=2)
B_RACE = B_FIRST + timedelta(days=19)


def test_a_queued_plan_runs_the_plan_before_it_up_to_its_own_first_week() -> None:
    a = _outline("a", FIRST_MONDAY, 5, A_RACE)
    b = _outline("b", B_FIRST, 3, B_RACE)
    result = project_load(b, load=[_load(SUNDAY_BEFORE, 10.0, 10.0)], per_minute=ONES, others=[a])
    assert result.expected is not None
    assert result.expected.bridged_from == ["a"]
    trimp = {w.week_start: w.trimp for w in result.expected.weeks}
    # A's race week holds its six days to the race and a Sunday no plan holds.
    assert trimp[FIRST_MONDAY] == pytest.approx(70.0)
    assert trimp[FIRST_MONDAY + timedelta(weeks=4)] == pytest.approx(60.0)
    assert trimp[B_FIRST] == pytest.approx(70.0)


def test_without_the_plan_before_it_the_gap_is_rest() -> None:
    b = _outline("b", B_FIRST, 3, B_RACE)
    result = project_load(b, load=[_load(SUNDAY_BEFORE, 10.0, 10.0)], per_minute=ONES)
    assert result.expected is not None
    assert result.expected.bridged_from == []
    assert result.expected.weeks[0].trimp == 0.0


def test_an_unpriced_week_in_the_plan_before_it_leaves_nothing_projected() -> None:
    a = _outline("a", FIRST_MONDAY, 5, A_RACE)
    a.weeks[1].planned_zone_minutes = None
    b = _outline("b", B_FIRST, 3, B_RACE)
    result = project_load(b, load=[_load(SUNDAY_BEFORE, 10.0, 10.0)], per_minute=ONES, others=[a])
    assert result.expected is None
    assert result.reason is not None and result.reason.startswith("a has weeks")


def test_a_plan_whose_race_has_passed_bridges_nothing() -> None:
    old = _outline("old", FIRST_MONDAY - timedelta(weeks=5), 5, SUNDAY_BEFORE - timedelta(days=1))
    b = _outline("b", B_FIRST, 3, B_RACE)
    result = project_load(b, load=[_load(SUNDAY_BEFORE, 10.0, 10.0)], per_minute=ONES, others=[old])
    assert result.expected is not None
    assert result.expected.bridged_from == []


def test_each_week_starts_where_the_week_before_ends() -> None:
    draft = _outline("steady", FIRST_MONDAY, 5, RACE_DATE)
    result = project_load(draft, load=[_load(SUNDAY_BEFORE, 10.0, 10.0)], per_minute=ONES)
    assert result.expected is not None
    weeks = result.expected.weeks
    assert weeks[0].start is not None and weeks[0].start.local_date == SUNDAY_BEFORE
    for week in weeks:
        assert week.start is not None and week.end is not None
        assert (week.start.ctl, week.start.atl) == pytest.approx((10.0, 10.0))
        assert (week.end.ctl, week.end.atl) == pytest.approx((10.0, 10.0))
    for before, after in zip(weeks, weeks[1:], strict=False):
        assert after.start == before.end


def test_week_ends_decay_analytically_without_load() -> None:
    result = project_load(
        five_week_draft(), load=[_load(SUNDAY_BEFORE, 42.0, 70.0)], per_minute=[0.0] * 5
    )
    assert result.expected is not None
    end = result.expected.weeks[0].end
    assert end is not None
    assert end.local_date == FIRST_MONDAY + timedelta(days=6)
    assert end.ctl == pytest.approx(42.0 * math.exp(-7 / CTL_TAU_DAYS))
    assert end.atl == pytest.approx(70.0 * math.exp(-7 / ATL_TAU_DAYS))
    assert end.form == pytest.approx(end.ctl - end.atl)


def test_the_race_week_ends_on_race_morning() -> None:
    result = project_load(
        five_week_draft(), load=[_load(SUNDAY_BEFORE, 40.0, 50.0)], per_minute=ONES
    )
    assert result.expected is not None
    assert result.expected.weeks[-1].end == result.expected.race_morning


def test_a_monday_race_week_starts_and_ends_on_race_morning() -> None:
    monday = FIRST_MONDAY + timedelta(weeks=4)
    draft = _outline("monday", FIRST_MONDAY, 5, monday)
    result = project_load(draft, load=[_load(SUNDAY_BEFORE, 10.0, 10.0)], per_minute=ONES)
    assert result.expected is not None
    race_week = result.expected.weeks[-1]
    assert race_week.week_start == monday
    assert race_week.start == race_week.end == result.expected.race_morning


def test_the_first_week_starts_from_its_measured_sunday() -> None:
    load = [
        _load(SUNDAY_BEFORE, 30.0, 20.0),
        _load(FIRST_MONDAY, 31.0, 22.0),
        _load(FIRST_MONDAY + timedelta(days=1), 32.0, 24.0),
    ]
    result = project_load(
        _outline("steady", FIRST_MONDAY, 5, RACE_DATE), load=load, per_minute=ONES
    )
    assert result.expected is not None
    start = result.expected.weeks[0].start
    assert start is not None
    assert (start.local_date, start.ctl, start.atl, start.form) == (SUNDAY_BEFORE, 30.0, 20.0, 10.0)
