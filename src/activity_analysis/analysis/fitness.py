"""VO2max estimates and race predictions.

Two independent estimates of the same quantity are computed, because they
answer different questions and disagree widely on this athlete:
measured over the real store, the smoothed heart-rate series sits at a median
1.62 times VDOT, with a standard deviation of 0.08 in that ratio, and the two
correlate at r = 0.47.

**Performance based (VDOT).** Daniels and Gilbert observed that race times
across distances are predicted jointly by maximal oxygen uptake and running
economy, and collapsed both into one number: the VO2max a runner of *average
economy* would need in order to run the times actually run. It is therefore
an inversion of performance rather than a measurement, which is why it is the
natural input to race prediction, and why an effort only estimates fitness if
it was run near maximally. A 5 km window inside an easy jog returns a 13.

**Heart rate based.** Oxygen cost estimated from speed, scaled by how hard
the heart was working. This is the family Garmin uses. It works on any
qualifying run rather than only on days the athlete ran hard, which is what
makes a smoothed series meaningful, and it is the headline number here.

Neither has ground truth in this project. See docs/reference/math/vo2max.md
for every constant's source, for the regression inversion this rests on and
the bias that carries, and for why the reported level is a model output while
only the trend is defensible.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date
from typing import Any

import numpy as np
import pandas as pd

from activity_analysis.analysis.best_efforts import VDOT_DISTANCES_M, distance_trusted
from activity_analysis.analysis.smoothing import trailing_mean


def vdot(distance_m: float, elapsed_time_s: float) -> float:
    """The Daniels and Gilbert pseudo VO2max implied by one performance.

    Two empirical curves, neither derived from physiology::

        v    = distance / time                        m/min
        VO2  = -4.60 + 0.182258 v + 0.000104 v^2      oxygen cost at v
        pct  = 0.8 + 0.1894393 exp(-0.012778 t)
                   + 0.2989558 exp(-0.1932605 t)      fraction sustainable for t
        VDOT = VO2 / pct

    The percentage curve carries the idea: a five-minute effort is run at
    about 97% of VO2max and a three-hour one at about 80%, so the same oxygen
    cost implies a very different VO2max depending on how long it was held.
    """
    if distance_m <= 0.0 or elapsed_time_s <= 0.0:
        return float("nan")
    minutes = elapsed_time_s / 60.0
    velocity = distance_m / minutes
    cost = -4.60 + 0.182258 * velocity + 0.000104 * velocity * velocity
    fraction = (
        0.8 + 0.1894393 * math.exp(-0.012778 * minutes) + 0.2989558 * math.exp(-0.1932605 * minutes)
    )
    if fraction <= 0.0:
        return float("nan")
    return cost / fraction


def time_for_vdot(distance_m: float, target_vdot: float) -> float:
    """Seconds to cover ``distance_m`` at fitness ``target_vdot``.

    ``vdot`` has no closed-form inverse, but it is strictly decreasing in time
    at a fixed distance, so a bisection converges. Sixty iterations take the
    bracket below a millisecond, which is far finer than any prediction here
    deserves to be read at.
    """
    if distance_m <= 0.0 or not math.isfinite(target_vdot) or target_vdot <= 0.0:
        return float("nan")
    low, high = 1.0, 200_000.0
    for _ in range(60):
        middle = (low + high) / 2.0
        if vdot(distance_m, middle) > target_vdot:
            low = middle
        else:
            high = middle
    return (low + high) / 2.0


#: Garmin compares internal against external workload over 20 to 30 second
#: windows. 30 s is the top of that range and divides a 1 Hz grid evenly.
SEGMENT_SECONDS = 30

#: Garmin's qualifying intensity. Below roughly this fraction of maximum the
#: heart rate to oxygen relation bends away from linear and the Swain map
#: stops holding, so a segment under it is not evidence about VO2max.
QUALIFYING_HR_FRACTION = 0.70

#: Ten minutes of qualifying data, which is Garmin's published requirement.
MIN_QUALIFYING_SEGMENTS = 20

#: A segment counts as steady below this within-segment speed standard
#: deviation. During an acceleration heart rate is still catching up to a
#: speed already reached, so the pair says nothing about aerobic capacity.
STEADY_SPEED_SD_MPS = 0.30

#: Below this the athlete is walking, and the ACSM running equation is for
#: running.
MIN_RUNNING_SPEED_MPS = 1.5

#: ACSM metabolic equation for running, level form: VO2 = 0.2 v + 3.5, with v
#: in m/min. 0.2 is the oxygen cost per metre of moving one kilogram
#: horizontally and 3.5 is resting metabolism, one MET. The full equation
#: carries a 0.9 v G vertical term; grade adjustment is shelved
#: (docs/reference/math/README.md, stage 9), and if it lands that term becomes
#: available from the same work.
_ACSM_HORIZONTAL = 0.2
_ACSM_REST = 3.5

#: The inverse of Swain et al. (1994), %HRmax = 0.64 %VO2max + 37, solved for
#: %VO2max. **Inverting a regression is not the same as fitting one in the
#: other direction**, and the bias that introduces is quantified in
#: docs/reference/math/vo2max.md. It is stated there rather than hidden here
#: because Swain's own paper exists to criticise exactly this class of error
#: in earlier work.
_SWAIN_SLOPE = 1.0 / 0.64
_SWAIN_INTERCEPT = 37.0 / 0.64

#: Below this fraction the division blows up and the linear map is far
#: outside the range it was fitted over.
_MIN_VO2_FRACTION = 0.35


def _qualifying_segments(
    speed: np.ndarray, hr: np.ndarray, max_hr_bpm: float
) -> tuple[np.ndarray, np.ndarray] | None:
    """The per-segment mean speed and heart rate of every qualifying segment.

    One gate, shared by the estimate and by the count the derived table
    stores beside it, so the two cannot disagree about which segments
    counted. ``None`` when there is no maximum heart rate to gate against or
    not even one whole segment of data.
    """
    if not math.isfinite(max_hr_bpm) or max_hr_bpm <= 0.0:
        return None
    usable = min(speed.size, hr.size)
    whole = (usable // SEGMENT_SECONDS) * SEGMENT_SECONDS
    if whole < SEGMENT_SECONDS:
        return None
    speed_blocks = speed[:whole].reshape(-1, SEGMENT_SECONDS)
    hr_blocks = hr[:whole].reshape(-1, SEGMENT_SECONDS)

    with np.errstate(invalid="ignore"):
        mean_speed = speed_blocks.mean(axis=1)
        mean_hr = hr_blocks.mean(axis=1)
        steady = speed_blocks.std(axis=1) < STEADY_SPEED_SD_MPS

    qualifying = (
        np.isfinite(mean_speed)
        & np.isfinite(mean_hr)
        & steady
        & (mean_speed > MIN_RUNNING_SPEED_MPS)
        & (mean_hr >= QUALIFYING_HR_FRACTION * max_hr_bpm)
    )
    return mean_speed[qualifying], mean_hr[qualifying]


def qualifying_segments(speed: np.ndarray, hr: np.ndarray, max_hr_bpm: float) -> int:
    """How many 30 s segments passed the gate, or 0 without a maximum heart rate.

    Stored beside the estimate so a consumer can tell one from 10 minutes of
    data from one from an hour. A count below ``MIN_QUALIFYING_SEGMENTS`` is
    a run that did not qualify, and its estimate is null.
    """
    segments = _qualifying_segments(speed, hr, max_hr_bpm)
    return 0 if segments is None else int(segments[0].size)


def hr_vo2max(speed: np.ndarray, hr: np.ndarray, max_hr_bpm: float) -> float:
    """VO2max implied by heart rate against speed, over qualifying segments.

    Returns ``nan`` for a run that does not qualify, which is the honest
    answer rather than an estimate from data the method does not apply to.
    Measured on the real store, 150 of the 225 outdoor runs qualify.

    The median over segments rather than the mean, because a single segment
    at an unusual heart rate should not carry the run.
    """
    segments = _qualifying_segments(speed, hr, max_hr_bpm)
    if segments is None:
        return float("nan")
    mean_speed, mean_hr = segments
    if mean_speed.size < MIN_QUALIFYING_SEGMENTS:
        return float("nan")

    metres_per_minute = mean_speed * 60.0
    cost = _ACSM_HORIZONTAL * metres_per_minute + _ACSM_REST
    fraction = (_SWAIN_SLOPE * (mean_hr / max_hr_bpm * 100.0) - _SWAIN_INTERCEPT) / 100.0
    estimates = cost / np.clip(fraction, _MIN_VO2_FRACTION, 1.0)
    return float(np.median(estimates))


#: The trailing window the reported series averages over.
#:
#: Measured on the real store, as a share of the median estimate, this takes
#: the median change between consecutive reported values from 8.8% to 0.7%,
#: and the 95th percentile from 29.3% to 3.5%. A rolling maximum was considered
#: and rejected: it steps by up to 32.6% when a peak ages out, which is
#: exactly the single-activity sensitivity the smoothing exists to avoid.
#:
#: A calendar window rather than a count of activities, so that a two-week
#: break shows as a gap rather than being invisibly bridged by whatever six
#: activities happened to come last. 42 days matches the window the
#: consistency metrics already use.
SMOOTHING_WINDOW_DAYS = 42


def smooth_series(when: pd.Series, value: pd.Series) -> pd.Series:
    """Trailing calendar-window mean of ``value``, indexed by ``when``.

    The window is `SMOOTHING_WINDOW_DAYS`; the mechanism is
    `analysis.smoothing.trailing_mean`, shared with the efficiency series,
    which needs the same trailing-calendar-window rule at a different width.
    """
    return trailing_mean(when, value, window_days=SMOOTHING_WINDOW_DAYS)


#: Calibration of the heart-rate VO2max onto the VDOT scale, fitted on
#: 2026-11-14 against the ``fitness_series`` this module writes, so on the
#: shipped ``hr_vo2max``. One least-squares regression of the VDOT of the
#: fastest eligible 5 km in the 42 days up to a run on that run's
#: ``hr_vo2max_smoothed``, over every run that has a smoothed estimate and at
#: least two eligible 5 km efforts in those 42 days: 188 points,
#: VDOT = 0.586 * VO2hr + 5.92, r = 0.597, residual SD 2.30 VDOT units.
#: docs/reference/math/predictions.md, "The calibration", has the selection
#: and the reproduction.
#:
#: It replaced a fit made during design on an exploratory estimator. Applied
#: to these points that fit put VDOT 1.64 units too high on average, so the
#: refit moved every ordinary-run prediction slower.
#:
#: **This is a different thing from calibrating the reported VO2max.** That
#: was considered and rejected: it would adjust a headline number using an
#: offset derived from our own two models with no external reference. This is
#: a regression of predicted performance on *observed* performance, fitted
#: against the athlete's own recorded efforts, and it reports its own
#: residual. The reported VO2max stays raw.
#:
#: The slope is not a scale factor between the two. It is r times the ratio
#: of their standard deviations, and over these points that ratio is 0.98,
#: so a slope below 1 is the scatter between the two series, not the
#: heart-rate estimate moving faster than performance.
ORDINARY_RUN_CALIBRATION_SLOPE = 0.586
ORDINARY_RUN_CALIBRATION_INTERCEPT = 5.92
ORDINARY_RUN_RESIDUAL_VDOT = 2.30


@dataclass(frozen=True)
class OrdinaryRunPrediction:
    """A race time predicted without a maximal effort, and its band.

    The band is one residual standard deviation either side, converted from
    VDOT units into times. It is wide - about 5% on a 25 minute 5 km - and
    every surface showing it must show the band too. Where a recent eligible
    best effort exists, the best-efforts series is the better prediction;
    this reads what typical training supports, so after a breakthrough
    effort it sits slower than it does.
    """

    predicted_s: float
    low_s: float
    high_s: float


def predict_from_ordinary_run(
    calibrated_vdot: float, distance_m: float
) -> OrdinaryRunPrediction | None:
    """Predict a race time from a calibrated ordinary-run VDOT.

    ``calibrated_vdot`` is the series' ``ordinary_runs_vdot``, which already
    carries the calibration of ``_prediction_vdots``; this adds the band.
    ``None`` when there is no finite VDOT to work from.

    The band is computed by inverting at ``vdot +/- residual`` rather than by
    adding seconds to the prediction, because time is a nonlinear function of
    VDOT and a symmetric band in one is asymmetric in the other. A higher
    VDOT is a lower time, so ``low_s`` comes from ``vdot + residual``.
    """
    if not math.isfinite(calibrated_vdot) or calibrated_vdot <= 0.0 or distance_m <= 0.0:
        return None
    return OrdinaryRunPrediction(
        predicted_s=time_for_vdot(distance_m, calibrated_vdot),
        low_s=time_for_vdot(distance_m, calibrated_vdot + ORDINARY_RUN_RESIDUAL_VDOT),
        high_s=time_for_vdot(distance_m, calibrated_vdot - ORDINARY_RUN_RESIDUAL_VDOT),
    )


#: How many runs the best-efforts series averages. Measured on the real store,
#: the single best run in 90 days sat 1.49 VDOT units above the best run of the
#: following four weeks on average and the mean of three 0.35, with half its
#: largest daily move; docs/reference/math/predictions.md, "What the
#: measurement showed", has the table.
PREDICTION_TOP_RUNS = 3


def _prediction_vdots(rows: pd.DataFrame, run_vdot_1k: pd.Series) -> pd.DataFrame:
    """The two smoothed prediction VDOTs on each row's local day.

    ``rows`` carries ``local_date`` and ``hr_vo2max_smoothed``; ``run_vdot_1k``
    is each row's highest VDOT over its eligible efforts of at least
    ``MIN_PREDICTION_DISTANCE_M``, NaN where it has none. Both series are
    computed per calendar day over ``PREDICTION_WINDOW_DAYS``, then averaged
    over ``SMOOTHING_WINDOW_DAYS`` days, so a day with no run still weighs in
    and a run's value is not counted again for each run that shares its week.
    The result is aligned to ``rows``' index.
    """
    dates = pd.to_datetime(rows["local_date"])
    days = pd.date_range(dates.min(), dates.max(), freq="D")
    top = run_vdot_1k.to_numpy(dtype=float)
    hr = rows["hr_vo2max_smoothed"].to_numpy(dtype=float)
    best_raw = np.full(len(days), np.nan)
    ordinary_raw = np.full(len(days), np.nan)
    for index, day in enumerate(days):
        inside = (
            (dates > day - pd.Timedelta(days=PREDICTION_WINDOW_DAYS)) & (dates <= day)
        ).to_numpy()
        values = np.sort(top[inside & np.isfinite(top)])[::-1][:PREDICTION_TOP_RUNS]
        if values.size:
            best_raw[index] = values.mean()
        usable = np.flatnonzero(inside & np.isfinite(hr))
        if usable.size:
            ordinary_raw[index] = (
                ORDINARY_RUN_CALIBRATION_SLOPE * hr[usable[-1]] + ORDINARY_RUN_CALIBRATION_INTERCEPT
            )
    when = pd.Series(days)
    per_day = pd.DataFrame(
        {
            "best_efforts_vdot": trailing_mean(
                when, pd.Series(best_raw), window_days=SMOOTHING_WINDOW_DAYS
            ).to_numpy(),
            "ordinary_runs_vdot": trailing_mean(
                when, pd.Series(ordinary_raw), window_days=SMOOTHING_WINDOW_DAYS
            ).to_numpy(),
        },
        index=days,
    )
    return per_day.reindex(dates).set_axis(rows.index)


def local_date(start: pd.Timestamp, utc_offset_s: Any) -> date:
    """The run's calendar day where it was run, as ``queries.LOCAL_DATE_SQL`` has it.

    A run with no recorded offset, which is every GPX, is read in UTC there
    too, so the two agree on which day its load falls.
    """
    offset = 0 if utc_offset_s is None or pd.isna(utc_offset_s) else int(utc_offset_s)
    return (start + pd.Timedelta(seconds=offset)).date()


def fitness_rows(
    activities: pd.DataFrame,
    efforts: pd.DataFrame,
    grids: dict[str, tuple[np.ndarray, np.ndarray]],
    max_hr_by_activity: dict[str, float],
    excluded_activity_ids: set[str],
) -> pd.DataFrame:
    """One row per activity that produced at least one VO2max estimate.

    ``grids`` maps an activity id to its ``(speed, hr)`` arrays off the 1 Hz
    grid, with the sensor channels null across pauses and outages so that a
    segment containing either fails the gate by itself. ``max_hr_by_activity``
    carries the maximum heart rate in force for each activity, ``nan`` where
    the profile has none. ``excluded_activity_ids`` are the treadmill and
    not-known-outdoors activities, and they are excluded from *both*
    estimates: their best efforts cannot count toward VDOT, and no heart-rate
    estimate is computed for them, so such an activity contributes no row.
    The caller supplies all three because this module reads no store, the
    same arrangement ``analysis.tags`` uses.

    The exclusion holds on the heart-rate side for the same reason
    ``analysis.efficiency`` excludes indoor runs: a treadmill speed comes
    from an uncalibrated footpod and is not comparable with an outdoor
    run's, and ``hr_vo2max`` turns that speed into an oxygen cost. Garmin's
    own running VO2max requires outdoor GPS on the same grounds.

    VDOT is the best among the activity's *eligible* efforts at one of
    ``VDOT_DISTANCES_M``, the nine the project started with, rather than at
    every distance the extractor knows. The candidate set is a modelling
    choice here and a display choice in the records ladder, so the two are
    separate constants; see ``VDOT_DISTANCES_M``. Ineligible efforts
    are dropped rather than compared: a treadmill distance comes from an
    uncalibrated footpod and a jumped effort was credited metres nobody ran,
    and either would produce a fitness estimate from a number nobody measured.
    Eligible means ``best_efforts.distance_trusted``: a jump counts only
    where the measured speed confirms the recorded distance, and a null
    means not known and is dropped like a known jump, the rule the records
    list and the ``pr`` tag already apply.

    No distance floor is applied to ``vdot``, unlike the prediction series,
    which takes each run's best over efforts of at least
    ``MIN_PREDICTION_DISTANCE_M``. A noisy 400 m window there would be a third
    of every predicted time's input; ``vdot``'s series shows each raw point
    beneath a 42-day mean and names its distance in ``vdot_distance_key``,
    so a consumer can exclude the 400 m points without a recompute. Should
    they prove noisy, applying the same floor here is a one-constant change.
    """
    ordered = activities.sort_values("start_time_utc", kind="stable")
    clean = efforts[distance_trusted(efforts).to_numpy()]
    clean = clean[~clean["activity_id"].astype(str).isin(excluded_activity_ids)]
    clean = clean[clean["distance_key"].astype(str).isin(VDOT_DISTANCES_M)]
    efforts_by_activity = {
        str(activity_id): group
        for activity_id, group in clean.groupby(clean["activity_id"].astype(str))
    }

    rows: list[dict[str, object]] = []
    for _, activity in ordered.iterrows():
        activity_id = str(activity["activity_id"])
        speed, hr = grids.get(activity_id, (np.zeros(0), np.zeros(0)))
        if activity_id in excluded_activity_ids:
            speed, hr = np.zeros(0), np.zeros(0)
        max_hr = max_hr_by_activity.get(activity_id, float("nan"))
        estimate = hr_vo2max(speed, hr, max_hr) if speed.size else float("nan")

        best_vdot, best_key = float("nan"), None
        best_1k = float("nan")
        mine = efforts_by_activity.get(activity_id)
        if mine is not None:
            for _, effort in mine.iterrows():
                candidate = vdot(float(effort["distance_m"]), float(effort["elapsed_time_s"]))
                if math.isfinite(candidate) and (math.isnan(best_vdot) or candidate > best_vdot):
                    best_vdot, best_key = candidate, str(effort["distance_key"])
                if (
                    float(effort["distance_m"]) >= MIN_PREDICTION_DISTANCE_M
                    and math.isfinite(candidate)
                    and (math.isnan(best_1k) or candidate > best_1k)
                ):
                    best_1k = candidate

        if math.isnan(estimate) and math.isnan(best_vdot):
            continue
        rows.append(
            {
                "activity_id": activity_id,
                "start_time_utc": activity["start_time_utc"],
                "hr_vo2max": estimate,
                "vdot": best_vdot,
                "vdot_distance_key": best_key,
                "qualifying_segments": qualifying_segments(speed, hr, max_hr),
                "run_vdot_1k": best_1k,
                "local_date": local_date(activity["start_time_utc"], activity.get("utc_offset_s")),
            }
        )
    frame = pd.DataFrame(rows)
    if frame.empty:
        return frame
    frame = frame.sort_values("start_time_utc", kind="stable").reset_index(drop=True)
    frame["hr_vo2max_smoothed"] = smooth_series(frame["start_time_utc"], frame["hr_vo2max"])
    frame["vdot_smoothed"] = smooth_series(frame["start_time_utc"], frame["vdot"])
    frame[["best_efforts_vdot", "ordinary_runs_vdot"]] = _prediction_vdots(
        frame, frame["run_vdot_1k"]
    )
    return frame.drop(columns=["run_vdot_1k", "local_date"])


#: How far back "recent" reaches for a race prediction, measured from the
#: most recent run in the store rather than from today. Anchored on the
#: history so that the answer is a function of the store alone, and so an
#: athlete who stopped running still sees the prediction their last block
#: of training supports. 90 days is the window the long-run tag already
#: calls recent; 42 days, the smoothing window, leaves the 15 km and half
#: marathon almost never inside it on the real history, where those two
#: have 20 and 5 eligible efforts across three years.
PREDICTION_WINDOW_DAYS = 90

#: The shortest distance a prediction is made from or for. The Daniels
#: percentage curve exceeds 1.0 below about two minutes and his tables start
#: at 1500 m, and a 400 m window is short enough that one bad second dominates
#: it, which is why the five fastest 400 m efforts on the real store all carry
#: ``contains_jump``.
MIN_PREDICTION_DISTANCE_M = 1000.0


def _race_model(
    model: str, predicted_s: float, *, low_s: float | None = None, high_s: float | None = None
) -> dict[str, object]:
    return {
        "model": model,
        "predicted_time_s": predicted_s,
        "low_s": low_s,
        "high_s": high_s,
        "source": model,
    }


def race_predictions(
    best_efforts_vdot: float | None, ordinary_runs_vdot: float | None
) -> dict[str, object]:
    """Every model's prediction at each distance of at least 1 km, or why there are none.

    The two arguments are the newest ``fitness_series`` values of
    ``best_efforts_vdot`` and ``ordinary_runs_vdot``, or ``None``. Each is
    inverted to a time with ``time_for_vdot`` at every distance of
    ``VDOT_DISTANCES_M`` from ``MIN_PREDICTION_DISTANCE_M`` up, for the reason
    ``VDOT_DISTANCES_M`` records: the candidate set is a modelling choice here
    and a display one in the records ladder, so adding a rung to the ladder
    must not move a predicted time. The ordinary-run model carries a band of
    one residual SD either side; the best-efforts model has none.
    Returns the shape of ``api.models.Predictions`` as plain containers, so
    the router only validates.

    ``insufficient_data`` is true whenever either series could not produce a
    value, and ``reason`` says which, so an absence in ``models`` is never
    silent.
    """
    best = _finite(best_efforts_vdot)
    ordinary = _finite(ordinary_runs_vdot)
    missing: list[str] = []
    if best is None:
        missing.append(
            "no eligible best effort of at least 1 km in the last "
            f"{PREDICTION_WINDOW_DAYS} days of the history, so there is no "
            "prediction from best efforts"
        )
    if ordinary is None:
        missing.append(
            "no heart-rate VO2max estimate in the window, so there is no prediction "
            "from ordinary runs"
        )

    items: list[dict[str, object]] = []
    for key, distance_m in VDOT_DISTANCES_M.items():
        if distance_m < MIN_PREDICTION_DISTANCE_M:
            continue
        models: list[dict[str, object]] = []
        if best is not None:
            models.append(_race_model("best_efforts", time_for_vdot(distance_m, best)))
        prediction = None if ordinary is None else predict_from_ordinary_run(ordinary, distance_m)
        if prediction is not None:
            models.append(
                _race_model(
                    "ordinary_runs",
                    prediction.predicted_s,
                    low_s=prediction.low_s,
                    high_s=prediction.high_s,
                )
            )
        if models:
            items.append({"distance_key": key, "distance_m": distance_m, "models": models})

    return {
        "items": items,
        "insufficient_data": bool(missing),
        "reason": "; ".join(missing) if missing else None,
    }


def _finite(value: float | None) -> float | None:
    return None if value is None or not math.isfinite(value) else float(value)
