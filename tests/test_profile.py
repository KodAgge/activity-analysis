"""Profile versioning, tested on fabricated observation sequences."""

from __future__ import annotations

import pandas as pd

from activity_analysis.analysis.profile import (
    observations_for_sport,
    profile_at,
    version_profile,
)


def _observations(rows: list[dict[str, object]]) -> pd.DataFrame:
    frame = pd.DataFrame(rows)
    if frame.empty:
        frame = pd.DataFrame(
            columns=[
                "athlete_id",
                "observed_at",
                "weight_kg",
                "height_m",
                "resting_hr_bpm",
                "max_hr_bpm",
                "hr_zone_boundaries",
                "hr_calc_type",
            ]
        )
    frame["observed_at"] = pd.to_datetime(frame["observed_at"], utc=True)
    for column in ("weight_kg", "height_m", "resting_hr_bpm", "max_hr_bpm"):
        if column not in frame:
            frame[column] = None
    if "hr_zone_boundaries" not in frame:
        frame["hr_zone_boundaries"] = [None] * len(frame)
    if "hr_calc_type" not in frame:
        frame["hr_calc_type"] = None
    if "athlete_id" not in frame:
        frame["athlete_id"] = "tester"
    return frame


def test_identical_consecutive_observations_collapse_into_one_interval() -> None:
    frame = version_profile(
        _observations(
            [
                {"observed_at": "2025-01-01T10:00:00Z", "weight_kg": 92.0},
                {"observed_at": "2025-02-01T10:00:00Z", "weight_kg": 92.0},
                {"observed_at": "2025-03-01T10:00:00Z", "weight_kg": 92.0},
            ]
        )
    )
    assert len(frame) == 1
    assert frame["effective_from"].iloc[0] == pd.Timestamp("2025-01-01T10:00:00Z")


def test_a_changed_value_opens_a_new_interval_and_closes_the_previous_one() -> None:
    frame = version_profile(
        _observations(
            [
                {"observed_at": "2025-01-01T10:00:00Z", "weight_kg": 93.0},
                {"observed_at": "2025-06-01T10:00:00Z", "weight_kg": 92.0},
            ]
        )
    )
    assert len(frame) == 2
    assert frame["effective_to"].iloc[0] == pd.Timestamp("2025-06-01T10:00:00Z")
    assert frame["effective_from"].iloc[1] == pd.Timestamp("2025-06-01T10:00:00Z")


def test_the_latest_interval_stays_open() -> None:
    frame = version_profile(
        _observations([{"observed_at": "2025-01-01T10:00:00Z", "weight_kg": 93.0}])
    )
    assert pd.isna(frame["effective_to"].iloc[0])


def test_observations_out_of_order_are_sorted_before_collapsing() -> None:
    frame = version_profile(
        _observations(
            [
                {"observed_at": "2025-06-01T10:00:00Z", "weight_kg": 92.0},
                {"observed_at": "2025-01-01T10:00:00Z", "weight_kg": 93.0},
            ]
        )
    )
    assert frame["weight_kg"].tolist() == [93.0, 92.0]


def test_a_value_returning_to_an_earlier_one_opens_a_third_interval() -> None:
    # The athlete edited the setting back. That is a change, not a return to
    # the first interval, because the interval in between really happened.
    frame = version_profile(
        _observations(
            [
                {"observed_at": "2025-01-01T10:00:00Z", "weight_kg": 93.0},
                {"observed_at": "2025-03-01T10:00:00Z", "weight_kg": 92.0},
                {"observed_at": "2025-06-01T10:00:00Z", "weight_kg": 93.0},
            ]
        )
    )
    assert len(frame) == 3
    assert frame["weight_kg"].tolist() == [93.0, 92.0, 93.0]


def test_zone_boundaries_take_part_in_the_comparison() -> None:
    frame = version_profile(
        _observations(
            [
                {"observed_at": "2025-01-01T10:00:00Z", "hr_zone_boundaries": [100.0, 120.0]},
                {"observed_at": "2025-02-01T10:00:00Z", "hr_zone_boundaries": [100.0, 120.0]},
                {"observed_at": "2025-03-01T10:00:00Z", "hr_zone_boundaries": [105.0, 125.0]},
            ]
        )
    )
    assert len(frame) == 2


