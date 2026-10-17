"""Best efforts are verified against synthetic runs whose answers are known exactly."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from activity_analysis.analysis.best_efforts import (
    STANDARD_DISTANCES_M,
    VDOT_DISTANCES_M,
    best_effort,
    best_efforts,
    distance_trusted,
    speed_channel_distance_m,
    speed_is_measured,
)


def _even_run(pace_s_per_km: float, distance_m: float) -> tuple[np.ndarray, np.ndarray]:
    """A run at a perfectly constant pace, sampled once per second."""
    speed = 1000.0 / pace_s_per_km
    seconds = int(round(distance_m / speed))
    t_s = np.arange(0.0, seconds + 1.0)
    return t_s, t_s * speed


def test_a_five_kilometre_run_at_five_minute_pace_takes_exactly_twenty_five_minutes() -> None:
    t_s, distance = _even_run(300.0, 5000.0)
    window = best_effort(t_s, distance, 5000.0)
    assert window is not None
    assert window.elapsed_time_s == pytest.approx(1500.0)


def test_every_standard_distance_inside_that_run_is_exact() -> None:
    t_s, distance = _even_run(300.0, 5000.0)
    for target, expected in ((400.0, 120.0), (1000.0, 300.0), (3000.0, 900.0)):
        window = best_effort(t_s, distance, target)
        assert window is not None
        assert window.elapsed_time_s == pytest.approx(expected)


def test_the_fastest_window_is_found_and_not_merely_the_first() -> None:
    # Two kilometres: the first slow, the second fast.
    slow_t = np.arange(0.0, 401.0)
    slow_d = slow_t * 2.5
    fast_t = np.arange(401.0, 601.0)
    fast_d = 1000.0 + (fast_t - 400.0) * 5.0
    window = best_effort(np.concatenate([slow_t, fast_t]), np.concatenate([slow_d, fast_d]), 1000.0)
    assert window is not None
    assert window.elapsed_time_s == pytest.approx(200.0)
    assert window.start_t_s == pytest.approx(400.0)


def test_a_distance_longer_than_the_run_has_no_effort() -> None:
    t_s, distance = _even_run(300.0, 3000.0)
    assert best_effort(t_s, distance, 5000.0) is None


def test_the_window_starts_where_the_target_distance_actually_begins() -> None:
    # Stood still for 7 s, then ran 5 km at 5:00/km. The clock for the effort
    # itself starts when the running does, not when the recording does.
    t_s, distance = _even_run(300.0, 5000.0)
    t_s = np.concatenate([np.arange(0.0, 7.0), t_s + 7.0])
    distance = np.concatenate([np.zeros(7), distance])
    window = best_effort(t_s, distance, 5000.0)
    assert window is not None
    assert window.elapsed_time_s == pytest.approx(1500.0)
    assert window.start_t_s == pytest.approx(7.0)


def test_the_clock_runs_through_a_pause() -> None:
    """The scenario the user specified: 5 km, five minutes standing, 5 km.

    The ten kilometre effort is 65 minutes, not 60. Under elapsed time a rest
    can only ever make an effort slower, which is exactly why this is the rule.
    """
    first_t = np.arange(0.0, 1801.0)
    first_d = first_t * (5000.0 / 1800.0)
    pause_t = np.arange(1801.0, 2101.0)
    pause_d = np.full(len(pause_t), 5000.0)
    second_t = np.arange(2101.0, 3901.0)
    second_d = 5000.0 + (second_t - 2100.0) * (5000.0 / 1800.0)

    t_s = np.concatenate([first_t, pause_t, second_t])
    distance = np.concatenate([first_d, pause_d, second_d])

    ten_k = best_effort(t_s, distance, 10000.0)
    assert ten_k is not None
    assert ten_k.elapsed_time_s == pytest.approx(65.0 * 60.0, abs=1.0)

    # The five kilometre effort is untouched by the stop.
    five_k = best_effort(t_s, distance, 5000.0)
    assert five_k is not None
    assert five_k.elapsed_time_s == pytest.approx(30.0 * 60.0, abs=1.0)


def test_the_frame_reports_only_distances_the_run_actually_covered() -> None:
    t_s, distance = _even_run(300.0, 5000.0)
    grid = pd.DataFrame(
        {
            "t_s": t_s,
            "distance_m": distance,
            "hr_bpm": np.full(len(t_s), 150.0),
            "paused": np.zeros(len(t_s), dtype=bool),
            "outage": np.zeros(len(t_s), dtype=bool),
        }
    )
    frame = best_efforts(grid)
    # "Only when attempted" needs no mechanism of its own: a distance longer
    # than the run simply yields no row. That is why the records ladder holds
    # no marathon today, and why it will hold no 30k or 35k until a run covers
    # them.
    assert set(frame["distance_key"]) == {"400m", "1k", "1mi", "2k", "3k", "4k", "3mi", "5k"}
    assert not frame["contains_pause"].any()
    assert not frame["contains_outage"].any()
    assert frame.loc[frame["distance_key"] == "5k", "avg_hr_bpm"].iloc[0] == pytest.approx(150.0)


def test_an_effort_spanning_a_pause_is_flagged() -> None:
    t_s = np.arange(0.0, 1201.0)
    distance = np.where(
        t_s < 600,
        t_s * 2.5,
        np.where(t_s < 660, 1500.0, 1500.0 + (t_s - 660) * 2.5),
    )
    paused = (t_s > 600) & (t_s < 660)
    grid = pd.DataFrame(
        {
            "t_s": t_s,
            "distance_m": distance,
            "hr_bpm": np.nan,
            "paused": paused,
            "outage": np.zeros(len(t_s), dtype=bool),
        }
    )
    frame = best_efforts(grid)
    row = frame[frame["distance_key"] == "1mi"].iloc[0]
    assert bool(row["contains_pause"])
    assert not bool(row["contains_outage"])
    assert np.isnan(row["avg_hr_bpm"])


def test_an_effort_spanning_an_outage_is_flagged() -> None:
    """A window every metre of which was interpolated says so.

    The number itself is conservative rather than inflated, but a consumer
    cannot decide to exclude what it cannot see.

    2000 m at 2 m/s, then a 200 s outage interpolated at 3 m/s, then 1200 m
    at 4 m/s. The fastest 400 m fits inside the closing sprint, but a mile
    does not, so it has to reach back across the outage.
    """
    t_s = np.arange(0.0, 1501.0)
    distance = np.where(
        t_s <= 1000,
        t_s * 2.0,
        np.where(t_s <= 1200, 2000.0 + (t_s - 1000.0) * 3.0, 2600.0 + (t_s - 1200.0) * 4.0),
    )
    outage = (t_s > 1000) & (t_s < 1200)
    grid = pd.DataFrame(
        {
            "t_s": t_s,
            "distance_m": distance,
            "hr_bpm": np.where(outage, np.nan, 150.0),
            "paused": np.zeros(len(t_s), dtype=bool),
            "outage": outage,
        }
    )
    frame = best_efforts(grid).set_index("distance_key")

    assert bool(frame.loc["1mi", "contains_outage"])
    assert not bool(frame.loc["1mi", "contains_pause"])
    assert frame.loc["400m", "elapsed_time_s"] == pytest.approx(100.0)
    assert not bool(frame.loc["400m", "contains_outage"])


def test_the_standard_distances_are_the_twenty_two_the_spec_names() -> None:
    assert list(STANDARD_DISTANCES_M) == [
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
        "8mi",
        "15k",
        "10mi",
        "20k",
        "half",
        "15mi",
        "25k",
        "30k",
        "35k",
        "marathon",
    ]
    assert STANDARD_DISTANCES_M["marathon"] == pytest.approx(42195.0)


def test_the_table_is_in_ascending_order() -> None:
    # The records ladder renders in this order and two endpoints sort by
    # position in it, so the order is part of the contract rather than an
    # accident of how the dict was typed.
    values = list(STANDARD_DISTANCES_M.values())
    assert values == sorted(values)


def test_the_vdot_distances_are_the_nine_the_phase_one_spec_named() -> None:
    """VDOT and the race predictions read nine of the twenty-two.

    Both take a maximum over whatever candidates they are handed, so sharing
    one set with the records ladder would make adding a rung to that ladder
    move every activity's ``vdot`` and every predicted time.
    """
    assert list(VDOT_DISTANCES_M) == [
        "400m",
        "1k",
        "1mi",
        "3k",
        "5k",
        "10k",
        "15k",
        "half",
        "marathon",
    ]


def test_the_vdot_distances_are_a_subset_of_the_standard_ones() -> None:
    """The two sets may differ in membership, never in what a distance is."""
    assert set(VDOT_DISTANCES_M) <= set(STANDARD_DISTANCES_M)
    for key, distance_m in VDOT_DISTANCES_M.items():
        assert distance_m == pytest.approx(STANDARD_DISTANCES_M[key])
    ascending = [key for key in STANDARD_DISTANCES_M if key in VDOT_DISTANCES_M]
    assert list(VDOT_DISTANCES_M) == ascending


def test_the_imperial_distances_are_the_exact_conversions() -> None:
    assert STANDARD_DISTANCES_M["3mi"] == pytest.approx(3 * 1609.344)
    assert STANDARD_DISTANCES_M["5mi"] == pytest.approx(5 * 1609.344)
    assert STANDARD_DISTANCES_M["8mi"] == pytest.approx(8 * 1609.344)
    assert STANDARD_DISTANCES_M["15mi"] == pytest.approx(15 * 1609.344)


def test_an_effort_containing_an_impossible_advance_is_flagged() -> None:
    """An implausible advance in the recorded distance credits metres nobody ran.

    The distance trace is kept exactly as the device wrote it, so the effort
    is flagged rather than corrected. 100 m arriving in one second is 100 m/s,
    which no human has ever run.
    """
    t_s = np.arange(0.0, 601.0)
    distance = np.where(t_s < 300, t_s * 2.5, 750.0 + 100.0 + (t_s - 300) * 2.5)
    grid = pd.DataFrame(
        {
            "t_s": t_s,
            "distance_m": distance,
            "hr_bpm": np.full(len(t_s), 150.0),
            "paused": np.zeros(len(t_s), dtype=bool),
            "outage": np.zeros(len(t_s), dtype=bool),
        }
    )
    frame = best_efforts(grid).set_index("distance_key")

    assert bool(frame.loc["400m", "contains_jump"])
    assert not bool(frame.loc["400m", "contains_pause"])
    assert not bool(frame.loc["400m", "contains_outage"])


def test_an_ordinary_effort_is_not_flagged_as_a_jump() -> None:
    # 5.5 m/s is a fast running speed and is still nowhere near the physical
    # bound the flag encodes.
    t_s = np.arange(0.0, 601.0)
    grid = pd.DataFrame(
        {
            "t_s": t_s,
            "distance_m": t_s * 5.5,
            "hr_bpm": np.full(len(t_s), 150.0),
            "paused": np.zeros(len(t_s), dtype=bool),
            "outage": np.zeros(len(t_s), dtype=bool),
        }
    )
    assert not best_efforts(grid)["contains_jump"].any()


def _steady_grid_with_jump(
    speed_mps: float, seconds: int, jump_at_s: int, jump_m: float
) -> pd.DataFrame:
    """A steady run whose odometer alone gains ``jump_m`` in one second.

    The speed channel never leaves ``speed_mps``, the shape of a real half
    marathon: the recorded distance blips while the measured speed does not.
    """
    t_s = np.arange(0.0, seconds + 1.0)
    distance = t_s * speed_mps + np.where(t_s >= jump_at_s, jump_m, 0.0)
    return pd.DataFrame(
        {
            "t_s": t_s,
            "distance_m": distance,
            "speed_mps": np.full(len(t_s), speed_mps),
            "hr_bpm": np.full(len(t_s), 150.0),
            "paused": np.zeros(len(t_s), dtype=bool),
            "outage": np.zeros(len(t_s), dtype=bool),
        }
    )


def test_the_speed_channel_distance_of_a_steady_window_is_speed_times_time() -> None:
    """Trapezoidal integration is exact for a constant speed, fractional start included."""
    t_s = np.arange(0.0, 101.0)
    speed = np.full(len(t_s), 3.0)
    assert speed_channel_distance_m(t_s, speed, 10.25, 90.0) == pytest.approx(3.0 * 79.75)


def test_a_second_without_a_speed_reading_confirms_no_distance() -> None:
    """A metre the speed channel never saw cannot be vouched for by it."""
    t_s = np.arange(0.0, 11.0)
    speed = np.full(len(t_s), 3.0)
    speed[5] = np.nan
    # The two intervals touching t=5 lose their share: 8 of 10 seconds remain.
    assert speed_channel_distance_m(t_s, speed, 0.0, 10.0) == pytest.approx(24.0)


def test_a_small_jump_the_speed_channel_confirms_is_trusted_over_a_long_effort() -> None:
    """15 m of odometer blip inside a 5 km effort is a 0.3% disagreement.

    At 3 m/s the 5 km window needs (5000 - 15) / 3 = 1661.67 s, over which
    the speed channel accounts for 4985 m, so the recorded distance runs
    15 / 4985 = 0.301% ahead: inside the 1% tolerance.
    """
    grid = _steady_grid_with_jump(3.0, 2000, jump_at_s=1000, jump_m=15.0)
    frame = best_efforts(grid, speed_is_measured=True).set_index("distance_key")

    five = frame.loc["5k"]
    assert bool(five["contains_jump"])
    assert five["elapsed_time_s"] == pytest.approx((5000.0 - 15.0) / 3.0)
    assert five["speed_distance_m"] == pytest.approx(5000.0 - 15.0)
    assert bool(five["distance_trusted"])


def test_the_same_jump_inside_a_short_effort_is_not_trusted() -> None:
    """The same 15 m inside a 400 m window is 15 / 385 = 3.9% ahead."""
    grid = _steady_grid_with_jump(3.0, 2000, jump_at_s=1000, jump_m=15.0)
    frame = best_efforts(grid, speed_is_measured=True).set_index("distance_key")

    four = frame.loc["400m"]
    assert bool(four["contains_jump"])
    assert four["speed_distance_m"] == pytest.approx(385.0)
    assert not bool(four["distance_trusted"])


def test_an_effort_without_a_jump_is_trusted_whatever_the_speed_channel_says() -> None:
    """The agreement check only readmits; it never excludes an unflagged effort."""
    t_s = np.arange(0.0, 601.0)
    grid = pd.DataFrame(
        {
            "t_s": t_s,
            "distance_m": t_s * 3.0,
            "speed_mps": np.full(len(t_s), 2.0),
            "hr_bpm": np.full(len(t_s), 150.0),
            "paused": np.zeros(len(t_s), dtype=bool),
            "outage": np.zeros(len(t_s), dtype=bool),
        }
    )
    frame = best_efforts(grid, speed_is_measured=True)
    assert not frame["contains_jump"].any()
    assert frame["distance_trusted"].all()


def test_a_speed_channel_derived_from_the_distance_cannot_readmit_a_jump() -> None:
    """Without a measured speed there is no independent evidence to check against."""
    grid = _steady_grid_with_jump(3.0, 2000, jump_at_s=1000, jump_m=15.0)
    frame = best_efforts(grid).set_index("distance_key")

    assert bool(frame.loc["5k", "contains_jump"])
    assert np.isnan(frame.loc["5k", "speed_distance_m"])
    assert not bool(frame.loc["5k", "distance_trusted"])


def test_a_speed_channel_computed_from_the_odometer_is_recognised_as_derived() -> None:
    """The fallback ``normalize`` applies to GPX, and to any FIT with no speed field."""
    t_s = np.array([0.0, 1.0, 3.0, 4.0, 9.0])
    distance = np.array([0.0, 3.1, 9.0, 12.5, 30.0])
    derived = pd.Series(distance).diff() / pd.Series(t_s).diff()
    streams = pd.DataFrame({"t_s": t_s, "distance_m": distance, "speed_mps": derived.bfill()})
    assert not speed_is_measured(streams)


def test_a_speed_channel_the_device_wrote_is_recognised_as_measured() -> None:
    t_s = np.array([0.0, 1.0, 3.0, 4.0, 9.0])
    distance = np.array([0.0, 3.1, 9.0, 12.5, 30.0])
    streams = pd.DataFrame(
        {"t_s": t_s, "distance_m": distance, "speed_mps": [3.0, 3.05, 2.98, 3.4, 3.5]}
    )
    assert speed_is_measured(streams)


def test_a_stream_with_no_speed_at_all_has_no_measured_speed() -> None:
    streams = pd.DataFrame(
        {"t_s": [0.0, 1.0], "distance_m": [0.0, 3.0], "speed_mps": [np.nan, np.nan]}
    )
    assert not speed_is_measured(streams)


def test_the_trusted_mask_counts_only_an_explicit_true() -> None:
    """A null is not known, and a record is the consumer for which that is worst."""
    efforts = pd.DataFrame(
        {"contains_jump": [False, True, True], "distance_trusted": [True, True, None]}
    )
    assert distance_trusted(efforts).tolist() == [True, True, False]
