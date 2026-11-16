"""Fitness estimates, against values computed by hand from the published
formulas rather than against real data, which has no ground truth here."""

from __future__ import annotations

import math

import numpy as np
import pandas as pd
import pytest

from activity_analysis.analysis.fitness import (
    ORDINARY_RUN_CALIBRATION_INTERCEPT,
    ORDINARY_RUN_CALIBRATION_SLOPE,
    ORDINARY_RUN_RESIDUAL_VDOT,
    _prediction_vdots,
    fitness_rows,
    hr_vo2max,
    predict_from_ordinary_run,
    race_predictions,
    smooth_series,
    time_for_vdot,
    vdot,
)


def test_vdot_matches_a_hand_computed_value() -> None:
    """The 2026-08-25 fixture's fastest clean 5 km, 25:07.919.

    v    = 5000 / 25.13198 = 198.95 m/min
    VO2  = -4.60 + 0.182258*198.95 + 0.000104*198.95^2 = 35.78
    pct  = 0.8 + 0.1894393*exp(-0.012778*25.13198)
               + 0.2989558*exp(-0.1932605*25.13198)    = 0.9397
    VDOT = 35.78 / 0.9397 = 38.1
    """
    assert abs(vdot(5000.0, 1507.918707) - 38.1) < 0.1


def test_vdot_rises_as_the_same_distance_is_run_faster() -> None:
    assert vdot(5000.0, 1200.0) > vdot(5000.0, 1400.0)


def test_a_longer_effort_at_the_same_pace_implies_a_higher_vdot() -> None:
    """The whole point of the percentage curve. Holding 4:00/km for 10 km is
    a better performance than holding it for 3 km, because a longer effort is
    run at a lower fraction of VO2max."""
    assert vdot(10000.0, 2400.0) > vdot(3000.0, 720.0)


def test_the_inverse_round_trips() -> None:
    for distance, target in ((5000.0, 42.0), (10000.0, 35.0), (1000.0, 50.0)):
        predicted = time_for_vdot(distance, target)
        assert abs(vdot(distance, predicted) - target) < 0.01


def test_the_inverse_is_monotone_in_fitness() -> None:
    assert time_for_vdot(5000.0, 50.0) < time_for_vdot(5000.0, 40.0)


def test_vdot_of_a_nonsense_effort_is_nan() -> None:
    assert math.isnan(vdot(5000.0, 0.0))
    assert math.isnan(vdot(0.0, 1200.0))


def test_hr_vo2max_on_a_hand_computable_segment() -> None:
    """One steady segment at 3.0 m/s and 160 bpm against a max of 200.

    v      = 3.0 * 60 = 180 m/min
    VO2seg = 0.2 * 180 + 3.5 = 39.5
    pctseg = (1.5625 * (160/200 * 100) - 57.81) / 100 = 0.6719
    est    = 39.5 / 0.6719 = 58.79
    """
    speed = np.full(30 * 40, 3.0)
    hr = np.full(30 * 40, 160.0)
    assert abs(hr_vo2max(speed, hr, 200.0) - 58.79) < 0.2


def test_a_run_below_the_intensity_gate_does_not_qualify() -> None:
    """Garmin's rule, and it is not arbitrary: below about 70% of maximum the
    heart rate to oxygen relation bends and the linear map stops holding."""
    speed = np.full(30 * 40, 3.0)
    hr = np.full(30 * 40, 120.0)
    assert math.isnan(hr_vo2max(speed, hr, 200.0))


def test_a_run_too_short_to_qualify_returns_nan() -> None:
    """Ten minutes of qualifying data, which is 20 segments of 30 s."""
    speed = np.full(30 * 10, 3.0)
    hr = np.full(30 * 10, 160.0)
    assert math.isnan(hr_vo2max(speed, hr, 200.0))


def test_an_unsteady_segment_is_discarded() -> None:
    """Comparing heart rate against speed only means anything where speed is
    steady. During an acceleration heart rate is still catching up."""
    rng = np.random.default_rng(3)
    speed = 3.0 + 2.0 * rng.normal(size=30 * 40)
    hr = np.full(30 * 40, 160.0)
    assert math.isnan(hr_vo2max(speed, hr, 200.0))


