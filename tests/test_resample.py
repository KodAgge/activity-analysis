"""Resampling is verified against synthetic input with known analytic answers.

A real activity has no independent ground truth for what its 1 Hz grid should
contain, so a test against one proves only that the code ran.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from activity_analysis.analysis.best_efforts import best_efforts
from activity_analysis.analysis.resample import (
    GAP_OUTAGE,
    GAP_STOP,
    PAUSE_MAX_IMPLIED_SPEED_MPS,
    PAUSE_MIN_GAP_S,
    PAUSE_UNCONDITIONAL_GAP_S,
    find_gaps,
    resample_to_1hz,
)


def _kinds(t_s: list[float], distance_m: list[float]) -> list[tuple[float, float, str]]:
    gaps = find_gaps(np.array(t_s), np.array(distance_m))
    return [(g.start_t_s, g.end_t_s, g.kind) for g in gaps]


def _streams(t_s: list[float], distance_m: list[float], **columns: list[float]) -> pd.DataFrame:
    """A canonical-shaped stream frame. Absent columns default to null."""
    start = pd.Timestamp("2026-01-01T00:00:00Z")
    frame = pd.DataFrame(
        {
            "t_s": t_s,
            "timestamp_utc": [start + pd.Timedelta(seconds=v) for v in t_s],
            "distance_m": distance_m,
            "lat_deg": np.nan,
            "lon_deg": np.nan,
            "altitude_m": np.nan,
            "speed_mps": np.nan,
            "hr_bpm": np.nan,
            "cadence_spm": np.nan,
        }
    )
    for name, values in columns.items():
        frame[name] = values
    return frame


def test_a_gap_where_the_athlete_kept_running_is_neither_stop_nor_outage() -> None:
    # 12 s at 2.5 m/s. Measured across the real history: gaps of 10 to 14 s
    # carry a median implied speed of 1.60 m/s, so they are smart recording,
    # not stops. Nulling them would tear holes in a third of the activities.
    assert _kinds([0.0, 12.0], [0.0, 30.0]) == []


def test_a_long_gap_with_no_distance_is_a_stop() -> None:
    assert _kinds([0.0, 40.0], [100.0, 100.5]) == [(0.0, 40.0, GAP_STOP)]


def test_a_gap_just_under_the_threshold_is_never_a_stop() -> None:
    gap = PAUSE_MIN_GAP_S - 0.5
    assert _kinds([0.0, gap], [0.0, 0.0]) == []


def test_a_gap_over_the_threshold_but_moving_is_not_a_stop() -> None:
    # A GPS dropout while running: distance advanced normally, so interpolating
    # is the honest thing to do.
    speed = PAUSE_MAX_IMPLIED_SPEED_MPS + 1.0
    assert _kinds([0.0, 20.0], [0.0, 20.0 * speed]) == []


def test_a_very_long_gap_with_no_movement_is_a_stop() -> None:
    gap = PAUSE_UNCONDITIONAL_GAP_S + 1.0
    assert _kinds([0.0, gap], [500.0, 500.2]) == [(0.0, gap, GAP_STOP)]


def test_a_very_long_gap_the_athlete_moved_across_is_an_outage_not_a_stop() -> None:
    # The odometer advanced at 3 m/s, so the athlete kept running; the device
    # simply went quiet. Calling that a stop would hold distance flat and then
    # dump the whole advance into a single second.
    gap = PAUSE_UNCONDITIONAL_GAP_S + 1.0
    assert _kinds([0.0, gap], [0.0, gap * 3.0]) == [(0.0, gap, GAP_OUTAGE)]


def test_grid_has_one_row_per_second_of_elapsed_time() -> None:
    grid = resample_to_1hz(_streams([0.0, 3.0, 7.0], [0.0, 9.0, 21.0]))
    assert grid["t_s"].tolist() == [0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0]


def test_distance_interpolates_linearly_between_samples() -> None:
    grid = resample_to_1hz(_streams([0.0, 4.0], [0.0, 12.0]))
    assert grid["distance_m"].tolist() == [0.0, 3.0, 6.0, 9.0, 12.0]


def test_heart_rate_interpolates_linearly() -> None:
    grid = resample_to_1hz(_streams([0.0, 2.0], [0.0, 6.0], hr_bpm=[120.0, 140.0]))
    assert grid["hr_bpm"].tolist() == [120.0, 130.0, 140.0]


def test_across_a_stop_distance_interpolates_and_channels_are_null() -> None:
    # Ran to 100 m, stood still for 60 s while the GPS drifted 6 m, ran on.
    # Distance is not held: the drift is spread over the seconds it took, at
    # 0.1 m/s, which cannot trouble anything. Holding it instead would land
    # all 6 m in the single second the recording resumed.
    streams = _streams(
        [0.0, 10.0, 70.0, 80.0],
        [0.0, 100.0, 106.0, 206.0],
        hr_bpm=[150.0, 150.0, 90.0, 150.0],
        speed_mps=[10.0, 10.0, 0.0, 10.0],
    )
    grid = resample_to_1hz(streams)

    inside = grid[(grid["t_s"] > 10.0) & (grid["t_s"] < 70.0)]
    assert len(inside) == 59
    assert inside["paused"].all()
    assert not inside["outage"].any()
    assert inside["distance_m"].iloc[0] == pytest.approx(100.1)
    assert inside["distance_m"].iloc[-1] == pytest.approx(105.9)
    assert inside["hr_bpm"].isna().all()
    assert inside["speed_mps"].isna().all()

    # No second carries more than the drift rate, so nothing was compressed.
    assert grid["distance_m"].diff().max() == pytest.approx(10.0)

    # The clock kept running, so the grid still spans the whole activity.
    assert grid["t_s"].iloc[-1] == 80.0
    assert len(grid) == 81
    # The samples bounding the stop are real measurements and are kept.
    assert not bool(grid.loc[grid["t_s"] == 10.0, "paused"].iloc[0])
    assert not bool(grid.loc[grid["t_s"] == 70.0, "paused"].iloc[0])


def test_distance_never_decreases() -> None:
    # Device distance occasionally jitters backwards by a few centimetres.
    grid = resample_to_1hz(_streams([0.0, 1.0, 2.0], [0.0, 10.0, 9.5]))
    assert grid["distance_m"].is_monotonic_increasing


def test_a_channel_the_device_never_recorded_stays_null() -> None:
    grid = resample_to_1hz(_streams([0.0, 2.0], [0.0, 6.0]))
    assert grid["hr_bpm"].isna().all()
    assert grid["cadence_spm"].isna().all()


def test_a_channel_is_not_extrapolated_beyond_where_it_was_recorded() -> None:
    # HR strap connected 4 s in. Those first seconds are unknown, not 150.
    streams = _streams([0.0, 4.0, 6.0], [0.0, 12.0, 18.0], hr_bpm=[np.nan, 150.0, 160.0])
    grid = resample_to_1hz(streams)
    assert grid.loc[grid["t_s"] < 4.0, "hr_bpm"].isna().all()
    assert grid.loc[grid["t_s"] == 4.0, "hr_bpm"].iloc[0] == pytest.approx(150.0)


def test_timestamps_advance_one_second_at_a_time() -> None:
    grid = resample_to_1hz(_streams([0.0, 2.0], [0.0, 6.0]))
    deltas = grid["timestamp_utc"].diff().dropna().dt.total_seconds()
    assert (deltas == 1.0).all()


def test_an_empty_stream_yields_an_empty_grid() -> None:
    grid = resample_to_1hz(_streams([], []))
    assert grid.empty


def test_across_an_outage_distance_interpolates_and_the_seconds_still_count() -> None:
    """The device went quiet for 150 s while the athlete ran 450 m.

    Holding distance would claim the athlete stood still and then covered
    450 m in the single second the recording came back. The odometer says
    otherwise, so distance is spread across the gap and those seconds are
    moving time. Heart rate and cadence are still null: nothing measured them.
    """
    streams = _streams(
        [0.0, 100.0, 250.0],
        [0.0, 300.0, 750.0],
        hr_bpm=[150.0, 150.0, 150.0],
        cadence_spm=[170.0, 170.0, 170.0],
        speed_mps=[3.0, 3.0, 3.0],
    )
    grid = resample_to_1hz(streams)

    inside = grid[(grid["t_s"] > 100.0) & (grid["t_s"] < 250.0)]
    assert len(inside) == 149
    assert not inside["paused"].any()
    assert inside["outage"].all()
    assert inside["hr_bpm"].isna().all()
    assert inside["cadence_spm"].isna().all()
    assert inside["speed_mps"].isna().all()

    # Linear across the outage: 3 m/s for every one of the 150 seconds.
    assert inside["distance_m"].iloc[0] == pytest.approx(303.0)
    assert inside["distance_m"].iloc[-1] == pytest.approx(747.0)
    assert grid["distance_m"].iloc[-1] == pytest.approx(750.0)


def test_an_outage_cannot_manufacture_an_impossibly_fast_effort() -> None:
    """The regression: a held outage collapsed 450 m into one second.

    best_effort then interpolated a window start inside that jump and reported
    400 m in 0.89 s, with contains_pause false so nothing downstream could
    filter it out. The whole run is at 3 m/s, so no window may be faster.
    """
    t_s = [float(v) for v in range(0, 101, 10)] + [250.0]
    distance_m = [v * 3.0 for v in t_s[:-1]] + [750.0]
    grid = resample_to_1hz(_streams(t_s, distance_m))

    efforts = best_efforts(grid)
    assert not efforts.empty
    speeds = efforts["distance_m"] / efforts["elapsed_time_s"]
    assert (speeds <= 3.0 + 1e-6).all()

    four_hundred = efforts.loc[efforts["distance_key"] == "400m"].iloc[0]
    assert four_hundred["elapsed_time_s"] == pytest.approx(400.0 / 3.0, rel=1e-6)


def test_a_stop_the_odometer_advanced_across_cannot_manufacture_a_fast_effort() -> None:
    """The regression on the stop branch, mirroring the outage one.

    600 m at 3 m/s, then a 300 s gap across which distance advances 140 m.
    That implies 0.47 m/s, under PAUSE_MAX_IMPLIED_SPEED_MPS, so it is a
    stop. Holding distance flat put all 140 m in the second the recording
    resumed, and best_effort interpolated a window start inside that jump:
    400 m in 88 s, 4.5 m/s, for an athlete who never exceeded 3 m/s, and
    contains_pause was false so nothing downstream could filter it.
    """
    before = [float(v) for v in range(0, 201, 10)]
    after = [float(v) for v in range(500, 801, 10)]
    t_s = before + after
    distance_m = [v * 3.0 for v in before] + [740.0 + (v - 500.0) * 3.0 for v in after]
    grid = resample_to_1hz(_streams(t_s, distance_m))

    assert grid.loc[(grid["t_s"] > 200.0) & (grid["t_s"] < 500.0), "paused"].all()
    # Every second is at most a running second: the advance across the stop is
    # spread over the 300 s it occupied rather than compressed into one.
    assert grid["distance_m"].diff().max() <= 3.0 + 1e-9

    efforts = best_efforts(grid)
    assert not efforts.empty
    speeds = efforts["distance_m"] / efforts["elapsed_time_s"]
    assert (speeds <= 3.0 + 1e-6).all()


def test_a_null_distance_sample_does_not_anchor_interpolation() -> None:
    """The last place a hold-then-jump could hide: the monotone pass.

    Records at 3 m/s to 30 m, then 280 s of records whose distance channel is
    null, then a record at 930 m. A null distance is an absence of
    information, not an observation that distance did not change: treating it
    as the running maximum held the grid at 30 m and then advanced 90 m in a
    single second, which yielded a 400 m effort of 4.44 s with neither flag
    set. No gap here exceeds 15 s, so find_gaps cannot help; the bridge has to
    be honest in the first place.
    """
    middle = [float(v) for v in range(20, 301, 10)]
    t_s = [0.0, 10.0, *middle, 310.0]
    distance_m = [0.0, 30.0, *[float("nan")] * len(middle), 930.0]
    grid = resample_to_1hz(_streams(t_s, distance_m, hr_bpm=[150.0] * len(t_s)))

    # 900 m over the 300 s between the two real samples is a steady 3 m/s.
    assert grid["distance_m"].diff().max() == pytest.approx(3.0)
    assert grid.loc[grid["t_s"] == 160.0, "distance_m"].iloc[0] == pytest.approx(480.0)

    efforts = best_efforts(grid)
    speeds = efforts["distance_m"] / efforts["elapsed_time_s"]
    assert (speeds <= 3.0 + 1e-6).all()


def test_a_channel_that_stops_before_the_end_is_not_carried_forward() -> None:
    # The odometer goes quiet 4 s before the recording does. Those seconds are
    # unknown rather than a repeat of the last reading.
    grid = resample_to_1hz(_streams([0.0, 4.0, 8.0], [0.0, 12.0, float("nan")]))
    assert grid.loc[grid["t_s"] > 4.0, "distance_m"].isna().all()
    assert grid.loc[grid["t_s"] == 4.0, "distance_m"].iloc[0] == pytest.approx(12.0)


def test_a_stop_bounded_by_a_null_distance_sample_is_still_a_stop() -> None:
    # The athlete stood still for 200 s and the odometer field was missing on
    # the sample that closed the stop. Reading that null as an observation
    # leaves the advance undefined, which no gap bounded by it could survive
    # as a stop, so 199 standing-still seconds would be labelled an outage and
    # counted as moving time.
    gaps = find_gaps(np.array([0.0, 200.0, 210.0]), np.array([100.0, np.nan, 100.5]))
    assert [(g.start_t_s, g.end_t_s, g.kind) for g in gaps] == [(0.0, 200.0, GAP_STOP)]


def test_the_grid_agrees_with_the_classifier_about_a_null_bounded_stop() -> None:
    grid = resample_to_1hz(_streams([0.0, 200.0, 210.0], [100.0, float("nan"), 100.5]))
    inside = grid[(grid["t_s"] > 0.0) & (grid["t_s"] < 200.0)]
    assert inside["paused"].all()
    assert not inside["outage"].any()
