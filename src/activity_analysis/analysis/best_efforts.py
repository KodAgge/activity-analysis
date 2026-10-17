"""Fastest time to cover each standard distance within one activity.

Efforts are measured in elapsed time and windows span pauses. A run of 5 km,
five minutes standing still, then 5 km yields a 10 km effort of 65 minutes.
Measuring in moving time instead would report 60 minutes, which is the one
rule under which resting is free.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from activity_analysis.analysis.resample import IMPLAUSIBLE_SPEED_MPS

_MILE_M = 1609.344

#: Twenty-two distances, in ascending order, which is the order the records
#: ladder renders in and the order two endpoints sort their items by.
#:
#: The nine the project started with, plus thirteen the maintainer asked for on
#: 2026-09-12. A distance appears in the tables only when an activity actually
#: covered it, which is why `marathon` is absent from the records ladder on
#: the current store and why `30k` and `35k` will be too until a run covers
#: them.
#:
#: `8k` and `5mi` are 46.7 m apart, 0.6%, so their best efforts read almost
#: the same. Both are kept deliberately: a runner who thinks in miles is not
#: served by being told the 8 km is close enough.
#:
#: Cost, measured 2026-09-12 over the 307 runs with the grids already in
#: memory: the extraction is a linear two-pointer sweep per distance, so the
#: sweep alone takes 3.3 s at nine targets and 5.7 s at twenty-two. That is
#: the sweep, not the whole best-effort pass, and the whole `recompute` over
#: the same store takes about 18 s. See docs/reference/math/best-efforts.md.
STANDARD_DISTANCES_M: dict[str, float] = {
    "400m": 400.0,
    "1k": 1000.0,
    "1mi": _MILE_M,
    "2k": 2000.0,
    "3k": 3000.0,
    "4k": 4000.0,
    "3mi": 3 * _MILE_M,
    "5k": 5000.0,
    "6k": 6000.0,
    "8k": 8000.0,
    "5mi": 5 * _MILE_M,
    "10k": 10000.0,
    "8mi": 8 * _MILE_M,
    "15k": 15000.0,
    "10mi": 10 * _MILE_M,
    "20k": 20000.0,
    "half": 21097.5,
    "15mi": 15 * _MILE_M,
    "25k": 25000.0,
    "30k": 30000.0,
    "35k": 35000.0,
    "marathon": 42195.0,
}

#: The nine keys the project started with, the candidate set for VDOT and for
#: the race predictions.
_VDOT_DISTANCE_KEYS = frozenset({"400m", "1k", "1mi", "3k", "5k", "10k", "15k", "half", "marathon"})

#: The nine distances VDOT and the race predictions are allowed to read, in
#: ascending order, a subset of ``STANDARD_DISTANCES_M`` by construction.
#:
#: The two sets are separate on purpose. ``STANDARD_DISTANCES_M`` exists so
#: that the records ladder and the progression picker cover the distances the
#: athlete actually runs, and a rung can be added to that ladder whenever one
#: is wanted. VDOT is a different kind of thing: an inversion of race
#: performance through the Daniels tables, whose candidate set is a modelling
#: choice. Sharing one set would have let adding a rung silently move every
#: activity's ``vdot`` and ``vdot_distance_key`` and every predicted time,
#: because both take the best over whatever candidates they are given: an
#: activity that scored highest at 3 km would score higher at the new 2 km or
#: 4 km, and the race models anchor on the highest-scoring recent effort.
#:
#: Derived from ``STANDARD_DISTANCES_M`` rather than restated, so the two
#: cannot disagree about what 1 mile is and cannot fall out of one order.
VDOT_DISTANCES_M: dict[str, float] = {
    key: distance_m
    for key, distance_m in STANDARD_DISTANCES_M.items()
    if key in _VDOT_DISTANCE_KEYS
}

#: How far the recorded distance may run ahead of the measured speed over an
#: effort's window, as a fraction, for an effort flagged ``contains_jump`` to
#: count anyway. Decided by the maintainer on 2026-09-27 over a half
#: marathon whose odometer gains 4.9 times the speed channel's reading in one
#: second while that channel reads steadily throughout, and which the flag
#: had kept off the records ladder.
#:
#: Measured that day over the 2175 outdoor efforts in the real store: the
#: 2032 unflagged ones run a median 1.6% ahead of their speed channel, so 1%
#: readmits only an effort that agrees more closely than a typical clean one.
#: It readmits 26 of the 143 flagged efforts, from 5 of the 30 flagged runs,
#: and the five fastest flagged 400 m efforts it keeps out run 56% to 447%
#: ahead. Every tolerance from 0.5% to 3% changes the same three records, so
#: the choice moves which flagged efforts appear as eligible on the
#: progression chart, not which runs hold a record. See
#: docs/reference/math/best-efforts.md.
SPEED_AGREEMENT_TOLERANCE = 0.01

#: Why an effort's distance is not trusted, worded for ``Not eligible: {reason}``.
#: They name the distance channel rather than the GPS on purpose: the flag
#: is defined on the recorded distance, and the cause of a jump is not
#: established; see docs/reference/math/best-efforts.md.
#: ``routes.ineligible_reason`` stores them and ``api.queries`` serves them,
#: so a route chart, the progression chart and an activity say one thing.
JUMP_UNCONFIRMED = "a jump in the recorded distance that the measured speed does not confirm"
JUMP_UNCHECKABLE = "a jump in the recorded distance, with no measured speed to check it against"
JUMP_UNKNOWN = "not known to be free of distance jumps"

BEST_EFFORT_COLUMNS = [
    "distance_key",
    "distance_m",
    "elapsed_time_s",
    "start_t_s",
    "end_t_s",
    "avg_hr_bpm",
    "contains_pause",
    "contains_outage",
    "contains_jump",
    "speed_distance_m",
    "distance_trusted",
]


@dataclass(frozen=True)
class BestEffortWindow:
    elapsed_time_s: float
    start_t_s: float
    end_t_s: float


def best_effort(
    t_s: np.ndarray, distance_m: np.ndarray, target_m: float
) -> BestEffortWindow | None:
    """The fastest window covering ``target_m``, or None if the run was shorter.

    A two-pointer sweep, exact and linear in the number of samples. The start
    of the window is interpolated between the two samples that straddle the
    target distance, so the answer does not depend on where the second
    boundaries happen to fall.
    """
    if len(distance_m) < 2 or distance_m[-1] - distance_m[0] < target_m:
        return None

    best: BestEffortWindow | None = None
    left = 0
    for right in range(1, len(distance_m)):
        if distance_m[right] - distance_m[0] < target_m:
            continue
        while left + 1 < right and distance_m[right] - distance_m[left + 1] >= target_m:
            left += 1

        threshold = distance_m[right] - target_m
        span = distance_m[left + 1] - distance_m[left]
        if span > 0:
            fraction = (threshold - distance_m[left]) / span
            start = t_s[left] + fraction * (t_s[left + 1] - t_s[left])
        else:
            # Defensive only: the two-pointer invariant leaves the target
            # straddled by two samples that differ in distance, so a flat span
            # here is unreachable. The window would start at the last second
            # before distance resumed.
            start = t_s[left]

        elapsed = t_s[right] - start
        if best is None or elapsed < best.elapsed_time_s:
            best = BestEffortWindow(
                elapsed_time_s=float(elapsed),
                start_t_s=float(start),
                end_t_s=float(t_s[right]),
            )
    return best


def implausible_advance(t_s: np.ndarray, distance_m: np.ndarray) -> np.ndarray:
    """Seconds the odometer reached faster than a human can move.

    Flagged against the second that closes the advance, since that is where
    the device recorded it. ``analysis.routes`` scans a whole run's grid with
    this same rule, so a route and a best effort agree on what a jump is.
    """
    flagged = np.zeros(len(t_s), dtype=bool)
    if len(t_s) < 2:
        return flagged
    step = np.diff(t_s)
    with np.errstate(divide="ignore", invalid="ignore"):
        implied = np.where(step > 0, np.diff(distance_m) / step, 0.0)
    flagged[1:] = np.nan_to_num(implied, nan=0.0) > IMPLAUSIBLE_SPEED_MPS
    return flagged


def speed_is_measured(streams: pd.DataFrame) -> bool:
    """Whether a stream's speed channel is independent of its distance channel.

    ``ingest.normalize`` fills a speed channel the file did not carry with the
    odometer's own derivative: always for GPX, and for any FIT whose device
    wrote no speed field. That channel agrees with the distance by
    construction, so it can confirm nothing about it. Read on the raw stream
    rather than the 1 Hz grid, because the grid interpolates both channels and
    the exact identity would no longer hold there.
    """
    if streams.empty or "speed_mps" not in streams:
        return False
    speed = streams["speed_mps"].to_numpy(dtype=np.float64)
    if np.isnan(speed).all():
        return False
    t_s = streams["t_s"].to_numpy(dtype=np.float64)
    distance = streams["distance_m"].to_numpy(dtype=np.float64)
    step = np.diff(t_s)
    with np.errstate(divide="ignore", invalid="ignore"):
        derivative = np.diff(distance) / step
    comparable = (step > 0) & ~np.isnan(derivative) & ~np.isnan(speed[1:])
    if not comparable.any():
        return False
    return not bool(np.allclose(speed[1:][comparable], derivative[comparable]))


def speed_channel_distance_m(
    t_s: np.ndarray, speed_mps: np.ndarray, start_t_s: float, end_t_s: float
) -> float:
    """Distance the speed channel accounts for between two instants.

    The trapezoid of each sample interval, clipped to the window, so a
    fractional window start is honoured the way ``best_effort`` interpolates
    it. An interval with a null speed at either end contributes nothing: a
    metre the speed channel never saw is not one it can vouch for. That is
    the conservative side for its one use, deciding whether a flagged effort
    may count, since an unconfirmed metre can only widen the disagreement.
    """
    if len(t_s) < 2:
        return 0.0
    mean = 0.5 * (speed_mps[1:] + speed_mps[:-1])
    mean = np.where(np.isnan(mean), 0.0, mean)
    lo = np.maximum(t_s[:-1], start_t_s)
    hi = np.minimum(t_s[1:], end_t_s)
    return float(np.sum(mean * np.clip(hi - lo, 0.0, None)))


def distance_trusted(efforts: pd.DataFrame) -> pd.Series:
    """Per effort, whether its recorded distance may be trusted for a record.

    The one reading of the rule every in-memory consumer applies: records
    through ``analysis.tags``, VDOT through ``analysis.fitness`` and route
    eligibility through ``analysis.routes``. Only an explicit True counts,
    because a record is the one consumer for which an unverified effort is
    worse than no effort.
    """
    return efforts["distance_trusted"].eq(True).astype(bool)


def jump_reasons(efforts: pd.DataFrame) -> pd.Series:
    """Per effort, which of the three jump reasons applies, or None when trusted.

    The same precedence ``api.queries`` restates in SQL: an effort nobody
    checked is ``JUMP_UNKNOWN``, a flagged one with no measured speed is
    ``JUMP_UNCHECKABLE``, and one whose measured speed disagrees is
    ``JUMP_UNCONFIRMED``.
    """
    trusted = distance_trusted(efforts)
    unknown = efforts["distance_trusted"].isna()
    checked = efforts["speed_distance_m"].notna()
    reasons = pd.Series(None, index=efforts.index, dtype=object)
    reasons[~trusted & checked] = JUMP_UNCONFIRMED
    reasons[~trusted & ~checked] = JUMP_UNCHECKABLE
    reasons[unknown] = JUMP_UNKNOWN
    return reasons


def grid_jump_reason(grid: pd.DataFrame, *, speed_is_measured: bool) -> str | None:
    """Why a whole run's recorded distance is not trusted, or None when it is.

    The run-level form of the best-effort rule, for a consumer that times the
    whole run: a jump outside every best-effort window still credits the run
    metres nobody ran. A run with a jump is trusted when its whole recorded
    distance agrees with its measured speed within
    ``SPEED_AGREEMENT_TOLERANCE``, the same test an effort's window gets.
    """
    t_s = grid["t_s"].to_numpy(dtype=np.float64)
    distance = grid["distance_m"].to_numpy(dtype=np.float64)
    if not implausible_advance(t_s, distance).any():
        return None
    if not speed_is_measured or "speed_mps" not in grid:
        return JUMP_UNCHECKABLE
    covered = float(np.nanmax(distance) - np.nanmin(distance))
    confirmed = speed_channel_distance_m(
        t_s, grid["speed_mps"].to_numpy(dtype=np.float64), float(t_s[0]), float(t_s[-1])
    )
    if confirmed > 0.0 and abs(covered / confirmed - 1.0) <= SPEED_AGREEMENT_TOLERANCE:
        return None
    return JUMP_UNCONFIRMED


def best_efforts(grid: pd.DataFrame, *, speed_is_measured: bool = False) -> pd.DataFrame:
    """One row per standard distance the activity actually covered.

    ``speed_is_measured`` says whether the grid's speed channel is the
    device's own reading, as the function of that name decides on the raw
    stream. False, the default, leaves ``speed_distance_m`` null, so a jump
    can never be readmitted on a speed channel that is the odometer again.
    """
    if grid.empty:
        return pd.DataFrame(columns=BEST_EFFORT_COLUMNS)

    t_s = grid["t_s"].to_numpy(dtype=np.float64)
    distance = grid["distance_m"].to_numpy(dtype=np.float64)
    speed = (
        grid["speed_mps"].to_numpy(dtype=np.float64)
        if speed_is_measured and "speed_mps" in grid
        else None
    )
    hr = grid["hr_bpm"].to_numpy(dtype=np.float64)
    paused = grid["paused"].to_numpy(dtype=bool)
    # The same shape as is_indoor and is_gpx_sourced: the consumer decides
    # what to exclude, but it cannot decide what it cannot see. An effort
    # measured across an outage is conservative rather than inflated, since
    # every metre of it is the outage's own average, so this is observability
    # rather than a correction.
    outage = grid["outage"].to_numpy(dtype=bool)

    # An advance in the recorded distance whose implied speed no human can
    # reach credits metres the athlete never ran, whatever wrote it. The
    # trace is kept exactly as the device wrote it, so the effort is flagged
    # rather than corrected. Correcting it is not done yet.
    jump = implausible_advance(t_s, distance)

    usable = ~np.isnan(distance)
    if usable.sum() < 2:
        return pd.DataFrame(columns=BEST_EFFORT_COLUMNS)

    rows = []
    for key, target in STANDARD_DISTANCES_M.items():
        window = best_effort(t_s[usable], distance[usable], target)
        if window is None:
            continue
        inside = (t_s >= window.start_t_s) & (t_s <= window.end_t_s)
        hr_inside = hr[inside]
        jumped = bool(jump[inside].any())
        confirmed = (
            speed_channel_distance_m(t_s, speed, window.start_t_s, window.end_t_s)
            if speed is not None
            else np.nan
        )
        # The agreement check only readmits: an effort with no jump is
        # trusted whatever its speed channel says, because the check was
        # measured and decided as a way back in for a flagged effort, not
        # as a second test on clean ones. See SPEED_AGREEMENT_TOLERANCE.
        agrees = bool(confirmed > 0.0) and (
            abs(target / confirmed - 1.0) <= SPEED_AGREEMENT_TOLERANCE
        )
        rows.append(
            {
                "distance_key": key,
                "distance_m": target,
                "elapsed_time_s": window.elapsed_time_s,
                "start_t_s": window.start_t_s,
                "end_t_s": window.end_t_s,
                "avg_hr_bpm": (
                    float(np.nanmean(hr_inside)) if not np.isnan(hr_inside).all() else np.nan
                ),
                "contains_pause": bool(paused[inside].any()),
                "contains_outage": bool(outage[inside].any()),
                "contains_jump": jumped,
                "speed_distance_m": confirmed,
                "distance_trusted": not jumped or agrees,
            }
        )
    return pd.DataFrame(rows, columns=BEST_EFFORT_COLUMNS)