def test_no_max_heart_rate_means_no_estimate() -> None:
    """84 of 307 real runs carry no heart rate at all and one athlete profile
    interval has a null maximum. The estimate scales directly with that
    number, so guessing one would be inventing the answer."""
    speed = np.full(30 * 40, 3.0)
    hr = np.full(30 * 40, 160.0)
    assert math.isnan(hr_vo2max(speed, hr, float("nan")))


def test_a_faster_run_at_the_same_heart_rate_estimates_higher() -> None:
    slow = hr_vo2max(np.full(30 * 40, 2.6), np.full(30 * 40, 160.0), 200.0)
    fast = hr_vo2max(np.full(30 * 40, 3.4), np.full(30 * 40, 160.0), 200.0)
    assert fast > slow


def test_smoothing_averages_over_the_calendar_window() -> None:
    when = pd.to_datetime(["2026-01-01", "2026-01-08", "2026-01-15"])
    value = pd.Series([40.0, 50.0, 60.0])
    smoothed = smooth_series(pd.Series(when), value)
    assert smoothed.iloc[0] == 40.0
    assert smoothed.iloc[1] == 45.0
    assert smoothed.iloc[2] == 50.0


def test_a_break_in_training_leaves_the_window_rather_than_being_bridged() -> None:
    """The reason the window is calendar-based rather than a count of
    activities. Two runs a year apart must not be averaged together just
    because they are adjacent in the table."""
    when = pd.Series(pd.to_datetime(["2025-01-01", "2026-06-01", "2026-06-08"]))
    value = pd.Series([40.0, 60.0, 62.0])
    smoothed = smooth_series(when, value)
    assert smoothed.iloc[1] == 60.0
    assert smoothed.iloc[2] == 61.0


def test_smoothing_reduces_the_step_between_consecutive_values() -> None:
    """The property the maintainer asked for, and the measured reason for it: raw
    per-activity estimates move a median of 8.8% of the median estimate run to
    run and 29% at the 95th percentile, which is unreadable as fitness."""
    rng = np.random.default_rng(6)
    when = pd.Series(pd.date_range("2026-01-01", periods=120, freq="2D"))
    value = pd.Series(50.0 + 6.0 * rng.normal(size=120))
    smoothed = smooth_series(when, value)
    assert smoothed.diff().abs().median() < value.diff().abs().median() / 3.0


def test_smoothing_requires_sorted_input_and_says_so() -> None:
    when = pd.Series(pd.to_datetime(["2026-02-01", "2026-01-01"]))
    with pytest.raises(ValueError):
        smooth_series(when, pd.Series([50.0, 40.0]))


def test_smoothing_ignores_activities_with_no_estimate() -> None:
    """A run that did not qualify contributes nothing rather than a zero,
    which would drag the mean down and read as a collapse in fitness."""
    when = pd.Series(pd.to_datetime(["2026-01-01", "2026-01-05", "2026-01-08"]))
    value = pd.Series([40.0, float("nan"), 50.0])
    smoothed = smooth_series(when, value)
    assert smoothed.iloc[2] == 45.0


def test_the_prediction_inverts_the_calibrated_vdot_it_is_given() -> None:
    prediction = predict_from_ordinary_run(36.392, 5000.0)
    assert prediction is not None
    assert prediction.predicted_s == pytest.approx(time_for_vdot(5000.0, 36.392))


def test_the_band_brackets_the_prediction_and_is_not_symmetric_in_time() -> None:
    """The residual is symmetric in VDOT units, and time is a nonlinear
    function of VDOT, so the band must not be reported as a plus-or-minus on
    the time."""
    prediction = predict_from_ordinary_run(36.4, 5000.0)
    assert prediction is not None
    assert prediction.low_s == pytest.approx(
        time_for_vdot(5000.0, 36.4 + ORDINARY_RUN_RESIDUAL_VDOT)
    )
    assert prediction.high_s == pytest.approx(
        time_for_vdot(5000.0, 36.4 - ORDINARY_RUN_RESIDUAL_VDOT)
    )
    assert prediction.low_s < prediction.predicted_s < prediction.high_s
    lower_gap = prediction.predicted_s - prediction.low_s
    upper_gap = prediction.high_s - prediction.predicted_s
    assert abs(lower_gap - upper_gap) > 0.1


