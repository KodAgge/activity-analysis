"""TRIMP and its inputs, against closed forms and published examples."""

from __future__ import annotations

import math
from datetime import date, timedelta

import numpy as np
import pandas as pd
import pytest

from activity_analysis.analysis.trimp import (
    REST_CARRY_DAYS,
    max_at,
    peak_hr,
    rest_at,
    run_trimp,
    trimp_by_zone,
    trimp_weights,
)

REST, MAX = 45.0, 191.0


def grid(hr: list[float], paused: list[bool] | None = None) -> pd.DataFrame:
    return pd.DataFrame({"hr_bpm": hr, "paused": paused or [False] * len(hr)})


def test_trimp_of_a_constant_heart_rate_matches_the_closed_form() -> None:
    x = 90 / 146
    expected = 60 * x * 0.64 * math.exp(1.92 * x)
    assert expected == pytest.approx(77.3, abs=0.1)
    assert run_trimp(grid([135.0] * 3600), REST, MAX) == pytest.approx(expected)


def test_per_minute_weights_match_the_worked_examples() -> None:
    for bpm, expected in ((130, 1.14), (150, 1.83), (170, 2.84)):
        assert run_trimp(grid([float(bpm)] * 60), REST, MAX) == pytest.approx(expected, abs=0.01)


def test_heart_rate_is_clipped_to_the_reserve() -> None:
    assert run_trimp(grid([40.0] * 60), REST, MAX) == 0.0
    assert run_trimp(grid([200.0] * 60), REST, MAX) == pytest.approx(
        run_trimp(grid([191.0] * 60), REST, MAX)
    )
    assert trimp_weights(np.array([40.0]), REST, MAX)[0] == 0.0


def test_paused_and_missing_seconds_count_nothing() -> None:
    mixed = grid([150.0, 150.0, np.nan, 150.0], [False, True, False, False])
    assert run_trimp(mixed, REST, MAX) == pytest.approx(run_trimp(grid([150.0] * 2), REST, MAX))


def test_a_run_without_heart_rate_has_no_trimp() -> None:
    assert run_trimp(grid([np.nan] * 5), REST, MAX) is None
    assert run_trimp(grid([150.0] * 5, [True] * 5), REST, MAX) is None


def test_trimp_by_zone_sums_to_the_run_and_puts_a_boundary_second_in_the_zone_it_opens() -> None:
    g = grid([100.0, 130.0, 130.0, 160.0, 185.0, np.nan])
    zones = trimp_by_zone(g, [130.0, 160.0], REST, MAX)
    assert len(zones) == 3
    assert sum(zones) == pytest.approx(run_trimp(g, REST, MAX))
    w = trimp_weights(np.array([100.0, 130.0, 130.0, 160.0, 185.0]), REST, MAX)
    assert zones[0] == pytest.approx(w[0])
    assert zones[1] == pytest.approx(w[1] + w[2])
    assert zones[2] == pytest.approx(w[3] + w[4])


def test_peak_is_the_highest_ten_second_mean() -> None:
    hr = [150.0] * 600
    hr[300] = 230.0
    assert peak_hr(grid(hr)) == pytest.approx(158.0)
    assert peak_hr(grid([150.0] * 9)) is None
    assert peak_hr(grid([150.0] * 20, [i == 5 for i in range(20)])) == pytest.approx(150.0)
    assert peak_hr(grid([150.0] * 10, [i == 5 for i in range(10)])) is None


def test_rest_is_the_median_of_the_trailing_28_days() -> None:
    on = date(2026, 6, 30)
    resting = pd.DataFrame(
        {
            "calendar_date": [on - timedelta(days=28), on - timedelta(days=27), on],
            "resting_hr_bpm": [100.0, 50.0, 60.0],
        }
    )
    assert rest_at(resting, on) == (pytest.approx(55.0), on)
    # Nothing measured on or before the date.
    assert rest_at(resting, on - timedelta(days=29)) is None


def test_rest_inside_the_window_rests_on_its_newest_measured_day() -> None:
    on = date(2026, 6, 30)
    resting = pd.DataFrame(
        {
            "calendar_date": [on - timedelta(days=40), on - timedelta(days=10), on + timedelta(1)],
            "resting_hr_bpm": [70.0, 50.0, 90.0],
        }
    )
    # The day after the run is not behind it, and the 28 days hold one day.
    assert rest_at(resting, on) == (pytest.approx(50.0), on - timedelta(days=10))


def test_rest_carries_the_last_measured_window_forward_for_90_days() -> None:
    """With no measured day in the 28 days, the 28 days up to the newest one stand in."""
    last = date(2026, 6, 30)
    resting = pd.DataFrame(
        {
            "calendar_date": [
                # 28 days before the newest measured day: just outside its window.
                last - timedelta(days=29),
                last - timedelta(days=27),
                last - timedelta(days=1),
                last,
            ],
            "resting_hr_bpm": [100.0, 50.0, 52.0, None],
        }
    )
    # A null day is not a measured day: the newest one is the day before.
    through = last - timedelta(days=1)
    assert rest_at(resting, last + timedelta(days=60)) == (pytest.approx(51.0), through)
    assert rest_at(resting, through + timedelta(days=REST_CARRY_DAYS)) == (
        pytest.approx(51.0),
        through,
    )
    assert rest_at(resting, through + timedelta(days=REST_CARRY_DAYS + 1)) is None


def test_max_is_the_median_of_the_top_three_peaks_in_540_days() -> None:
    at = pd.Timestamp("2026-06-30", tz="UTC")
    peaks = pd.DataFrame(
        {
            "start_time_utc": [at - pd.Timedelta(days=d) for d in (10, 20, 30, 40, 541)],
            "peak_hr_10s_bpm": [207.0, 201.0, 201.0, 195.0, 210.0],
        }
    )
    assert max_at(peaks, at) == 201.0
    assert max_at(peaks.iloc[:2], at) is None
