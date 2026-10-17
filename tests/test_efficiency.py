"""Efficiency fits, against synthetic data with known analytic answers.

Real data has no independent ground truth for these quantities, so every
assertion here is against a series constructed to have one.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from activity_analysis.analysis.efficiency import (
    AEROBIC_TAGS,
    MIN_AEROBIC_LONG_RUN_SECONDS,
    ActivitySample,
    Decoupling,
    between_activity_tau,
    block_bootstrap_se,
    decoupling,
    efficiency_rows,
    fit_slope,
    naive_se,
    reference_paces,
    shared_slope,
    shrink,
    smooth_efficiency,
)


def test_fit_slope_recovers_an_exact_line() -> None:
    x = np.linspace(2.0, 4.0, 500)
    y = 7.0 * x + 100.0
    slope, intercept = fit_slope(x, y)
    assert abs(slope - 7.0) < 1e-9
    assert abs(intercept - 100.0) < 1e-9


def test_fit_slope_returns_nan_when_x_never_varies() -> None:
    """A run held at exactly one speed has no slope to fit, and must say so
    rather than returning whatever the least-squares solver produces for a
    singular design."""
    x = np.full(500, 3.0)
    y = np.linspace(140.0, 150.0, 500)
    slope, intercept = fit_slope(x, y)
    assert np.isnan(slope)
    assert np.isnan(intercept)


def _autocorrelated_noise(n: int, rho: float, seed: int) -> np.ndarray:
    """An AR(1) series: each value is mostly the previous one.

    This is the shape of real heart rate noise on a 1 Hz grid, and it is what
    makes an ordinary least-squares standard error wrong.
    """
    rng = np.random.default_rng(seed)
    out = np.zeros(n)
    for i in range(1, n):
        out[i] = rho * out[i - 1] + rng.normal(0.0, 1.0)
    return out


def test_the_block_bootstrap_error_exceeds_the_naive_one_under_autocorrelation() -> None:
    """The property the whole estimator depends on.

    With independent noise the two agree to within a factor of about two.
    With the autocorrelation a 1 Hz grid actually carries, the naive error is
    far too small, and using it would drive every shrinkage weight to 1.
    """
    n = 2400
    x = 3.0 + 0.3 * np.sin(np.linspace(0.0, 12.0, n))
    y = 10.0 * x + 140.0 + 4.0 * _autocorrelated_noise(n, rho=0.99, seed=3)

    naive = naive_se(x, y)
    block = block_bootstrap_se(x, y, seed=11)

    assert block > 3.0 * naive


def test_the_block_bootstrap_is_deterministic_for_a_given_seed() -> None:
    n = 1200
    x = 3.0 + 0.2 * np.sin(np.linspace(0.0, 9.0, n))
    y = 8.0 * x + 150.0 + _autocorrelated_noise(n, rho=0.95, seed=5)
    assert block_bootstrap_se(x, y, seed=7) == block_bootstrap_se(x, y, seed=7)


def test_the_block_bootstrap_returns_inf_for_a_series_too_short_to_block() -> None:
    """Shorter than one block is not a fit whose error can be estimated, and
    infinity is the honest answer: it drives the shrinkage weight to zero and
    the activity takes the shared slope."""
    x = np.linspace(2.0, 3.0, 30)
    y = 10.0 * x + 140.0
    assert np.isinf(block_bootstrap_se(x, y, seed=1))


def test_reference_paces_are_the_quartiles_of_per_activity_median_speed() -> None:
    speeds = np.array([2.0, 2.5, 3.0, 3.5, 4.0])
    refs = reference_paces(speeds)
    assert refs.slow == 2.5
    assert refs.median == 3.0
    assert refs.fast == 3.5


def test_reference_paces_are_ordered() -> None:
    rng = np.random.default_rng(4)
    speeds = 2.8 + 0.3 * rng.normal(size=300)
    refs = reference_paces(speeds)
    assert refs.slow < refs.median < refs.fast


def test_reference_paces_from_a_single_activity_collapse_to_that_speed() -> None:
    """One run is not a distribution. Every quartile is the same number, and
    the fit then evaluates all three references at one pace rather than
    inventing a spread the history does not support."""
    refs = reference_paces(np.array([2.9]))
    assert refs.slow == refs.median == refs.fast == 2.9


def test_a_run_with_no_leverage_takes_the_shared_slope_exactly() -> None:
    """The property that preserves what the pooled decision was made for.

    An infinite standard error means the activity told us nothing about its
    own slope, so it must contribute nothing and take the shared value.
    """
    shrunk, weight = shrink(own=-30.0, error=float("inf"), shared=9.5, tau=10.0)
    assert weight == 0.0
    assert shrunk == 9.5


def test_a_precisely_measured_run_keeps_almost_all_of_its_own_slope() -> None:
    shrunk, weight = shrink(own=20.0, error=0.05, shared=9.5, tau=10.0)
    assert weight > 0.99
    assert abs(shrunk - 20.0) < 0.2


def test_shrinkage_is_the_precision_weighted_average() -> None:
    """With error equal to tau the weight is exactly one half, so the result
    is the midpoint. This is the arithmetic the whole estimator rests on."""
    shrunk, weight = shrink(own=20.0, error=10.0, shared=10.0, tau=10.0)
    assert abs(weight - 0.5) < 1e-12
    assert abs(shrunk - 15.0) < 1e-12


def test_tau_is_zero_when_all_the_spread_is_estimation_noise() -> None:
    """If the observed variation between activities is no larger than the
    errors explain, there is no real between-activity variation to keep, and
    every activity should take the shared slope."""
    rng = np.random.default_rng(2)
    errors = np.full(200, 5.0)
    slopes = 10.0 + 5.0 * rng.normal(size=200)
    tau = between_activity_tau(slopes, errors)
    assert tau < 2.0


def test_tau_recovers_real_between_activity_spread() -> None:
    rng = np.random.default_rng(8)
    true = 10.0 + 8.0 * rng.normal(size=400)
    errors = np.full(400, 3.0)
    observed = true + 3.0 * rng.normal(size=400)
    tau = between_activity_tau(observed, errors)
    assert 6.5 < tau < 9.5


def test_tau_ignores_activities_with_no_usable_error() -> None:
    slopes = np.array([10.0, 12.0, 8.0, 50.0])
    errors = np.array([2.0, 2.0, 2.0, float("inf")])
    assert np.isfinite(between_activity_tau(slopes, errors))


def test_decoupling_is_zero_when_efficiency_holds() -> None:
    speed = np.full(2000, 3.0)
    hr = np.full(2000, 150.0)
    assert abs(decoupling(speed, hr).pct) < 1e-9


def test_decoupling_is_positive_when_heart_rate_drifts_up_at_the_same_speed() -> None:
    """The usual direction, and the one the metric exists to detect: the same
    pace costing more heart rate as the run goes on."""
    speed = np.full(2000, 3.0)
    hr = np.concatenate([np.full(1000, 150.0), np.full(1000, 165.0)])
    value = decoupling(speed, hr).pct
    assert value > 0
    # First-half efficiency 3.0/150 = 0.0200, second half 3.0/165 = 0.018182.
    # (0.0200 - 0.018182) / 0.0200 = 9.0909 percent.
    assert abs(value - 9.0909) < 0.01


def test_decoupling_is_negative_when_the_second_half_is_more_efficient() -> None:
    speed = np.full(2000, 3.0)
    hr = np.concatenate([np.full(1000, 165.0), np.full(1000, 150.0)])
    assert decoupling(speed, hr).pct < 0


def test_decoupling_needs_both_halves() -> None:
    result = decoupling(np.full(10, 3.0), np.full(10, 150.0))
    assert np.isnan(result.pct)
    # The halves are null together with the percentage, never shown alone.
    assert np.isnan(result.first_speed_mps)
    assert np.isnan(result.second_speed_mps)
    assert np.isnan(result.first_hr_bpm)
    assert np.isnan(result.second_hr_bpm)


def test_decoupling_reports_the_halves_it_compares() -> None:
    """(3.0/150 - 2.9/165) / (3.0/150) = 12.1212 percent: slower and dearer."""
    speed = np.concatenate([np.full(1000, 3.0), np.full(1000, 2.9)])
    hr = np.concatenate([np.full(1000, 150.0), np.full(1000, 165.0)])
    result = decoupling(speed, hr)
    assert result == Decoupling(
        pct=pytest.approx(12.1212, abs=1e-4),
        first_speed_mps=3.0,
        second_speed_mps=pytest.approx(2.9),
        first_hr_bpm=150.0,
        second_hr_bpm=165.0,
    )


def test_the_halves_reproduce_the_percentage_on_an_odd_count() -> None:
    """``n // 2`` gives the second half the extra second; the four means are
    the ones the percentage was computed from, so they reproduce it exactly."""
    rng = np.random.default_rng(3)
    speed = rng.uniform(2.5, 3.5, 2001)
    hr = rng.uniform(140.0, 170.0, 2001)
    result = decoupling(speed, hr)
    first = result.first_speed_mps / result.first_hr_bpm
    second = result.second_speed_mps / result.second_hr_bpm
    assert result.pct == pytest.approx(100.0 * (first - second) / first, rel=1e-12)
    assert result.first_speed_mps == pytest.approx(float(np.mean(speed[:1000])), rel=1e-12)
    assert result.second_speed_mps == pytest.approx(float(np.mean(speed[1000:])), rel=1e-12)


def test_the_halves_are_halves_of_the_seconds_carrying_heart_rate() -> None:
    """A run whose heart rate starts late is split later than its midpoint in
    time, because only seconds with both channels are compared."""
    speed = np.full(2000, 3.0)
    speed[1000:] = 2.0
    hr = np.full(2000, 150.0)
    hr[:400] = np.nan
    result = decoupling(speed, hr)
    # 1600 usable seconds, so the first half is seconds 400 to 1199:
    # 600 of them at 3.0 m/s and 200 at 2.0 m/s.
    assert result.first_speed_mps == pytest.approx((600 * 3.0 + 200 * 2.0) / 800)
    assert result.second_speed_mps == pytest.approx(2.0)


def _sample(
    activity_id: str,
    mean_speed: float,
    hr_slope: float,
    hr_level: float,
    years: float = 0.0,
    n: int = 2400,
    spread: float = 0.30,
    seed: int = 1,
    moving_speed_mps: float | None = None,
) -> ActivitySample:
    rng = np.random.default_rng(seed)
    speed = mean_speed + spread * np.sin(np.linspace(0.0, 14.0, n))
    hr = hr_slope * speed + hr_level + rng.normal(0.0, 0.5, size=n)
    cadence = 18.0 * speed + 110.0 + rng.normal(0.0, 0.3, size=n)
    return ActivitySample(
        activity_id=activity_id,
        effort_tag="easy",
        speed=speed,
        hr=hr,
        cadence=cadence,
        years=years,
        moving_speed_mps=moving_speed_mps,
    )


def test_the_shared_slope_recovers_a_known_between_activity_relation() -> None:
    """Activities at different mean speeds, all with the same true relation.

    The shared slope is fitted between activities, one point each, which is
    where the leverage is: run-median speed spans far more than speed inside
    any single run.
    """
    samples = [
        _sample(f"a{i}", mean_speed=2.4 + 0.1 * i, hr_slope=10.0, hr_level=120.0, seed=i)
        for i in range(12)
    ]
    assert abs(shared_slope(samples, "hr") - 10.0) < 1.0


def test_the_shared_slope_is_not_confounded_by_a_fitness_trend() -> None:
    """Heart rate falling over the years must not be absorbed into the speed
    coefficient. The fit carries a time term precisely so it is not.

    The athlete here gets faster as the years pass, so date and speed are
    correlated but not collinear: perfectly collinear columns would leave the
    two effects unidentifiable for any estimator. Heart rate at a fixed pace
    falls 5 bpm a year, and a fit without the time term hands most of that
    fall to the speed coefficient instead.
    """
    years = [i / 4.0 + 0.6 * ((i % 3) - 1) for i in range(12)]
    samples = [
        _sample(
            f"a{i}",
            mean_speed=2.4 + 0.1 * i,
            hr_slope=10.0,
            hr_level=120.0 - 5.0 * years[i],
            years=years[i],
            seed=i,
        )
        for i in range(12)
    ]
    speeds = np.array([np.median(sample.speed) for sample in samples])
    heart_rates = np.array([np.median(sample.hr) for sample in samples])
    without_time_term, _ = fit_slope(speeds, heart_rates)
    assert abs(without_time_term - 10.0) > 3.0
    assert abs(shared_slope(samples, "hr") - 10.0) < 1.5


def test_efficiency_rows_produce_one_row_per_eligible_activity() -> None:
    samples = [_sample(f"a{i}", 2.5 + 0.1 * i, 10.0, 120.0, seed=i) for i in range(8)]
    rows, shared = efficiency_rows(samples)
    assert len(rows) == 8
    assert set(rows["activity_id"]) == {f"a{i}" for i in range(8)}
    assert "hr_slope_shared_bpm_per_mps" in shared


def test_the_three_reference_values_are_not_parallel_across_activities() -> None:
    """The property the estimator change exists to deliver.

    Under one shared slope the gap between the slow and fast columns would be
    an identical constant for every activity, making the three series exact
    vertical translations of each other and the extra two columns pointless.
    Under shrinkage the gap varies run to run.
    """
    samples = [
        _sample("wide", 2.8, hr_slope=18.0, hr_level=100.0, spread=0.9, seed=1),
        _sample("narrow", 2.8, hr_slope=4.0, hr_level=140.0, spread=0.8, seed=2),
    ] + [_sample(f"f{i}", 2.4 + 0.12 * i, 10.0, 120.0, spread=0.6, seed=10 + i) for i in range(10)]
    rows, _ = efficiency_rows(samples)
    gaps = rows["hr_at_fast_bpm"] - rows["hr_at_slow_bpm"]
    assert gaps.std() > 0.05


def test_an_intervals_session_is_excluded_from_the_fit() -> None:
    samples = [_sample(f"a{i}", 2.5 + 0.1 * i, 10.0, 120.0, seed=i) for i in range(8)]
    reps = _sample("reps", 3.2, 10.0, 120.0, seed=99)
    samples.append(ActivitySample("reps", "intervals", reps.speed, reps.hr, reps.cadence, 0.0))
    rows, _ = efficiency_rows(samples)
    assert "reps" not in set(rows["activity_id"])


def test_a_run_too_short_to_fit_produces_no_row() -> None:
    samples = [_sample(f"a{i}", 2.5 + 0.1 * i, 10.0, 120.0, seed=i) for i in range(8)]
    short = _sample("short", 2.9, 10.0, 120.0, n=120, seed=50)
    samples.append(short)
    rows, _ = efficiency_rows(samples)
    assert "short" not in set(rows["activity_id"])


def test_a_run_without_heart_rate_keeps_its_cadence_and_nulls_every_hr_column() -> None:
    """The one hr column group that must be null is the *whole* group.

    Writing the shared slope with weight 0 for a run that had no heart rate
    at all would make it indistinguishable from a run held at one pace, which
    genuinely takes the shared slope. The run still counts: it has speed and
    cadence, so it sets the reference paces and enters the cadence fit.
    """
    samples = [_sample(f"a{i}", 2.5 + 0.1 * i, 10.0, 120.0, seed=i) for i in range(8)]
    strapless = _sample("strapless", 2.9, 10.0, 120.0, seed=77)
    samples.append(
        ActivitySample(
            "strapless",
            None,
            strapless.speed,
            np.full(strapless.speed.size, np.nan),
            strapless.cadence,
            0.0,
        )
    )
    rows, shared = efficiency_rows(samples)
    row = rows.set_index("activity_id").loc["strapless"]
    assert shared["activities_in_fit"] == 9.0
    for reference in ("slow", "median", "fast"):
        assert np.isfinite(row[f"cadence_at_{reference}_spm"])
    assert np.isfinite(row["cadence_slope_shrunk_spm_per_mps"])
    hr_columns = [column for column in rows.columns if column.startswith("hr_")]
    assert len(hr_columns) == 7
    assert row[hr_columns].isna().all()
    assert np.isnan(row["decoupling_pct"])


def test_a_run_held_at_one_pace_takes_the_shared_slope_but_keeps_its_level() -> None:
    """Distinct from having no data: speed never varied, so the run has no
    slope of its own, but its heart rate is real and its level at the shared
    slope is defined, so the at-reference columns are filled."""
    samples = [_sample(f"a{i}", 2.5 + 0.1 * i, 10.0, 120.0, seed=i) for i in range(8)]
    n = 2400
    flat = ActivitySample(
        "flat", "easy", np.full(n, 2.8), np.full(n, 150.0), np.full(n, 160.0), 0.0
    )
    samples.append(flat)
    rows, shared = efficiency_rows(samples)
    row = rows.set_index("activity_id").loc["flat"]
    assert np.isnan(row["hr_slope_own_bpm_per_mps"])
    assert row["hr_slope_se_bpm_per_mps"] is None or np.isnan(row["hr_slope_se_bpm_per_mps"])
    assert row["hr_slope_weight"] == 0.0
    assert row["hr_slope_shrunk_bpm_per_mps"] == shared["hr_slope_shared_bpm_per_mps"]
    expected_level = 150.0 - shared["hr_slope_shared_bpm_per_mps"] * 2.8
    assert (
        abs(
            row["hr_at_median_bpm"]
            - (expected_level + shared["hr_slope_shared_bpm_per_mps"] * shared["ref_median_mps"])
        )
        < 1e-9
    )


def test_weight_is_null_when_too_few_activities_carry_a_channel() -> None:
    """Weight 0 means the run took the shared slope entirely.

    With only two heart rate runs there is no shared slope to take, so the
    weight must be null rather than a zero that claims something the row
    cannot satisfy. Cadence, present on every run, still gets a full fit.
    """
    samples = [_sample(f"a{i}", 2.5 + 0.1 * i, 10.0, 120.0, seed=i) for i in range(8)]
    for sample in samples[2:]:
        sample.hr[:] = np.nan
    rows, shared = efficiency_rows(samples)
    assert len(rows) == 8
    assert np.isnan(shared["hr_slope_shared_bpm_per_mps"])
    assert rows["hr_slope_weight"].isna().all()
    assert rows["hr_slope_shrunk_bpm_per_mps"].isna().all()
    assert rows["hr_slope_own_bpm_per_mps"].notna().sum() == 2
    assert rows["cadence_slope_weight"].notna().all()


def _runs() -> list[ActivitySample]:
    """Four ordinary runs, spread in speed so the reference quartiles vary."""
    return [_sample(f"a{i}", 2.5 + 0.1 * i, 10.0, 120.0, seed=i) for i in range(4)]


def _walk(moving_speed_mps: float | None = 1.3) -> ActivitySample:
    """A walk whose usable seconds look like slow running.

    Its own seconds are all above `MIN_FIT_SPEED_MPS`, so the per-second
    filter cannot see it and only the whole-activity moving speed can. That
    is the shape a walk with a few brisk stretches has.
    """
    return _sample("walk", 1.6, 10.0, 120.0, seed=9, moving_speed_mps=moving_speed_mps)


def test_a_walk_leaves_the_fit_entirely() -> None:
    # 8:00/km is 2.0833 m/s, and the walker is slower than that over the
    # whole activity even though every second it recorded is faster.
    rows, _ = efficiency_rows([*_runs(), _walk()])

    assert set(rows["activity_id"]) == {"a0", "a1", "a2", "a3"}


def test_an_activity_with_no_moving_speed_stays_in_the_fit() -> None:
    # Null means not known, and the fit's own eligibility rules already
    # decide the rest. Dropping it would silently shrink the population on a
    # store whose moving time had not been computed.
    rows, _ = efficiency_rows([*_runs(), _walk(moving_speed_mps=None)])

    assert "walk" in set(rows["activity_id"])


def test_the_walk_does_not_set_a_reference_pace() -> None:
    # The references are quartiles over the population that enters the fit,
    # so a walk left in the population drags the slow reference down.
    _, with_walk = efficiency_rows([*_runs(), _walk()])
    _, without = efficiency_rows(_runs())

    assert with_walk["ref_slow_mps"] == without["ref_slow_mps"]


def test_the_walk_would_have_moved_the_reference_had_it_stayed() -> None:
    """The guard above only means something if the walk could have moved it.

    Without this, a walk whose seconds happened to look like every other run
    would pass that test while the rule did nothing at all.
    """
    _, with_walk = efficiency_rows([*_runs(), _walk(moving_speed_mps=None)])
    _, without = efficiency_rows(_runs())

    assert with_walk["ref_slow_mps"] < without["ref_slow_mps"]


def _fitted_rows(
    values: list[float], tags: list[str | None], fit_seconds: list[int]
) -> pd.DataFrame:
    """The shape ``efficiency_rows`` returns, with one value on every channel.

    One number per row across all seven smoothed inputs, because what is under
    test is the windowing rather than the arithmetic of any one channel.
    """
    return pd.DataFrame(
        {
            "activity_id": [f"a{i}" for i in range(len(values))],
            "effort_tag": tags,
            "fit_seconds": fit_seconds,
            "hr_at_slow_bpm": values,
            "hr_at_median_bpm": values,
            "hr_at_fast_bpm": values,
            "cadence_at_slow_spm": values,
            "cadence_at_median_spm": values,
            "cadence_at_fast_spm": values,
            "decoupling_pct": values,
        }
    )


def test_the_reference_paces_are_smoothed_on_a_42_day_window() -> None:
    # Two runs a week apart, so both are inside 42 days and the second's
    # smoothed value is the mean of the two.
    when = pd.Series(pd.to_datetime(["2025-01-01", "2025-01-08"], utc=True))
    rows = _fitted_rows([150.0, 160.0], ["steady", "steady"], [3000, 3000])

    out = smooth_efficiency(rows, when)

    assert out["hr_at_median_smoothed_bpm"].tolist() == [150.0, 155.0]
    assert out["cadence_at_fast_smoothed_spm"].tolist() == [150.0, 155.0]


def test_a_run_outside_the_42_day_window_does_not_pull_the_mean() -> None:
    when = pd.Series(pd.to_datetime(["2025-01-01", "2025-06-01"], utc=True))
    rows = _fitted_rows([150.0, 160.0], ["steady", "steady"], [3000, 3000])

    out = smooth_efficiency(rows, when)

    assert out["hr_at_median_smoothed_bpm"].tolist() == [150.0, 160.0]


def test_the_raw_columns_survive_the_smoothing() -> None:
    # The smoothed series is an addition, not a replacement: the per-activity
    # value is what the activity view reads.
    when = pd.Series(pd.to_datetime(["2025-01-01", "2025-01-08"], utc=True))
    rows = _fitted_rows([150.0, 160.0], ["steady", "steady"], [3000, 3000])

    out = smooth_efficiency(rows, when)

    assert out["hr_at_median_bpm"].tolist() == [150.0, 160.0]
    assert out["decoupling_pct"].tolist() == [150.0, 160.0]


def test_only_long_aerobic_runs_are_marked_and_smoothed_for_decoupling() -> None:
    # The population is the classifier's easy and steady tags at
    # MIN_AEROBIC_LONG_RUN_SECONDS or more of fitted seconds. An all-out
    # session and a short easy one are both outside it.
    when = pd.Series(pd.to_datetime(["2025-01-01", "2025-01-02", "2025-01-03"], utc=True))
    rows = _fitted_rows(
        [4.0, 20.0, 6.0],
        ["steady", "all_out", "easy"],
        [
            MIN_AEROBIC_LONG_RUN_SECONDS,
            MIN_AEROBIC_LONG_RUN_SECONDS,
            MIN_AEROBIC_LONG_RUN_SECONDS - 1,
        ],
    )

    out = smooth_efficiency(rows, when)

    assert out["is_aerobic_long_run"].tolist() == [True, False, False]
    # Only the qualifying run has a smoothed decoupling, and the all-out
    # session's 20% does not reach it.
    assert out["decoupling_smoothed_pct"].iloc[0] == 4.0
    assert pd.isna(out["decoupling_smoothed_pct"].iloc[1])
    assert pd.isna(out["decoupling_smoothed_pct"].iloc[2])


def test_an_untagged_run_is_not_assumed_aerobic() -> None:
    # 86 of the 307 real runs carry no effort tag, and a run with no heart
    # rate cannot be shown to have been easy.
    when = pd.Series(pd.to_datetime(["2025-01-01"], utc=True))
    rows = _fitted_rows([5.0], [None], [MIN_AEROBIC_LONG_RUN_SECONDS])

    out = smooth_efficiency(rows, when)

    assert out["is_aerobic_long_run"].tolist() == [False]
    assert "easy" in AEROBIC_TAGS and "steady" in AEROBIC_TAGS


def test_decoupling_is_smoothed_on_a_90_day_window() -> None:
    # Wider than the reference paces because the population is a quarter the
    # size: two qualifying runs 60 days apart still average together.
    when = pd.Series(pd.to_datetime(["2025-01-01", "2025-03-02"], utc=True))
    rows = _fitted_rows([4.0, 6.0], ["easy", "easy"], [3000, 3000])

    out = smooth_efficiency(rows, when)

    assert out["decoupling_smoothed_pct"].tolist() == [4.0, 5.0]
    # The same two runs are outside each other's reference-pace window.
    assert out["hr_at_median_smoothed_bpm"].tolist() == [4.0, 6.0]


def test_an_empty_frame_still_carries_the_new_columns() -> None:
    # recompute writes the table whether or not any activity was fitted, and
    # a missing column is a schema error rather than an empty chart.
    out = smooth_efficiency(_fitted_rows([], [], []), pd.Series(dtype="datetime64[ns, UTC]"))

    assert out.empty
    for column in (
        "hr_at_slow_smoothed_bpm",
        "cadence_at_fast_smoothed_spm",
        "is_aerobic_long_run",
        "decoupling_smoothed_pct",
    ):
        assert column in out.columns
