"""Streaks and consistency, over the weeks the athlete ran in.

A week is an ISO week, Monday to Sunday, which is the convention where this
athlete lives and runs. Weeks are identified by their Monday, so a week is a
``date`` and arithmetic on weeks is arithmetic on dates.

The input is a set of week starts derived from the *local* date of each run
rather than from its UTC instant: a run belongs to the week the athlete ran
it in, not the week UTC was in at the time.

Both metrics ignore any week after the current one. A store can hold an
activity stamped in the future, because a device clock can be wrong, and a
week that has not happened yet is not training the athlete has done.

Deliberately not modelled: distance, duration and intensity. A streak here
measures whether the athlete ran, not how much. Anything stronger would be a
training-load metric, which is a different question with a different answer.

See ``docs/reference/math/consistency.md`` for the derivation.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date, timedelta

WEEK = timedelta(weeks=1)


def week_start(day: date) -> date:
    """The Monday of ``day``'s ISO week."""
    return day - timedelta(days=day.weekday())


def week_end(day: date) -> date:
    """The Sunday of ``day``'s ISO week.

    The last date the overview covers, so that every field it serves is
    bounded the way ``streak`` and ``consistency`` bound themselves.
    """
    return week_start(day) + WEEK - timedelta(days=1)


def week_starts(days: Iterable[date]) -> set[date]:
    """The distinct weeks a set of dates falls in."""
    return {week_start(day) for day in days}


@dataclass(frozen=True)
class StreakResult:
    current_weeks: int
    longest_weeks: int
    #: The Monday of the last week of the longest streak. ``None`` when there
    #: is no streak at all, which is the only case where there is no week to
    #: name.
    longest_ended_week: date | None


@dataclass(frozen=True)
class ConsistencyResult:
    weeks_considered: int
    weeks_with_a_run: int


def streak(weeks: set[date], today: date) -> StreakResult:
    """Consecutive weeks holding at least one run.

    The week in progress is not counted against the streak. A streak alive on
    Sunday evening is still alive on Monday morning, when the athlete has
    simply not run yet, so an empty current week is stepped over rather than
    treated as a break. It counts towards the length only once it holds a run.
    Only a completed empty week breaks a streak.

    A week after the current one is dropped before either walk, the same bound
    ``consistency`` applies: an activity stamped in the future is a corrupt
    device clock rather than training, and it must not be able to join two
    real streaks or name a week that has not happened yet.

    When several streaks tie for longest, the most recent one is the one
    named. Both are equally long and equally correct; which one it was is the
    part the reader cannot reconstruct, and the recent one is what tells them
    whether they are in it now.
    """
    current = week_start(today)
    counted = {week for week in weeks if week <= current}
    if current not in counted:
        current -= WEEK

    length = 0
    while current in counted:
        length += 1
        current -= WEEK

    longest = 0
    longest_end: date | None = None
    for start in sorted(counted):
        if start - WEEK in counted:
            continue  # not the first week of a run of weeks
        end, run_length = start, 1
        while end + WEEK in counted:
            end += WEEK
            run_length += 1
        if run_length >= longest:
            longest, longest_end = run_length, end

    return StreakResult(current_weeks=length, longest_weeks=longest, longest_ended_week=longest_end)


def consistency(weeks: set[date], today: date, span_weeks: int = 52) -> ConsistencyResult:
    """How many of the last ``span_weeks`` weeks held a run.

    Reported as a count out of a count rather than as a percentage, because
    30 of 52 is a fact and 58% is a rounding of it.

    Bounded above at the current week for the reason ``streak`` is.
    """
    latest = week_start(today)
    earliest = latest - WEEK * (span_weeks - 1)
    within = {week for week in weeks if earliest <= week <= latest}
    return ConsistencyResult(weeks_considered=span_weeks, weeks_with_a_run=len(within))
