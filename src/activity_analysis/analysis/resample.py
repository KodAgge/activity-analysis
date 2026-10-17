"""Resample an irregular canonical stream onto a uniform 1 Hz grid.

Raw records arrive at 1 to 8 second intervals, and every rolling-window
metric downstream assumes a uniform grid. The interesting part is not the
interpolation, it is deciding what each gap in the recording actually was.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import numpy as np
import pandas as pd

#: A gap must exceed this before it can be a stop at all. Measured over all
#: 307 runs on 2026-08-29: the device's smart recording produces intervals up
#: to 9 s during ordinary running, and gaps of 10 to 14 s carry a median
#: implied speed of 1.60 m/s, so the athlete was still moving through them.
PAUSE_MIN_GAP_S = 15.0

#: Below this the athlete was not running. In the 20 to 30 second band the
#: median implied speed across a gap is 0.11 m/s.
PAUSE_MAX_IMPLIED_SPEED_MPS = 0.5

#: Beyond this a gap is never ordinary recording, whatever the distance says.
#: Nothing plausible keeps a running watch silent for two minutes mid-effort.
PAUSE_UNCONDITIONAL_GAP_S = 120.0

#: A sample-to-sample advance faster than this was not run, whatever the
#: device wrote. 12.5 m/s sits just above the peak speed of the 100 m world
#: record, roughly 12.4 m/s, so no human locomotion can exceed it and the
#: flag cannot false-positive for any athlete. Measured over the real history
#: on 2026-08-30, sample-to-sample implied speed has p99.9 of 7.35 m/s and
#: p99.99 of 20.76 m/s, so this sits inside that knee: 50 samples across 31
#: of 307 runs exceed it.
#:
#: It deliberately under-detects. 460 samples across 124 of 307 runs exceed
#: this athlete's own demonstrated best speed, so most of those are
#: very likely spurious advances too, but separating them from real running
#: needs an athlete-relative or trajectory-based model rather than a
#: universal physical bound. That belongs with the correction work, which
#: is not done yet.
#:
#: This flags an advance in the *recorded distance*, which is not the same
#: claim as a jump in position. On one real half marathon the position
#: advances steadily through the flagged second and the speed channel holds
#: its value while the odometer alone gains 4.9 times what that channel
#: reads.
IMPLAUSIBLE_SPEED_MPS = 12.5

#: The athlete stood still: the odometer did not advance across the gap.
GAP_STOP: Literal["stop"] = "stop"

#: The device stopped recording while the athlete kept moving: the odometer
#: did advance, but the silence is too long for the gap to be ordinary smart
#: recording.
GAP_OUTAGE: Literal["outage"] = "outage"

#: Positional, and so of a piece with the odometer: they interpolate across a
#: gap exactly as distance does.
_POSITIONAL_CHANNELS = ("lat_deg", "lon_deg", "altitude_m")

#: Sensor readings. Nothing measured them across a gap, so nothing may be
#: invented for them there.
_MEASURED_CHANNELS = ("speed_mps", "hr_bpm", "cadence_spm")

_CHANNELS = _POSITIONAL_CHANNELS + _MEASURED_CHANNELS

GRID_COLUMNS = [
    "t_s",
    "timestamp_utc",
    "lat_deg",
    "lon_deg",
    "altitude_m",
    "distance_m",
    "speed_mps",
    "hr_bpm",
    "cadence_spm",
    "paused",
    "outage",
]


@dataclass(frozen=True)
class Gap:
    """A half-open interval of activity time the device recorded nothing in."""

    start_t_s: float
    end_t_s: float
    kind: Literal["stop", "outage"]


def _interpolate(grid: np.ndarray, t_s: np.ndarray, values: np.ndarray) -> np.ndarray:
    """Linear interpolation that neither invents nor extrapolates.

    A channel is interpolated only between the first and last second it was
    actually recorded. Before and after that it is null, because a heart rate
    strap that connected four seconds in did not measure those four seconds.
    """
    known = ~np.isnan(values)
    if known.sum() < 2:
        return np.full(len(grid), np.nan)
    known_t = t_s[known]
    out: np.ndarray = np.interp(grid, known_t, values[known])
    out[(grid < known_t[0]) | (grid > known_t[-1])] = np.nan
    return out


def find_gaps(t_s: np.ndarray, distance_m: np.ndarray) -> list[Gap]:
    """Classify every stretch of activity time that carries no samples.

    Duration alone does not separate a stop from a recording dropout, so the
    rule has two conditions. A gap longer than ``PAUSE_MIN_GAP_S`` across
    which the implied speed is under ``PAUSE_MAX_IMPLIED_SPEED_MPS`` is a
    stop: the athlete was standing still. A gap longer than
    ``PAUSE_UNCONDITIONAL_GAP_S`` that is not a stop is an outage: the
    odometer advanced, so the athlete did move, but no watch goes quiet for
    two minutes in the middle of a run.

    The two are not interchangeable. A stop is time the athlete was not
    training, so those seconds leave moving time; an outage is time they were
    running unobserved, so those seconds stay in it. Neither kind reaches
    time in zone, since heart rate is null across both. Neither one touches
    distance either: whatever the odometer recorded across the gap is what
    happened, and it is spread over the seconds it took.
    """
    if len(t_s) < 2:
        return []

    # Classify from the same bridged view the grid is built from. A sample
    # whose distance channel is null is an absence of information, not an
    # observation, and reading it as one leaves the advance undefined, which
    # no gap bounded by it could ever survive as a stop.
    gaps = np.diff(t_s)
    advanced = np.diff(_interpolate(t_s, t_s, distance_m))
    with np.errstate(divide="ignore", invalid="ignore"):
        implied = np.where(gaps > 0, advanced / gaps, np.inf)
    implied = np.nan_to_num(implied, nan=np.inf)

    stopped = (gaps > PAUSE_MIN_GAP_S) & (implied < PAUSE_MAX_IMPLIED_SPEED_MPS)
    outage = (gaps > PAUSE_UNCONDITIONAL_GAP_S) & ~stopped
    return [
        Gap(float(t_s[i]), float(t_s[i + 1]), GAP_STOP if stopped[i] else GAP_OUTAGE)
        for i in np.flatnonzero(stopped | outage)
    ]


def resample_to_1hz(streams: pd.DataFrame) -> pd.DataFrame:
    """One row per second of elapsed time, gaps marked rather than removed.

    The grid spans the whole activity including time spent standing still.
    `distance_m` interpolates linearly across every gap without exception, as
    do the positional channels, because the odometer is the one thing that
    kept a record of what happened. The measured channels are null across the
    gaps `find_gaps` classifies, the stops and the outages, because nothing
    measured them there.

    Between the two constants sits a band that is neither: a gap of 15 to
    120 s across which the athlete kept moving is ordinary smart recording,
    so its channels interpolate like any other and its seconds count as
    measured. That is what the 120 s constant is for, and it is deliberate.

    Distance is never held. A genuine stop advances the odometer by
    approximately nothing, so interpolating across it adds approximately
    nothing and a coffee stop still does not become a slow kilometre, which
    was the whole purpose of holding. When the odometer does advance across a
    gap, spreading that advance over the seconds it actually occupied is what
    happened; compressing it into the second the recording resumed fabricates
    a discontinuity, and a best-effort window interpolated into that jump
    comes back faster than the athlete ever ran.

    `paused` and `outage` say what kind of gap a second sits in. They no
    longer influence distance: `paused` keeps those seconds out of moving
    time, and both mark where the measured channels are null, which is what
    keeps them out of time in zone.
    """
    if streams.empty:
        return pd.DataFrame(columns=GRID_COLUMNS)

    frame = streams.sort_values("t_s").reset_index(drop=True)
    t_s = frame["t_s"].to_numpy(dtype=np.float64)
    distance = frame["distance_m"].to_numpy(dtype=np.float64)

    grid = np.arange(0.0, np.floor(t_s[-1]) + 1.0, 1.0)
    columns: dict[str, np.ndarray] = {"t_s": grid}

    # Device distance jitters backwards by a few centimetres now and then, and
    # every consumer of this grid assumes it only ever grows. Only the samples
    # that carry a distance take part: a null one is an absence of
    # information, not an observation that distance did not change, so it must
    # not become a known value equal to the running maximum.
    known = ~np.isnan(distance)
    monotone = distance.copy()
    monotone[known] = np.maximum.accumulate(distance[known])
    columns["distance_m"] = _interpolate(grid, t_s, monotone)

    for name in _CHANNELS:
        columns[name] = _interpolate(grid, t_s, frame[name].to_numpy(dtype=np.float64))

    paused = np.zeros(len(grid), dtype=bool)
    outage = np.zeros(len(grid), dtype=bool)
    for gap in find_gaps(t_s, monotone):
        inside = (grid > gap.start_t_s) & (grid < gap.end_t_s)
        if not inside.any():
            continue
        for name in _MEASURED_CHANNELS:
            columns[name][inside] = np.nan
        if gap.kind == GAP_STOP:
            paused |= inside
        else:
            outage |= inside

    result = pd.DataFrame(columns)
    result["paused"] = paused
    result["outage"] = outage

    start_time = pd.Timestamp(frame["timestamp_utc"].iloc[0])
    result["timestamp_utc"] = start_time + pd.to_timedelta(grid, unit="s")
    return result[GRID_COLUMNS]
