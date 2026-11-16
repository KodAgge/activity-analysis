"""The threshold and load pass inside recompute, on a synthetic store.

The store is written straight into the canonical layer rather than ingested,
so every run's speed and heart rate are known exactly: three hard 40 minute
runs at 4 m/s whose heart rate settles at 180 after a half minute at 191, an
easy run at 3 m/s and 140, and a run with no heart rate channel at all. A
maximum heart rate of 190 in the profile tags the hard runs all out and the
easy one easy, which is what decides which runs give a threshold reading.
The estimate arithmetic is tested in tests/test_threshold.py, TRIMP's in
tests/test_trimp.py and the series' in tests/test_load.py; what is under test
here is the wiring.
"""

from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from activity_analysis.analysis.pipeline import recompute
from activity_analysis.analysis.trimp import run_trimp
from activity_analysis.config import Paths
from activity_analysis.models import (
    ACTIVITY_SCHEMA,
    PROFILE_OBSERVATION_SCHEMA,
    RESTING_HR_SCHEMA,
    empty_frame,
)
from activity_analysis.store.writer import (
    read_activities,
    read_derived_stream,
    read_hr_histogram,
    read_run_load,
    read_threshold_readings,
    read_training_load,
    read_training_load_weekly,
    read_zone_time_estimated,
    upsert_activities,
    upsert_profile_observations,
    upsert_resting_hr,
    write_streams,
)

DURATION_S = 2400
#: The grid holds both ends, 0 s and 2400 s, so 2401 seconds of heart rate.
GRID_S = DURATION_S + 1
#: Late in the UTC day, so every run's local day at UTC+1 is the next one.
T0 = pd.Timestamp("2026-06-01T23:30:00Z")
OFFSET = pd.Timedelta(hours=1)

#: id, day after T0, speed in m/s, heart rate after the first 600 s (None for
#: no channel). The fourth day is left empty so the daily series has a rest
#: day to fill.
RUNS: list[tuple[str, int, float, float | None]] = [
    ("a1", 0, 4.0, 180.0),
    ("a2", 1, 4.0, 180.0),
    ("a3", 2, 4.0, 180.0),
    ("b1", 4, 3.0, 140.0),
    ("c1", 5, 3.0, None),
]
HARD = ["a1", "a2", "a3"]
#: 90% of it is 171, so the hard runs spend three quarters of their seconds
#: above it and tag all out; the easy run's median, 140, is under 75% of it.
MAX_HR = 190.0
#: The profile's resting heart rate setting, which TRIMP falls back to on a
#: day the measured series does not cover.
REST_SETTING = 50.0
#: Each hard run's 10 s peak: a half minute at it inside the first 600 s,
#: which no effort's final 1200 s reaches, so the readings stay at 180.
PEAK_HR = 191.0
PEAK_FROM_S, PEAK_TO_S = 300, 330


def _activity(activity_id: str, start: pd.Timestamp, speed: float) -> dict[str, object]:
    row: dict[str, object] = {name: None for name in ACTIVITY_SCHEMA.names}
    row.update(
        activity_id=activity_id,
        athlete_id="tester",
        source="garmin_fit",
        source_file=f"{activity_id}.fit",
        source_file_sha256=activity_id * 8,
        start_time_utc=start,
        utc_offset_s=3600,
        sport="running",
        sub_sport="generic",
        elapsed_time_s=float(DURATION_S),
        timer_time_s=float(DURATION_S),
        moving_time_s=float(DURATION_S),
        distance_m=speed * DURATION_S,
        ingest_version=3,
    )
    return row


