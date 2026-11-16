"""The plan schema and the semantic checks a draft must pass."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from typing import Any

import pytest
from pydantic import ValidationError

from activity_analysis.plan.models import (
    EXPECTED_VDOT_START_TOLERANCE,
    ChangeEntry,
    Checkpoint,
    HeartRateRange,
    Outcome,
    PlanDraft,
    PlanVersion,
    Provenance,
    RaceResult,
    Session,
    SpeedRange,
    Step,
    planned_trimp,
)
from activity_analysis.plan.render import render_version
from activity_analysis.plan.validate import check_draft, resolve_pointer

CONTEXT: dict[str, Any] = {
    "predictions": {"items": [{}]},
    "fitness_now": {"garmin_vo2max": 52},
}
FIRST_MONDAY = date(2027, 2, 8)
RACE_DATE = date(2027, 3, 13)


def _session(week: int, offset: int, kind: str, name: str) -> dict[str, Any]:
    return {
        "id": f"w{week}-{name}",
        "date": FIRST_MONDAY + timedelta(days=7 * (week - 1) + offset),
        "kind": kind,
        "title": name.title(),
        "description": "A synthetic session.",
        "planned_distance_m": 5000.0,
        "planned_duration_s": 1800.0,
    }


def five_week_draft(**overrides: Any) -> PlanDraft:
    """A synthetic 5 km plan: weeks 1-3 and 5 detailed, week 4 an outline.

    Three 30 minute runs a detailed week, planned as 90 minutes of zone time.
    """
    weeks: list[dict[str, Any]] = []
    for n in range(1, 6):
        sessions: list[dict[str, Any]] = []
        if n != 4:
            last = "race" if n == 5 else "long"
            middle = "strides" if n == 5 else "intervals"
            sessions = [
                _session(n, 1, "easy", "easy"),
                _session(n, 3, middle, middle.replace("_", "-")),
                _session(n, 5, last, last),
            ]
        weeks.append(
            {
                "start_date": FIRST_MONDAY + timedelta(days=7 * (n - 1)),
                "phase": "base",
                "focus": "Build easy volume",
                "planned_distance_m": 15000.0,
                "detailed": n != 4,
                "sessions": sessions,
                "planned_zone_minutes": [60.0, 20.0, 8.0, 2.0, 0.0],
                "expected_vdot": 48.0,
                "expected_garmin_vo2max": 50.0,
                "load_note": "Keep the easy runs easy so the quality lands." if n != 4 else None,
            }
        )
    data: dict[str, Any] = {
        "goal": {
            "goal_id": "five-k",
            "distance_m": 5000.0,
            "target_time_s": 1500.0,
            "race_date": RACE_DATE,
            "surface": "road",
        },
        "constraints": {"runs_per_week": 3},
        "assessment": {
            "summary": "Close to the goal.",
            "estimate_s": 1540.0,
            "estimate_reasoning": "Recent efforts.",
            "verdict": "possible",
            "citations": [{"label": "Prediction", "pointer": "/predictions/items/0"}],
        },
        "weeks": weeks,
    }
    data.update(overrides)
    return PlanDraft.model_validate(data)


def _edit(draft: PlanDraft, **overrides: Any) -> PlanDraft:
    data = draft.model_dump()
    data.update(overrides)
    return PlanDraft.model_validate(data)


def _version(draft: PlanDraft) -> PlanVersion:
    provenance = Provenance(
        number=1,
        revises=None,
        created_at=datetime(2027, 2, 6, tzinfo=UTC),
        data_through=date(2027, 2, 5),
        snapshot=[],
    )
    return PlanVersion.model_validate({**draft.model_dump(), "provenance": provenance})


def _check(
    draft: PlanDraft,
    previous: PlanVersion | None = None,
    through: date | None = None,
    context: dict[str, Any] | None = None,
):
    return check_draft(
        draft,
        previous=previous,
        context=CONTEXT if context is None else context,
        data_through=through or date(2027, 2, 5),
    )


def _week_edit(draft: PlanDraft, index: int, **changes: Any) -> PlanDraft:
    data = draft.model_dump()
    data["weeks"][index].update(changes)
    return PlanDraft.model_validate(data)


def test_a_step_needs_exactly_one_of_distance_and_duration() -> None:
    with pytest.raises(ValidationError):
        Step(role="work")
    with pytest.raises(ValidationError):
        Step(role="work", distance_m=800, duration_s=180)


def test_quantities_must_be_positive() -> None:
    for build in (
        lambda: Step(role="work", duration_s=-100),
        lambda: Step(role="work", distance_m=0),
        lambda: Session.model_validate(
            {
                "id": "s",
                "date": FIRST_MONDAY,
                "kind": "easy",
                "title": "",
                "description": "",
                "planned_distance_m": 0,
            }
        ),
        lambda: Session.model_validate(
            {
                "id": "s",
                "date": FIRST_MONDAY,
                "kind": "easy",
                "title": "",
                "description": "",
                "planned_duration_s": -1,
            }
        ),
        lambda: Checkpoint(session_id="s", description="", target_time_s=0),
        lambda: RaceResult(time_s=-1, achieved=True),
    ):
        with pytest.raises(ValidationError):
            build()
    assert RaceResult(time_s=None, achieved=False).time_s is None


def test_a_goal_id_is_at_most_100_characters() -> None:
    goal = five_week_draft().goal.model_dump()
    assert five_week_draft(goal=goal | {"goal_id": "a" * 100}).goal.goal_id == "a" * 100
    with pytest.raises(ValidationError):
        five_week_draft(goal=goal | {"goal_id": "a" * 101})


def test_a_speed_range_runs_low_to_high() -> None:
    with pytest.raises(ValidationError):
        SpeedRange(low_mps=4.0, high_mps=3.9)


def test_the_synthetic_draft_is_valid() -> None:
    assert _check(five_week_draft()) == []


def test_check_refuses_weeks_off_consecutive_mondays() -> None:
    draft = _week_edit(five_week_draft(), 2, start_date=date(2027, 2, 24))
    problems = _check(draft)
    assert any("week starting 2027-02-24 does not start on a Monday" in p for p in problems)
    draft = _week_edit(five_week_draft(), 2, start_date=date(2027, 3, 1))
    assert any(
        "week of 2027-03-01 does not follow the week of 2027-02-15" in p for p in _check(draft)
    )


def test_check_refuses_a_race_date_outside_the_last_week() -> None:
    goal = five_week_draft().goal.model_dump() | {"race_date": date(2027, 3, 15)}
    problems = _check(_edit(five_week_draft(), goal=goal))
    assert any("race date 2027-03-15 is outside the last week" in p for p in problems)


def test_check_refuses_a_session_outside_its_week_or_a_repeated_id() -> None:
    data = five_week_draft().model_dump()
    data["weeks"][0]["sessions"][0]["date"] = date(2027, 2, 16)
    problems = _check(PlanDraft.model_validate(data))
    assert any(
        "session w1-easy is dated 2027-02-16, outside the week of 2027-02-08" in p for p in problems
    )
    data = five_week_draft().model_dump()
    data["weeks"][1]["sessions"][0]["id"] = "w1-easy"
    assert any(
        "session id w1-easy is used 2 times" in p for p in _check(PlanDraft.model_validate(data))
    )


def test_check_refuses_a_detailed_week_without_sessions_and_an_outline_with_them() -> None:
    draft = _week_edit(five_week_draft(), 1, sessions=[])
    assert any("week of 2027-02-15 is detailed but has no sessions" in p for p in _check(draft))
    sessions = five_week_draft().weeks[0].model_dump()["sessions"]
    for s in sessions:
        s["id"] += "x"
        s["date"] += timedelta(days=21)
    draft = _week_edit(five_week_draft(), 3, sessions=sessions)
    assert any("week of 2027-03-01 is an outline but has sessions" in p for p in _check(draft))


def test_check_refuses_a_race_week_that_is_not_detailed_or_has_no_race() -> None:
    draft = _week_edit(five_week_draft(), 4, detailed=False, sessions=[])
    assert any("race week of 2027-03-08 must be detailed" in p for p in _check(draft))
    data = five_week_draft().model_dump()
    data["weeks"][4]["sessions"][2]["kind"] = "easy"
    problems = _check(PlanDraft.model_validate(data))
    assert any(
        "no session of kind race is dated on the race date 2027-03-13" in p for p in problems
    )


def test_check_refuses_a_fourth_run_when_three_a_week_is_set() -> None:
    data = five_week_draft().model_dump()
    extra = _session(1, 4, "easy", "extra")
    data["weeks"][0]["sessions"].append(extra)
    problems = _check(PlanDraft.model_validate(data))
    assert "week of 2027-02-08 has 4 runs, more than the 3 a week the athlete set" in problems


def test_strides_and_time_trials_count_as_runs_and_rest_does_not() -> None:
    data = five_week_draft().model_dump()
    data["weeks"][0]["sessions"].append(_session(1, 4, "strides", "strides"))
    assert "week of 2027-02-08 has 4 runs, more than the 3 a week the athlete set" in _check(
        PlanDraft.model_validate(data)
    )
    data = five_week_draft().model_dump()
    data["weeks"][0]["sessions"].append(_session(1, 4, "time_trial", "tt"))
    assert "week of 2027-02-08 has 4 runs, more than the 3 a week the athlete set" in _check(
        PlanDraft.model_validate(data)
    )
    data = five_week_draft().model_dump()
    data["weeks"][0]["sessions"].append(_session(1, 4, "rest", "rest"))
    data["weeks"][0]["sessions"].append(_session(1, 6, "cross_training", "bike"))
    assert _check(PlanDraft.model_validate(data)) == []


def test_check_refuses_a_citation_that_does_not_resolve() -> None:
    data = five_week_draft().model_dump()
    data["assessment"]["citations"][0]["pointer"] = "/predictions/items/3"
    problems = _check(PlanDraft.model_validate(data))
    assert any("/predictions/items/3, which does not resolve" in p for p in problems)


def test_check_refuses_changing_or_adding_a_past_session() -> None:
    previous = _version(five_week_draft())
    through = date(2027, 2, 10)
    data = five_week_draft().model_dump()
    data["weeks"][0]["sessions"][0]["title"] = "Changed"
    problems = _check(PlanDraft.model_validate(data), previous, through)
    assert any(
        "session w1-easy" in p and "differs from the previous version" in p for p in problems
    )
    data = five_week_draft().model_dump()
    data["weeks"][0]["sessions"][0]["id"] = "w1-new"
    problems = _check(PlanDraft.model_validate(data), previous, through)
    assert any("session w1-new" in p and "is not in the previous version" in p for p in problems)
    assert _check(five_week_draft(), previous, through) == []


def test_check_refuses_dropping_a_past_session() -> None:
    previous = _version(five_week_draft())
    data = five_week_draft().model_dump()
    del data["weeks"][0]["sessions"][0]
    problems = _check(PlanDraft.model_validate(data), previous, date(2027, 2, 10))
    assert any("session w1-easy" in p and "missing from the draft" in p for p in problems)


def test_check_refuses_an_outcome_for_an_unknown_or_future_session() -> None:
    outcome = Outcome(session_id="nope", verdict="done")
    problems = _check(five_week_draft(outcomes=[outcome]))
    assert any("outcome names session nope, which is not in the plan" in p for p in problems)
    outcome = Outcome(session_id="w1-long", verdict="done")
    problems = _check(five_week_draft(outcomes=[outcome]), through=date(2027, 2, 10))
    assert any("outcome names session w1-long" in p and "not in the past" in p for p in problems)
    assert (
        _check(
            five_week_draft(outcomes=[Outcome(session_id="w1-easy", verdict="done")]),
            through=date(2027, 2, 10),
        )
        == []
    )


def test_check_refuses_a_goal_change_not_flagged_and_a_new_goal_id() -> None:
    previous = _version(five_week_draft())
    goal = previous.goal.model_dump() | {"target_time_s": 1450.0}
    problems = _check(_edit(five_week_draft(), goal=goal), previous)
    assert any("goal differs from the previous version's" in p for p in problems)
    flagged = [ChangeEntry(title="Faster target", reason="Fit", goal_change=True)]
    assert _check(_edit(five_week_draft(), goal=goal, changes=flagged), previous) == []
    goal = previous.goal.model_dump() | {"goal_id": "other"}
    problems = _check(_edit(five_week_draft(), goal=goal, changes=flagged), previous)
    assert any("goal id other differs from the previous version's five-k" in p for p in problems)


def test_resolve_pointer_follows_rfc_6901() -> None:
    assert resolve_pointer({"a/b": [{"~x": 1}]}, "/a~1b/0/~0x") == 1
    with pytest.raises(KeyError):
        resolve_pointer({"a": []}, "/a/0")


def _no_estimate_problem(start: date, end: date) -> str:
    return (
        "no estimate is given, so a time trial within two weeks of the version's "
        f"start, from {start} to {end}, must be scheduled and named by a checkpoint"
    )


NO_ESTIMATE = _no_estimate_problem(FIRST_MONDAY, date(2027, 2, 21))


def _no_estimate(
    trial_week: int | None = None, offset: int = 0, checkpoint: bool = True
) -> PlanDraft:
    """The synthetic draft without an estimate, optionally with a time trial."""
    data = five_week_draft().model_dump()
    data["assessment"]["estimate_s"] = None
    if trial_week is not None:
        trial = _session(trial_week, offset, "time_trial", "trial")
        sessions = data["weeks"][trial_week - 1]["sessions"]
        sessions.pop(1)  # the trial replaces the week's middle run, keeping three runs
        sessions.append(trial)
        sessions.sort(key=lambda s: s["date"])
        if checkpoint:
            data["checkpoints"] = [
                {"session_id": trial["id"], "description": "Time over the goal distance."}
            ]
    return PlanDraft.model_validate(data)


def test_check_refuses_no_estimate_without_an_early_time_trial() -> None:
    assert NO_ESTIMATE in _check(_no_estimate())
    # Day 15 is the first Monday after the two weeks; day 10 is a Wednesday of week 2.
    assert NO_ESTIMATE in _check(_no_estimate(trial_week=3, offset=0))
    assert NO_ESTIMATE in _check(_no_estimate(trial_week=2, offset=2, checkpoint=False))


def test_no_estimate_with_an_early_time_trial_and_checkpoint_is_valid() -> None:
    assert _check(_no_estimate(trial_week=2, offset=2)) == []


def _with_trial(draft: PlanDraft, week: int, offset: int) -> PlanDraft:
    """The draft with week's middle run replaced by a time trial a checkpoint names."""
    data = draft.model_dump()
    trial = _session(week, offset, "time_trial", "trial")
    sessions = data["weeks"][week - 1]["sessions"]
    sessions.pop(1)
    sessions.append(trial)
    sessions.sort(key=lambda s: s["date"])
    data["checkpoints"].append(
        {"session_id": trial["id"], "description": "Time over the goal distance."}
    )
    return PlanDraft.model_validate(data)