def test_no_vdot_means_no_prediction() -> None:
    assert predict_from_ordinary_run(float("nan"), 5000.0) is None


def _activities(*ids: str) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "activity_id": list(ids),
            "start_time_utc": pd.to_datetime(
                [f"2026-01-{day + 1:02d}" for day in range(len(ids))], utc=True
            ),
        }
    )


def _efforts(*rows: tuple[str, str, float, float, bool | None]) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "activity_id": [row[0] for row in rows],
            "distance_key": [row[1] for row in rows],
            "distance_m": [row[2] for row in rows],
            "elapsed_time_s": [row[3] for row in rows],
            "contains_jump": [row[4] for row in rows],
            "distance_trusted": [None if row[4] is None else not row[4] for row in rows],
        }
    )


def test_vdot_ignores_an_effort_at_a_distance_outside_the_model_set() -> None:
    """The 2 km here scores higher, and it is on the ladder but not in the set.

    `STANDARD_DISTANCES_M` is a display choice and grows when the athlete
    wants a rung; `VDOT_DISTANCES_M` is a modelling choice. Reading the
    former here would move every stored `vdot` the day one was added.
    """
    frame = fitness_rows(
        _activities("a1"),
        _efforts(("a1", "2k", 2000.0, 400.0, False), ("a1", "5k", 5000.0, 1400.0, False)),
        grids={},
        max_hr_by_activity={},
        excluded_activity_ids=set(),
    )
    assert len(frame) == 1
    assert frame.loc[0, "vdot_distance_key"] == "5k"
    assert abs(frame.loc[0, "vdot"] - vdot(5000.0, 1400.0)) < 1e-9


def test_fitness_rows_take_the_best_vdot_among_an_activity_s_efforts() -> None:
    """The 5 km here is the better performance: 4:40/km held for 23 minutes
    against 4:30/km for one. The row names the distance it came from."""
    frame = fitness_rows(
        _activities("a1"),
        _efforts(("a1", "1k", 1000.0, 270.0, False), ("a1", "5k", 5000.0, 1400.0, False)),
        grids={},
        max_hr_by_activity={},
        excluded_activity_ids=set(),
    )
    assert len(frame) == 1
    assert frame.loc[0, "vdot_distance_key"] == "5k"
    assert abs(frame.loc[0, "vdot"] - vdot(5000.0, 1400.0)) < 1e-9
    assert math.isnan(frame.loc[0, "hr_vo2max"])
    assert frame.loc[0, "qualifying_segments"] == 0


def test_a_treadmill_effort_never_produces_a_vdot() -> None:
    """Its distance comes from an uncalibrated footpod, so a VDOT computed
    from it would be a fitness estimate derived from a number nobody
    measured. The activity contributes no row at all when it has nothing
    else to say."""
    frame = fitness_rows(
        _activities("treadmill", "outdoor"),
        _efforts(
            ("treadmill", "5k", 5000.0, 1100.0, False), ("outdoor", "5k", 5000.0, 1500.0, False)
        ),
        grids={},
        max_hr_by_activity={},
        excluded_activity_ids={"treadmill"},
    )
    assert list(frame["activity_id"]) == ["outdoor"]