def test_athletes_are_versioned_independently() -> None:
    observations = _observations(
        [
            {"observed_at": "2025-01-01T10:00:00Z", "weight_kg": 92.0, "athlete_id": "a"},
            {"observed_at": "2025-02-01T10:00:00Z", "weight_kg": 70.0, "athlete_id": "b"},
        ]
    )
    frame = version_profile(observations)
    assert len(frame) == 2
    assert set(frame["athlete_id"]) == {"a", "b"}
    assert frame["effective_to"].isna().all()


def test_lookup_returns_the_interval_in_force_at_a_moment() -> None:
    frame = version_profile(
        _observations(
            [
                {"observed_at": "2025-01-01T10:00:00Z", "max_hr_bpm": 200.0},
                {"observed_at": "2025-06-01T10:00:00Z", "max_hr_bpm": 207.0},
            ]
        )
    )
    early = profile_at(frame, "tester", pd.Timestamp("2025-03-01T10:00:00Z"))
    late = profile_at(frame, "tester", pd.Timestamp("2025-07-01T10:00:00Z"))
    assert early is not None and early["max_hr_bpm"] == 200.0
    assert late is not None and late["max_hr_bpm"] == 207.0


def test_lookup_before_any_observation_returns_nothing() -> None:
    """The 84 oldest runs predate the first profile message.

    They also carry no heart rate at all, so there is nothing to attribute to
    a maximum and nothing to backfill.
    """
    frame = version_profile(
        _observations([{"observed_at": "2025-01-01T10:00:00Z", "max_hr_bpm": 207.0}])
    )
    assert profile_at(frame, "tester", pd.Timestamp("2024-01-01T10:00:00Z")) is None


def test_lookup_for_an_unknown_athlete_returns_nothing() -> None:
    frame = version_profile(
        _observations([{"observed_at": "2025-01-01T10:00:00Z", "max_hr_bpm": 207.0}])
    )
    assert profile_at(frame, "somebody_else", pd.Timestamp("2025-06-01T10:00:00Z")) is None


def test_no_observations_yields_an_empty_frame() -> None:
    frame = version_profile(_observations([]))
    assert frame.empty


def test_observations_are_filtered_to_one_sport_before_versioning() -> None:
    """Zone settings are per sport in FIT, and mixing them is nonsense.

    The real export has a maximum heart rate of 207 configured for running and
    205 for walking. Versioning both into one timeline yields hundreds of
    alternating intervals that record which sport happened next, not anything
    the athlete ever changed.
    """
    observations = _observations(
        [
            {"observed_at": "2025-01-01T10:00:00Z", "max_hr_bpm": 207.0, "activity_id": "run1"},
            {"observed_at": "2025-01-02T10:00:00Z", "max_hr_bpm": 205.0, "activity_id": "walk1"},
            {"observed_at": "2025-01-03T10:00:00Z", "max_hr_bpm": 207.0, "activity_id": "run2"},
        ]
    )
    activities = pd.DataFrame(
        {
            "activity_id": ["run1", "walk1", "run2"],
            "sport": ["running", "walking", "running"],
        }
    )

    running = observations_for_sport(observations, activities, "running")
    assert len(running) == 2
    assert version_profile(running)["max_hr_bpm"].tolist() == [207.0]

    # Without the filter the same data invents a change that never happened.
    assert len(version_profile(observations)) == 3


def test_filtering_a_sport_with_no_observations_yields_an_empty_frame() -> None:
    observations = _observations(
        [{"observed_at": "2025-01-01T10:00:00Z", "max_hr_bpm": 207.0, "activity_id": "run1"}]
    )
    activities = pd.DataFrame({"activity_id": ["run1"], "sport": ["running"]})
    assert observations_for_sport(observations, activities, "cycling").empty
