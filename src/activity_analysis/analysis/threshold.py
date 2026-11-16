"""Estimated lactate threshold heart rate, from sustained hard efforts.

A best effort of 30 to 60 minutes on a run tagged all out is, for a trained
runner, the effort the Friel field test asks for: the heart rate over the
final 20 minutes of a maximal 30 minute effort is taken as the threshold
heart rate. Each such run contributes at most one reading, its effort with the
highest VDOT, and the estimate in force on a date is the median of the
readings over the trailing window. A steady or interval run that happened to
cover 8 km in 40 minutes gives no reading, because its final 20 minutes read
well below an all-out effort's.

The heart rate is a device-independent measurement here, unlike the zones in
the FIT, which are settings. See docs/reference/math/threshold-and-load.md.
"""

from __future__ import annotations

from collections.abc import Mapping

import pandas as pd

from activity_analysis.analysis.fitness import vdot
from activity_analysis.analysis.tags import ALL_OUT_ABOVE, ALL_OUT_SHARE

MIN_EFFORT_S = 1800.0
MAX_EFFORT_S = 3600.0
FINAL_WINDOW_S = 1200.0
MIN_HR_COVERAGE = 0.9
#: Upper edges of zones 1 to 4 as fractions of threshold heart rate (Friel).
ZONE_FRACTIONS = (0.85, 0.90, 0.95, 1.00)

#: A second this far below the final window's median heart rate is a wrist
#: sensor misreading or a stop, not the effort's heart rate. Measured on the
#: real store; see "The lock-on guard" in docs/reference/math/threshold-and-load.md.
LOCK_ON_DROP_BPM = 20.0
#: The shortest tail a reading is taken from once a late lock-on is cut.
MIN_TAIL_S = 900.0

#: Measured on the real store against windows of 180 and 540 days, the whole
#: history, a minimum of 5 and the old VDOT margin on top of the all-out tag;
#: see "Choosing the window and the minimum" in
#: docs/reference/math/threshold-and-load.md.
WINDOW_DAYS = 365
MIN_READINGS = 3


def reading(grid: pd.DataFrame, effort: pd.Series) -> dict[str, float] | None:
    """Mean heart rate over an effort's final 1200 s, or None if it is not one.

    Paused seconds count toward neither the mean nor the coverage. Within the
    rest, the floor is ``LOCK_ON_DROP_BPM`` below the window's median heart
    rate. Leading seconds that read under the floor are a sensor locking on
    late and are cut, leaving the window's tail; a tail shorter than
    ``MIN_TAIL_S`` gives no reading. In the tail, a second under the floor is
    counted as a second without heart rate, and coverage is the share of the
    tail's seconds with a heart rate at or above the floor.
    """
    end = float(effort["end_t_s"])
    t = grid["t_s"]
    window = grid[(t > end - FINAL_WINDOW_S) & (t <= end) & ~grid["paused"].astype(bool)]
    hr = window["hr_bpm"].reset_index(drop=True)
    if hr.notna().sum() == 0:
        return None
    floor = float(hr.median()) - LOCK_ON_DROP_BPM
    # A missing second is not a lock-on: it stays in the tail and counts
    # against coverage, so only a known, low second is cut.
    locked = (hr.isna() | (hr >= floor)).to_numpy()
    tail = hr.iloc[int(locked.argmax()) :]
    if len(tail) < MIN_TAIL_S:
        return None
    kept = tail[tail >= floor]
    coverage = len(kept) / len(tail)
    if coverage < MIN_HR_COVERAGE:
        return None
    return {"final_hr_bpm": float(kept.mean()), "hr_coverage": coverage}