def test_a_treadmill_run_never_produces_a_heart_rate_estimate() -> None:
    """The footpod speed that makes a treadmill distance ineligible for VDOT
    is the same speed the heart-rate estimate turns into an oxygen cost, so
    the exclusion applies to both estimates. An identical outdoor run
    qualifies on the same grid."""
    speed = np.full(30 * 40, 3.0)
    hr = np.full(30 * 40, 160.0)
    frame = fitness_rows(
        _activities("treadmill", "outdoor"),
        _efforts(),
        grids={"treadmill": (speed, hr), "outdoor": (speed, hr)},
        max_hr_by_activity={"treadmill": 200.0, "outdoor": 200.0},
        excluded_activity_ids={"treadmill"},
    )
    assert list(frame["activity_id"]) == ["outdoor"]
    assert frame.loc[0, "qualifying_segments"] == 40
    assert frame.loc[0, "hr_vo2max"] == pytest.approx(hr_vo2max(speed, hr, 200.0))


def test_a_jumped_or_unverified_effort_never_produces_a_vdot() -> None:
    """Null means not known, and is excluded like a known jump: the same rule
    the records list and the pr tag apply."""
    frame = fitness_rows(
        _activities("jumped", "unknown", "clean"),
        _efforts(
            ("jumped", "5k", 5000.0, 1000.0, True),
            ("unknown", "5k", 5000.0, 1000.0, None),
            ("clean", "5k", 5000.0, 1500.0, False),
        ),
        grids={},
        max_hr_by_activity={},
        excluded_activity_ids=set(),
    )
    assert list(frame["activity_id"]) == ["clean"]


def test_a_jump_the_measured_speed_confirms_produces_a_vdot() -> None:
    """One rule everywhere: the effort a record may come from, VDOT may too."""
    efforts = _efforts(
        ("confirmed", "5k", 5000.0, 1400.0, True),
        ("unconfirmed", "5k", 5000.0, 1000.0, True),
    ).assign(distance_trusted=[True, False])
    frame = fitness_rows(
        _activities("confirmed", "unconfirmed"),
        efforts,
        grids={},
        max_hr_by_activity={},
        excluded_activity_ids=set(),
    )
    assert list(frame["activity_id"]) == ["confirmed"]


def test_fitness_rows_carry_the_heart_rate_estimate_and_its_segment_count() -> None:
    speed = np.full(30 * 40, 3.0)
    hr = np.full(30 * 40, 160.0)
    frame = fitness_rows(
        _activities("steady"),
        _efforts(),
        grids={"steady": (speed, hr)},
        max_hr_by_activity={"steady": 200.0},
        excluded_activity_ids=set(),
    )
    assert len(frame) == 1
    assert abs(frame.loc[0, "hr_vo2max"] - hr_vo2max(speed, hr, 200.0)) < 1e-9
    assert frame.loc[0, "qualifying_segments"] == 40
    assert frame.loc[0, "hr_vo2max_smoothed"] == frame.loc[0, "hr_vo2max"]
    assert math.isnan(frame.loc[0, "vdot"])
    assert frame.loc[0, "vdot_distance_key"] is None


def test_fitness_rows_are_sorted_by_time_and_smoothed_in_that_order() -> None:
    """The activities frame arrives in whatever order the store holds it, and
    the trailing window has to run over time, not over row order."""
    speed = np.full(30 * 40, 3.0)
    activities = _activities("later", "earlier")
    activities["start_time_utc"] = pd.to_datetime(["2026-03-01", "2026-02-01"], utc=True)
    frame = fitness_rows(
        activities,
        _efforts(),
        grids={
            "later": (speed, np.full(speed.size, 170.0)),
            "earlier": (speed, np.full(speed.size, 160.0)),
        },
        max_hr_by_activity={"later": 200.0, "earlier": 200.0},
        excluded_activity_ids=set(),
    )
    assert list(frame["activity_id"]) == ["earlier", "later"]
    assert frame.loc[1, "hr_vo2max_smoothed"] == pytest.approx(frame["hr_vo2max"].mean())


def test_an_activity_with_nothing_to_say_produces_no_row() -> None:
    frame = fitness_rows(
        _activities("silent"),
        _efforts(),
        grids={"silent": (np.full(30 * 40, 3.0), np.full(30 * 40, 120.0))},
        max_hr_by_activity={"silent": 200.0},
        excluded_activity_ids=set(),
    )
    assert frame.empty