def _without_estimate(draft: PlanDraft) -> PlanDraft:
    data = draft.model_dump()
    data["assessment"]["estimate_s"] = None
    return PlanDraft.model_validate(data)


# Weeks 1 and 2 have ended by this day, so a revision's trial falls from week 3 on.
REVISION_THROUGH = date(2027, 2, 21)
REVISION_NO_ESTIMATE = _no_estimate_problem(date(2027, 2, 22), date(2027, 3, 7))


def test_a_revision_without_an_estimate_may_schedule_its_trial_after_the_frozen_weeks() -> None:
    # The accepted version had an estimate and no trial; its first two weeks are frozen.
    previous = _version(five_week_draft())
    draft = _with_trial(_without_estimate(five_week_draft()), week=3, offset=2)
    assert _check(draft, previous, REVISION_THROUGH) == []


def test_a_revision_without_an_estimate_needs_a_trial_after_its_data() -> None:
    # The trial the accepted version scheduled in week 2 is past, and was not run.
    previous = _version(_no_estimate(trial_week=2, offset=2))
    problems = _check(_no_estimate(trial_week=2, offset=2), previous, REVISION_THROUGH)
    assert problems == [REVISION_NO_ESTIMATE]
    rescheduled = _with_trial(_no_estimate(trial_week=2, offset=2), week=3, offset=2)
    assert _check(rescheduled, previous, REVISION_THROUGH) == []
    # Day 15 after week 3's start is the Monday of week 5, outside the two weeks.
    late = _with_trial(_no_estimate(trial_week=2, offset=2), week=5, offset=0)
    assert REVISION_NO_ESTIMATE in _check(late, previous, REVISION_THROUGH)