def _stream(activity_id: str, start: pd.Timestamp, speed: float, hr: float | None) -> pd.DataFrame:
    t = np.arange(DURATION_S + 1, dtype="float64")
    # Lower for the first ten minutes, so the reading has to come from the
    # effort's final 1200 s rather than its whole length.
    heart = np.full(len(t), np.nan) if hr is None else np.where(t < 600, hr - 20.0, hr)
    if hr is not None and hr >= 171.0:
        heart[(t >= PEAK_FROM_S) & (t < PEAK_TO_S)] = PEAK_HR
    nan = np.full(len(t), np.nan)
    return pd.DataFrame(
        {
            "activity_id": activity_id,
            "t_s": t,
            "timestamp_utc": start + pd.to_timedelta(t, unit="s"),
            "lat_deg": nan,
            "lon_deg": nan,
            "altitude_m": nan,
            "distance_m": speed * t,
            "speed_mps": np.full(len(t), speed),
            "hr_bpm": heart,
            "cadence_spm": np.full(len(t), 170.0),
            "power_w": nan,
            "temperature_c": nan,
            "moving": True,
        }
    )


def write_store(
    paths: Paths, extra: list[tuple[str, int, float, float | None]] | None = None
) -> None:
    """The runs above, any ``extra`` ones, and a profile with ``MAX_HR``.

    Straight into the canonical layer. The profile is what tags the hard runs
    all out, so a store without it has no threshold readings at all.
    """
    paths.ensure()
    rows = []
    for activity_id, day, speed, hr in [*RUNS, *(extra or [])]:
        start = T0 + pd.Timedelta(days=day)
        rows.append(_activity(activity_id, start, speed))
        write_streams(paths, activity_id, _stream(activity_id, start, speed, hr))
    frame = pd.DataFrame(rows)
    upsert_activities(paths, frame.astype(empty_frame(ACTIVITY_SCHEMA).dtypes.to_dict()))
    observation = {name: None for name in PROFILE_OBSERVATION_SCHEMA.names}
    observation.update(
        activity_id="a1",
        athlete_id="tester",
        observed_at=T0,
        max_hr_bpm=MAX_HR,
        resting_hr_bpm=REST_SETTING,
    )
    upsert_profile_observations(
        paths,
        pd.DataFrame([observation]).astype(
            empty_frame(PROFILE_OBSERVATION_SCHEMA).dtypes.to_dict()
        ),
    )


def write_resting(paths: Paths, bpm: float, days: list[date] | None = None) -> None:
    """A measured resting heart rate of ``bpm`` on ``days``, else every day around the runs."""
    if days is None:
        span = pd.date_range(T0 - pd.Timedelta(days=40), T0 + pd.Timedelta(days=10), freq="D")
        days = [d.date() for d in span]
    frame = pd.DataFrame(
        {
            "athlete_id": "tester",
            "calendar_date": days,
            "resting_hr_bpm": bpm,
            "record_version": 1,
            "source_file_sha256": "uds",
        }
    )
    upsert_resting_hr(paths, frame.astype(empty_frame(RESTING_HR_SCHEMA).dtypes.to_dict()))


@pytest.fixture
def store(tmp_path: Path) -> Paths:
    paths = Paths(root=tmp_path)
    write_store(paths)
    return paths


def test_recompute_writes_an_estimate_for_runs_after_three_readings(store: Paths) -> None:
    result = recompute(store)
    assert result.errors == []

    readings = read_threshold_readings(store).set_index("activity_id")
    # The easy run has 30 to 60 minute efforts too, but it is not tagged all
    # out, so it gives no reading.
    assert set(readings.index) == set(HARD)
    assert readings.loc["a1", "final_hr_bpm"] == pytest.approx(180.0)
    assert result.threshold_readings == 3

    loads = read_run_load(store).set_index("activity_id")
    assert result.run_load_rows == len(loads) == 5
    # Two hard runs are not yet three readings, but they still carry TRIMP:
    # it needs no threshold estimate.
    assert loads.loc[["a1", "a2"], "lthr_bpm"].isna().all()
    assert (loads.loc[["a1", "a2"], "trimp"] > 0).all()

    easy = loads.loc["b1"]
    assert easy["lthr_bpm"] == 180.0
    assert sorted(easy["reading_ids"]) == HARD

    zones = read_zone_time_estimated(store)
    easy_zones = zones[zones["activity_id"] == "b1"].sort_values("zone_index")
    assert list(easy_zones["high_bpm"].iloc[:4]) == pytest.approx([153.0, 162.0, 171.0, 180.0])
    assert easy_zones["seconds_s"].sum() == pytest.approx(GRID_S)

    histogram = read_hr_histogram(store)
    easy_histogram = histogram[histogram["activity_id"] == "b1"].set_index("hr_bpm")
    assert easy_histogram.loc[140, "seconds_s"] == pytest.approx(GRID_S - 600)
    assert easy_histogram.loc[120, "seconds_s"] == pytest.approx(600)