def _models(result: dict[str, object], key: str) -> dict[str, dict[str, object]]:
    items = result["items"]
    assert isinstance(items, list)
    (item,) = [item for item in items if item["distance_key"] == key]
    return {model["model"]: model for model in item["models"]}


def test_race_predictions_inverts_each_vdot_at_every_distance() -> None:
    out = race_predictions(45.0, 44.0)
    five = _models(out, "5k")
    best = five["best_efforts"]
    assert best["predicted_time_s"] == pytest.approx(time_for_vdot(5000.0, 45.0))
    assert best["source"] == "best_efforts"
    assert best["low_s"] is None and best["high_s"] is None
    ordinary = five["ordinary_runs"]
    assert ordinary["source"] == "ordinary_runs"
    assert ordinary["predicted_time_s"] == pytest.approx(time_for_vdot(5000.0, 44.0))
    assert ordinary["low_s"] == pytest.approx(
        time_for_vdot(5000.0, 44.0 + ORDINARY_RUN_RESIDUAL_VDOT)
    )
    assert ordinary["high_s"] == pytest.approx(
        time_for_vdot(5000.0, 44.0 - ORDINARY_RUN_RESIDUAL_VDOT)
    )
    # Every `VDOT_DISTANCES_M` entry at or above MIN_PREDICTION_DISTANCE_M,
    # ascending; 400 m is below the floor. The distances added to the records
    # ladder later are absent on purpose: a predicted time must not move
    # because a rung was added to a ladder.
    assert [item["distance_key"] for item in out["items"]] == [
        "1k",
        "1mi",
        "3k",
        "5k",
        "10k",
        "15k",
        "half",
        "marathon",
    ]
    assert out["insufficient_data"] is False and out["reason"] is None


def test_race_predictions_without_best_efforts_keeps_ordinary_runs_and_says_why() -> None:
    out = race_predictions(None, 44.0)
    assert out["insufficient_data"] is True
    reason = out["reason"]
    assert isinstance(reason, str) and "best effort" in reason
    assert {m["model"] for i in out["items"] for m in i["models"]} == {"ordinary_runs"}


def test_race_predictions_without_ordinary_runs_keeps_best_efforts_and_says_why() -> None:
    out = race_predictions(45.0, float("nan"))
    assert out["insufficient_data"] is True
    reason = out["reason"]
    assert isinstance(reason, str) and "ordinary" in reason
    assert set(_models(out, "5k")) == {"best_efforts"}


def test_race_predictions_with_neither_is_an_empty_list_with_a_reason() -> None:
    out = race_predictions(None, None)
    assert out["items"] == []
    assert out["insufficient_data"] is True


def _timed_runs(days_and_vdots: list[tuple[int, float]], offset_s: int = 0):
    """Runs at 12:00 UTC on the given days of 2026, each holding one 5 km at its VDOT."""
    ids = [f"r{index}" for index in range(len(days_and_vdots))]
    start = pd.Timestamp("2026-01-01 12:00", tz="UTC")
    activities = pd.DataFrame(
        {
            "activity_id": ids,
            "start_time_utc": [start + pd.Timedelta(days=day) for day, _ in days_and_vdots],
            "utc_offset_s": [offset_s] * len(ids),
        }
    )
    efforts = _efforts(
        *(
            (i, "5k", 5000.0, time_for_vdot(5000.0, v), False)
            for i, (_, v) in zip(ids, days_and_vdots, strict=True)
        )
    )
    return activities, efforts


def _series(activities: pd.DataFrame, efforts: pd.DataFrame) -> pd.DataFrame:
    return fitness_rows(activities, efforts, {}, {}, set())


def test_best_efforts_vdot_averages_the_three_best_runs_in_90_days() -> None:
    """Raw on day 30 is 47; the 42-day mean runs over days 0-30:
    days 0-9 raw 50, 10-19 raw 47 (50, 44), 20-29 raw 47 (50, 47, 44), day 30 raw 47."""
    frame = _series(*_timed_runs([(0, 50.0), (10, 44.0), (20, 47.0), (30, 40.0)]))
    expected = (10 * 50 + 10 * 47 + 10 * 47 + 47) / 31
    assert frame["best_efforts_vdot"].iloc[3] == pytest.approx(expected, abs=1e-9)