def test_a_revision_does_not_count_a_trial_missed_earlier_in_the_current_week() -> None:
    # The trial was on Wednesday of week 2, and the data runs through Thursday.
    through = date(2027, 2, 18)
    previous = _version(_no_estimate(trial_week=2, offset=2))
    problems = _check(_no_estimate(trial_week=2, offset=2), previous, through)
    assert problems == [_no_estimate_problem(date(2027, 2, 19), date(2027, 3, 4))]
    rescheduled = _with_trial(_no_estimate(trial_week=2, offset=2), week=3, offset=2)
    assert _check(rescheduled, previous, through) == []


def test_a_revision_needs_no_trial_when_the_race_falls_within_two_weeks() -> None:
    # The data runs through the Monday of race week, five days before the race.
    previous = _version(_no_estimate(trial_week=2, offset=2))
    draft = _no_estimate(trial_week=2, offset=2)
    assert _check(draft, previous, date(2027, 3, 8)) == []
    # Twenty days before the race, a trial is still needed.
    assert _check(draft, previous, date(2027, 2, 21)) == [REVISION_NO_ESTIMATE]


def test_a_closing_version_needs_no_trial_without_an_estimate() -> None:
    previous = _version(_no_estimate(trial_week=2, offset=2))
    result = {"time_s": 1490.0, "achieved": True}
    closing = _edit(_no_estimate(trial_week=2, offset=2), result=result)
    assert _check(closing, previous, RACE_DATE) == []


