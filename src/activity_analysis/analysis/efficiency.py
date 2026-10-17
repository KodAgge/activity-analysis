"""Cadence and heart rate at reference paces, and aerobic decoupling.

Plotting raw cadence or raw average heart rate over time mostly measures how
fast the athlete happened to run that day. These metrics answer one
counterfactual instead: what would cadence and heart rate have been at a
fixed pace? That number is comparable between a hilly Tuesday jog and a flat
Sunday long run, so its trend is fitness rather than scheduling.

The estimator is not the per-activity fit the original design specified.
This athlete's runs are too evenly paced to fit a slope inside one: the
within-run interquartile speed range has a median of about 9% of the median
reference speed, and 44 of the 227 per-activity fits on the 2026-10-16 store
return a negative slope, meaning heart rate falling as speed rises. Instead
each activity's own slope is shrunk toward a slope shared across the
history, weighted by its own precision, so a run with wide speed variation
keeps most of its own and a run held at one pace takes the shared one. See
docs/reference/math/efficiency.md for the derivation.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np
import pandas as pd

from activity_analysis.analysis.smoothing import trailing_mean

#: Block length for the bootstrap, in seconds.
#:
#: A block has to be long enough to carry the correlation structure of the
#: series and short enough that a run yields many of them. Heart rate on a
#: 1 Hz grid decorrelates over roughly a minute, so 120 s spans it with
#: margin while still giving about 20 blocks from a 40 minute run.
BLOCK_SECONDS = 120

#: Bootstrap resamples. The quantity being estimated is a standard error
#: feeding a shrinkage weight, not a confidence interval anybody reads
#: directly, so this buys enough stability without making a recompute slow.
BOOTSTRAP_DRAWS = 120


def fit_slope(x: np.ndarray, y: np.ndarray) -> tuple[float, float]:
    """Ordinary least squares of ``y`` on ``x``, as ``(slope, intercept)``.

    Returns ``(nan, nan)`` when ``x`` does not vary. A run held at exactly one
    speed has no slope, and the least-squares solver would otherwise return a
    minimum-norm answer for a singular design, which looks like a measurement
    and is not one.
    """
    if x.size < 2:
        return (float("nan"), float("nan"))
    x_mean = float(x.mean())
    y_mean = float(y.mean())
    centred = x - x_mean
    sxx = float(centred @ centred)
    if sxx <= 0.0:
        return (float("nan"), float("nan"))
    # The closed form rather than a general solver: with one regressor the
    # two are the same answer, and the bootstrap below calls this tens of
    # thousands of times per recompute.
    slope = float(centred @ (y - y_mean)) / sxx
    return (slope, y_mean - slope * x_mean)


def naive_se(x: np.ndarray, y: np.ndarray) -> float:
    """The ordinary least-squares standard error of the slope.

    **Not used by the estimator**, and present so the derivation document and
    its test can show how far wrong it is. It assumes independent
    observations, and consecutive seconds on a 1 Hz grid are anything but:
    measured over the 227 runs the real store fits on 2026-10-16, it comes
    out 8.2 times too small for heart rate and 8.3 times for cadence.
    """
    slope, intercept = fit_slope(x, y)
    if not np.isfinite(slope):
        return float("inf")
    residual = y - (slope * x + intercept)
    dof = x.size - 2
    if dof <= 0:
        return float("inf")
    variance = float(residual @ residual) / dof
    centred = x - x.mean()
    sxx = float(centred @ centred)
    return float(np.sqrt(variance / sxx))


def block_bootstrap_se(x: np.ndarray, y: np.ndarray, *, seed: int) -> float:
    """Standard error of the slope under a moving-block bootstrap.

    Resampling individual seconds would destroy exactly the structure that
    makes the naive error wrong. Resampling contiguous blocks preserves the
    within-block correlation, so the spread of the resampled slopes reflects
    how much independent information the series actually carries.

    ``inf`` for a series shorter than one block: that is not a fit whose
    error can be estimated, and infinity is the honest answer because it
    drives the shrinkage weight to zero and the activity takes the shared
    slope.
    """
    n = x.size
    if n < BLOCK_SECONDS or not np.isfinite(fit_slope(x, y)[0]):
        return float("inf")

    blocks = max(1, n // BLOCK_SECONDS)
    highest_start = n - BLOCK_SECONDS
    rng = np.random.default_rng(seed)
    slopes: list[float] = []
    for _ in range(BOOTSTRAP_DRAWS):
        starts = rng.integers(0, highest_start + 1, size=blocks)
        index = (starts[:, None] + np.arange(BLOCK_SECONDS)).ravel()
        slope, _ = fit_slope(x[index], y[index])
        if np.isfinite(slope):
            slopes.append(slope)
    if len(slopes) < 2:
        return float("inf")
    return float(np.std(slopes, ddof=1))


@dataclass(frozen=True)
class ReferencePaces:
    """The three speeds every efficiency metric is reported at, in m/s.

    Derived from the athlete's own distribution rather than fixed, because a
    fixed reference is only useful if the athlete runs at it. The original
    design specified 5:00/km, and measured against the real store on
    2026-10-16 only 35 of 335 runs have an interquartile speed band
    containing it, so it was an extrapolation for the other 300.
    """

    slow: float
    median: float
    fast: float


def reference_paces(per_activity_median_speed: np.ndarray) -> ReferencePaces:
    """The 25th, 50th and 75th percentile of per-activity median speed.

    Each activity contributes one value, so a three-hour long run does not
    outweigh a half-hour easy run in setting the reference. A median over all
    seconds pooled would weight by duration for no stated reason.

    The population is the activities that feed the fit, not every run: a
    treadmill's footpod speed is excluded from the fit for not being
    comparable, so it should not set the paces the fit is read at either.
    Measured over the 227 eligible runs in the real store on 2026-10-16,
    this puts the slow reference 4.6% below the median and the fast one 4.5%
    above it; over all 335 runs, the original definition,
    they sit 5.1% below and 5.4% above. The band is narrow because this
    athlete's sessions are evenly paced, so these are three paces actually
    run rather than three spread far enough apart to be mostly extrapolated.
    """
    finite = per_activity_median_speed[np.isfinite(per_activity_median_speed)]
    if finite.size == 0:
        return ReferencePaces(float("nan"), float("nan"), float("nan"))
    return ReferencePaces(
        slow=float(np.percentile(finite, 25)),
        median=float(np.percentile(finite, 50)),
        fast=float(np.percentile(finite, 75)),
    )


def between_activity_tau(slopes: np.ndarray, errors: np.ndarray) -> float:
    """The standard deviation of *true* between-activity slopes.

    The spread observed across activities is the real spread plus estimation
    noise, so the real one is what remains after the average squared error is
    subtracted:

        tau^2 = var(observed) - mean(se^2)

    Floored at zero, which is the correct degenerate case: if the observed
    variation is no larger than the errors explain, there is no real
    between-activity variation, every weight becomes zero, and the estimator
    reduces to a single shared slope for the whole history.

    Activities with a non-finite slope or error are excluded, since neither
    term can be formed for them.
    """
    usable = np.isfinite(slopes) & np.isfinite(errors)
    if usable.sum() < 2:
        return 0.0
    observed_variance = float(np.var(slopes[usable], ddof=1))
    mean_error_variance = float(np.mean(errors[usable] ** 2))
    return float(np.sqrt(max(0.0, observed_variance - mean_error_variance)))


def shrink(own: float, error: float, shared: float, tau: float) -> tuple[float, float]:
    """Pull an activity's own slope toward the shared one by its precision.

    Returns ``(shrunk_slope, weight)`` where::

        weight = tau^2 / (tau^2 + error^2)
        shrunk = weight * own + (1 - weight) * shared

    The weight is the fraction of this activity's apparent deviation from the
    shared slope that is credible rather than noise. A run with a wide speed
    range has a small error, a weight near 1, and keeps its own slope. A run
    held at one pace has a huge error, a weight near 0, and takes the shared
    slope. The plain pooled estimator is the special case where every weight
    is zero.
    """
    if not np.isfinite(shared):
        return (float("nan"), 0.0)
    if not np.isfinite(own) or not np.isfinite(error) or tau <= 0.0:
        return (shared, 0.0)
    weight = (tau * tau) / (tau * tau + error * error)
    return (weight * own + (1.0 - weight) * shared, float(weight))


#: Below this many usable seconds a run has no two halves worth comparing.
MIN_DECOUPLING_SECONDS = 600


@dataclass(frozen=True)
class Decoupling:
    """A run's decoupling and the four means it is computed from.

    All five are NaN together when the run has no two halves worth comparing,
    so a reader is never shown halves that do not reproduce the percentage.
    """

    pct: float
    first_speed_mps: float
    second_speed_mps: float
    first_hr_bpm: float
    second_hr_bpm: float


_NO_DECOUPLING = Decoupling(*([float("nan")] * 5))


def decoupling(speed: np.ndarray, hr: np.ndarray) -> Decoupling:
    """Percentage loss of efficiency from the first half to the second.

    Efficiency is speed per heartbeat, ``speed / hr``. Decoupling compares the
    two halves of one run::

        decoupling = 100 * (ef_first - ef_second) / ef_first

    Positive means the second half cost more heart rate for the same speed,
    which is the usual direction and is the standard measure of endurance
    durability.

    Comparing a run against itself is what makes this the one trend metric
    that is nearly insensitive to terrain: both halves were run by the same
    athlete on the same day, so a hilly course inflates both sides.

    This is also why the cardiac drift that makes a within-run ``hr ~ speed``
    fit unusable is not removed anywhere in this module. That drift is the
    signal here. Cleaning it out of one metric while reporting it as another
    would be incoherent.

    The four means are returned beside the percentage because the
    percentage alone cannot say which of pace and heart rate moved: it rises
    when heart rate climbs and also when pace drops. They are halves of the
    seconds carrying both channels, not of elapsed time.
    """
    usable = np.isfinite(speed) & np.isfinite(hr) & (hr > 0)
    v = speed[usable]
    beats = hr[usable]
    if v.size < MIN_DECOUPLING_SECONDS:
        return _NO_DECOUPLING
    half = v.size // 2
    first_speed = float(np.mean(v[:half]))
    second_speed = float(np.mean(v[half:]))
    first_hr = float(np.mean(beats[:half]))
    second_hr = float(np.mean(beats[half:]))
    first = first_speed / first_hr
    second = second_speed / second_hr
    if first <= 0:
        return _NO_DECOUPLING
    return Decoupling(
        pct=100.0 * (first - second) / first,
        first_speed_mps=first_speed,
        second_speed_mps=second_speed,
        first_hr_bpm=first_hr,
        second_hr_bpm=second_hr,
    )


#: A fit needs enough seconds to mean anything. Ten minutes is the same
#: order as Garmin's own qualifying rule for a VO2max estimate.
MIN_FIT_SECONDS = 600

#: Below this the athlete is walking or the sensor is drifting, and neither
#: belongs in a running efficiency fit.
MIN_FIT_SPEED_MPS = 1.0

#: Below this the activity is a walk rather than a run, measured over the
#: whole activity rather than second by second.
#:
#: `MIN_FIT_SPEED_MPS` already drops the walking *seconds* inside a run, and
#: this drops the walking *activity*: a walk has no business setting the
#: reference paces, which are quartiles over the population that enters the
#: fit, nor contributing a slope to the shared fit. 2.0833 m/s is 8:00 per
#: kilometre. On the 2026-10-16 store it excludes nothing: since
#: `ANALYSIS_VERSION` 13 the 9:00/km reclassification counts a walk before
#: the fit sees it. The rule stays for the band between 8:00 and 9:00/km,
#: which the reclassification leaves to running and this fit does not. See
#: docs/reference/math/efficiency.md, which owns the measurement.
#:
#: Moving speed rather than elapsed, because elapsed keeps the stopped
#: seconds and a run with a long stop in it would read as a walk.
#:
#: **Moving time excludes stopped seconds but not outage seconds, and that
#: limit is real.** An outage is a gap over 120 s that is not a stop, and by
#: design its seconds stay in moving time while its metres interpolate, so a
#: run carrying a long outage across which the odometer barely advanced could
#: in principle fall under this threshold and be dropped from the fit as a
#: walk. The denominator does not handle both kinds of gap, only one.
#: Nothing in the current history is in that state: the rule excludes no
#: activity on the 2026-10-16 store. Whether any run sits near the
#: boundary under a denominator that also removed outage seconds has not been
#: measured, and changing which seconds it counts is a metric definition
#: rather than a fix, so it is not done here.
MIN_FIT_MOVING_SPEED_MPS = 1000.0 / 480.0

#: The one session type excluded. Heart rate lags speed sharply during
#: repetitions, so the relation being fitted does not hold within them.
#: `easy`, `steady` and `all_out` all feed the fit: the pilot measured the
#: spread within each tag at 79%, 69% and 82% of the spread across all tags,
#: so widening the set trades some session-type variation for a trend over
#: 227 runs rather than the 104 tagged `easy` or `steady`. See
#: docs/reference/math/efficiency.md, which owns the figures.
EXCLUDED_EFFORT_TAG = "intervals"


@dataclass(frozen=True)
class ActivitySample:
    """One activity's usable seconds, already filtered by the caller.

    The caller filters rather than this module because this module reads no
    store: ``analysis.pipeline`` knows which activities are indoors and which
    seconds are paused, and passing frames here would couple the two.
    """

    activity_id: str
    effort_tag: str | None
    speed: np.ndarray
    hr: np.ndarray
    cadence: np.ndarray
    #: Years since the first activity in the history, for the time term in
    #: the shared fit.
    years: float
    #: The activity's own moving speed, ``activity_metrics.avg_speed_mps``. None
    #: when the caller does not know it, which leaves the activity in the
    #: fit: null means not known, not slow.
    moving_speed_mps: float | None = None


def _channel(sample: ActivitySample, channel: str) -> np.ndarray:
    return sample.hr if channel == "hr" else sample.cadence


def _eligible(sample: ActivitySample) -> bool:
    if sample.effort_tag == EXCLUDED_EFFORT_TAG:
        return False
    if sample.moving_speed_mps is not None and sample.moving_speed_mps < MIN_FIT_MOVING_SPEED_MPS:
        return False
    usable = np.isfinite(sample.speed) & (sample.speed > MIN_FIT_SPEED_MPS)
    return bool(usable.sum() >= MIN_FIT_SECONDS)


def shared_slope(samples: Sequence[ActivitySample], channel: str) -> float:
    """One slope for the whole history, fitted *between* activities.

    Each activity contributes one point: its median usable speed against its
    median value on the channel. That is where the leverage is. From the
    10th to the 90th percentile of the real history run-median speed spans
    1.9 times the interquartile range inside a typical run, so the
    between-activity fit has nearly twice the spread of speed a within-run
    fit does.

    A time term is carried so that the athlete getting fitter is not absorbed
    into the speed coefficient. On the 2026-10-16 store run-median speed and
    date correlate at r = +0.14 while heart rate at fixed pace falls with
    time, so a fit without the term credits part of the later runs' lower
    heart rate to their higher speed: the heart rate slope without it comes
    out 0.61 times this one, and the within-run pooled fit, which has no
    time term either, 0.58 times. See docs/reference/math/efficiency.md,
    which owns these figures.
    """
    speeds: list[float] = []
    values: list[float] = []
    years: list[float] = []
    for sample in samples:
        if not _eligible(sample):
            continue
        channel_values = _channel(sample, channel)
        usable = (
            np.isfinite(sample.speed)
            & (sample.speed > MIN_FIT_SPEED_MPS)
            & np.isfinite(channel_values)
        )
        if usable.sum() < MIN_FIT_SECONDS:
            continue
        speeds.append(float(np.median(sample.speed[usable])))
        values.append(float(np.median(channel_values[usable])))
        years.append(sample.years)
    if len(speeds) < 3:
        return float("nan")
    design = np.column_stack([np.array(speeds), np.array(years), np.ones(len(speeds))])
    coefficients, *_ = np.linalg.lstsq(design, np.array(values), rcond=None)
    return float(coefficients[0])


@dataclass(frozen=True)
class _ChannelFit:
    """One channel's own fit inside one activity, before shrinkage."""

    own: float
    se: float
    mean_x: float
    mean_y: float


