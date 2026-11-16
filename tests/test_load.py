"""The heart-rate histogram and the daily and weekly series, against known answers."""

from __future__ import annotations

import math

import numpy as np
import pandas as pd
import pytest

from activity_analysis.analysis.load import (
    ATL_TAU_DAYS,
    CTL_TAU_DAYS,
    daily_series,
    hr_histogram,
    weekly_series,
)
from activity_analysis.models import TRAINING_LOAD_WEEKLY_SCHEMA, empty_frame


def test_histogram_counts_seconds_per_whole_bpm() -> None:
    grid = pd.DataFrame(
        {
            "t_s": np.arange(5, dtype="float64"),
            "hr_bpm": [150.4, 150.6, 151.0, np.nan, 160.0],
            "paused": [False, False, False, False, True],
        }
    )
    histogram = hr_histogram(grid)
    assert dict(zip(histogram["hr_bpm"], histogram["seconds_s"], strict=True)) == {
        150: 1.0,
        151: 2.0,
    }
    assert histogram["hr_bpm"].dtype == np.int16


def _d(text: str) -> object:
    return pd.Timestamp(text).date()


def test_daily_series_sums_two_runs_and_decays_over_empty_days() -> None:
    day1, day3 = _d("2026-06-01"), _d("2026-06-03")
    runs = pd.DataFrame(
        {
            "local_date": [day1, day1, day3],
            "trimp": [70.0, 30.0, 0.0],
            "distance_m": [1.0, 2.0, 3.0],
        }
    )
    series = daily_series(runs)
    assert len(series) == 3
    assert series["trimp"].iloc[0] == pytest.approx(100.0)
    for column, tau in (("atl", ATL_TAU_DAYS), ("ctl", CTL_TAU_DAYS)):
        first = 100.0 * (1 - math.exp(-1 / tau))
        assert series[column].iloc[0] == pytest.approx(first)
        assert series[column].iloc[2] == pytest.approx(first * math.exp(-2 / tau))
    assert (series["form"] == series["ctl"] - series["atl"]).all()


def test_distance_7d_counts_the_seven_days_ending_that_day() -> None:
    runs = pd.DataFrame(
        {
            "local_date": [_d("2026-06-01"), _d("2026-06-07"), _d("2026-06-08")],
            "trimp": [10.0, 10.0, 0.0],
            "distance_m": [5000.0, 10000.0, 0.0],
        }
    )
    series = daily_series(runs).set_index("local_date")
    assert series.loc[_d("2026-06-07"), "distance_7d_m"] == 15000.0
    assert series.loc[_d("2026-06-08"), "distance_7d_m"] == 10000.0


def test_a_run_without_trimp_still_counts_its_distance() -> None:
    runs = pd.DataFrame(
        {
            "local_date": [_d("2026-06-01"), _d("2026-06-02")],
            "trimp": [50.0, None],
            "distance_m": [1000.0, 4000.0],
        }
    )
    series = daily_series(runs)
    assert series["trimp"].iloc[1] == 0.0
    assert series["distance_m"].iloc[1] == 4000.0
    assert series["distance_7d_m"].iloc[1] == 5000.0


def test_weekly_series_means_and_counts_days() -> None:
    days = pd.date_range("2026-06-01", periods=7, freq="D")  # Monday to Sunday
    daily = pd.DataFrame(
        {
            "local_date": [d.date() for d in days],
            "trimp": np.arange(1.0, 8.0),
            "ctl": np.arange(10.0, 17.0),
            "atl": np.arange(20.0, 27.0),
            "form": np.arange(-10.0, -3.0),
            "distance_m": np.full(7, 1000.0),
        }
    )
    weekly = weekly_series(daily)
    assert len(weekly) == 1
    row = weekly.iloc[0]
    assert row["week_start"] == _d("2026-06-01")
    assert row["days"] == 7
    assert row["trimp"] == 28.0
    assert row["ctl_mean"] == 13.0
    assert row["atl_mean"] == 23.0
    assert row["form_mean"] == -7.0
    assert row["distance_m"] == 7000.0
    thursday = weekly_series(daily.iloc[3:])
    assert thursday["days"].tolist() == [4]


def test_weekly_series_of_no_days_is_a_typed_empty_frame() -> None:
    daily = daily_series(pd.DataFrame({"local_date": [], "trimp": [], "distance_m": []}))
    weekly = weekly_series(daily)
    assert weekly.empty
    expected = empty_frame(TRAINING_LOAD_WEEKLY_SCHEMA).drop(columns="analysis_version")
    assert weekly.dtypes.to_dict() == expected.dtypes.to_dict()
