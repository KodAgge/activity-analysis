"""Training load: each day's TRIMP, smoothed into fitness, fatigue and form.

A run's TRIMP comes from ``trimp.run_trimp``. The daily series sums it per
local day and carries two exponentially weighted averages of it, the 42 day
``ctl`` (fitness) and the 7 day ``atl`` (fatigue), with ``form`` their
difference. A day with no run is a zero, so both decay across rest. Running
distance rides beside them, because TRIMP measures the heart and not the
legs. The weekly series means the daily values over each week, which removes
the sawtooth a few runs a week cut into ``atl`` and ``form``.

The heart-rate histogram keeps seconds at each whole bpm so that the
estimated zones can be recomputed under different boundaries without reading
the 1 Hz grids again. See docs/reference/math/threshold-and-load.md.
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

from activity_analysis.analysis.consistency import week_start
from activity_analysis.models import (
    TRAINING_LOAD_WEEKLY_SCHEMA,
    TRAINING_SERIES_SCHEMA,
    empty_frame,
)

ATL_TAU_DAYS = 7.0
CTL_TAU_DAYS = 42.0


def hr_histogram(grid: pd.DataFrame) -> pd.DataFrame:
    """Seconds at each whole bpm. Paused and heart-rate-less seconds are excluded.

    This is the same exclusion ``zone_time`` makes. Each grid row is one second.
    """
    hr = grid["hr_bpm"].to_numpy(dtype=np.float64)
    usable = ~np.isnan(hr) & ~grid["paused"].to_numpy(dtype=bool)
    rounded = np.rint(hr[usable]).astype(np.int16)
    values, counts = np.unique(rounded, return_counts=True)
    return pd.DataFrame({"hr_bpm": values.astype(np.int16), "seconds_s": counts.astype(np.float64)})


def _ewma(values: np.ndarray, tau: float, start: float = 0.0) -> np.ndarray:
    """``x_t = x_{t-1} + alpha * (v_t - x_{t-1})``, ``alpha = 1 - exp(-1 / tau)``.

    ``x`` is ``start`` before the first value.
    """
    alpha = 1.0 - math.exp(-1.0 / tau)
    value = start
    out = np.empty(len(values), dtype=np.float64)
    for i, x in enumerate(values):
        value += alpha * (x - value)
        out[i] = value
    return out


def carry_on(ctl: float, atl: float, trimp: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """``ctl`` and ``atl`` carried from one day's values through the next days' TRIMP.

    The same recursion ``daily_series`` runs, started from a stored day rather
    than from zero, which is how a training plan projects its planned load.
    """
    return _ewma(trimp, CTL_TAU_DAYS, ctl), _ewma(trimp, ATL_TAU_DAYS, atl)


def daily_series(runs: pd.DataFrame) -> pd.DataFrame:
    """One row per day from the first run's day to the last's.

    ``runs`` has ``local_date``, ``trimp`` (nullable) and ``distance_m``. A null
    TRIMP counts nothing but the run's distance still counts. ``ctl`` and
    ``atl`` are the 42 and 7 day averages of the day's TRIMP, ``form`` is
    ``ctl - atl`` and ``distance_7d_m`` sums the 7 days ending that day.
    """
    columns = [f.name for f in TRAINING_SERIES_SCHEMA if f.name != "analysis_version"]
    if runs.empty:
        return empty_frame(TRAINING_SERIES_SCHEMA)[columns]
    dates = pd.to_datetime(runs["local_date"])
    days = pd.date_range(dates.min(), dates.max(), freq="D")
    trimp = runs["trimp"].astype("float64").groupby(dates).sum().reindex(days, fill_value=0.0)
    distance = (
        runs["distance_m"].astype("float64").groupby(dates).sum().reindex(days, fill_value=0.0)
    )
    ctl = _ewma(trimp.to_numpy(), CTL_TAU_DAYS)
    atl = _ewma(trimp.to_numpy(), ATL_TAU_DAYS)
    return pd.DataFrame(
        {
            "local_date": [d.date() for d in days],
            "trimp": trimp.to_numpy(),
            "ctl": ctl,
            "atl": atl,
            "form": ctl - atl,
            "distance_m": distance.to_numpy(),
            "distance_7d_m": distance.rolling(7, min_periods=1).sum().to_numpy(),
        },
        columns=columns,
    )


def weekly_series(daily: pd.DataFrame) -> pd.DataFrame:
    """One row per ISO week of the daily series, with the means over its days."""
    columns = [f.name for f in TRAINING_LOAD_WEEKLY_SCHEMA if f.name != "analysis_version"]
    if daily.empty:
        return empty_frame(TRAINING_LOAD_WEEKLY_SCHEMA)[columns]
    weeks = daily["local_date"].map(week_start)
    grouped = daily.groupby(weeks)
    out = pd.DataFrame(
        {
            "days": grouped.size().astype("int32"),
            "trimp": grouped["trimp"].sum(),
            "ctl_mean": grouped["ctl"].mean(),
            "atl_mean": grouped["atl"].mean(),
            "form_mean": grouped["form"].mean(),
            "distance_m": grouped["distance_m"].sum(),
        }
    )
    out.index.name = "week_start"
    return out.reset_index()[columns]