def test_an_estimate_may_be_omitted_from_the_model() -> None:
    data = five_week_draft().model_dump()
    data["assessment"]["estimate_s"] = None
    assert PlanDraft.model_validate(data).assessment.estimate_s is None
    data["assessment"]["estimate_s"] = 0
    with pytest.raises(ValidationError):
        PlanDraft.model_validate(data)


def test_resolve_pointer_refuses_a_non_ascii_digit_as_an_index() -> None:
    # "²".isdigit() is true and int("²") raises ValueError.
    with pytest.raises(KeyError):
        resolve_pointer({"a": [1, 2, 3]}, "/a/²")


def test_check_reports_a_pointer_with_a_non_ascii_digit_as_unresolved() -> None:
    data = five_week_draft().model_dump()
    data["assessment"]["citations"][0]["pointer"] = "/predictions/items/²"
    problems = _check(PlanDraft.model_validate(data))
    assert any("/predictions/items/², which does not resolve" in p for p in problems)


def test_check_refuses_a_checkpoint_naming_no_session() -> None:
    draft = five_week_draft(checkpoints=[{"session_id": "w9-trial", "description": "Time trial."}])
    assert "checkpoint names session w9-trial, which is not in the plan" in _check(draft)
    named = five_week_draft(checkpoints=[{"session_id": "w2-long", "description": "Long."}])
    assert _check(named) == []


def test_check_refuses_a_change_naming_no_session() -> None:
    change = {"title": "Swap", "reason": "Tired", "session_ids": ["w2-easy", "w9-gone"]}
    problems = _check(five_week_draft(changes=[change]))
    assert problems == ["change 'Swap' names session w9-gone, which is not in the plan"]