def test_run_load_carries_trimp_rest_and_max(store: Paths) -> None:
    write_resting(store, 45.0)
    assert recompute(store).errors == []
    loads = read_run_load(store).set_index("activity_id")

    assert list(loads.loc[HARD, "peak_hr_10s_bpm"]) == pytest.approx([PEAK_HR] * 3)
    assert loads.loc["b1", "peak_hr_10s_bpm"] == pytest.approx(140.0)
    # From a3 on, three peaks of 191 are in the window.
    for activity_id in ("a3", "b1"):
        run = loads.loc[activity_id]
        assert run["rest_bpm"] == 45.0
        assert run["max_bpm"] == pytest.approx(PEAK_HR)
        assert not run["rest_from_setting"] and not run["max_from_setting"]
        grid = read_derived_stream(store, activity_id)
        assert run["trimp"] == pytest.approx(run_trimp(grid, 45.0, PEAK_HR))
    # a1 and a2 have one and two peaks behind them, under the three the
    # measured maximum needs, so theirs is the device setting, flagged.
    assert list(loads.loc[["a1", "a2"], "max_bpm"]) == [MAX_HR, MAX_HR]
    assert loads.loc[["a1", "a2"], "max_from_setting"].all()
    grid = read_derived_stream(store, "a1")
    assert loads.loc["a1", "trimp"] == pytest.approx(run_trimp(grid, 45.0, MAX_HR))


def test_rest_falls_back_to_the_device_setting_and_says_so(store: Paths) -> None:
    recompute(store)
    loads = read_run_load(store)
    assert (loads["rest_bpm"] == REST_SETTING).all()
    assert loads["rest_from_setting"].all()


def test_rest_is_read_on_the_runs_local_date(store: Paths) -> None:
    """One measured day, b1's local day, which is the day after its UTC one.

    b1 starts 23:30 UTC at UTC+1. Read on its UTC day the row would lie
    outside the 28 days and b1 would fall back to the setting.
    """
    b1_local = (T0 + OFFSET + pd.Timedelta(days=4)).date()
    assert b1_local == (T0 + pd.Timedelta(days=4)).date() + pd.Timedelta(days=1)
    write_resting(store, 48.0, [b1_local])
    recompute(store)
    loads = read_run_load(store).set_index("activity_id")
    assert loads.loc["b1", "rest_bpm"] == 48.0
    assert not loads.loc["b1", "rest_from_setting"]
    assert loads.loc["b1", "rest_measured_through"] == b1_local
    # a3, two days earlier, has no measured day in its 28 days.
    assert loads.loc["a3", "rest_bpm"] == REST_SETTING
    assert loads.loc["a3", "rest_from_setting"]


def test_rest_carries_the_newest_measured_days_forward_for_90_days(store: Paths) -> None:
    """A run past the resting series' end reads the 28 days up to its newest day.

    For 90 days after it, then the device setting again. One measured day 90
    days before a1's local day: a1 carries it forward, a2 a day later does not.
    """
    a1_local = (T0 + OFFSET).date()
    measured = a1_local - timedelta(days=90)
    write_resting(store, 46.0, [measured])
    assert recompute(store).errors == []
    loads = read_run_load(store).set_index("activity_id")
    assert loads.loc["a1", "rest_bpm"] == 46.0
    assert not loads.loc["a1", "rest_from_setting"]
    assert loads.loc["a1", "rest_measured_through"] == measured
    for later in ("a2", "a3", "b1", "c1"):
        assert loads.loc[later, "rest_bpm"] == REST_SETTING
        assert loads.loc[later, "rest_from_setting"]
        assert pd.isna(loads.loc[later, "rest_measured_through"])


