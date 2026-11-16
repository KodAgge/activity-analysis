"""Banister's TRIMP and the heart rates it is computed from.

TRIMP weights each second of heart rate by its position in the heart-rate
reserve, ``x = (hr - rest) / (max - rest)``, as ``x * a * exp(b * x)``. A
minute at the weight is that many TRIMP units. Morton, Fitz-Clarke and Banister
(1990) fitted ``a = 0.64`` and ``b = 1.92`` for men; their women's pair, 0.86
and 1.67, is not used.

Rest and max are measured rather than taken from the device settings: rest is
the median daily resting heart rate of the trailing 28 days, carried forward
for up to 90 days past the newest measured day, and max is the median of the
three highest 10 second peaks in the trailing 540 days.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date, timedelta
from typing import NamedTuple

import numpy as np
import pandas as pd

TRIMP_FACTOR = 0.64
TRIMP_EXPONENT = 1.92
REST_WINDOW_DAYS = 28
#: How long after the newest measured resting day its 28 day median still
#: stands in for a run's rest before the device setting does.
REST_CARRY_DAYS = 90
MAX_WINDOW_DAYS = 540
MAX_TOP_N = 3
PEAK_WINDOW_S = 10


def peak_hr(grid: pd.DataFrame) -> float | None:
    """Highest mean over ``PEAK_WINDOW_S`` consecutive unpaused seconds with a heart rate."""
    if len(grid) < PEAK_WINDOW_S:
        return None
    hr = grid["hr_bpm"].to_numpy(dtype=np.float64).copy()
    hr[grid["paused"].to_numpy(dtype=bool)] = np.nan
    means = pd.Series(hr).rolling(PEAK_WINDOW_S, min_periods=PEAK_WINDOW_S).mean().dropna()
    if means.empty:
        return None
    return float(means.max())


class Rest(NamedTuple):
    """A measured resting heart rate and the newest measured day it rests on."""

    bpm: float
    measured_through: date


def rest_at(resting: pd.DataFrame, on: date) -> Rest | None:
    """Median measured resting heart rate in ``(on - 28 days, on]``.

    When those 28 days hold no measured day, the median of the 28 days up to
    the newest measured day before ``on`` stands in for it, provided that day
    is at most ``REST_CARRY_DAYS`` before ``on``; otherwise None, and the
    device setting is the caller's to use. A full Garmin export carries the
    resting series and a single run's export does not, so the newest runs
    usually lie past the series' end.
    """
    measured = resting.loc[resting["resting_hr_bpm"].notna()]
    days = measured.loc[measured["calendar_date"] <= on, "calendar_date"]
    if days.empty:
        return None
    through: date = days.max()
    if (on - through).days > REST_CARRY_DAYS:
        return None
    # Inside the window this is ``on``'s own window; past it, the newest one.
    end = on if (on - through).days < REST_WINDOW_DAYS else through
    low = end - timedelta(days=REST_WINDOW_DAYS)
    window = measured.loc[(measured["calendar_date"] > low) & (measured["calendar_date"] <= end)]
    return Rest(float(window["resting_hr_bpm"].median()), through)


def max_at(peaks: pd.DataFrame, at: pd.Timestamp) -> float | None:
    """Median of the ``MAX_TOP_N`` highest peaks in ``(at - 540 days, at]``.

    None with fewer than ``MAX_TOP_N`` peaks in the window.
    """
    times = peaks["start_time_utc"]
    low = at - pd.Timedelta(days=MAX_WINDOW_DAYS)
    window = peaks.loc[(times > low) & (times <= at), "peak_hr_10s_bpm"].dropna()
    if len(window) < MAX_TOP_N:
        return None
    return float(window.nlargest(MAX_TOP_N).median())


def trimp_weights(hr: np.ndarray, rest_bpm: float, max_bpm: float) -> np.ndarray:
    """TRIMP per second: ``x * 0.64 * exp(1.92 * x) / 60``, ``x`` clipped to [0, 1]."""
    x = np.clip((hr - rest_bpm) / (max_bpm - rest_bpm), 0.0, 1.0)
    weights: np.ndarray = x * TRIMP_FACTOR * np.exp(TRIMP_EXPONENT * x) / 60.0
    return weights


def _usable(grid: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
    hr = grid["hr_bpm"].to_numpy(dtype=np.float64)
    mask = ~np.isnan(hr) & ~grid["paused"].to_numpy(dtype=bool)
    return hr, mask


def run_trimp(grid: pd.DataFrame, rest_bpm: float, max_bpm: float) -> float | None:
    """Sum over unpaused seconds with a heart rate; None when there are none."""
    hr, mask = _usable(grid)
    if not mask.any():
        return None
    return float(trimp_weights(hr[mask], rest_bpm, max_bpm).sum())


def trimp_by_zone(
    grid: pd.DataFrame, boundaries: Sequence[float], rest_bpm: float, max_bpm: float
) -> list[float]:
    """TRIMP in each of ``len(boundaries) + 1`` zones.

    A second on a boundary is in the zone it opens, as ``zones.zone_time`` has it.
    """
    edges = [float(v) for v in boundaries]
    sums = np.zeros(len(edges) + 1, dtype=np.float64)
    hr, mask = _usable(grid)
    if mask.any():
        values = hr[mask]
        zones = np.searchsorted(edges, values, side="right")
        sums = np.bincount(
            zones, weights=trimp_weights(values, rest_bpm, max_bpm), minlength=len(edges) + 1
        )
    return [float(v) for v in sums]