def test_a_change_may_name_a_session_the_draft_removes() -> None:
    previous = _version(five_week_draft())
    data = five_week_draft().model_dump()
    del data["weeks"][1]["sessions"][0]  # w2-easy, a future session
    data["weeks"][1]["planned_zone_minutes"] = [40.0, 14.0, 4.0, 2.0, 0.0]
    data["changes"] = [{"title": "Drop", "reason": "Tired", "session_ids": ["w2-easy"]}]
    assert _check(PlanDraft.model_validate(data), previous) == []


def test_check_refuses_dropping_or_changing_an_earlier_outcome() -> None:
    through = date(2027, 2, 10)
    kept = Outcome(session_id="w1-easy", verdict="done", activity_ids=["a1"])
    previous = _version(five_week_draft(outcomes=[kept]))
    problems = _check(five_week_draft(), previous, through)
    assert (
        "the outcome for session w1-easy in the previous version is missing from the draft; "
        "earlier outcomes are kept"
    ) in problems
    changed = kept.model_copy(update={"verdict": "missed"})
    problems = _check(five_week_draft(outcomes=[changed]), previous, through)
    assert (
        "the outcome for session w1-easy differs from the previous version's; "
        "earlier outcomes are kept"
    ) in problems
    assert _check(five_week_draft(outcomes=[kept]), previous, through) == []


def test_check_refuses_changing_a_past_week() -> None:
    previous = _version(five_week_draft())
    through = date(2027, 2, 21)  # week 2 ends on this day, so weeks 1 and 2 are past
    for field, value in (("phase", "build"), ("focus", "Speed"), ("planned_distance_m", 9000.0)):
        problems = _check(_week_edit(five_week_draft(), 1, **{field: value}), previous, through)
        assert problems == [
            f"week of 2027-02-15 has ended and changes {field} "
            "from the previous version; past weeks are frozen"
        ]
    # Week 3 has not ended, so it may change.
    assert _check(_week_edit(five_week_draft(), 2, phase="build"), previous, through) == []


def test_a_revision_may_change_the_current_weeks_planned_distance() -> None:
    previous = _version(five_week_draft())
    through = date(2027, 2, 17)  # mid-week 2, which has not ended
    draft = _week_edit(five_week_draft(), 1, planned_distance_m=9000.0)
    assert _check(draft, previous, through) == []


def test_check_refuses_a_result_before_the_race() -> None:
    result = {"time_s": 1490.0, "achieved": True}
    problems = _check(five_week_draft(result=result), through=date(2027, 3, 12))
    assert problems == [
        "a result is given, but the data runs only through 2027-03-12, "
        "before the race date 2027-03-13"
    ]
    assert _check(five_week_draft(result=result), through=RACE_DATE) == []


def test_check_refuses_adding_or_dropping_a_past_week() -> None:
    previous = _version(five_week_draft())
    through = date(2027, 2, 14)
    data = five_week_draft().model_dump()
    dropped = data["weeks"].pop(0)
    problems = _check(PlanDraft.model_validate(data), previous, through)
    assert (
        "week of 2027-02-08 has ended and is missing from the draft; past weeks are frozen"
    ) in problems
    earlier = dict(dropped, start_date=FIRST_MONDAY - timedelta(days=7), sessions=[])
    earlier["detailed"] = False
    data = five_week_draft().model_dump()
    data["weeks"].insert(0, earlier)
    problems = _check(PlanDraft.model_validate(data), previous, through)
    assert (
        "week of 2027-02-01 has ended but is not in the previous version; past weeks are frozen"
    ) in problems


def _with_strides(draft: PlanDraft) -> PlanDraft:
    data = draft.model_dump()
    data["weeks"][0]["sessions"][0]["steps"] = [
        {"role": "warmup", "distance_m": 3000.0, "heart_rate": {"high_bpm": 150.0}},
        {"role": "strides", "repeat": 4, "duration_s": 20.0},
    ]
    return PlanDraft.model_validate(data)


def test_a_draft_with_a_strides_step_passes_every_check() -> None:
    draft = _with_strides(five_week_draft())
    assert draft.weeks[0].sessions[0].steps[1].role == "strides"
    assert _check(draft) == []


def test_render_prints_a_strides_step_as_its_repeats_of_its_duration() -> None:
    text = render_version(_version(_with_strides(five_week_draft())), "proposed")
    assert "      strides: 4 x 0:20" in text.splitlines()


# The load and VO2max fields, their checks and their rendering.


def _stored_v4_json() -> dict[str, Any]:
    """A version in the shape stored before the load fields existed."""
    data = five_week_draft().model_dump(mode="json")
    for week in data["weeks"]:
        for field in ("planned_zone_minutes", "expected_vdot", "expected_garmin_vo2max"):
            del week[field]
    data["weeks"][0]["sessions"][0]["steps"] = [
        {"role": "work", "distance_m": 5000.0, "heart_rate": {"low_bpm": 140, "high_bpm": 150}}
    ]
    data["provenance"] = {
        "number": 4,
        "revises": 3,
        "created_at": "2027-02-06T00:00:00Z",
        "data_through": "2027-02-05",
        "snapshot": [],
    }
    return data