def test_a_run_without_heart_rate_has_null_trimp(store: Paths) -> None:
    recompute(store)
    loads = read_run_load(store).set_index("activity_id")
    # The estimate and the rest and max in force on its date still exist;
    # only the run's own heart-rate figures are absent.
    assert loads.loc["c1", "lthr_bpm"] == 180.0
    assert loads.loc["c1", "max_bpm"] == pytest.approx(PEAK_HR)
    assert pd.isna(loads.loc["c1", "trimp"])
    assert pd.isna(loads.loc["c1", "peak_hr_10s_bpm"])
    assert "c1" not in set(read_zone_time_estimated(store)["activity_id"])
    assert "c1" not in set(read_hr_histogram(store)["activity_id"])


def test_a_rest_at_or_above_the_max_gives_no_trimp(tmp_path: Path) -> None:
    """A resting heart rate at or above the maximum leaves no reserve to divide by.

    Only a bad device setting can do that, since the measured rest is a
    night's heart rate and the measured max a run's peak. The run's TRIMP is
    null rather than infinite, negative or clipped into a number; its rest and
    max stay on the row so it says why.
    """
    paths = Paths(root=tmp_path)
    write_store(paths)
    write_resting(paths, 195.0)
    assert recompute(paths).errors == []
    loads = read_run_load(paths).set_index("activity_id")
    assert loads.loc["a1", "rest_bpm"] == 195.0
    assert loads.loc["a1", "max_bpm"] == MAX_HR
    assert loads["trimp"].isna().all()
    zones = read_zone_time_estimated(paths)
    assert not zones.empty and zones["trimp"].isna().all()
    days = read_training_load(paths)
    assert (days["trimp"] == 0.0).all() and (days["ctl"] == 0.0).all()


def test_estimated_zone_rows_carry_trimp_summing_to_the_run(store: Paths) -> None:
    recompute(store)
    loads = read_run_load(store).set_index("activity_id")
    zones = read_zone_time_estimated(store)
    assert set(zones["activity_id"]) == {"a3", "b1"}
    for activity_id, run_zones in zones.groupby("activity_id"):
        assert run_zones["trimp"].sum() == pytest.approx(loads.loc[activity_id, "trimp"])
    # 140 and 120 are under 85% of 180 (153) throughout, so all of the easy
    # run's TRIMP is in zone 1.
    easy = zones[zones["activity_id"] == "b1"].set_index("zone_index")
    assert easy.loc[0, "trimp"] == pytest.approx(loads.loc["b1", "trimp"])
    assert (easy.loc[1:, "trimp"] == 0.0).all()


def test_training_load_has_one_row_per_day_from_first_to_last_run(store: Paths) -> None:
    """From the first run to the last, rest days as zeros.

    Every run counts, c1 without heart rate too: it adds no TRIMP but its
    distance. Days are local: every run starts 23:30 UTC at UTC+1, so on the
    next calendar day.
    """
    result = recompute(store)
    days = read_training_load(store)
    first = (T0 + OFFSET).date()
    last = (T0 + OFFSET + pd.Timedelta(days=5)).date()
    assert first == pd.Timestamp("2026-06-02").date()
    expected = [d.date() for d in pd.date_range(first, last, freq="D")]
    assert [pd.Timestamp(d).date() for d in days["local_date"]] == expected
    assert result.training_load_days == len(expected)

    loads = read_run_load(store).set_index("activity_id")
    by_day = days.set_index(pd.to_datetime(days["local_date"]).dt.date)
    rest_day = (T0 + OFFSET + pd.Timedelta(days=3)).date()
    b1_day = (T0 + OFFSET + pd.Timedelta(days=4)).date()
    assert by_day.loc[rest_day, "trimp"] == 0.0
    assert by_day.loc[rest_day, "distance_m"] == 0.0
    assert by_day.loc[b1_day, "trimp"] == pytest.approx(loads.loc["b1", "trimp"])
    assert by_day.loc[last, "trimp"] == 0.0
    assert by_day.loc[last, "distance_m"] == pytest.approx(3.0 * DURATION_S)
    # Six days ending on c1's: three hard runs, b1 and c1.
    assert by_day.loc[last, "distance_7d_m"] == pytest.approx((3 * 4.0 + 2 * 3.0) * DURATION_S)
    assert (by_day["form"] == by_day["ctl"] - by_day["atl"]).all()
    assert (days["analysis_version"] > 0).all()


