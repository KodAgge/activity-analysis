"""The activity browser.

The list covers every sport, not only running. Runs are a minority of the
real export, and a browser that hid everything else would answer a different
question from the one the user asks it, which is what did I do. The sport
filter defaults to running because that is the training this application is
about, and turning it off is one click away.
"""

from __future__ import annotations

import math
from datetime import date
from typing import Annotated, Any, Literal

from fastapi import APIRouter, HTTPException, Query

from activity_analysis.analysis.efficiency import (
    AEROBIC_TAGS,
    EXCLUDED_EFFORT_TAG,
    MIN_AEROBIC_LONG_RUN_SECONDS,
    MIN_DECOUPLING_SECONDS,
    MIN_FIT_MOVING_SPEED_MPS,
)
from activity_analysis.analysis.pipeline import RUNNING_SPORT
from activity_analysis.analysis.reclassification import WALK_THRESHOLD_MPS
from activity_analysis.api import queries
from activity_analysis.api.deps import CursorDep, PathsDep
from activity_analysis.api.models import (
    ActivityDetail,
    ActivityMetrics,
    ActivityPage,
    ActivityRoute,
    ActivitySummary,
    ActivityTag,
    BestEffort,
    DecouplingOut,
    DerivedBlocks,
    Lap,
    Reclassification,
    SportCount,
    Streams,
    ZoneBucket,
)
from activity_analysis.store.db import read_grid

router = APIRouter(tags=["activities"])

#: The same constant ``recompute`` filters on, so the browser's default filter
#: cannot go on sending a string the rest of the system has stopped meaning.
DEFAULT_SPORT = RUNNING_SPORT


@router.get("/api/sports")
def sports(cur: CursorDep) -> list[SportCount]:
    """Sport values with counts, so the frontend does not hardcode a list."""
    return [SportCount(**row) for row in queries.sport_counts(cur)]


