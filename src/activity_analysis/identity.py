"""Content-derived activity identity.

Filenames and activity names are not identifiers. Strava assigns default
names by time of day, so a history contains many activities called
"Löpning på kvällen", and browsers append "(1)" to colliding downloads.

Measured quantities are not identifiers either. Different exports of one run
disagree on distance by a metre or so, which is enough to fall either side of
any fixed bucket edge. Only the start time is taken verbatim from the device
by every source, so only it is hashed; everything else is reconciled with a
tolerance.

Maths: ``docs/reference/math/identity.md`` quantifies the bucket-edge argument,
derives the symmetric relative-difference metric, and records the one property
the reconciliation relation lacks.
"""

from __future__ import annotations

import hashlib
from datetime import datetime

import pandas as pd

from activity_analysis.models import SOURCE_PRIORITY

#: Start times are floored into buckets of this many seconds before hashing.
START_BUCKET_S = 60
#: Two recordings starting this close together may be the same run.
MATCH_WINDOW_S = 90.0
#: Fractional distance disagreement tolerated when reconciling.
MATCH_DISTANCE_TOLERANCE = 0.02


def compute_activity_id(athlete_id: str, start_time_utc: datetime) -> str:
    """A provisional 16-character identity for one recorded session."""
    minute = int(start_time_utc.timestamp()) // START_BUCKET_S
    return hashlib.sha256(f"{athlete_id}|{minute}".encode()).hexdigest()[:16]


def find_matching_activity(
    existing: pd.DataFrame,
    athlete_id: str,
    start_time_utc: datetime,
    distance_m: float | None,
) -> str | None:
    """The id of a stored activity that is the same run, if there is one.

    ``existing`` needs the columns ``activity_id``, ``athlete_id``,
    ``start_time_utc`` and ``distance_m``.
    """
    if existing.empty:
        return None

    candidates = existing[existing["athlete_id"] == athlete_id]
    if candidates.empty:
        return None

    start = pd.Timestamp(start_time_utc)
    offsets = (candidates["start_time_utc"] - start).abs().dt.total_seconds()
    candidates = candidates[offsets <= MATCH_WINDOW_S]
    if candidates.empty:
        return None

    if distance_m is not None:

        def compatible(other: float | None) -> bool:
            if other is None or pd.isna(other):
                return True
            scale = max(abs(float(other)), abs(distance_m), 1.0)
            return abs(float(other) - distance_m) / scale <= MATCH_DISTANCE_TOLERANCE

        candidates = candidates[candidates["distance_m"].map(compatible)]
        if candidates.empty:
            return None

    return str(candidates.iloc[0]["activity_id"])


def wins(candidate_source: str, incumbent_source: str) -> bool:
    """Whether ``candidate_source`` should displace ``incumbent_source``.

    Ties keep the incumbent, so re-ingesting an equivalent file is inert.
    """
    return SOURCE_PRIORITY.get(candidate_source, 0) > SOURCE_PRIORITY.get(incumbent_source, 0)


def displaces(candidate_source: str, incumbent_source: str, *, force: bool = False) -> bool:
    """Whether the candidate should replace the incumbent, honouring ``force``.

    Under ``force`` a tie displaces rather than keeping the incumbent. The
    operator has asked for the work to be redone, and a reprocess that then
    discards its own result is not a reprocess. Priority still holds across
    sources: forcing does not make a GPX richer than the FIT of the same run.
    """
    if wins(candidate_source, incumbent_source):
        return True
    return force and SOURCE_PRIORITY.get(candidate_source, 0) == SOURCE_PRIORITY.get(
        incumbent_source, 0
    )
