"""Days since the previous run, counted on the local calendar.

The question this answers is how many days off the athlete took between two
runs, not how many hours elapsed. A 07:00 run following a 21:00 run the
evening before is ten hours apart and one calendar day later, not 0.4 days;
counting elapsed time would make an evening-to-morning turnaround look like
the shortest rest in the history when it is an ordinary night's sleep. So the
unit is the **local date**, `start_time_utc` shifted by `utc_offset_s` with a
null offset treated as zero, the same rule `LOCAL_DATE_SQL` and
`consistency.py`'s week key both use.

Runs only. Every other view in this project is about running, so a hike or a
ride slotted between two runs must not make the second one read as a shorter
rest than it was.

Whole-history and ordered by instant (`start_time_utc`), not by the order rows
happen to arrive in, because "the previous run" means the one that actually
preceded it in time. The history is every running activity in the canonical
layer, including one with no streams or a failed grid: it still happened, so
it is still the next run's previous run, though it has no derived row of its
own to carry a value. The first run in the history has no previous run, so it
is null. A later run whose local date is earlier, after travel west, is 0.

See `docs/reference/math/rest-days.md` for the derivation and the measured
distribution.
"""

from __future__ import annotations

import pandas as pd


def days_since_previous_run(runs: pd.DataFrame) -> pd.Series:
    """Local calendar days from the previous run to each run, null on the first.

    ``runs`` needs ``activity_id``, ``start_time_utc`` (tz-aware UTC) and
    ``utc_offset_s`` (nullable int). Returned as an ``Int32`` series indexed
    by ``activity_id``, in no particular order relative to the input.
    """
    if runs.empty:
        return pd.Series(dtype="Int32", name="days_since_previous_run")

    # Instant order decides "previous", never input order: two activities
    # reconciled from different sources can arrive in any order, and the
    # local date only makes sense once the runs are in the order they
    # actually happened in. activity_id breaks ties for determinism; it has
    # no effect on the real store, where two runs never share a start.
    ordered = runs.sort_values(["start_time_utc", "activity_id"])

    # A null offset is GPX's case - it recorded no local timestamp - and is
    # treated as UTC, the same substitution consistency.py's week key makes.
    offsets = pd.to_timedelta(ordered["utc_offset_s"].fillna(0).astype("int64"), unit="s")
    local_date = (
        ordered["start_time_utc"].dt.tz_convert("UTC").dt.tz_localize(None) + offsets
    ).dt.normalize()

    # A calendar-day difference, not an hours-based one: two dates a single
    # midnight apart are one day apart regardless of the clock time on
    # either side of it, which is the whole point of counting dates rather
    # than instants. shift() puts NaT against the first row, so its
    # difference is NaT and the cast to Int32 below turns that into <NA>.
    gaps = (local_date - local_date.shift()).dt.days

    # Flying west can put the later run on an earlier local date: 01:00 at
    # UTC+2 then 21:00 the evening before at UTC-5, three hours later. No
    # day off came between them, so the gap is 0, the same-day answer, and
    # never a negative count that no category downstream could hold.
    gaps = gaps.clip(lower=0)

    return pd.Series(
        gaps.to_numpy(), index=ordered["activity_id"].to_numpy(), name="days_since_previous_run"
    ).astype("Int32")
