"""Counting a run slower than 9:00/km as a walk.

The five committed fixtures are all genuine runs, so a walk is made from one
of them by rewriting its canonical distance. The pace the rule judges is that
distance over the grid's moving time, so a distance chosen from the moving
time puts the activity exactly where a test needs it either side of the
threshold, with the grid itself untouched.
"""

from __future__ import annotations

import math
import shutil
from pathlib import Path

import pandas as pd
import pytest

from activity_analysis.analysis.pipeline import recompute
from activity_analysis.analysis.reclassification import (
    WALK_SPORT,
    WALK_THRESHOLD_MPS,
    is_walk,
)
from activity_analysis.config import ANALYSIS_VERSION, Paths
from activity_analysis.ingest.pipeline import ingest
from activity_analysis.store import db
from activity_analysis.store.writer import (
    read_activities,
    read_activity_metrics,
    read_activity_tags,
    read_athlete_profile,
    read_best_efforts,
    read_sport_reclassifications,
    read_streams,
    read_zone_time,
    upsert_activities,
    write_streams,
)


@pytest.fixture
def ingested(tmp_path: Path, all_fit_fixtures: list[Path]) -> Paths:
    paths = Paths(root=tmp_path)
    source = tmp_path / "dump"
    source.mkdir()
    for fixture in all_fit_fixtures:
        shutil.copy(fixture, source / fixture.name)
    ingest(paths, source, athlete_id="tester")
    return paths


def _in_time_order(paths: Paths) -> list[str]:
    return [str(a) for a in read_activities(paths).sort_values("start_time_utc")["activity_id"]]


def _set_moving_speed(paths: Paths, activity_id: str, speed_mps: float) -> None:
    """Rewrite the canonical distance so the judged pace is ``speed_mps``.

    The moving time comes from a recompute of the untouched store, so it is
    the one the rule will divide by.
    """
    recompute(paths)
    moving = float(
        read_activity_metrics(paths).set_index("activity_id").loc[activity_id, "moving_time_s"]
    )
    stored = read_activities(paths)
    stored.loc[stored["activity_id"] == activity_id, "distance_m"] = speed_mps * moving
    upsert_activities(paths, stored)


def test_the_threshold_is_nine_minutes_per_kilometre() -> None:
    assert pytest.approx(540.0) == 1000.0 / WALK_THRESHOLD_MPS


@pytest.mark.parametrize(
    ("speed_mps", "expected"),
    [
        (WALK_THRESHOLD_MPS * 0.999, True),
        (WALK_THRESHOLD_MPS, False),
        (WALK_THRESHOLD_MPS * 1.001, False),
        (None, False),
        (math.nan, False),
    ],
)
def test_only_a_known_pace_slower_than_the_threshold_is_a_walk(
    speed_mps: float | None, expected: bool
) -> None:
    # No pace, which is a zero distance or a zero moving time, cannot be
    # judged, so the activity stays what it was recorded as.
    assert is_walk(speed_mps) is expected


def test_a_run_slower_than_the_threshold_is_counted_as_a_walk(ingested: Paths) -> None:
    walk = _in_time_order(ingested)[2]
    _set_moving_speed(ingested, walk, WALK_THRESHOLD_MPS * 0.99)

    result = recompute(ingested)

    assert result.reclassified == 1
    assert result.activities == 4
    assert not result.errors
    (row,) = read_sport_reclassifications(ingested).to_dict("records")
    assert row["activity_id"] == walk
    assert row["recorded_sport"] == "running"
    assert row["sport"] == WALK_SPORT
    assert row["avg_speed_mps"] == pytest.approx(WALK_THRESHOLD_MPS * 0.99)
    assert row["threshold_mps"] == pytest.approx(WALK_THRESHOLD_MPS)
    assert row["analysis_version"] == ANALYSIS_VERSION


def test_a_walk_gets_nothing_else_from_the_derived_layer(ingested: Paths) -> None:
    walk = _in_time_order(ingested)[2]
    _set_moving_speed(ingested, walk, WALK_THRESHOLD_MPS * 0.99)

    recompute(ingested)

    assert not ingested.derived_stream_path(walk).exists()
    for frame in (
        read_activity_metrics(ingested),
        read_best_efforts(ingested),
        read_zone_time(ingested),
        read_activity_tags(ingested),
    ):
        assert walk not in set(frame["activity_id"])


