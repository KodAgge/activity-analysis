"""Semantic checks a draft must pass beyond what the schema can say.

The schema refuses a malformed file; these refuse a well-formed plan that
contradicts itself, the athlete's constraints or the history it revises. Each
problem is one sentence, so Claude can read the list and fix the draft.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping
from datetime import date, timedelta
from typing import Any

from activity_analysis.plan.models import (
    RUNNING_KINDS,
    ZONE_MINUTES_TOLERANCE,
    PlanDraft,
    PlanVersion,
    Session,
)


def resolve_pointer(document: Any, pointer: str) -> Any:
    """Follow an RFC 6901 JSON Pointer, raising ``KeyError`` when it does not resolve."""
    if pointer == "":
        return document
    if not pointer.startswith("/"):
        raise KeyError(pointer)
    node = document
    for raw in pointer[1:].split("/"):
        token = raw.replace("~1", "/").replace("~0", "~")
        if isinstance(node, Mapping):
            if token not in node:
                raise KeyError(pointer)
            node = node[token]
        elif isinstance(node, list):
            # ASCII only: "²".isdigit() is true and int("²") raises.
            if not (token.isascii() and token.isdigit()) or (len(token) > 1 and token[0] == "0"):
                raise KeyError(pointer)
            index = int(token)
            if index >= len(node):
                raise KeyError(pointer)
            node = node[index]
        else:
            raise KeyError(pointer)
    return node


def _sessions(draft: PlanDraft) -> dict[str, Session]:
    return {s.id: s for week in draft.weeks for s in week.sessions}


def _garmin_vo2max_known(context: Mapping[str, Any]) -> bool:
    """Whether the context holds a Garmin VO2max for the outlook to start from."""
    fitness_now = context.get("fitness_now")
    return isinstance(fitness_now, Mapping) and fitness_now.get("garmin_vo2max") is not None


def _detail_problems(
    draft: PlanDraft, data_through: date | None, context: Mapping[str, Any]
) -> list[str]:
    """Checks 16 to 20: a week that has not ended carries the load and VO2max outlook."""
    problems: list[str] = []
    # A store without Garmin's VO2max, such as a Strava-only one, has no value for
    # the expected curve to start from, so check 16 does not ask for one.
    fields = ["planned_zone_minutes", "expected_vdot"]
    if _garmin_vo2max_known(context):
        fields.append("expected_garmin_vo2max")
    for week in draft.weeks:
        if data_through is not None and week.start_date + timedelta(days=6) <= data_through:
            continue
        start = week.start_date
        for field in fields:
            if getattr(week, field) is None:
                problems.append(f"week of {start} has not ended and needs {field}")
        if not week.detailed:
            continue
        if week.load_note is None or not week.load_note.strip():
            problems.append(
                f"week of {start} is detailed and has not ended, so it needs a load_note"
            )
        # Check 8 freezes sessions dated on or before data_through, so a past session
        # cannot be asked to gain a heart rate or a duration.
        future = [s for s in week.sessions if data_through is None or s.date > data_through]
        running = [s for s in future if s.kind in RUNNING_KINDS]
        for s in future:
            if s.kind not in ("easy", "long"):
                continue
            for step in s.steps:
                if step.speed is not None:
                    problems.append(
                        f"session {s.id} is an easy or long run, so its {step.role} step "
                        "gives a heart rate, not a speed"
                    )
                if step.role != "strides" and step.heart_rate is None:
                    problems.append(
                        f"session {s.id} is an easy or long run, so its {step.role} step "
                        "needs a heart_rate"
                    )
        missing = [s.id for s in running if s.planned_duration_s is None]
        for session_id in missing:
            problems.append(f"session {session_id} is a run and needs planned_duration_s")
        # A week holding a past session has a total no one can check against its frozen
        # sessions' unknown durations, so only a wholly future week is held to check 19.
        whole = len(future) == len(week.sessions)
        if week.planned_zone_minutes is not None and not missing and whole:
            planned = sum(s.planned_duration_s or 0.0 for s in running) / 60
            zoned = sum(week.planned_zone_minutes)
            if abs(zoned - planned) > ZONE_MINUTES_TOLERANCE * planned:
                problems.append(
                    f"week of {start} plans {zoned:g} zone minutes, but its runs last "
                    f"{planned:g} minutes, more than {ZONE_MINUTES_TOLERANCE:.0%} apart"
                )
    return problems


def check_draft(
    draft: PlanDraft,
    *,
    previous: PlanVersion | None,
    context: Mapping[str, Any],
    data_through: date | None,
) -> list[str]:
    """Return one sentence per problem, or an empty list when the draft is valid."""
    problems: list[str] = []
    weeks = draft.weeks
    goal = draft.goal

    for week in weeks:
        if week.start_date.weekday() != 0:
            problems.append(f"week starting {week.start_date} does not start on a Monday")
    for earlier, later in zip(weeks, weeks[1:], strict=False):
        if later.start_date != earlier.start_date + timedelta(days=7):
            problems.append(
                f"week of {later.start_date} does not follow the week of "
                f"{earlier.start_date} by exactly seven days"
            )

    if weeks:
        last = weeks[-1].start_date
        if not last <= goal.race_date <= last + timedelta(days=6):
            problems.append(
                f"race date {goal.race_date} is outside the last week, which starts {last}"
            )
    else:
        problems.append("the plan has no weeks")

    seen: Counter[str] = Counter(s.id for w in weeks for s in w.sessions)
    for session_id, count in seen.items():
        if count > 1:
            problems.append(f"session id {session_id} is used {count} times")

    for week in weeks:
        end = week.start_date + timedelta(days=6)
        for s in week.sessions:
            if not week.start_date <= s.date <= end:
                problems.append(
                    f"session {s.id} is dated {s.date}, outside the week of {week.start_date}"
                )
        if week.detailed and not week.sessions:
            problems.append(f"week of {week.start_date} is detailed but has no sessions")
        if not week.detailed and week.sessions:
            problems.append(f"week of {week.start_date} is an outline but has sessions")
        runs = sum(1 for s in week.sessions if s.kind in RUNNING_KINDS)
        if runs > draft.constraints.runs_per_week:
            problems.append(
                f"week of {week.start_date} has {runs} runs, more than the "
                f"{draft.constraints.runs_per_week} a week the athlete set"
            )

    if weeks:
        race_week = weeks[-1]
        if not race_week.detailed:
            problems.append(f"the race week of {race_week.start_date} must be detailed")
        if not any(
            s.kind == "race" and s.date == goal.race_date for w in weeks for s in w.sessions
        ):
            problems.append(f"no session of kind race is dated on the race date {goal.race_date}")

    for citation in draft.assessment.citations:
        try:
            resolve_pointer(context, citation.pointer)
        except KeyError:
            problems.append(
                f"citation {citation.label!r} points at {citation.pointer}, "
                "which does not resolve in the context"
            )

    current = _sessions(draft)
    if draft.assessment.estimate_s is None and draft.result is None and weeks:
        start = weeks[0].start_date
        if previous is not None and data_through is not None:
            start = max(start, data_through + timedelta(days=1))
        end = start + timedelta(days=13)
        named = {c.session_id for c in draft.checkpoints}
        if not start <= goal.race_date <= end and not any(
            s.kind == "time_trial" and start <= s.date <= end and s.id in named
            for s in current.values()
        ):
            problems.append(
                "no estimate is given, so a time trial within two weeks of the version's "
                f"start, from {start} to {end}, must be scheduled and named by a checkpoint"
            )

    for checkpoint in draft.checkpoints:
        if checkpoint.session_id not in current:
            problems.append(
                f"checkpoint names session {checkpoint.session_id}, which is not in the plan"
            )
    # A change may also name a session the accepted version had and the draft removes.
    removable = set(_sessions(previous)) if previous is not None else set()
    for change in draft.changes:
        for session_id in change.session_ids:
            if session_id not in current and session_id not in removable:
                problems.append(
                    f"change {change.title!r} names session {session_id}, which is not in the plan"
                )

    if draft.result is not None and (data_through is None or data_through < goal.race_date):
        through = "no run" if data_through is None else f"only through {data_through}"
        problems.append(
            f"a result is given, but the data runs {through}, before the race date {goal.race_date}"
        )

    for outcome in draft.outcomes:
        session = current.get(outcome.session_id)
        if session is None:
            problems.append(f"outcome names session {outcome.session_id}, which is not in the plan")
        elif data_through is None or session.date > data_through:
            problems.append(
                f"outcome names session {outcome.session_id}, dated {session.date}, "
                "which is not in the past of the data"
            )

    if draft.result is None:
        problems.extend(_detail_problems(draft, data_through, context))

    if previous is not None:
        if goal.goal_id != previous.goal.goal_id:
            problems.append(
                f"goal id {goal.goal_id} differs from the previous version's "
                f"{previous.goal.goal_id}; a new goal needs its own plan"
            )
        elif goal != previous.goal and not (draft.changes and draft.changes[0].goal_change):
            problems.append(
                "the goal differs from the previous version's, "
                "but the first change entry does not say goal_change"
            )
        kept = {o.session_id: o for o in draft.outcomes}
        for outcome in previous.outcomes:
            if outcome.session_id not in kept:
                problems.append(
                    f"the outcome for session {outcome.session_id} in the previous version "
                    "is missing from the draft; earlier outcomes are kept"
                )
            elif kept[outcome.session_id] != outcome:
                problems.append(
                    f"the outcome for session {outcome.session_id} differs from the previous "
                    "version's; earlier outcomes are kept"
                )
        if data_through is not None:
            old_weeks = {w.start_date: w for w in previous.weeks}
            new_weeks = {w.start_date: w for w in weeks}
            for week_start, week in new_weeks.items():
                if week_start + timedelta(days=6) > data_through:
                    continue
                before = old_weeks.get(week_start)
                if before is None:
                    problems.append(
                        f"week of {week_start} has ended but is not in the previous version; "
                        "past weeks are frozen"
                    )
                    continue
                for field in ("phase", "focus", "planned_distance_m"):
                    if getattr(week, field) != getattr(before, field):
                        problems.append(
                            f"week of {week_start} has ended and changes {field} from the "
                            "previous version; past weeks are frozen"
                        )
            for week_start in old_weeks:
                if week_start + timedelta(days=6) <= data_through and week_start not in new_weeks:
                    problems.append(
                        f"week of {week_start} has ended and is missing from the draft; "
                        "past weeks are frozen"
                    )
            old = _sessions(previous)
            for session_id, session in current.items():
                if session.date > data_through:
                    continue
                if session_id not in old:
                    problems.append(
                        f"session {session_id} is dated {session.date}, in the past of the "
                        "data, but is not in the previous version; past sessions are frozen"
                    )
                elif session != old[session_id]:
                    problems.append(
                        f"session {session_id} is dated {session.date}, in the past of the "
                        "data, and differs from the previous version; past sessions are frozen"
                    )
            for session_id, session in old.items():
                if session.date <= data_through and session_id not in current:
                    problems.append(
                        f"session {session_id} is dated {session.date}, in the past of the "
                        "data, and is missing from the draft; past sessions are frozen"
                    )

    return problems