@router.get("/api/activities")
def activities(
    cur: CursorDep,
    sport: Annotated[
        str,
        Query(
            description=(
                f"A sport value from /api/sports. '{queries.ALL_SPORTS}' turns the "
                f"filter off; '{queries.UNKNOWN_SPORT}' selects the activities whose "
                "sport is null, which is what /api/sports reports as a null bucket."
            )
        ),
    ] = DEFAULT_SPORT,
    start: Annotated[
        date | None,
        Query(
            alias="from",
            description=(
                "Inclusive lower bound, compared against the activity's local "
                "calendar date rather than its UTC instant: a run belongs to the "
                "day the athlete ran it."
            ),
        ),
    ] = None,
    end: Annotated[
        date | None,
        Query(
            alias="to",
            description=(
                "Exclusive upper bound, compared against the activity's local "
                "calendar date rather than its UTC instant. To cover through the "
                "31st, send the 1st of the next month."
            ),
        ),
    ] = None,
    source: Literal["garmin_fit", "strava_fit", "gpx"] | None = None,
    has_hr: bool | None = None,
    q: Annotated[
        str | None,
        Query(
            description=(
                "Substring of the activity name. A convenience only: names are "
                "Strava's Swedish defaults and collide freely, so this narrows a "
                "list and never identifies an activity."
            )
        ),
    ] = None,
    min_distance_m: Annotated[
        float | None,
        Query(
            ge=0,
            description=(
                "Inclusive lower bound on the activity's own distance, in metres. "
                "SI at this boundary like every other quantity: a kilometre input "
                "belongs in the client that renders kilometres."
            ),
        ),
    ] = None,
    max_distance_m: Annotated[
        float | None, Query(ge=0, description="Inclusive upper bound, in metres.")
    ] = None,
    min_moving_time_s: Annotated[
        float | None,
        Query(
            ge=0,
            description=(
                "Inclusive lower bound on the derived moving time, in seconds - "
                "elapsed minus this project's own paused time, the same column the "
                "list renders and sorts by, not the device's auto-paused timer. An "
                "activity with no derived layer has no moving time to compare and "
                "falls out of this filter rather than being coerced into passing "
                "it: that is every non-running activity and every run not yet "
                "recomputed."
            ),
        ),
    ] = None,
    max_moving_time_s: Annotated[
        float | None, Query(ge=0, description="Inclusive upper bound, in seconds.")
    ] = None,
    has_pr: Annotated[
        bool | None,
        Query(
            description=(
                "True selects only activities that set a personal record at some "
                "distance, false only those that set none. The analysis layer "
                "decides what a record is - see GET /api/records."
            )
        ),
    ] = None,
    sort: Literal[
        "start_time_utc",
        "distance_m",
        "elapsed_time_s",
        "moving_time_s",
        "avg_speed_mps",
        "avg_hr_bpm",
    ] = "start_time_utc",
    order: Literal["desc", "asc"] = "desc",
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> ActivityPage:
    """One page of the browser.

    Ordered by instant rather than by local wall clock, which are not the same
    order across an offset change: sorting by wall clock would put a run
    recorded at 09:00 in New York after one recorded at 10:00 in Jönköping
    that happened five hours earlier.
    """
    total, rows = queries.activity_page(
        cur,
        sport=None if sport == queries.ALL_SPORTS else sport,
        start=start,
        end=end,
        source=source,
        has_hr=has_hr,
        q=q,
        min_distance_m=min_distance_m,
        max_distance_m=max_distance_m,
        min_moving_time_s=min_moving_time_s,
        max_moving_time_s=max_moving_time_s,
        has_pr=has_pr,
        sort=sort,
        descending=order == "desc",
        limit=limit,
        offset=offset,
    )
    return ActivityPage(
        total=total,
        limit=limit,
        offset=offset,
        items=[ActivitySummary(**row) for row in rows],
    )


#: The normal case, and not a fault: the derived layer covers running only,
#: so most of the store is outside it by design.
NOT_A_RUN = (
    "the derived layer covers running only and this activity is not recorded "
    "as a run, so it has no metrics, zone distribution or best efforts"
)

#: A run without a derived layer, which is a state of the store rather than a
#: property of the activity. Three paths lead here - never recomputed, skipped
#: for having no stream, or failed during the rebuild - and the store cannot
#: tell them apart afterwards, so neither does this sentence.
RUN_WITHOUT_A_DERIVED_LAYER = (
    "this run has no derived layer: either 'activity-analysis recompute' has "
    "not been run since it was ingested, or the rebuild skipped or failed on it"
)


_WALK_THRESHOLD_MIN, _WALK_THRESHOLD_S = divmod(round(1000.0 / WALK_THRESHOLD_MPS), 60)

#: A run ``recompute`` judged and counted as a walk, which is a decision about
#: the activity rather than a state of the store.
COUNTED_AS_A_WALK = (
    "this activity was recorded as a run but is counted as a walk, its moving "
    f"pace being slower than {_WALK_THRESHOLD_MIN}:{_WALK_THRESHOLD_S:02d}/km, so it "
    "has no metrics, zone distribution or best efforts"
)


def derived_absent_reason(sport: str | None, recorded_sport: str | None) -> str:
    """Why an activity has no derived layer, from the sport it counts as and the recorded one.

    Both routes read the wording from here. Saying "the derived layer covers
    running only" of an activity whose sport was never looked at would assert
    a cause nobody checked, which is the same defect the stream route's 404
    already avoids between an unknown id and a known one. A walk recorded as a
    run is neither of the other two: it is not recorded as anything but a run,
    and recompute did reach it.
    """
    if sport == RUNNING_SPORT:
        return RUN_WITHOUT_A_DERIVED_LAYER
    if recorded_sport == RUNNING_SPORT:
        return COUNTED_AS_A_WALK
    return NOT_A_RUN


_WALK_PACE_MIN, _WALK_PACE_S = divmod(round(1000.0 / MIN_FIT_MOVING_SPEED_MPS), 60)

#: Why a run has no decoupling value. Tested in this order, so the first
#: fact that applies names the run; the counts are the real store's on
#: 2026-10-03.
#: 82 runs.
DECOUPLING_INDOORS = (
    "A treadmill run: its speed is a footpod estimate, so the efficiency fit "
    "that decoupling belongs to leaves it out."
)
#: 12 runs.
DECOUPLING_INTERVALS = "An interval session, which the efficiency fit leaves out."
#: 53 runs.
DECOUPLING_NO_HEART_RATE = (
    "No heart rate was recorded, and decoupling compares heart rate with pace."
)
#: 10 runs.
DECOUPLING_TOO_SHORT = (
    f"Under {MIN_DECOUPLING_SECONDS // 60} minutes of moving time, too short to split "
    "into two halves worth comparing."
)
#: None today: the one outdoor run with heart rate under walking pace is too short first,
#: so the reason above names it.
DECOUPLING_WALK = (
    f"An average moving pace slower than {_WALK_PACE_MIN}:{_WALK_PACE_S:02d}/km, "
    "which the efficiency fit leaves out as a walk."
)
#: A store written before ANALYSIS_VERSION 12: the percentage is stored and
#: its halves are not. Tested before every other fact, because the run may
#: well have a value the store cannot show yet.
DECOUPLING_NOT_RECOMPUTED = (
    "This run's halves are not known until 'activity-analysis recompute' rewrites the store."
)
#: None today. The fallback when every fact above allows a value.
DECOUPLING_TOO_FEW_SECONDS = (
    f"Fewer than {MIN_DECOUPLING_SECONDS // 60} minutes carrying both speed and heart rate, "
    "too few to split into two halves worth comparing."
)

_AEROBIC_RULE = (
    "aerobic durability is read on easy or steady runs of "
    f"{MIN_AEROBIC_LONG_RUN_SECONDS // 60} minutes or more"
)
#: Why a run with a value is not a durability reading. 62 runs.
OUTSIDE_ALL_OUT = (
    f"An all-out session, so this measures the session rather than the athlete: {_AEROBIC_RULE}."
)
#: 57 runs.
OUTSIDE_SHORT = (
    f"Under {MIN_AEROBIC_LONG_RUN_SECONDS // 60} fitted minutes, so this measures the session "
    f"rather than the athlete: {_AEROBIC_RULE}."
)
#: 2 runs.
OUTSIDE_UNTAGGED = (
    "This run has no effort classification, so it cannot be shown to have been easy or "
    f"steady: {_AEROBIC_RULE}."
)
#: An effort tag the classifier may add later. None today.
OUTSIDE_NOT_EASY_OR_STEADY = (
    f"Not an easy or steady run, so this measures the session rather than the athlete: "
    f"{_AEROBIC_RULE}."
)
#: A store written before is_aerobic_long_run existed.
OUTSIDE_UNKNOWN = (
    "Whether this run is one durability is read on is not known until "
    "'activity-analysis recompute' rewrites the store."
)

_HALVES = (
    "decoupling_first_speed_mps",
    "decoupling_second_speed_mps",
    "decoupling_first_hr_bpm",
    "decoupling_second_hr_bpm",
)


def _finite(value: object) -> bool:
    return isinstance(value, (int, float)) and math.isfinite(value)


def decoupling_absent_reason(facts: dict[str, Any]) -> str:
    """Why a run has no decoupling value, from the stored facts that decide it.

    Only an explicit True or False names a reason: a null flag is not known,
    and saying "no heart rate was recorded" of a run nobody checked would
    assert a cause.
    """
    if _finite(facts["decoupling_pct"]) and not all(_finite(facts[c]) for c in _HALVES):
        return DECOUPLING_NOT_RECOMPUTED
    if facts["is_indoor"] is True:
        return DECOUPLING_INDOORS
    if facts["effort_tag"] == EXCLUDED_EFFORT_TAG:
        return DECOUPLING_INTERVALS
    if facts["has_hr"] is False:
        return DECOUPLING_NO_HEART_RATE
    moving = facts["moving_time_s"]
    if _finite(moving) and moving < MIN_DECOUPLING_SECONDS:
        return DECOUPLING_TOO_SHORT
    speed = facts["avg_speed_mps"]
    if _finite(speed) and speed < MIN_FIT_MOVING_SPEED_MPS:
        return DECOUPLING_WALK
    return DECOUPLING_TOO_FEW_SECONDS


def outside_population_reason(
    is_aerobic_long_run: bool | None, effort_tag: str | None
) -> str | None:
    """Why a run's decoupling is not a durability reading, or None when it is."""
    if is_aerobic_long_run is True:
        return None
    if is_aerobic_long_run is None:
        return OUTSIDE_UNKNOWN
    if effort_tag is None:
        return OUTSIDE_UNTAGGED
    if effort_tag in AEROBIC_TAGS:
        return OUTSIDE_SHORT
    if effort_tag == "all_out":
        return OUTSIDE_ALL_OUT
    return OUTSIDE_NOT_EASY_OR_STEADY


def decoupling_block(facts: dict[str, Any]) -> tuple[DecouplingOut | None, str | None]:
    """The served decoupling, or the reason there is none; never both."""
    values = [facts["decoupling_pct"], *(facts[column] for column in _HALVES)]
    if not all(_finite(value) for value in values):
        return None, decoupling_absent_reason(facts)
    pct, first_speed, second_speed, first_hr, second_hr = values
    return (
        DecouplingOut(
            decoupling_pct=pct,
            first_half_speed_mps=first_speed,
            second_half_speed_mps=second_speed,
            first_half_hr_bpm=first_hr,
            second_half_hr_bpm=second_hr,
            is_aerobic_long_run=facts["is_aerobic_long_run"],
            outside_population_reason=outside_population_reason(
                facts["is_aerobic_long_run"], facts["effort_tag"]
            ),
        ),
        None,
    )


@router.get("/api/activities/{activity_id}")
def activity(cur: CursorDep, activity_id: str) -> ActivityDetail:
    """Everything known about one activity.

    Declared after ``/api/activities`` so the literal path is matched before
    this parameterised one; FastAPI matches in declaration order.
    """
    summary = queries.activity_summary(cur, activity_id)
    if summary is None:
        raise HTTPException(status_code=404, detail=f"no such activity: {activity_id}")

    metrics, zones, efforts = queries.derived_blocks(cur, activity_id)
    facts = queries.decoupling_facts(cur, activity_id) if metrics is not None else None
    decoupling, decoupling_absent = decoupling_block(facts) if facts is not None else (None, None)
    derived = (
        DerivedBlocks(
            metrics=ActivityMetrics(**metrics),
            zones=[ZoneBucket(**zone) for zone in zones],
            best_efforts=[BestEffort(**effort) for effort in efforts],
            tags=[ActivityTag(**row) for row in queries.activity_tags(cur, activity_id)],
            decoupling=decoupling,
            decoupling_absent_reason=decoupling_absent,
        )
        if metrics is not None
        else None
    )
    route_row = queries.activity_route(cur, activity_id)
    reclassified = queries.reclassification(cur, activity_id)
    return ActivityDetail(
        summary=ActivitySummary(**summary),
        laps=[Lap(**lap) for lap in queries.laps(cur, activity_id)],
        derived=derived,
        derived_absent_reason=(
            None
            if derived is not None
            else derived_absent_reason(summary["sport"], summary["recorded_sport"])
        ),
        reclassification=Reclassification(**reclassified) if reclassified is not None else None,
        route=ActivityRoute(**route_row) if route_row is not None else None,
    )


#: The grid columns the frontend plots. ``activity_id`` is in the file too,
#: and is not repeated once per sample.
CHANNELS = (
    "t_s",
    "distance_m",
    "speed_mps",
    "hr_bpm",
    "cadence_spm",
    "altitude_m",
    "lat_deg",
    "lon_deg",
    "paused",
    "outage",
)


@router.get("/api/activities/{activity_id}/streams")
def streams(cur: CursorDep, paths: PathsDep, activity_id: str) -> Streams:
    """The 1 Hz grid, at full resolution.

    Reads the activity's own Parquet file rather than filtering the
    ``streams_1hz`` glob, which is several times slower because the glob opens
    every file's footer to answer a predicate on a column stored inside them;
    see ``store.db.read_grid``. The cursor is only consulted when there is no
    such file, to say which of the two absences this is.

    Raw ``records`` are deliberately not served in place of a missing grid.
    The grid is where pauses and outages are flagged and where distance is
    guaranteed monotonic, so a chart drawn from raw records would be a
    different, noisier picture of the same run presented as the same thing.
    """
    try:
        table = read_grid(paths, activity_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if table is None:
        # An unknown id, a run the rebuild has not reached, and an activity of
        # another sport are three different facts. A body that named any of
        # them while meaning another would assert a reason nobody checked.
        stored, sport, recorded_sport = queries.stored_sport(cur, activity_id)
        detail = (
            f"no 1 Hz grid for {activity_id}: {derived_absent_reason(sport, recorded_sport)}"
            if stored
            else f"no such activity: {activity_id}"
        )
        raise HTTPException(status_code=404, detail=detail)
    columns = {name: table.column(name).to_pylist() for name in CHANNELS}
    return Streams(activity_id=activity_id, sample_count=table.num_rows, **columns)