def test_a_version_without_the_new_fields_still_validates() -> None:
    version = PlanVersion.model_validate(_stored_v4_json())
    assert version.weeks[0].planned_zone_minutes is None
    assert version.provenance.lthr_bpm is None
    assert version.provenance.target_vdot is None


def test_a_heart_rate_range_may_have_no_floor() -> None:
    assert HeartRateRange(high_bpm=161).low_bpm is None


def test_a_floor_above_the_ceiling_is_refused() -> None:
    with pytest.raises(ValidationError):
        HeartRateRange(low_bpm=170, high_bpm=161)


def test_planned_zone_minutes_needs_five_values() -> None:
    with pytest.raises(ValidationError):
        _week_edit(five_week_draft(), 0, planned_zone_minutes=[60.0, 20.0, 8.0, 2.0])
    with pytest.raises(ValidationError):
        _week_edit(five_week_draft(), 0, planned_zone_minutes=[60.0, 20.0, 8.0, 2.0, -1.0])


def test_planned_trimp_weights_minutes_by_the_stamp() -> None:
    assert planned_trimp([60, 30, 0, 10, 0], [1.0, 1.5, 2.0, 2.5, 3.0]) == 130.0


def test_planned_trimp_is_none_without_a_factor_for_planned_minutes() -> None:
    assert planned_trimp([60, 30, 0, 10, 0], [1.0, None, 2.0, 2.5, 3.0]) is None
    assert planned_trimp([60, 0, 0, 10, 0], [1.0, None, None, 2.5, 3.0]) == 85.0


def test_a_week_that_has_not_ended_needs_zone_minutes_and_expected_values() -> None:
    for field in ("planned_zone_minutes", "expected_vdot", "expected_garmin_vo2max"):
        problems = _check(_week_edit(five_week_draft(), 1, **{field: None}))
        assert problems == [f"week of 2027-02-15 has not ended and needs {field}"]


def test_expected_garmin_vo2max_is_required_only_when_the_watch_has_a_value() -> None:
    draft = _week_edit(five_week_draft(), 1, expected_garmin_vo2max=None)
    assert _check(draft) == ["week of 2027-02-15 has not ended and needs expected_garmin_vo2max"]
    without = {**CONTEXT, "fitness_now": {"garmin_vo2max": None}}
    assert _check(draft, context=without) == []
    # Every other outlook field is still required without the watch's value.
    no_vdot = _week_edit(five_week_draft(), 1, expected_vdot=None)
    assert _check(no_vdot, context=without) == [
        "week of 2027-02-15 has not ended and needs expected_vdot"
    ]


def _series_context(value: float | None) -> dict[str, Any]:
    return {**CONTEXT, "fitness_now": {"garmin_vo2max": 52, "best_efforts_vdot": value}}


def test_check_refuses_a_curve_that_does_not_start_on_the_series() -> None:
    # The fixture's first week ends 2027-02-14, after data_through 2027-02-05.
    too_far = _week_edit(
        five_week_draft(), 0, expected_vdot=45.0 + EXPECTED_VDOT_START_TOLERANCE + 0.1
    )
    problems = _check(too_far, context=_series_context(45.0))
    assert len(problems) == 1
    assert "2027-02-08" in problems[0]
    assert "45.0" in problems[0]
    assert f"{45.0 + EXPECTED_VDOT_START_TOLERANCE + 0.1:.1f}" in problems[0]
    near = _week_edit(
        five_week_draft(), 0, expected_vdot=45.0 + EXPECTED_VDOT_START_TOLERANCE - 0.1
    )
    assert _check(near, context=_series_context(45.0)) == []


def test_check_reads_the_start_rule_on_the_first_week_that_has_not_ended() -> None:
    # data_through 2027-02-14 is week 1's Sunday, so week 2 is the first that
    # has not ended. Week 1 is frozen from an earlier version and week 3 is
    # free to move away from the start, so neither is compared.
    through = date(2027, 2, 14)
    far = 45.0 + EXPECTED_VDOT_START_TOLERANCE + 5.0
    draft = _week_edit(_week_edit(five_week_draft(), 0, expected_vdot=far), 2, expected_vdot=far)
    draft = _week_edit(draft, 1, expected_vdot=45.0)
    assert _check(draft, through=through, context=_series_context(45.0)) == []
    off = _week_edit(draft, 1, expected_vdot=far)
    problems = _check(off, through=through, context=_series_context(45.0))
    assert len(problems) == 1
    assert "week of 2027-02-15" in problems[0]


def test_check_skips_the_start_rule_without_a_series_value() -> None:
    far = _week_edit(five_week_draft(), 0, expected_vdot=60.0)
    assert _check(far, context=_series_context(None)) == []
    assert _check(far) == []


def test_an_easy_run_step_needs_a_heart_rate_and_no_speed() -> None:
    data = five_week_draft().model_dump()
    data["weeks"][0]["sessions"][0]["steps"] = [
        {"role": "work", "distance_m": 5000.0, "speed": {"low_mps": 3.0, "high_mps": 3.4}},
    ]
    problems = _check(PlanDraft.model_validate(data))
    assert problems == [
        "session w1-easy is an easy or long run, so its work step gives a heart rate, not a speed",
        "session w1-easy is an easy or long run, so its work step needs a heart_rate",
    ]
    data["weeks"][0]["sessions"][0]["steps"] = [{"role": "strides", "duration_s": 20.0}]
    assert _check(PlanDraft.model_validate(data)) == []