#: What a channel with too few finite seconds contributes: no slope, no
#: level, and an infinite error so it drops out of ``tau``. Every column of
#: that channel is written null, which is distinct from a run whose speed
#: did not vary: that one has a level and takes the shared slope at weight 0.
_UNFITTABLE = _ChannelFit(float("nan"), float("inf"), float("nan"), float("nan"))


@dataclass(frozen=True)
class _ActivityFit:
    activity_id: str
    effort_tag: str | None
    fit_seconds: int
    decoupling: Decoupling
    hr: _ChannelFit
    cadence: _ChannelFit

    def channel(self, prefix: str) -> _ChannelFit:
        return self.hr if prefix == "hr" else self.cadence


def _fit_channel(speed: np.ndarray, values: np.ndarray, *, seed: int) -> _ChannelFit:
    finite = np.isfinite(values)
    x, y = speed[finite], values[finite]
    if x.size < MIN_FIT_SECONDS:
        return _UNFITTABLE
    own, _ = fit_slope(x, y)
    return _ChannelFit(
        own=own,
        se=block_bootstrap_se(x, y, seed=seed),
        mean_x=float(np.mean(x)),
        mean_y=float(np.mean(y)),
    )


def efficiency_rows(
    samples: Sequence[ActivitySample], *, seed: int = 0
) -> tuple[pd.DataFrame, dict[str, float]]:
    """Every per-activity efficiency row, plus the whole-history quantities.

    Two passes, and they cannot be merged. The first needs every activity to
    exist before the shared slopes and ``tau`` can be formed; the second needs
    those values to shrink each activity's own slope. The return is the rows
    and a dictionary matching ``ATHLETE_FIT_SCHEMA``'s columns.
    """
    eligible = [sample for sample in samples if _eligible(sample)]

    fits: list[_ActivityFit] = []
    median_speeds: list[float] = []
    for sample in eligible:
        usable = np.isfinite(sample.speed) & (sample.speed > MIN_FIT_SPEED_MPS)
        speed = sample.speed[usable]
        median_speeds.append(float(np.median(speed)))
        fits.append(
            _ActivityFit(
                activity_id=sample.activity_id,
                effort_tag=sample.effort_tag,
                fit_seconds=int(speed.size),
                decoupling=decoupling(speed, sample.hr[usable]),
                hr=_fit_channel(speed, sample.hr[usable], seed=seed),
                cadence=_fit_channel(speed, sample.cadence[usable], seed=seed),
            )
        )

    refs = reference_paces(np.array(median_speeds))
    shared = {
        "hr": shared_slope(eligible, "hr"),
        "cadence": shared_slope(eligible, "cadence"),
    }
    tau = {
        prefix: between_activity_tau(
            np.array([fit.channel(prefix).own for fit in fits]),
            np.array([fit.channel(prefix).se for fit in fits]),
        )
        for prefix in ("hr", "cadence")
    }

    out: list[dict[str, object]] = []
    for fit in fits:
        built: dict[str, object] = {
            "activity_id": fit.activity_id,
            "effort_tag": fit.effort_tag,
            "decoupling_pct": fit.decoupling.pct,
            "decoupling_first_speed_mps": fit.decoupling.first_speed_mps,
            "decoupling_second_speed_mps": fit.decoupling.second_speed_mps,
            "decoupling_first_hr_bpm": fit.decoupling.first_hr_bpm,
            "decoupling_second_hr_bpm": fit.decoupling.second_hr_bpm,
            "fit_seconds": fit.fit_seconds,
        }
        for prefix, unit, reported, suffix in (
            ("hr", "bpm_per_mps", "hr_at", "bpm"),
            ("cadence", "spm_per_mps", "cadence_at", "spm"),
        ):
            own_fit = fit.channel(prefix)
            if np.isfinite(own_fit.mean_x) and np.isfinite(shared[prefix]):
                shrunk, weight = shrink(own_fit.own, own_fit.se, shared[prefix], tau[prefix])
            else:
                shrunk, weight = (float("nan"), float("nan"))
            built[f"{prefix}_slope_own_{unit}"] = own_fit.own
            built[f"{prefix}_slope_se_{unit}"] = own_fit.se if np.isfinite(own_fit.se) else None
            built[f"{prefix}_slope_weight"] = weight
            built[f"{prefix}_slope_shrunk_{unit}"] = shrunk
            # The level is refitted holding the slope at its shrunk value:
            # for a fixed slope the least-squares intercept is mean(y) minus
            # slope times mean(x). Keeping the activity's own OLS intercept
            # instead would pair a shrunk slope with an unshrunk level and
            # the pair would no longer pass through the activity's own data.
            level = (
                own_fit.mean_y - shrunk * own_fit.mean_x if np.isfinite(shrunk) else float("nan")
            )
            for name, reference in (
                ("slow", refs.slow),
                ("median", refs.median),
                ("fast", refs.fast),
            ):
                built[f"{reported}_{name}_{suffix}"] = (
                    level + shrunk * reference if np.isfinite(level) else float("nan")
                )
        out.append(built)

    whole_history = {
        "ref_slow_mps": refs.slow,
        "ref_median_mps": refs.median,
        "ref_fast_mps": refs.fast,
        "hr_slope_shared_bpm_per_mps": shared["hr"],
        "hr_slope_tau": tau["hr"],
        "cadence_slope_shared_spm_per_mps": shared["cadence"],
        "cadence_slope_tau": tau["cadence"],
        "activities_in_fit": float(len(out)),
    }
    return (pd.DataFrame(out), whole_history)


