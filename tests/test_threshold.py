"""The threshold heart-rate estimate, against synthetic grids with known answers."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from activity_analysis.analysis.threshold import (
    LOCK_ON_DROP_BPM,
    MIN_HR_COVERAGE,
    MIN_TAIL_S,
    WINDOW_DAYS,
    estimate_at,
    is_hard,
    reading,
    run_readings,
    zone_boundaries,
)

T0 = pd.Timestamp("2026-06-01T08:00:00Z")


def make_grid(hr: list[float | None], activity_id: str = "a") -> pd.DataFrame:
    n = len(hr)
    return pd.DataFrame(
        {
            "activity_id": activity_id,
            "t_s": np.arange(n, dtype="float64"),
            "hr_bpm": pd.Series(hr, dtype="float64"),
            "paused": False,
            "outage": False,
        }
    )


def effort(
    activity_id: str = "a",
    start: float = 0.0,
    elapsed: float = 2400.0,
    distance_m: float = 8000.0,
    key: str = "8k",
    pause: bool = False,
) -> dict[str, object]:
    return {
        "activity_id": activity_id,
        "distance_key": key,
        "distance_m": distance_m,
        "elapsed_time_s": elapsed,
        "start_t_s": start,
        "end_t_s": start + elapsed,
        "contains_pause": pause,
        "contains_outage": False,
        "contains_jump": False,
    }


#: 90% of it is 162, so a grid at 170 bpm is hard throughout.
MAX_HR = {"a": 180.0}


def runs_frame(*ids: str) -> pd.DataFrame:
    return pd.DataFrame({"activity_id": list(ids), "start_time_utc": [T0] * len(ids)})


def test_reading_is_the_mean_of_the_final_1200_seconds() -> None:
    grid = make_grid([150.0] * 1201 + [180.0] * 1200)
    out = reading(grid, pd.Series(effort()))
    assert out is not None
    assert out["final_hr_bpm"] == 180.0
    assert out["hr_coverage"] == 1.0


def test_a_reading_needs_ninety_percent_heart_rate_coverage() -> None:
    assert MIN_HR_COVERAGE == 0.9
    hr: list[float | None] = [150.0] * 1201 + [180.0] * 1200
    for i in range(2401 - 121, 2401):
        hr[i] = None
    assert reading(make_grid(hr), pd.Series(effort())) is None
    hr2: list[float | None] = [150.0] * 1201 + [180.0] * 1200
    for i in range(2401 - 120, 2401):
        hr2[i] = None
    out = reading(make_grid(hr2), pd.Series(effort()))
    assert out is not None
    assert out["hr_coverage"] == 0.9


def test_a_late_lock_on_is_cut_and_the_reading_taken_from_the_tail() -> None:
    """A wrist sensor that locks on late reads far low at the window's start.

    The seconds before the heart rate first comes within LOCK_ON_DROP_BPM of
    the window's median are cut, and the reading is the mean of the rest.
    """
    assert LOCK_ON_DROP_BPM == 20.0
    lock_on = 250
    hr = [150.0] * 1201 + [130.0] * lock_on + [188.0] * (1200 - lock_on)
    out = reading(make_grid(hr), pd.Series(effort()))
    assert out is not None
    assert out["final_hr_bpm"] == 188.0
    assert out["hr_coverage"] == 1.0


def test_a_tail_shorter_than_the_minimum_gives_no_reading() -> None:
    assert MIN_TAIL_S == 900.0
    hr = [150.0] * 1201 + [130.0] * 300 + [188.0] * 900
    assert reading(make_grid(hr), pd.Series(effort())) is not None
    hr = [150.0] * 1201 + [130.0] * 301 + [188.0] * 899
    assert reading(make_grid(hr), pd.Series(effort())) is None


def test_a_dip_inside_the_window_counts_as_missing_heart_rate() -> None:
    """A dip after the sensor has locked on is not cut, it is not counted.

    Its seconds leave the mean and count against coverage, as seconds with no
    heart rate do, so a walk of more than a tenth of the window rejects it.
    """
    hr = [150.0] * 1201 + [180.0] * 500 + [130.0] * 100 + [180.0] * 600
    out = reading(make_grid(hr), pd.Series(effort()))
    assert out is not None
    assert out["final_hr_bpm"] == 180.0
    assert out["hr_coverage"] == pytest.approx(1100 / 1200)
    hr = [150.0] * 1201 + [180.0] * 500 + [130.0] * 121 + [180.0] * 579
    assert reading(make_grid(hr), pd.Series(effort())) is None


def test_missing_heart_rate_at_the_start_is_not_cut() -> None:
    """Only a low reading is a lock-on; no reading still counts against coverage."""
    hr: list[float | None] = [150.0] * 1201 + [None] * 121 + [180.0] * 1079
    assert reading(make_grid(hr), pd.Series(effort())) is None


def test_a_second_exactly_the_drop_below_the_median_is_kept() -> None:
    hr = [150.0] * 1201 + [180.0 - LOCK_ON_DROP_BPM] * 200 + [180.0] * 1000
    out = reading(make_grid(hr), pd.Series(effort()))
    assert out is not None
    assert out["hr_coverage"] == 1.0
    assert out["final_hr_bpm"] == pytest.approx((200 * 160.0 + 1000 * 180.0) / 1200)


def test_a_clean_rising_window_is_read_untouched() -> None:
    """A heart rate that climbs steadily through the window is not a lock-on."""
    rising = list(np.linspace(160.0, 199.0, 1200))
    out = reading(make_grid([150.0] * 1201 + rising), pd.Series(effort()))
    assert out is not None
    assert out["hr_coverage"] == 1.0
    assert out["final_hr_bpm"] == pytest.approx(float(np.mean(rising)))


def test_only_efforts_of_thirty_to_sixty_minutes_and_clean_count() -> None:
    grid = make_grid([170.0] * 4000)
    efforts = pd.DataFrame([effort(elapsed=1799.0), effort(elapsed=3601.0), effort(pause=True)])
    out = run_readings(efforts, {"a": grid}, runs_frame("a"), set(), {"a"}, MAX_HR)
    assert out.empty


def test_a_run_contributes_its_highest_vdot_effort_only() -> None:
    grid = make_grid([170.0] * 4000)
    slow8 = effort(elapsed=2400.0, distance_m=8000.0, key="8k")
    fast10 = effort(elapsed=2700.0, distance_m=10000.0, key="10k")
    out = run_readings(
        pd.DataFrame([slow8, fast10]), {"a": grid}, runs_frame("a"), set(), {"a"}, MAX_HR
    )
    assert len(out) == 1
    assert out.iloc[0]["distance_key"] == "10k"
    assert out.iloc[0]["activity_id"] == "a"


@pytest.mark.parametrize("flag", ["contains_outage", "contains_jump"])
def test_outage_and_jump_efforts_give_no_reading(flag: str) -> None:
    grid = make_grid([170.0] * 4000)
    row = effort()
    row[flag] = True
    out = run_readings(pd.DataFrame([row]), {"a": grid}, runs_frame("a"), set(), {"a"}, MAX_HR)
    assert out.empty


def test_a_higher_vdot_effort_without_heart_rate_falls_through() -> None:
    hr: list[float | None] = [170.0] * 2401 + [None] * 400
    grid = make_grid(hr)
    fast10 = effort(elapsed=2800.0, distance_m=10000.0, key="10k")
    slow8 = effort(elapsed=2400.0, distance_m=8000.0, key="8k")
    out = run_readings(
        pd.DataFrame([fast10, slow8]), {"a": grid}, runs_frame("a"), set(), {"a"}, MAX_HR
    )
    assert len(out) == 1
    assert out.iloc[0]["distance_key"] == "8k"


def test_a_run_not_tagged_all_out_gives_no_reading() -> None:
    grid = make_grid([170.0] * 4000)
    efforts = pd.DataFrame([effort()])
    assert run_readings(efforts, {"a": grid}, runs_frame("a"), set(), set(), MAX_HR).empty
    assert len(run_readings(efforts, {"a": grid}, runs_frame("a"), set(), {"a"}, MAX_HR)) == 1


def test_an_effort_needs_a_tenth_of_its_seconds_at_ninety_percent_of_max() -> None:
    """The effort itself must have been hard, as the all-out tag's first branch reads a run.

    Max 200 puts the line at 180. 241 of the effort's 2401 seconds at 190 is
    10.04%, 240 is 9.996%. The hard seconds lie before the final window, so
    the reading itself is the 170 after them.
    """
    for hard_s, expected in ((241, 1), (240, 0)):
        grid = make_grid([190.0] * hard_s + [170.0] * (4000 - hard_s))
        assert is_hard(grid, pd.Series(effort()), 200.0) is (expected == 1)
        out = run_readings(
            pd.DataFrame([effort()]), {"a": grid}, runs_frame("a"), set(), {"a"}, {"a": 200.0}
        )
        assert len(out) == expected
        if expected:
            assert out.iloc[0]["final_hr_bpm"] == 170.0


def test_a_run_without_a_maximum_heart_rate_gives_no_reading() -> None:
    grid = make_grid([170.0] * 4000)
    efforts = pd.DataFrame([effort()])
    for max_hr in ({}, {"a": float("nan")}):
        assert run_readings(efforts, {"a": grid}, runs_frame("a"), set(), {"a"}, max_hr).empty


def test_a_faster_effort_that_was_not_hard_falls_through_to_one_that_was() -> None:
    """A long run's fast segment is not hard; its later, slower effort is."""
    grid = make_grid([170.0] * 2701 + [190.0] * 400 + [170.0] * 899)
    fast10 = effort(start=0.0, elapsed=2700.0, distance_m=10000.0, key="10k")
    slow8 = effort(start=1000.0, elapsed=2800.0, distance_m=8000.0, key="8k")
    out = run_readings(
        pd.DataFrame([fast10, slow8]), {"a": grid}, runs_frame("a"), set(), {"a"}, {"a": 200.0}
    )
    assert len(out) == 1
    assert out.iloc[0]["distance_key"] == "8k"
    assert out.iloc[0]["final_hr_bpm"] == pytest.approx((400 * 190.0 + 800 * 170.0) / 1200)