def test_a_run_just_faster_than_the_threshold_stays_a_run(ingested: Paths) -> None:
    run = _in_time_order(ingested)[2]
    _set_moving_speed(ingested, run, WALK_THRESHOLD_MPS * 1.01)

    result = recompute(ingested)

    assert result.reclassified == 0
    assert read_sport_reclassifications(ingested).empty
    assert run in set(read_activity_metrics(ingested)["activity_id"])


def test_a_treadmill_run_is_judged_on_its_canonical_distance(ingested: Paths) -> None:
    """Indoors the grid's odometer is a footpod estimate and the session total
    is the better number, so a slow session total makes a walk however fast
    the grid says the athlete moved."""
    walk = _in_time_order(ingested)[2]
    stored = read_activities(ingested)
    stored.loc[stored["activity_id"] == walk, "sub_sport"] = "treadmill"
    upsert_activities(ingested, stored)
    _set_moving_speed(ingested, walk, WALK_THRESHOLD_MPS * 0.95)

    recompute(ingested)

    grid_distance = float(read_streams(ingested, walk)["distance_m"].max())
    assert grid_distance > float(
        read_activities(ingested).set_index("activity_id").loc[walk, "distance_m"]
    ), "the grid's odometer must say faster, or this proves nothing"
    assert set(read_sport_reclassifications(ingested)["activity_id"]) == {walk}


def test_a_run_with_long_stops_is_judged_on_its_moving_pace(ingested: Paths) -> None:
    """An hour standing still halfway makes the elapsed pace a walker's while
    the athlete ran every moving second; the rule must not see a walk."""
    run = _in_time_order(ingested)[2]
    streams = read_streams(ingested, run)
    half = len(streams) // 2
    streams.loc[half:, "timestamp_utc"] += pd.Timedelta(hours=1)
    streams.loc[half:, "t_s"] += 3600.0
    write_streams(ingested, run, streams)

    recompute(ingested)

    metrics = read_activity_metrics(ingested).set_index("activity_id").loc[run]
    distance = float(read_activities(ingested).set_index("activity_id").loc[run, "distance_m"])
    assert distance / float(metrics["elapsed_time_s"]) < WALK_THRESHOLD_MPS, (
        "the elapsed pace must be a walker's, or this proves nothing"
    )
    assert read_sport_reclassifications(ingested).empty


def test_a_walk_is_not_the_run_before_the_next_one(ingested: Paths) -> None:
    first, second, third = _in_time_order(ingested)[:3]
    _set_moving_speed(ingested, second, WALK_THRESHOLD_MPS * 0.99)

    recompute(ingested)

    starts = read_activities(ingested).set_index("activity_id")["start_time_utc"]
    gap = read_activity_metrics(ingested).set_index("activity_id").loc[third]
    expected = (starts[third].date() - starts[first].date()).days
    assert gap["days_since_previous_run"] == expected


def test_the_athlete_profile_still_versions_from_the_recorded_sport(ingested: Paths) -> None:
    # The activity was started on the watch's running profile, so it carries
    # that profile's settings whatever the athlete then did.
    recompute(ingested)
    before = read_athlete_profile(ingested).drop(columns="analysis_version")
    walk = _in_time_order(ingested)[-1]
    _set_moving_speed(ingested, walk, WALK_THRESHOLD_MPS * 0.99)

    recompute(ingested)

    after = read_athlete_profile(ingested).drop(columns="analysis_version")
    pd.testing.assert_frame_equal(before, after)


def test_the_activities_view_serves_the_sport_it_is_counted_as(ingested: Paths) -> None:
    walk = _in_time_order(ingested)[2]
    _set_moving_speed(ingested, walk, WALK_THRESHOLD_MPS * 0.99)
    recompute(ingested)

    rows = (
        db.connect(ingested)
        .execute("SELECT activity_id, sport, recorded_sport FROM activities")
        .df()
        .set_index("activity_id")
    )

    assert rows.loc[walk, "sport"] == WALK_SPORT
    assert rows.loc[walk, "recorded_sport"] == "running"
    others = rows.drop(index=walk)
    assert (others["sport"] == "running").all()
    assert (others["recorded_sport"] == "running").all()


def test_an_empty_store_has_an_empty_reclassification_view(tmp_path: Path) -> None:
    paths = Paths(root=tmp_path)
    recompute(paths)
    con = db.connect(paths)
    assert con.execute("SELECT count(*) FROM sport_reclassifications").fetchone() == (0,)
    assert con.execute("SELECT count(*) FROM activities").fetchone() == (0,)
