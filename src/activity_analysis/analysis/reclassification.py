"""Count an activity recorded as a run, but slower than any run, as a walk.

The watch records whatever profile the athlete started, so a walk started on
the running profile arrives as a run and reaches every running analysis: its
distance in the week's volume, its efforts on the records charts, its length
in the long-run threshold of the runs around it. ``recompute`` judges every
run here once its grid exists, and one that fails gets a row in
``sport_reclassifications`` and nothing else from the derived layer.

The rule lives in the derived layer rather than rewriting ``sport`` at
ingestion because it reads the grid's moving time, which only ``recompute``
computes, and so that a change of threshold is a rebuild rather than a
re-ingest. Canonical stays what the device recorded.

``docs/reference/math/reclassification.md`` has the threshold's measurement
and the rejected alternatives.
"""

from __future__ import annotations

import math

#: What a reclassified activity is counted as.
WALK_SPORT = "walking"

#: 9:00/km. Chosen by the maintainer on 2026-10-02 and confirmed against the
#: store: the slowest activity left a run takes 12% less time per kilometre
#: than the threshold and the fastest one counted as a walk 3.5% more, with
#: nothing between them.
WALK_THRESHOLD_MPS = 1000.0 / 540.0


def is_walk(avg_speed_mps: float | None) -> bool:
    """Whether a run's average moving speed is a walker's.

    ``avg_speed_mps`` is ``activity_metrics.avg_speed_mps``: the canonical
    distance over the grid's moving time, the same figure the efficiency fit
    tells a walk from a run by. Moving rather than elapsed, because a run with
    long stops is still a run. Null, the case of a zero distance or a zero
    moving time, cannot be judged, so the activity stays a run.
    """
    if avg_speed_mps is None or math.isnan(avg_speed_mps):
        return False
    return avg_speed_mps < WALK_THRESHOLD_MPS