def test_training_load_weekly_is_written(store: Paths) -> None:
    recompute(store)
    days = read_training_load(store)
    weeks = read_training_load_weekly(store)
    # 2026-06-02 to 2026-06-07 is one Monday-started week, Tuesday to Sunday.
    assert [pd.Timestamp(w).date() for w in weeks["week_start"]] == [
        pd.Timestamp("2026-06-01").date()
    ]
    week = weeks.iloc[0]
    assert week["days"] == len(days) == 6
    assert week["trimp"] == pytest.approx(days["trimp"].sum())
    assert week["ctl_mean"] == pytest.approx(days["ctl"].mean())
    assert week["atl_mean"] == pytest.approx(days["atl"].mean())
    assert week["form_mean"] == pytest.approx(days["form"].mean())
    assert week["distance_m"] == pytest.approx(days["distance_m"].sum())
    assert (weeks["analysis_version"] > 0).all()


def test_a_run_without_a_recorded_offset_is_dated_in_utc(store: Paths) -> None:
    """A null ``utc_offset_s``, which is every GPX, reads as offset 0.

    b1 starts 23:30 UTC, so with its offset it falls on the next local day and
    without one on the UTC day it started, as ``queries.LOCAL_DATE_SQL`` has it.
    """
    activities = read_activities(store)
    activities["utc_offset_s"] = activities["utc_offset_s"].astype("Int32")
    activities.loc[activities["activity_id"] == "b1", "utc_offset_s"] = pd.NA
    upsert_activities(store, activities)

    recompute(store)
    loads = read_run_load(store).set_index("activity_id")
    days = read_training_load(store)
    utc_day = (T0 + pd.Timedelta(days=4)).date()
    local_a3 = (T0 + OFFSET + pd.Timedelta(days=2)).date()
    assert utc_day == local_a3 + pd.Timedelta(days=1)
    by_day = days.set_index(pd.to_datetime(days["local_date"]).dt.date)["trimp"]
    assert by_day[utc_day] == pytest.approx(loads.loc["b1", "trimp"])
    assert by_day[utc_day + pd.Timedelta(days=1)] == 0.0


def test_a_failing_threshold_pass_leaves_the_tables_empty_and_reports_it(
    store: Paths, monkeypatch: pytest.MonkeyPatch
) -> None:
    recompute(store)
    assert not read_run_load(store).empty

    def broken(*_: object, **__: object) -> None:
        raise RuntimeError("boom")

    monkeypatch.setattr("activity_analysis.analysis.pipeline.run_readings", broken)
    result = recompute(store)
    assert ("threshold", "RuntimeError: boom") in result.errors
    assert result.activities == len(RUNS)
    for path in (
        store.threshold_readings_parquet,
        store.run_load_parquet,
        store.zone_time_estimated_parquet,
        store.hr_histogram_parquet,
        store.training_load_parquet,
        store.training_load_weekly_parquet,
    ):
        assert path.exists()
    for table in (
        read_threshold_readings(store),
        read_run_load(store),
        read_zone_time_estimated(store),
        read_hr_histogram(store),
        read_training_load(store),
        read_training_load_weekly(store),
    ):
        assert table.empty