def test_a_running_session_in_a_detailed_week_needs_a_duration() -> None:
    data = five_week_draft().model_dump()
    data["weeks"][0]["sessions"][1]["planned_duration_s"] = None
    assert _check(PlanDraft.model_validate(data)) == [
        "session w1-intervals is a run and needs planned_duration_s"
    ]


def test_zone_minutes_must_match_the_planned_run_time() -> None:
    problems = _check(_week_edit(five_week_draft(), 0, planned_zone_minutes=[60.0, 20, 8, 2, 11]))
    assert problems == [
        "week of 2027-02-08 plans 101 zone minutes, but its runs last 90 minutes, "
        "more than 10% apart"
    ]
    assert _check(_week_edit(five_week_draft(), 0, planned_zone_minutes=[60.0, 20, 8, 2, 9])) == []


def test_a_closing_version_is_exempt_from_the_new_checks() -> None:
    data = five_week_draft(result={"time_s": 1490.0, "achieved": True}).model_dump()
    for week in data["weeks"]:
        week["planned_zone_minutes"] = None
        week["expected_vdot"] = None
    data["weeks"][0]["sessions"][0]["planned_duration_s"] = None
    data["weeks"][1]["load_note"] = None
    assert _check(PlanDraft.model_validate(data), through=date(2027, 3, 13)) == []


def test_a_detailed_week_not_ended_needs_a_load_note() -> None:
    problems = _check(_week_edit(five_week_draft(), 1, load_note=None))
    assert problems == ["week of 2027-02-15 is detailed and has not ended, so it needs a load_note"]


def test_an_ended_or_outline_week_needs_no_load_note() -> None:
    # Week 4 is an outline; week 1 has ended by the 14th, where check 14 freezes it.
    assert _check(_week_edit(five_week_draft(), 3, load_note=None)) == []
    previous = _version(_week_edit(five_week_draft(), 0, load_note=None))
    draft = _week_edit(five_week_draft(), 0, load_note=None)
    assert _check(draft, previous, date(2027, 2, 14)) == []


def test_ended_weeks_need_no_zone_minutes() -> None:
    previous = _version(five_week_draft())
    through = date(2027, 2, 14)  # week 1 ended on the 14th
    data = five_week_draft().model_dump()
    first = data["weeks"][0]
    first["planned_zone_minutes"] = None
    first["expected_vdot"] = None
    first["expected_garmin_vo2max"] = None
    # Check 8 freezes past sessions, so the week's sessions stay as they were.
    assert _check(PlanDraft.model_validate(data), previous, through) == []


def _with_hr_steps(draft: PlanDraft) -> PlanDraft:
    data = draft.model_dump()
    data["weeks"][0]["sessions"][0]["steps"] = [
        {"role": "warmup", "distance_m": 1000.0, "heart_rate": {"high_bpm": 161.0}},
        {
            "role": "work",
            "distance_m": 4000.0,
            "heart_rate": {"low_bpm": 171.0, "high_bpm": 179.0},
        },
    ]
    return PlanDraft.model_validate(data)


def _stamped(draft: PlanDraft, **provenance: Any) -> PlanVersion:
    version = _version(draft)
    stamped = version.provenance.model_copy(update=provenance)
    return version.model_copy(update={"provenance": stamped})


def test_render_prints_a_ceiling_with_its_zone() -> None:
    version = _stamped(
        _with_hr_steps(five_week_draft()), zone_boundaries_bpm=[130.0, 161.0, 170.0, 180.0]
    )
    lines = render_version(version, "proposed").splitlines()
    assert "      warmup: 1 x 1 km @ up to 161 bpm (Z2)" in lines
    assert "      work: 1 x 4 km @ 171-179 bpm (Z4)" in lines


def test_render_prints_a_heart_rate_without_a_zone_when_no_boundaries_are_stamped() -> None:
    lines = render_version(_version(_with_hr_steps(five_week_draft())), "proposed").splitlines()
    assert "      warmup: 1 x 1 km @ up to 161 bpm" in lines
    assert "      work: 1 x 4 km @ 171-179 bpm" in lines


def _version_with_stamp(draft: PlanDraft, stamp: list[float | None] | None) -> PlanVersion:
    data = _version(draft).model_dump()
    data["provenance"]["trimp_per_minute"] = stamp
    return PlanVersion.model_validate(data)


def test_render_prints_weekly_trimp_and_its_change() -> None:
    data = five_week_draft().model_dump()
    data["weeks"][1]["planned_zone_minutes"] = [65.0, 22.0, 9.0, 2.0, 0.0]
    version = _version_with_stamp(PlanDraft.model_validate(data), [1.0, 2.0, 3.0, 4.0, 5.0])
    lines = render_version(version, "proposed").splitlines()
    # 60 + 40 + 24 + 8 = 132, then 65 + 44 + 27 + 8 = 144.
    assert "  TRIMP 132" in lines
    assert "  TRIMP 144 (+9%)" in lines