#: The reference-pace series are smoothed over this window.
#:
#: Measured on 2026-10-16 over the 227 activities in the fit: raw, the
#: median heart rate step from one run to the next is 3.4 times the gap
#: between the fast and slow series on the same run, so the noise is over
#: three times the signal and the three lines are unreadable. At 42 days the
#: smoothed gap is 3.44 times the smoothed step. 42 days is also the window
#: the VO2max series and the consistency metrics already use. The full table is the smoothed-series
#: section of docs/reference/math/efficiency.md, which owns these figures.
REFERENCE_SMOOTHING_WINDOW_DAYS = 42

#: Decoupling is smoothed over a wider window because its population is a
#: fifth the size: 46 runs against 227, so at 90 days the median window
#: holds 7 of them and the largest gap is 74 days.
DECOUPLING_SMOOTHING_WINDOW_DAYS = 90

#: Decoupling is only interpretable on long aerobic efforts. Across every
#: session it measures the shape of the session rather than the athlete:
#: measured 2026-10-16, all-out 10.37%, steady 8.00% and easy 8.70%, under
#: two points apart against an interquartile range over nine points wide.
#: Restricted to this population it reads 7.65%, and to runs of 60 fitted
#: minutes or more 6.33%, so the median falls toward the conventional 5%
#: durability line as the population narrows to the efforts the metric is
#: defined on.
AEROBIC_TAGS = frozenset({"easy", "steady"})