def is_hard(grid: pd.DataFrame, effort: pd.Series, max_hr_bpm: float) -> bool:
    """Whether the effort itself was run all out, by the all-out tag's first rule.

    At least ``ALL_OUT_SHARE`` of the effort's unpaused seconds with a heart
    rate at or above ``ALL_OUT_ABOVE`` of the maximum in force. A run tagged
    all out can hold a 30 to 60 minute effort that was not: the fast stretch
    of a long run whose median alone tagged it.
    """
    t = grid["t_s"]
    span = grid[
        (t >= float(effort["start_t_s"]))
        & (t <= float(effort["end_t_s"]))
        & ~grid["paused"].astype(bool)
    ]
    hr = span["hr_bpm"].dropna()
    if hr.empty:
        return False
    return float((hr >= ALL_OUT_ABOVE * max_hr_bpm).mean()) >= ALL_OUT_SHARE


def run_readings(
    efforts: pd.DataFrame,
    grids: Mapping[str, pd.DataFrame],
    runs: pd.DataFrame,
    excluded: set[str],
    all_out: set[str],
    max_hr: Mapping[str, float],
) -> pd.DataFrame:
    """One row per run tagged all out: its eligible effort with the highest VDOT.

    Eligible is 30 to 60 minutes of elapsed time, with no pause, outage or
    jump, on a run that is in ``all_out``, is not in ``excluded`` and whose
    grid is available. ``all_out`` is the runs whose effort tag is
    ``all_out`` (``tags.classify_effort``), passed in so this module reads no
    store. The effort must also have been hard itself (``is_hard``) under
    ``max_hr``, each run's maximum heart rate in force; a run without one
    gives no reading. An effort that is not hard, or whose final window gives
    no reading, falls through to the run's next-highest VDOT.
    """
    columns = [
        "activity_id",
        "start_time_utc",
        "distance_key",
        "elapsed_time_s",
        "vdot",
        "final_hr_bpm",
        "hr_coverage",
    ]
    starts = runs.set_index("activity_id")["start_time_utc"]
    rows: list[dict[str, object]] = []
    for activity_id, group in efforts.groupby("activity_id", sort=False):
        aid = str(activity_id)
        if aid not in all_out or aid in excluded or aid not in grids or aid not in starts.index:
            continue
        max_hr_bpm = max_hr.get(aid, float("nan"))
        if not max_hr_bpm > 0:
            continue
        eligible = group[
            (group["elapsed_time_s"] >= MIN_EFFORT_S)
            & (group["elapsed_time_s"] <= MAX_EFFORT_S)
            & ~group["contains_pause"].astype(bool)
            & ~group["contains_outage"].astype(bool)
            & ~group["contains_jump"].astype(bool)
        ]
        best: dict[str, object] | None = None
        best_vdot = float("-inf")
        for _, eff in eligible.iterrows():
            value = vdot(float(eff["distance_m"]), float(eff["elapsed_time_s"]))
            if not value > best_vdot:
                continue
            if not is_hard(grids[aid], eff, max_hr_bpm):
                continue
            got = reading(grids[aid], eff)
            if got is None:
                continue
            best_vdot = value
            best = {
                "activity_id": aid,
                "start_time_utc": starts.loc[aid],
                "distance_key": str(eff["distance_key"]),
                "elapsed_time_s": float(eff["elapsed_time_s"]),
                "vdot": value,
                **got,
            }
        if best is not None:
            rows.append(best)
    return pd.DataFrame(rows, columns=columns)


def estimate_at(readings: pd.DataFrame, at: pd.Timestamp) -> tuple[float | None, list[str]]:
    """The threshold heart rate in force at ``at``, with the readings behind it.

    The median of the final heart rates of the readings from the trailing
    ``WINDOW_DAYS`` days. Fewer than ``MIN_READINGS`` gives ``(None, [])``.
    Every reading counts: intensity was decided before it became a reading,
    by its run's all-out tag.
    """
    start = readings["start_time_utc"]
    inside = readings[(start > at - pd.Timedelta(days=WINDOW_DAYS)) & (start <= at)]
    if len(inside) < MIN_READINGS:
        return None, []
    return float(inside["final_hr_bpm"].median()), [str(i) for i in inside["activity_id"]]


def zone_boundaries(lthr_bpm: float) -> list[float]:
    """Upper edges of zones 1 to 4 for a threshold heart rate."""
    return [f * lthr_bpm for f in ZONE_FRACTIONS]