def test_render_prints_no_load_without_the_stamp() -> None:
    text = render_version(_version(five_week_draft()), "proposed")
    assert "TRIMP" not in text


def test_trimp_per_minute_stamp_needs_five_values() -> None:
    for bad in ([1.0, 2.0], [1.0] * 6, []):
        with pytest.raises(ValidationError, match="exactly five values"):
            _version_with_stamp(five_week_draft(), bad)
    assert _version_with_stamp(five_week_draft(), [None] * 5).provenance.trimp_per_minute


def _mid_week_two_previous() -> PlanVersion:
    """An accepted version whose week 2 easy run, already past, has a speed and no duration."""
    data = five_week_draft().model_dump()
    easy = data["weeks"][1]["sessions"][0]
    easy["planned_duration_s"] = None
    easy["steps"] = [
        {"role": "work", "distance_m": 5000.0, "speed": {"low_mps": 3.0, "high_mps": 3.4}}
    ]
    return _version(PlanDraft.model_validate(data))


def test_past_sessions_of_a_current_week_are_exempt_from_checks_17_to_19() -> None:
    previous = _mid_week_two_previous()
    through = date(2027, 2, 17)  # mid-week 2: the easy run on the 16th is frozen by check 8
    draft = PlanDraft.model_validate(previous.model_dump(exclude={"provenance"}))
    assert _check(draft, previous, through) == []


def test_zone_minutes_are_not_checked_in_a_week_holding_a_past_session() -> None:
    previous = _mid_week_two_previous()
    through = date(2027, 2, 17)
    data = previous.model_dump(exclude={"provenance"})
    data["weeks"][1]["planned_zone_minutes"] = [1.0, 1.0, 1.0, 1.0, 1.0]
    assert _check(PlanDraft.model_validate(data), previous, through) == []


def test_future_sessions_of_a_current_week_are_still_checked() -> None:
    previous = _mid_week_two_previous()
    through = date(2027, 2, 17)
    data = previous.model_dump(exclude={"provenance"})
    data["weeks"][1]["sessions"][2]["planned_duration_s"] = None  # the long run, on the 20th
    assert _check(PlanDraft.model_validate(data), previous, through) == [
        "session w2-long is a run and needs planned_duration_s"
    ]


def test_render_prints_the_expected_load_and_each_weeks_means() -> None:
    from activity_analysis.plan.models import ExpectedLoad

    version = _version_with_stamp(five_week_draft(), [1.0, 1.0, 1.0, 1.0, 1.0])
    version.provenance.expected_load = ExpectedLoad.model_validate(
        {
            "start": {"local_date": "2027-02-07", "ctl": 40.0, "atl": 52.5, "form": -12.5},
            "race_morning": {"local_date": "2027-03-12", "ctl": 41.25, "atl": 35.0, "form": 6.25},
            "weeks": [
                {
                    "week_start": "2027-02-08",
                    "days": 7,
                    "trimp": 90.0,
                    "ctl_mean": 40.4,
                    "atl_mean": 47.6,
                    "form_mean": -7.2,
                }
            ],
            "bridged_from": ["10k-earlier"],
        }
    )
    lines = render_version(version, "proposed").splitlines()
    assert (
        "Expected from 2027-02-07 to race morning: fitness 40.0 -> 41.2, "
        "fatigue 52.5 -> 35.0, form -12.5 -> +6.2"
    ) in lines
    assert "  Before this plan's first week it runs the plan of 10k-earlier" in lines
    assert "  TRIMP 90; week means fitness 40, fatigue 48, form -7" in lines


def test_render_prints_the_weeks_start_end_and_note() -> None:
    from activity_analysis.plan.models import ExpectedLoad

    version = _version_with_stamp(five_week_draft(), [1.0, 1.0, 1.0, 1.0, 1.0])
    version.provenance.expected_load = ExpectedLoad.model_validate(
        {
            "start": {"local_date": "2027-02-07", "ctl": 40.0, "atl": 52.5, "form": -12.5},
            "race_morning": {"local_date": "2027-03-12", "ctl": 41.25, "atl": 35.0, "form": 6.25},
            "weeks": [
                {
                    "week_start": "2027-02-08",
                    "days": 7,
                    "trimp": 90.0,
                    "ctl_mean": 40.4,
                    "atl_mean": 47.6,
                    "form_mean": -7.2,
                    "start": {"local_date": "2027-02-07", "ctl": 40.0, "atl": 52.5, "form": -12.5},
                    "end": {"local_date": "2027-02-14", "ctl": 41.25, "atl": 35.0, "form": 6.25},
                }
            ],
        }
    )
    lines = render_version(version, "proposed").splitlines()
    assert "  Fitness 40.0 -> 41.2, fatigue 52.5 -> 35.0, form -12.5 -> +6.2 over the week" in lines
    assert "  Load: Keep the easy runs easy so the quality lands." in lines