#: Forty minutes of fitted seconds. A run the classifier could not tag is
#: outside the population rather than assumed aerobic, because a run with no
#: heart rate cannot be shown to have been easy.
MIN_AEROBIC_LONG_RUN_SECONDS = 2400

#: Each raw reference-pace column and the smoothed column it feeds.
_REFERENCE_COLUMNS = (
    ("hr_at_slow_bpm", "hr_at_slow_smoothed_bpm"),
    ("hr_at_median_bpm", "hr_at_median_smoothed_bpm"),
    ("hr_at_fast_bpm", "hr_at_fast_smoothed_bpm"),
    ("cadence_at_slow_spm", "cadence_at_slow_smoothed_spm"),
    ("cadence_at_median_spm", "cadence_at_median_smoothed_spm"),
    ("cadence_at_fast_spm", "cadence_at_fast_smoothed_spm"),
)


def smooth_efficiency(rows: pd.DataFrame, when: pd.Series) -> pd.DataFrame:
    """Add the smoothed columns to ``rows``, which must be in time order.

    Separate from ``efficiency_rows`` because that function takes samples
    carrying ``years`` rather than instants, and a trailing calendar window
    needs real dates. The caller has them, so it passes them here rather than
    this module reaching for a store it deliberately never reads.

    The raw columns are left exactly as they were. The smoothed series is what
    a trend is read from; the raw value is what one activity actually fitted,
    and the activity view shows that.
    """
    out = rows.copy()
    if out.empty:
        for _, smoothed in _REFERENCE_COLUMNS:
            out[smoothed] = pd.Series(dtype=float)
        out["is_aerobic_long_run"] = pd.Series(dtype=bool)
        out["decoupling_smoothed_pct"] = pd.Series(dtype=float)
        return out

    for raw, smoothed in _REFERENCE_COLUMNS:
        out[smoothed] = trailing_mean(when, out[raw], window_days=REFERENCE_SMOOTHING_WINDOW_DAYS)

    aerobic = out["effort_tag"].isin(AEROBIC_TAGS) & (
        out["fit_seconds"] >= MIN_AEROBIC_LONG_RUN_SECONDS
    )
    out["is_aerobic_long_run"] = aerobic.fillna(False).astype(bool)
    # Masked on both sides of the window. Nulling the input keeps a session
    # type the metric does not hold for out of every mean; nulling the output
    # keeps the series from repeating that mean at each non-qualifying run,
    # which would draw a flat run of points no activity actually measured.
    qualifying = out["decoupling_pct"].where(out["is_aerobic_long_run"])
    windowed = trailing_mean(when, qualifying, window_days=DECOUPLING_SMOOTHING_WINDOW_DAYS)
    out["decoupling_smoothed_pct"] = windowed.where(out["is_aerobic_long_run"])
    return out
