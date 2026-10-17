from datetime import UTC, datetime

import pandas as pd

from activity_analysis.identity import compute_activity_id, find_matching_activity, wins
from activity_analysis.models import SOURCE_GPX, SOURCE_STRAVA_FIT

START = datetime(2026, 8, 28, 18, 19, 14, tzinfo=UTC)


def _stored(activity_id: str, start: datetime, distance: float | None) -> pd.DataFrame:
    return pd.DataFrame(
        [
            {
                "activity_id": activity_id,
                "athlete_id": "default",
                "start_time_utc": pd.Timestamp(start),
                "distance_m": distance,
            }
        ]
    )


def test_identity_is_deterministic():
    assert compute_activity_id("default", START) == compute_activity_id("default", START)
    assert len(compute_activity_id("default", START)) == 16


def test_identity_ignores_seconds_within_the_same_minute():
    assert compute_activity_id("default", START) == compute_activity_id(
        "default", START.replace(second=44)
    )


def test_identity_differs_across_minutes():
    assert compute_activity_id("default", START) != compute_activity_id(
        "default", START.replace(minute=20)
    )


def test_identity_differs_between_athletes():
    assert compute_activity_id("august", START) != compute_activity_id("someone-else", START)


def test_no_match_against_an_empty_store():
    assert find_matching_activity(pd.DataFrame(), "default", START, 7456.06) is None


def test_matches_the_same_run_despite_distance_measurement_differences():
    # The real fixture pair: FIT 7456.06 m, GPX-derived 7454.85 m.
    stored = _stored("existing", START, 7456.06)
    assert find_matching_activity(stored, "default", START, 7454.85) == "existing"


def test_matches_across_a_minute_boundary():
    stored = _stored("existing", datetime(2026, 8, 28, 18, 19, 59, tzinfo=UTC), 7456.06)
    candidate = datetime(2026, 8, 28, 18, 20, 1, tzinfo=UTC)
    assert find_matching_activity(stored, "default", candidate, 7456.06) == "existing"


def test_does_not_match_a_different_run_starting_nearby():
    stored = _stored("existing", START, 7456.06)
    assert find_matching_activity(stored, "default", START, 4069.2) is None


def test_does_not_match_a_run_far_apart_in_time():
    stored = _stored("existing", START, 7456.06)
    later = datetime(2026, 8, 28, 19, 30, 0, tzinfo=UTC)
    assert find_matching_activity(stored, "default", later, 7456.06) is None


def test_does_not_match_another_athlete():
    stored = _stored("existing", START, 7456.06)
    assert find_matching_activity(stored, "someone-else", START, 7456.06) is None


def test_matches_when_a_distance_is_unknown():
    stored = _stored("existing", START, None)
    assert find_matching_activity(stored, "default", START, 7456.06) == "existing"


def test_fit_wins_against_gpx():
    assert wins(SOURCE_STRAVA_FIT, SOURCE_GPX) is True
    assert wins(SOURCE_GPX, SOURCE_STRAVA_FIT) is False


def test_equal_priority_does_not_displace_the_incumbent():
    assert wins(SOURCE_STRAVA_FIT, SOURCE_STRAVA_FIT) is False
