"""One summary row per activity, derived from the 1 Hz grid.

The flags matter as much as the numbers. Treadmill distance comes from an
uncalibrated footpod and GPX speed is an order of magnitude noisier than FIT,
so every consumer downstream needs to be able to say which activities it is
willing to include.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

from activity_analysis.analysis.places import first_fixed_position, nearest_place
from activity_analysis.models import SOURCE_GPX


def activity_metrics(grid: pd.DataFrame, activity: pd.Series) -> dict[str, Any]:
    """Summarise one activity. Every row of the grid is one second.

    Elapsed time is the span the grid covers, the last second minus the
    first, rather than the number of rows, which overstates the span by the
    one row that closes the interval. It is not the same quantity as the
    canonical `activities.elapsed_time_s`, which for a FIT carrying a session
    is the device's own `total_elapsed_time`; the two match only to within
    the rounding between them.
    """
    paused = grid["paused"].to_numpy(dtype=bool) if not grid.empty else np.zeros(0, dtype=bool)
    elapsed = float(len(grid) - 1) if not grid.empty else 0.0
    paused_time = float(paused.sum())

    distance = grid["distance_m"].to_numpy(dtype=np.float64) if not grid.empty else np.zeros(0)
    covered = float(np.nanmax(distance)) if distance.size and not np.isnan(distance).all() else 0.0

    moving_time = elapsed - paused_time
    #: The activity's **canonical** distance over this project's moving time.
    #:
    #: Mixed on purpose, and `ascent_per_km_m` two lines below is the
    #: precedent: that one divides the device's own barometric ascent by the
    #: grid's distance, because the device's number is the better one for
    #: that quantity. The same holds here for the numerator. On a treadmill
    #: there is no satellite fix, so the stream's distance is a footpod or
    #: estimated figure that drifts, while the session total Strava carries
    #: is the corrected one: measured on 2026-09-12 the two differ by a
    #: median of 7.78% and by up to 13.32% over the 16 treadmill runs
    #: carrying both, and fourteen of the sixteen session totals are round to
    #: 10 m where the odometer is not. The browser renders the canonical
    #: distance, so taking the pace from any other one would print a row that
    #: does not multiply out.
    #:
    #: The denominator is this project's rather than the device's for the
    #: reason `moving_time_s` exists at all: the canonical
    #: `activities.moving_time_s` is the device's auto-paused timer. The
    #: device's own `avg_speed` is that timer's average, and it is null on 224
    #: of the 307 real runs because the device began writing it only in late
    #: January 2026, which left the browser's Pace column empty on 73% of the
    #: list. This one exists for every run. Where both exist they agree to a
    #: median of 0.025% over the 67 outdoor rows, 59 of them to under 0.4%;
    #: the remaining 8 differ by up to 32 s/km, the largest across 133 paused
    #: seconds. See docs/reference/math/units.md.
    #:
    #: None rather than zero when either term is missing or not positive: a
    #: zero speed renders as an infinite pace, which is a measurement nobody
    #: took, and the API falls back to the device's value on a null.
    session_distance = activity.get("distance_m")
    canonical = (
        float(session_distance)
        if session_distance is not None and not pd.isna(session_distance)
        else 0.0
    )
    avg_speed = canonical / moving_time if canonical > 0.0 and moving_time > 0.0 else None

    ascent = activity.get("ascent_m")
    ascent_per_km = (
        float(ascent) / (covered / 1000.0)
        if ascent is not None and not pd.isna(ascent) and covered > 0
        else np.nan
    )

    return {
        "activity_id": str(activity["activity_id"]),
        "elapsed_time_s": elapsed,
        "moving_time_s": moving_time,
        "paused_time_s": paused_time,
        "distance_m": covered,
        "avg_speed_mps": avg_speed,
        "ascent_per_km_m": ascent_per_km,
        "is_indoor": str(activity.get("sub_sport")) == "treadmill",
        "has_hr": bool(not grid.empty and grid["hr_bpm"].notna().any()),
        "has_gps": bool(not grid.empty and grid["lat_deg"].notna().any()),
        "is_gpx_sourced": str(activity.get("source")) == SOURCE_GPX,
        **_where(grid),
    }


def _where(grid: pd.DataFrame) -> dict[str, Any]:
    """Where the activity started, resolved offline. All null if nowhere.

    From the *first* fixed position rather than any average over the route -
    see `places.first_fixed_position` - and through the bundled place table
    rather than any network service, for the same reason the route panel has
    no basemap: these are the athlete's own coordinates.

    The four keys are always present, so every row of the metrics table has
    the same shape whether the activity had a position or not. 86 of the 307
    real runs have none at all, every treadmill run among them.
    """
    absent: dict[str, Any] = {
        "locality": None,
        "country_code": None,
        "country": None,
        "locality_distance_m": np.nan,
    }
    if grid.empty or "lat_deg" not in grid or "lon_deg" not in grid:
        return absent

    position = first_fixed_position(
        grid["lat_deg"].to_numpy(dtype=np.float64),
        grid["lon_deg"].to_numpy(dtype=np.float64),
    )
    if position is None:
        return absent

    place = nearest_place(*position)
    if place is None:
        return absent

    return {
        "locality": place.locality,
        "country_code": place.country_code,
        "country": place.country,
        "locality_distance_m": place.distance_m,
    }
