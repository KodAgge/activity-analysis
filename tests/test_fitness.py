"""Fitness estimates, against values computed by hand from the published
formulas rather than against real data, which has no ground truth here."""

from __future__ import annotations

import math

import numpy as np
import pandas as pd
import pytest

from activity_analysis.analysis.fitness import (
    cameron,
    fitness_rows,
    hr_vo2max,
    predict_from_ordinary_run,
    race_predictions,
    riegel,
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


def test_riegel_matches_the_published_exponent() -> None:
    """T2 = T1 * (D2/D1)^1.06. From 5 km in 25:00, the 10 km is
    1500 * 2^1.06 = 3127.4 s."""
    assert abs(riegel(5000.0, 1500.0, 10000.0) - 3127.4) < 1.0


def test_riegel_returns_the_same_time_for_the_same_distance() -> None:
    assert abs(riegel(5000.0, 1500.0, 5000.0) - 1500.0) < 1e-6


def test_cameron_and_riegel_agree_closely_at_short_extrapolations() -> None:
    """Both are fits to observed performance, so they should not disagree
    much over a doubling. Their divergence at the marathon end is the reason
    both are reported rather than one."""
    r = riegel(5000.0, 1500.0, 10000.0)
    c = cameron(5000.0, 1500.0, 10000.0)
    assert abs(r - c) / r < 0.05


def test_the_raw_heart_rate_estimate_is_not_used_directly() -> None:
    """The measured reason this whole function exists: inverting the raw
    estimate predicts a 19.2 minute 5 km against an actual best of 25.1."""
    raw = time_for_vdot(5000.0, 52.0)
    calibrated = predict_from_ordinary_run(52.0, 5000.0)
    assert calibrated is not None
    assert calibrated.predicted_s > raw * 1.2


def test_the_calibration_maps_a_known_estimate_to_a_known_vdot() -> None:
    """VDOT = 0.510 * 52.0 + 11.60 = 38.12."""
    prediction = predict_from_ordinary_run(52.0, 5000.0)
    assert prediction is not None
    assert abs(prediction.predicted_s - time_for_vdot(5000.0, 38.12)) < 1.0


def test_the_band_brackets_the_prediction_and_is_not_symmetric_in_time() -> None:
    """The residual is symmetric in VDOT units, and time is a nonlinear
    function of VDOT, so the band must not be reported as a plus-or-minus on
    the time."""
    prediction = predict_from_ordinary_run(52.0, 5000.0)
    assert prediction is not None
    assert prediction.low_s < prediction.predicted_s < prediction.high_s
    lower_gap = prediction.predicted_s - prediction.low_s
    upper_gap = prediction.high_s - prediction.predicted_s
    assert abs(lower_gap - upper_gap) > 0.1


def test_the_band_is_about_the_measured_residual() -> None:
    """Roughly +/-1.26 min on a 5 km, from a residual of 2.37 VDOT units."""
    prediction = predict_from_ordinary_run(52.0, 5000.0)
    assert prediction is not None
    half_width = (prediction.high_s - prediction.low_s) / 2.0
    assert 60.0 < half_width < 100.0


def test_no_estimate_means_no_prediction() -> None:
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


def _recent(*rows: tuple[str, float, float]) -> list[dict[str, object]]:
    return [
        {"distance_key": key, "distance_m": metres, "elapsed_time_s": seconds}
        for key, metres, seconds in rows
    ]


def _models(result: dict[str, object], key: str) -> dict[str, dict[str, object]]:
    items = result["items"]
    assert isinstance(items, list)
    (item,) = [item for item in items if item["distance_key"] == key]
    return {model["model"]: model for model in item["models"]}


def test_race_predictions_cover_every_distance_from_a_kilometre_up() -> None:
    result = race_predictions(
        _recent(("1k", 1000.0, 250.0), ("5k", 5000.0, 1400.0), ("10k", 10000.0, 3000.0)), 52.0
    )
    # Every `VDOT_DISTANCES_M` entry at or above MIN_PREDICTION_DISTANCE_M,
    # in ascending order. 400 m is below the floor and so is absent. The
    # thirteen distances added to the records ladder on 2026-09-12 are absent
    # too, and deliberately: a predicted time must not move because a rung
    # was added to a ladder.
    assert [item["distance_key"] for item in result["items"]] == [
        "1k",
        "1mi",
        "3k",
        "5k",
        "10k",
        "15k",
        "half",
        "marathon",
    ]
    assert result["insufficient_data"] is False
    assert result["reason"] is None


def test_the_best_effort_models_come_from_the_highest_vdot_recent_effort() -> None:
    """The 5 km is the better performance here, so Riegel and Cameron are
    both anchored on it, and both return it unchanged at its own distance."""
    result = race_predictions(_recent(("1k", 1000.0, 270.0), ("5k", 5000.0, 1400.0)), float("nan"))
    models = _models(result, "5k")
    assert models["riegel"]["predicted_time_s"] == pytest.approx(1400.0)
    assert models["cameron"]["predicted_time_s"] == pytest.approx(1400.0)
    assert models["riegel"]["source"] == "best_efforts"
    assert models["riegel"]["low_s"] is None and models["riegel"]["high_s"] is None
    assert (
        models["riegel"]["predicted_time_s"] < _models(result, "10k")["riegel"]["predicted_time_s"]
    )


def test_a_single_recent_distance_is_enough_for_every_model() -> None:
    """Riegel and Cameron extrapolate from one anchor, so one eligible
    distance in the window is a complete answer, not an insufficient one."""
    result = race_predictions(_recent(("5k", 5000.0, 1400.0)), 52.0)
    assert result["insufficient_data"] is False
    assert result["reason"] is None
    assert set(_models(result, "10k")) == {"riegel", "cameron", "ordinary_runs"}


def test_an_easy_long_run_in_the_window_moves_no_prediction() -> None:
    """The shape of the window's efforts on 2026-10-03: a 10 km as the
    best-scored effort and, as the longest, a 15 km inside an easy long run
    scoring about three quarters of its VDOT.

    A fit across the per-distance bests, critical speed's, let that one easy
    point set the slope, and predicted a 10 km 18% slower than the one in the
    window. The models here read only the best-scored effort, so the easy one
    changes nothing and no third model appears."""
    fast = _recent(("3k", 3000.0, 900.0), ("5k", 5000.0, 1500.0), ("10k", 10000.0, 3000.0))
    with_easy = [*fast, *_recent(("15k", 15000.0, 6000.0))]
    for key in ("1k", "10k", "half", "marathon"):
        assert set(_models(race_predictions(with_easy, 52.0), key)) == {
            "riegel",
            "cameron",
            "ordinary_runs",
        }
        assert _models(race_predictions(with_easy, 52.0), key) == _models(
            race_predictions(fast, 52.0), key
        )
    assert _models(race_predictions(with_easy, 52.0), "10k")["riegel"][
        "predicted_time_s"
    ] == pytest.approx(3000.0)


def test_no_recent_effort_leaves_only_the_ordinary_run_prediction() -> None:
    result = race_predictions([], 52.0)
    assert result["insufficient_data"] is True
    reason = result["reason"]
    assert isinstance(reason, str) and "eligible best effort" in reason
    for item in result["items"]:
        assert [model["model"] for model in item["models"]] == ["ordinary_runs"]
        (model,) = item["models"]
        assert model["source"] == "ordinary_runs"
        assert model["low_s"] < model["predicted_time_s"] < model["high_s"]


def test_no_estimate_leaves_out_the_ordinary_run_prediction_and_says_so() -> None:
    result = race_predictions(_recent(("1k", 1000.0, 250.0), ("5k", 5000.0, 1400.0)), float("nan"))
    assert result["insufficient_data"] is True
    reason = result["reason"]
    assert isinstance(reason, str) and "ordinary" in reason
    assert "ordinary_runs" not in _models(result, "5k")


def test_nothing_at_all_is_an_empty_list_with_a_reason() -> None:
    result = race_predictions([], float("nan"))
    assert result["items"] == []
    assert result["insufficient_data"] is True


def test_a_400_m_effort_is_not_a_prediction_source() -> None:
    """Below ``MIN_PREDICTION_DISTANCE_M`` (1000 m), and so below the domain the
    curves were fitted over: the Daniels percentage curve exceeds 1.0 below about
    two minutes and his tables start at 1500 m, and Riegel's exponent was fitted
    to race distances. A 400 m window is also short enough that one bad second
    dominates it, which is why the five fastest 400 m efforts on the real store
    all carry ``contains_jump``."""
    result = race_predictions(_recent(("400m", 400.0, 90.0)), float("nan"))
    assert result["items"] == []
    assert result["insufficient_data"] is True