def test_excluded_runs_give_no_reading() -> None:
    grid = make_grid([170.0] * 4000)
    out = run_readings(pd.DataFrame([effort()]), {"a": grid}, runs_frame("a"), {"a"}, {"a"}, MAX_HR)
    assert out.empty


def readings(vdots: list[float], hrs: list[float], ages_days: list[float]) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "activity_id": [f"r{i}" for i in range(len(vdots))],
            "start_time_utc": [T0 - pd.Timedelta(days=d) for d in ages_days],
            "vdot": vdots,
            "final_hr_bpm": hrs,
        }
    )


def test_estimate_is_the_median_of_the_readings_in_the_window() -> None:
    """Every reading in the window counts, however slow its effort.

    Intensity is decided before a reading exists, by the run's all_out tag, so
    a slower effort's reading is not dropped here.
    """
    frame = readings([50, 49, 48, 40], [178, 180, 182, 176], [1, 2, 3, 4])
    assert estimate_at(frame, T0) == (179.0, ["r0", "r1", "r2", "r3"])


def test_estimate_ignores_readings_outside_the_window() -> None:
    frame = readings([50, 49, 48], [178, 180, 182], [1, 2, WINDOW_DAYS + 1])
    assert estimate_at(frame, T0) == (None, [])


def test_estimate_is_none_below_the_minimum_reading_count() -> None:
    frame = readings([50, 49], [178, 180], [1, 2])
    assert estimate_at(frame, T0) == (None, [])


def test_zone_boundaries_are_friel_fractions() -> None:
    assert zone_boundaries(180.0) == [153.0, 162.0, 171.0, 180.0]