def test_one_run_counts_once_whatever_distances_it_holds() -> None:
    activities = _activities("a1")
    efforts = _efforts(
        ("a1", "5k", 5000.0, time_for_vdot(5000.0, 46.0), False),
        ("a1", "10k", 10000.0, time_for_vdot(10000.0, 48.0), False),
    )
    frame = _series(activities, efforts)
    assert frame["best_efforts_vdot"].iloc[0] == pytest.approx(48.0, abs=1e-6)


def test_efforts_under_1_km_and_ineligible_ones_do_not_count() -> None:
    activities = _activities("short", "untrusted", "clean")
    efforts = _efforts(
        ("short", "400m", 400.0, time_for_vdot(400.0, 60.0), False),
        ("untrusted", "5k", 5000.0, time_for_vdot(5000.0, 58.0), True),
        ("clean", "5k", 5000.0, time_for_vdot(5000.0, 45.0), False),
    )
    frame = _series(activities, efforts)
    # The short run still has a row (its 400 m VDOT), but no 1 km run VDOT.
    assert frame["best_efforts_vdot"].iloc[-1] == pytest.approx(45.0, abs=1e-6)


def test_smoothing_is_over_days_not_runs() -> None:
    """Raw 40 on days 0-49, 43 on days 50-89. A row on day 70 with no effort
    reads (21 * 40 + 21 * 43) / 42 = 41.5, not the mean of the two runs' values."""
    start = pd.Timestamp("2026-01-01 12:00", tz="UTC")
    rows = pd.DataFrame(
        {
            "start_time_utc": [start + pd.Timedelta(days=d) for d in (0, 50, 70)],
            "local_date": [(start + pd.Timedelta(days=d)).date() for d in (0, 50, 70)],
            "hr_vo2max_smoothed": [np.nan] * 3,
        }
    )
    out = _prediction_vdots(rows, pd.Series([40.0, 46.0, np.nan]))
    assert out["best_efforts_vdot"].iloc[2] == pytest.approx(41.5, abs=1e-9)


def test_the_first_run_after_a_long_gap_stands_alone() -> None:
    frame = _series(*_timed_runs([(0, 40.0), (200, 46.0)]))
    assert frame["best_efforts_vdot"].iloc[1] == pytest.approx(46.0, abs=1e-6)


def test_ordinary_runs_vdot_is_the_calibrated_estimate_smoothed_over_days() -> None:
    """Raw 50 on days 0-20 and 60 from day 21, so day 41 averages 21 days of
    each: calibrated 55."""
    start = pd.Timestamp("2026-01-01 12:00", tz="UTC")
    days = (0, 21, 41)
    rows = pd.DataFrame(
        {
            "start_time_utc": [start + pd.Timedelta(days=d) for d in days],
            "local_date": [(start + pd.Timedelta(days=d)).date() for d in days],
            "hr_vo2max_smoothed": [50.0, 60.0, 60.0],
        }
    )
    out = _prediction_vdots(rows, pd.Series([np.nan] * 3))
    expected = ORDINARY_RUN_CALIBRATION_SLOPE * 55.0 + ORDINARY_RUN_CALIBRATION_INTERCEPT
    assert out["ordinary_runs_vdot"].iloc[2] == pytest.approx(expected, abs=1e-9)


def test_ordinary_runs_ignore_a_heart_rate_estimate_older_than_the_window() -> None:
    """The only estimate is day 0's, raw on days 0-89 and gone from day 90
    though later runs carry none. Day 130's 42 days, 89 to 130, still hold
    day 89; day 131's, 90 to 131, hold no raw value, so it is null rather
    than day 0's estimate carried forward."""
    start = pd.Timestamp("2026-01-01 12:00", tz="UTC")
    days = (0, 130, 131)
    rows = pd.DataFrame(
        {
            "start_time_utc": [start + pd.Timedelta(days=d) for d in days],
            "local_date": [(start + pd.Timedelta(days=d)).date() for d in days],
            "hr_vo2max_smoothed": [50.0, np.nan, np.nan],
        }
    )
    out = _prediction_vdots(rows, pd.Series([np.nan] * 3))
    calibrated = ORDINARY_RUN_CALIBRATION_SLOPE * 50.0 + ORDINARY_RUN_CALIBRATION_INTERCEPT
    assert out["ordinary_runs_vdot"].iloc[1] == pytest.approx(calibrated, abs=1e-9)
    assert math.isnan(out["ordinary_runs_vdot"].iloc[2])


