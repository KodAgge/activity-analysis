"""Time spent in each heart rate zone, computed from the 1 Hz grid.

The device writes its own `time_in_zone` totals into every FIT, which is free
and authoritative for one activity but cannot answer a question spanning more
than one, is absent from GPX, and is absent from the oldest runs. Computing it
here gives one code path for every source and every window, so time in zone
for a week is the same function as time in zone for a run.

The device's values are kept as a test oracle instead.
"""

from __future__ import annotations

from collections.abc import Sequence

import numpy as np
import pandas as pd

ZONE_TIME_COLUMNS = ["zone_index", "low_bpm", "high_bpm", "seconds_s"]


def zone_time(grid: pd.DataFrame, boundaries: Sequence[float]) -> pd.DataFrame:
    """Seconds in each zone. ``n`` boundaries define ``n + 1`` zones.

    Zone 0 is everything below the first boundary and the top zone is
    everything at or above the last. A sample sitting exactly on a boundary
    belongs to the zone that boundary opens.

    Every row of the grid is one second, so counting rows is counting seconds.
    Paused seconds and seconds with no heart rate are excluded: standing still
    is not time in zone 1, and an unrecorded second is not a measurement.
    """
    edges = [float(v) for v in boundaries]
    if not edges:
        return pd.DataFrame(columns=ZONE_TIME_COLUMNS)

    zone_count = len(edges) + 1
    seconds = np.zeros(zone_count, dtype=np.float64)

    if not grid.empty:
        hr = grid["hr_bpm"].to_numpy(dtype=np.float64)
        usable = ~np.isnan(hr) & ~grid["paused"].to_numpy(dtype=bool)
        if usable.any():
            indices = np.searchsorted(edges, hr[usable], side="right")
            seconds = np.bincount(indices, minlength=zone_count).astype(np.float64)

    lows = [np.nan, *edges]
    highs = [*edges, np.nan]
    return pd.DataFrame(
        {
            "zone_index": np.arange(zone_count, dtype=np.int32),
            "low_bpm": lows,
            "high_bpm": highs,
            "seconds_s": seconds,
        }
    )
