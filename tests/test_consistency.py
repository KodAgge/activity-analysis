from datetime import date, timedelta

from activity_analysis.analysis.consistency import consistency, streak, week_start, week_starts

#: The Monday of the week holding 2026-08-30, which is a Sunday.
MONDAY = date(2026, 8, 24)
SUNDAY = date(2026, 8, 30)


def weeks_back(n: int, *, ending: date = MONDAY) -> set[date]:
    """``n`` consecutive week-start Mondays, the last of them ``ending``."""
    return {ending - timedelta(weeks=i) for i in range(n)}


def test_a_week_starts_on_monday():
    assert week_start(SUNDAY) == MONDAY
    assert week_start(MONDAY) == MONDAY


def test_run_dates_collapse_to_the_weeks_they_fall_in():
    assert week_starts([MONDAY, SUNDAY, MONDAY + timedelta(days=3)]) == {MONDAY}


def test_consecutive_weeks_count_as_a_streak():
    assert streak(weeks_back(9), today=SUNDAY).current_weeks == 9


def test_a_gap_ends_the_streak():
    weeks = weeks_back(9) - {MONDAY - timedelta(weeks=3)}
    assert streak(weeks, today=SUNDAY).current_weeks == 3


def test_a_streak_survives_a_monday_morning_with_no_run_yet():
    """The nine-week streak ran through Sunday. It is Monday and nothing yet.

    Without the grace rule this reports zero every Monday at midnight, which
    measures the calendar rather than the training.
    """
    weeks = weeks_back(9, ending=MONDAY - timedelta(weeks=1))
    assert streak(weeks, today=MONDAY).current_weeks == 9


def test_the_current_week_counts_once_it_holds_a_run():
    weeks = weeks_back(9)
    assert streak(weeks, today=MONDAY).current_weeks == 9


def test_a_completed_empty_week_still_breaks_the_streak():
    """One finished week with no run is a break, however recent."""
    weeks = weeks_back(9, ending=MONDAY - timedelta(weeks=2))
    assert streak(weeks, today=MONDAY).current_weeks == 0


def test_the_longest_streak_is_found_anywhere_in_history():
    weeks = weeks_back(3) | weeks_back(7, ending=MONDAY - timedelta(weeks=20))
    result = streak(weeks, today=SUNDAY)
    assert result.current_weeks == 3
    assert result.longest_weeks == 7
    assert result.longest_ended_week == MONDAY - timedelta(weeks=20)


def test_the_longest_streak_is_measured_over_completed_weeks_only():
    """A week that has not happened yet cannot lengthen a streak.

    The longest run of weeks is the current four, which reaches the current
    week. An activity stamped a week ahead - a device clock that was wrong -
    would extend it to five and name as its end a week nobody has run in yet.
    """
    weeks = weeks_back(4) | weeks_back(3, ending=MONDAY - timedelta(weeks=6))
    result = streak(weeks | {MONDAY + timedelta(weeks=1)}, today=SUNDAY)

    assert result.longest_weeks == 4
    assert result.longest_ended_week == MONDAY
    assert result.current_weeks == 4
    assert result == streak(weeks, today=SUNDAY)


def test_the_most_recent_of_two_equally_long_streaks_is_the_one_named():
    """Which streak it was is the part the reader cannot reconstruct.

    Two three-week streaks are equally long and equally correct answers, so
    the useful one to name is the recent one: it is what tells the athlete
    whether they are in their best streak right now rather than in 2025.
    """
    weeks = weeks_back(3) | weeks_back(3, ending=MONDAY - timedelta(weeks=10))
    result = streak(weeks, today=SUNDAY)

    assert result.longest_weeks == 3
    assert result.longest_ended_week == MONDAY


def test_a_week_after_the_current_one_is_not_the_end_of_a_streak():
    """The tie-break must not reach past the bound and name a future week."""
    weeks = weeks_back(3) | {MONDAY + timedelta(weeks=2)}
    assert streak(weeks, today=SUNDAY).longest_ended_week == MONDAY


def test_no_runs_at_all_is_a_streak_of_zero():
    result = streak(set(), today=SUNDAY)
    assert result.current_weeks == 0
    assert result.longest_weeks == 0
    assert result.longest_ended_week is None


def test_consistency_counts_weeks_rather_than_reporting_a_percentage():
    result = consistency(weeks_back(30), today=SUNDAY, span_weeks=52)
    assert result.weeks_considered == 52
    assert result.weeks_with_a_run == 30


def test_consistency_ignores_weeks_outside_the_span():
    weeks = weeks_back(4) | {MONDAY - timedelta(weeks=60)}
    assert consistency(weeks, today=SUNDAY).weeks_with_a_run == 4


def test_consistency_ignores_a_week_in_the_future():
    weeks = weeks_back(4) | {MONDAY + timedelta(weeks=1)}
    assert consistency(weeks, today=SUNDAY).weeks_with_a_run == 4