def test_a_late_evening_run_is_dated_by_its_local_day() -> None:
    """23:30 UTC at +01:00 is local day 1, so the run 90 UTC days later is 89
    local days after it and still inside its window. Read in UTC the old run
    would sit exactly 90 days back and fall out."""
    start = pd.Timestamp("2026-01-01 23:30", tz="UTC")
    activities = pd.DataFrame(
        {
            "activity_id": ["old", "new"],
            "start_time_utc": [start, start + pd.Timedelta(days=90, hours=-11, minutes=-30)],
            "utc_offset_s": [3600, 0],
        }
    )
    efforts = _efforts(
        ("old", "5k", 5000.0, time_for_vdot(5000.0, 50.0), False),
        ("new", "5k", 5000.0, time_for_vdot(5000.0, 40.0), False),
    )
    frame = _series(activities, efforts)
    # Local days 1 and 90: raw 50 on days 1-89 and 45 on day 90, smoothed over days 49-90.
    assert frame["best_efforts_vdot"].iloc[1] == pytest.approx((41 * 50.0 + 45.0) / 42, abs=1e-6)


def test_no_eligible_effort_leaves_best_efforts_vdot_null_and_ordinary_set() -> None:
    activities = _activities("a1")
    frame = fitness_rows(
        activities,
        _efforts(),
        grids={"a1": (np.full(30 * 40, 3.0), np.full(30 * 40, 160.0))},
        max_hr_by_activity={"a1": 200.0},
        excluded_activity_ids=set(),
    )
    assert math.isnan(frame["best_efforts_vdot"].iloc[0])
    assert math.isfinite(frame["ordinary_runs_vdot"].iloc[0])


def _every_second_day(before: float, after: float) -> pd.DataFrame:
    """A row every day from day -200 to 200 and a run every second day, whose
    VDOT is ``before`` until day 0 and ``after`` from it, indexed by day."""
    offsets = np.arange(-200, 201)
    start = pd.Timestamp("2026-01-01")
    rows = pd.DataFrame(
        {
            "local_date": [(start + pd.Timedelta(days=int(d))).date() for d in offsets],
            "hr_vo2max_smoothed": [np.nan] * len(offsets),
        }
    )
    run_vdot = np.where(offsets % 2 == 0, np.where(offsets >= 0, after, before), np.nan)
    return _prediction_vdots(rows, pd.Series(run_vdot)).set_axis(offsets)


def test_a_held_rise_is_in_full_45_days_after_it() -> None:
    """The third run at the new level, day 4, lifts the raw value to it, and
    the 42-day mean holds only such days from day 4 + 41 = 45.
    predictions.md, "The lag", quotes this figure."""
    series = _every_second_day(40.0, 42.0)["best_efforts_vdot"]
    assert series[44] < 42.0
    assert series[45] == pytest.approx(42.0, abs=1e-9)


def test_a_held_fall_waits_for_the_best_runs_to_leave_the_window() -> None:
    """The three best runs stay the old ones until the first of them, day -6,
    leaves the 90-day window on day 84. The last, day -2, leaves on day 88,
    and the 42-day mean holds only lower days from 88 + 41 = 129."""
    series = _every_second_day(42.0, 40.0)["best_efforts_vdot"]
    assert series[83] == pytest.approx(42.0, abs=1e-9)
    assert series[84] < 42.0
    assert series[128] > 40.0
    assert series[129] == pytest.approx(40.0, abs=1e-9)
