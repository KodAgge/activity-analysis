"""End to end over the committed fixtures: ingest, then recompute."""

from __future__ import annotations

import shutil
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from activity_analysis.analysis.metrics import activity_metrics
from activity_analysis.analysis.pipeline import recompute
from activity_analysis.analysis.tags import Flag, TagHistory
from activity_analysis.config import ANALYSIS_VERSION, Paths
from activity_analysis.ingest.pipeline import ingest
from activity_analysis.store import db
from activity_analysis.store.writer import (
    read_activities,
    read_activity_metrics,
    read_activity_tags,
    read_athlete_profile,
    read_best_efforts,
    read_derived_stream,
    read_laps,
    read_streams,
    read_zone_time,
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


def test_recompute_covers_every_running_activity(ingested: Paths) -> None:
    result = recompute(ingested)
    assert result.activities == 5
    assert not result.errors


def test_a_derived_grid_is_written_per_activity(ingested: Paths) -> None:
    recompute(ingested)
    activities = read_activities(ingested)
    for activity_id in activities["activity_id"]:
        grid = read_derived_stream(ingested, activity_id)
        assert not grid.empty
        assert grid["t_s"].is_monotonic_increasing
        assert grid["distance_m"].is_monotonic_increasing


def test_best_efforts_cover_the_distances_the_fixtures_reach(ingested: Paths) -> None:
    # The five fixtures span 4.1 km to 10.4 km, so 10 km appears exactly once
    # and nothing longer appears at all. 5 miles is 8046.7 m and so reaches
    # the longest fixture; 8 miles is 12.9 km and so reaches none of them.
    recompute(ingested)
    frame = read_best_efforts(ingested)
    assert set(frame["distance_key"]) == {
        "400m",
        "1k",
        "1mi",
        "2k",
        "3k",
        "4k",
        "3mi",
        "5k",
        "6k",
        "8k",
        "5mi",
        "10k",
    }
    assert (frame["distance_key"] == "10k").sum() == 1
    assert (frame["elapsed_time_s"] > 0).all()


def test_zone_rows_exist_for_every_activity_with_a_profile(ingested: Paths) -> None:
    recompute(ingested)
    zones = read_zone_time(ingested)
    # Seven zones from six boundaries, five activities.
    assert len(zones) == 35
    assert zones.groupby("activity_id")["seconds_s"].sum().gt(0).all()


def test_metrics_exist_for_every_activity(ingested: Paths) -> None:
    recompute(ingested)
    metrics = read_activity_metrics(ingested)
    assert len(metrics) == 5
    assert (metrics["moving_time_s"] <= metrics["elapsed_time_s"]).all()
    assert metrics["has_hr"].all()


def test_days_since_previous_run_is_null_on_the_first_run(ingested: Paths) -> None:
    """Only the earliest run has no previous run to report a gap from.

    Earliest by start_time_utc, not by ingestion order. The five fixtures
    span five distinct local dates, so the other four each get a real gap
    rather than a null one.
    """
    recompute(ingested)
    metrics = read_activity_metrics(ingested).set_index("activity_id")
    activities = read_activities(ingested).sort_values("start_time_utc")
    first_id = activities.iloc[0]["activity_id"]
    assert pd.isna(metrics.loc[first_id, "days_since_previous_run"])
    assert metrics["days_since_previous_run"].notna().sum() == 4


def test_a_run_with_no_streams_still_counts_as_the_previous_run(ingested: Paths) -> None:
    """A run that never reaches the derived layer still happened.

    With the earliest run's streams gone it gets no metrics row of its own,
    but the second run's gap is still measured from it rather than read as
    the first run in the history.
    """
    activities = read_activities(ingested).sort_values("start_time_utc")
    first_id, second_id = (str(a) for a in activities["activity_id"].iloc[:2])
    recompute(ingested)
    expected = (
        read_activity_metrics(ingested)
        .set_index("activity_id")
        .loc[second_id, "days_since_previous_run"]
    )
    assert pd.notna(expected)

    ingested.stream_path(first_id).unlink()
    result = recompute(ingested)

    assert result.skipped_no_streams == 1
    metrics = read_activity_metrics(ingested).set_index("activity_id")
    assert first_id not in metrics.index
    assert metrics.loc[second_id, "days_since_previous_run"] == expected


def test_every_positioned_activity_keeps_its_place_through_parquet(ingested: Paths) -> None:
    """The place columns survive being written and read back, per activity.

    tests/test_metrics.py proves a grid reaches the place lookup; only the
    round trip through activity_metrics.parquet shows a dtype or null-handling
    fault. The five fixtures are all outdoor, so every row is placed; an
    indoor fixture would have to take the all-null branch instead. The
    specific name is deliberately not asserted here, so the bundled table's
    spelling is coupled to tests/test_places.py alone.
    """
    recompute(ingested)
    metrics = read_activity_metrics(ingested)
    assert len(metrics) == 5
    positioned = metrics["has_gps"] & ~metrics["is_indoor"]
    assert positioned.any()
    placed = metrics.loc[positioned]
    for column in ("locality", "country_code", "country"):
        assert placed[column].map(lambda value: isinstance(value, str) and value != "").all()
    assert np.isfinite(placed["locality_distance_m"]).all()
    unplaced = metrics.loc[~positioned]
    for column in ("locality", "country_code", "country"):
        assert unplaced[column].isna().all()
    assert unplaced["locality_distance_m"].isna().all()


def test_derived_elapsed_time_is_exactly_the_span_of_the_canonical_stream(
    ingested: Paths,
) -> None:
    # Exact, because this is the same quantity read two ways: the grid spans
    # whole seconds from zero to the last record. Canonical
    # activities.elapsed_time_s is a different quantity, the device's own
    # session total, so it is not what this compares against.
    recompute(ingested)
    metrics = read_activity_metrics(ingested).set_index("activity_id")
    assert len(metrics) == 5
    for activity_id in metrics.index:
        span = float(np.floor(read_streams(ingested, str(activity_id))["t_s"].max()))
        assert metrics.loc[activity_id, "elapsed_time_s"] == pytest.approx(span)


def test_an_activity_that_fails_leaves_no_grid_behind(
    ingested: Paths, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An activity in streams_1hz is an activity in activity_metrics.

    Otherwise a single failure mid-rebuild leaves the derived layer internally
    inconsistent: a grid on disk that the wholesale-rewritten tables have no
    row for, and a CLI that still exits 0.
    """
    recompute(ingested)
    doomed = str(read_activities(ingested)["activity_id"].iloc[0])
    assert ingested.derived_stream_path(doomed).exists()

    def explode(grid: pd.DataFrame, activity: pd.Series) -> dict[str, object]:
        if str(activity["activity_id"]) == doomed:
            raise TypeError("hr_zone_boundaries was not iterable")
        return activity_metrics(grid, activity)

    monkeypatch.setattr("activity_analysis.analysis.pipeline.activity_metrics", explode)
    result = recompute(ingested)

    assert result.activities == 4
    assert [activity_id for activity_id, _ in result.errors] == [doomed]
    assert not ingested.derived_stream_path(doomed).exists()
    for read in (read_activity_metrics, read_best_efforts, read_zone_time):
        assert doomed not in set(read(ingested)["activity_id"])

    on_disk = {path.stem for path in ingested.derived_streams_dir.glob("*.parquet")}
    assert on_disk == set(read_activity_metrics(ingested)["activity_id"])


def test_the_athlete_profile_is_rebuilt(ingested: Paths) -> None:
    recompute(ingested)
    profile = read_athlete_profile(ingested)
    assert not profile.empty
    assert profile["effective_to"].isna().sum() == 1


def test_recompute_is_idempotent(ingested: Paths) -> None:
    recompute(ingested)
    first = read_best_efforts(ingested)
    recompute(ingested)
    second = read_best_efforts(ingested)
    assert len(first) == len(second)


def test_recompute_drops_derived_rows_for_activities_that_are_gone(ingested: Paths) -> None:
    """A full rebuild must not leave orphans behind.

    This is the failure mode the version stamp cannot catch: stale rows from a
    previous run that no longer correspond to anything in the canonical store.
    """
    recompute(ingested)
    activities = read_activities(ingested)
    doomed = str(activities["activity_id"].iloc[0])

    remaining = activities[activities["activity_id"] != doomed]
    remaining.to_parquet(ingested.activities_parquet, index=False)

    recompute(ingested)
    assert doomed not in set(read_best_efforts(ingested)["activity_id"])
    assert doomed not in set(read_activity_metrics(ingested)["activity_id"])
    assert not ingested.derived_stream_path(doomed).exists()


def test_recompute_on_an_empty_store_writes_empty_tables(tmp_path: Path) -> None:
    paths = Paths(root=tmp_path)
    result = recompute(paths)
    assert result.activities == 0
    assert read_best_efforts(paths).empty
    assert read_activity_metrics(paths).empty


def test_recompute_writes_a_tag_table(ingested: Paths) -> None:
    """Every recomputed run gets a row per tag, and none without a reason."""
    recompute(ingested)
    tags = read_activity_tags(ingested)
    assert not tags.empty
    assert set(tags.columns) >= {"activity_id", "kind", "tag", "reason", "analysis_version"}
    assert (tags["reason"].str.len() > 0).all(), "a tag with no reasoning is not a tag"
    assert set(tags["kind"]) <= {"effort", "flag"}


def test_at_most_one_effort_tag_per_activity(ingested: Paths) -> None:
    """The effort tag is exclusive; the flags are not."""
    recompute(ingested)
    tags = read_activity_tags(ingested)
    efforts = tags[tags["kind"] == "effort"]
    assert efforts.groupby("activity_id").size().max() <= 1


def test_tag_rows_carry_the_analysis_version(ingested: Paths) -> None:
    recompute(ingested)
    tags = read_activity_tags(ingested)
    assert set(tags["analysis_version"]) == {ANALYSIS_VERSION}


def test_the_tag_view_is_queryable(ingested: Paths) -> None:
    recompute(ingested)
    con = db.connect(ingested)
    rows = con.execute("SELECT count(*) FROM activity_tags").fetchone()
    assert rows is not None and rows[0] > 0


def test_an_empty_store_has_an_empty_tag_view(tmp_path: Path) -> None:
    con = db.connect(Paths(root=tmp_path / "never-used"))
    result = con.execute("SELECT count(*) FROM activity_tags").fetchone()
    assert result is not None and result[0] == 0


def test_a_failed_history_flag_does_not_abort_the_rebuild(
    ingested: Paths, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The flag pass runs after every derived grid is already on disk.

    It needs the whole history, so it cannot move inside the per-activity
    loop, and an exception escaping it aborts the rebuild with fresh grids
    against derived tables that were never rewritten: exactly the internally
    inconsistent derived layer the loop's own containment exists to prevent.
    One activity's flags raise here. The rebuild has to finish, every table
    has to be written, and the failure has to be reported so the CLI exits 1.
    """
    recompute(ingested)
    baseline = read_activity_tags(ingested)
    doomed = str(baseline[baseline["kind"] == "flag"]["activity_id"].iloc[0])

    class Doomed(TagHistory):
        def flags(self, activity_id: str) -> list[Flag]:
            if activity_id == doomed:
                raise ValueError("cannot format a duration of NaN seconds")
            return super().flags(activity_id)

    monkeypatch.setattr("activity_analysis.analysis.pipeline.TagHistory", Doomed)
    result = recompute(ingested)

    assert result.activities == 5
    assert [activity_id for activity_id, _ in result.errors] == [doomed]

    tags = read_activity_tags(ingested)
    metrics = read_activity_metrics(ingested)
    assert set(tags[tags["kind"] == "effort"]["activity_id"]) == set(metrics["activity_id"])
    assert tags[(tags["activity_id"] == doomed) & (tags["kind"] == "flag")].empty
    on_disk = {path.stem for path in ingested.derived_streams_dir.glob("*.parquet")}
    assert on_disk == set(metrics["activity_id"])


def test_a_record_carries_the_distance_it_was_set_over(ingested: Paths) -> None:
    """A flag about one distance names it in a column, not only in its prose."""
    recompute(ingested)
    tags = read_activity_tags(ingested)
    records = tags[tags["tag"] == "pr"]
    assert not records.empty
    assert records["distance_key"].notna().all()
    assert tags.loc[tags["kind"] == "effort", "distance_key"].isna().all()


#: The committed interval sessions' rep counts, keyed by UTC start time.
#: Keyed per session so a new interval fixture fails here asking for its own
#: count, not against a count that belongs to another run. The 2026-08-25
#: session's laps classify as ``-WRWRWRWRWR---``: five reps beside recoveries.
INTERVAL_REP_COUNTS = {"2026-08-25T15:41:23+00:00": 5}


def test_an_intervals_tag_carries_its_rep_count(ingested: Paths) -> None:
    """One fixture is a real interval session, so this is exercised end to end.

    A count readable only inside ``reason`` is not a column, and a client
    that wants it has to parse prose. Every other tag row, effort or flag,
    must carry a null ``rep_count`` instead of the default going untested.
    """
    recompute(ingested)
    tags = read_activity_tags(ingested)
    intervals = tags[tags["tag"] == "intervals"]
    starts = read_activities(ingested).set_index("activity_id")["start_time_utc"]
    fired = {
        starts[row["activity_id"]].isoformat(): row["rep_count"] for _, row in intervals.iterrows()
    }
    assert fired == INTERVAL_REP_COUNTS
    others = tags[tags["tag"] != "intervals"]
    assert set(others["kind"]) == {"effort", "flag"}
    assert others["rep_count"].isna().all()


def test_an_intervals_tag_carries_its_rep_pattern(ingested: Paths) -> None:
    """The per-lap pattern is a column too, for the same reason the count is:

    a frontend that wants to know *which* recorded laps were reps cannot
    parse a pattern out of ``reason``'s prose, and must not recompute
    ``analysis.tags``'s own cadence-and-pace classification to get it.

    The two columns are joined by one rule, asserted below: ``rep_count``
    is the number of ``R`` labels sitting immediately beside a ``W``, not
    the number of ``R`` labels. ``web/src/components/splitsMath.ts``
    mirrors that predicate to decide which laps it numbers, so a change to
    ``interval_reps``' adjacency rule that left this pattern alone would
    put the frontend's numbered rows out of step with the count its own
    tab header reports.
    """
    recompute(ingested)
    tags = read_activity_tags(ingested)
    intervals = tags[tags["tag"] == "intervals"]
    assert not intervals.empty
    laps = read_laps(ingested)
    for _, row in intervals.iterrows():
        pattern = row["rep_pattern"]
        assert pattern is not None and pattern != ""
        assert set(pattern) <= {"R", "W", "-"}
        lap_count = (laps["activity_id"] == row["activity_id"]).sum()
        assert len(pattern) == lap_count
        assert pattern.count("R") >= row["rep_count"]
        beside_a_recovery = sum(
            1
            for i, label in enumerate(pattern)
            if label == "R"
            and (
                (i > 0 and pattern[i - 1] == "W")
                or (i + 1 < len(pattern) and pattern[i + 1] == "W")
            )
        )
        assert beside_a_recovery == row["rep_count"]
    others = tags[tags["tag"] != "intervals"]
    assert set(others["kind"]) == {"effort", "flag"}
    assert others["rep_pattern"].isna().all()


def test_recompute_writes_the_route_tables_even_when_no_route_forms(ingested: Paths) -> None:
    """The five fixtures are too few and too different to share a route."""
    result = recompute(ingested)
    assert result.routes == 0
    assert ingested.routes_parquet.exists() and ingested.route_runs_parquet.exists()
    con = db.connect(ingested)
    assert con.sql("select count(*) from routes").fetchone() == (0,)
    assert con.sql("select count(*) from route_runs").fetchone() == (0,)
