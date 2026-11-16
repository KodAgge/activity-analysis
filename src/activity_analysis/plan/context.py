"""The facts a training plan is written from, as one JSON document.

Claude reads this before writing or revising a plan, and ``propose`` stores it
beside the version so a cited figure can be resolved later. It computes no
metric of its own: every figure is read through the query and analysis
functions the API already calls, and the predictions, records and trends pass
through the API's own response models, so a figure here and the same figure
in the app cannot disagree.

Local dates are the athlete's calendar days, ``queries.LOCAL_DATE_SQL``'s,
because a plan is written in days and a run at 23:30 belongs to the day it
was run on.
"""

from __future__ import annotations

import math
from datetime import date, datetime, timedelta
from typing import Any

import duckdb

from activity_analysis.analysis.best_efforts import VDOT_DISTANCES_M
from activity_analysis.analysis.consistency import week_end, week_start
from activity_analysis.analysis.fitness import (
    MIN_PREDICTION_DISTANCE_M,
    PREDICTION_WINDOW_DAYS,
    prediction_anchor,
    race_predictions,
)
from activity_analysis.analysis.threshold import zone_boundaries
from activity_analysis.api import queries
from activity_analysis.api.models import (
    Predictions,
    Record,
    ReferencePacesOut,
    TrendPoint,
    Trends,
)
from activity_analysis.plan.models import GoalIndex
from activity_analysis.plan.store import PlanStore

#: How far back the recent runs and the trend points reach: twelve weeks,
#: enough to judge a block of training without handing over the history.
RECENT_DAYS = 84

#: How many weeks of volume the context carries, the current one included.
WEEKLY_WEEKS = 26


def _json_ready(value: Any) -> Any:
    """``value`` with dates as ISO text and non-finite floats as null.

    A NaN in a stored column means no value, and ``json.dumps`` would
    otherwise write it as ``NaN``, which is not JSON.
    """
    if isinstance(value, dict):
        return {key: _json_ready(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_json_ready(item) for item in value]
    if isinstance(value, datetime | date):
        return value.isoformat()
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def _freshness(cur: duckdb.DuckDBPyConnection, today: date) -> dict[str, Any]:
    """The newest run and the newest measured resting heart rate on or before
    today, and how many days old each is.

    A run stamped after today is a wrong device clock, not news, so it does
    not make a stale store look fresh. The resting series comes only with a
    full Garmin export, so it ages while single-run exports keep the runs
    fresh, and TRIMP is then weighed against an older rest or the device
    setting.
    """
    dates = queries.run_local_dates(cur, through=today)
    newest = dates[-1] if dates else None
    resting = queries.resting_hr_measured_through(cur, through=today)
    return {
        "newest_run_local_date": newest,
        "days_since_newest_run": None if newest is None else (today - newest).days,
        "resting_hr_measured_through": resting,
        "days_since_resting_hr": None if resting is None else (today - resting).days,
    }


def _predictions(cur: duckdb.DuckDBPyConnection) -> dict[str, Any]:
    """``/api/predictions``' payload, plus the run its best-effort models came from."""
    efforts = queries.recent_eligible_efforts(cur, window_days=PREDICTION_WINDOW_DAYS)
    served = Predictions.model_validate(
        race_predictions(
            efforts, queries.latest_hr_vo2max_smoothed(cur, window_days=PREDICTION_WINDOW_DAYS)
        )
    ).model_dump(mode="json")
    anchor = prediction_anchor(efforts)
    source = (
        None
        if anchor is None
        else queries.effort_source(
            cur,
            distance_key=str(anchor["distance_key"]),
            elapsed_time_s=float(anchor["elapsed_time_s"]),
        )
    )
    served["anchor"] = (
        None
        if anchor is None or source is None
        else {
            "distance_key": anchor["distance_key"],
            "elapsed_time_s": anchor["elapsed_time_s"],
            "activity_id": source["activity_id"],
            "local_date": source["local_date"],
        }
    )
    served["recent_best_efforts"] = _recent_best_efforts(cur, efforts)
    return served


def _recent_best_efforts(
    cur: duckdb.DuckDBPyConnection, efforts: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """The best effort in the prediction window at each distance of 1 km or more.

    Shortest first, each with the run it came from. These are what a plan's
    estimate rests on, so a distance with no eligible effort is absent.
    """
    out: list[dict[str, Any]] = []
    for effort in efforts:
        if effort["distance_m"] < MIN_PREDICTION_DISTANCE_M:
            continue
        source = queries.effort_source(
            cur,
            distance_key=str(effort["distance_key"]),
            elapsed_time_s=float(effort["elapsed_time_s"]),
        )
        if source is None:
            continue
        out.append(
            {
                "distance_key": effort["distance_key"],
                "distance_m": effort["distance_m"],
                "elapsed_time_s": effort["elapsed_time_s"],
                "activity_id": source["activity_id"],
                "local_date": source["local_date"],
            }
        )
    return out


def _records(cur: duckdb.DuckDBPyConnection) -> list[dict[str, Any]]:
    """The all-time record at each prediction distance, with the fitness of its day.

    The prediction distances are the ones ``race_predictions`` serves, so a
    record and a prediction at the same distance can be set side by side.
    """
    prediction_keys = {
        key for key, metres in VDOT_DISTANCES_M.items() if metres >= MIN_PREDICTION_DISTANCE_M
    }
    out: list[dict[str, Any]] = []
    for row in queries.records(cur):
        if row["distance_key"] not in prediction_keys:
            continue
        record = Record.model_validate(row).model_dump(mode="json")
        record["local_date"] = row["local_date"]
        record["fitness_then"] = queries.fitness_on(cur, on=row["local_date"])
        out.append(record)
    return out


def _trends(cur: duckdb.DuckDBPyConnection, since: date, through: date) -> dict[str, Any]:
    """``/api/trends``' payload with only the points from ``since`` through ``through``."""
    fit, rows = queries.trends(cur, since=since, through=through)
    shared = fit or {}
    return Trends(
        references=ReferencePacesOut(
            slow_mps=shared.get("ref_slow_mps"),
            median_mps=shared.get("ref_median_mps"),
            fast_mps=shared.get("ref_fast_mps"),
        ),
        hr_slope_shared_bpm_per_mps=shared.get("hr_slope_shared_bpm_per_mps"),
        cadence_slope_shared_spm_per_mps=shared.get("cadence_slope_shared_spm_per_mps"),
        items=[TrendPoint.model_validate(row) for row in rows],
    ).model_dump(mode="json")


def _zones(cur: duckdb.DuckDBPyConnection, today: date) -> dict[str, Any] | None:
    """The threshold estimate at the newest run, its zone edges and the athlete's
    TRIMP per minute in each zone over the last 84 days, or None."""
    now = queries.threshold_now(cur)
    if now is None:
        return None
    return {
        **now,
        "boundaries_bpm": zone_boundaries(float(now["lthr_bpm"])),
        "trimp_per_minute": queries.trimp_per_minute_by_zone(
            cur, since=today - timedelta(days=RECENT_DAYS), through=today
        ),
    }


def _weekly(
    cur: duckdb.DuckDBPyConnection, *, today: date, first_week: date
) -> list[dict[str, Any]]:
    """Weekly volume with each week's TRIMP and minutes per estimated zone.

    Both are null for a week of runs without heart rate, as ``weekly_load``
    reports it.
    """
    loads = {
        row["period_start"]: row
        for row in queries.weekly_load(cur, since=first_week, through=week_end(today))
    }
    out: list[dict[str, Any]] = []
    for row in queries.volume_by_period(cur, "week", through=week_end(today), today=today):
        if row["period_start"] < first_week:
            continue
        load = loads.get(row["period_start"], {})
        out.append({**row, "trimp": load.get("trimp"), "zone_minutes": load.get("zone_minutes")})
    return out


def _plan_goal(store: PlanStore) -> GoalIndex | None:
    """The active goal, else the newest goal with a version awaiting a verdict."""
    active = store.active_goal()
    if active is not None:
        return active
    return next((g for g in store.goals() if store.pending(g.goal_id) is not None), None)


def _pending_new_goal(store: PlanStore, goal_id: str) -> dict[str, Any] | None:
    """The newest proposal for a goal other than ``goal_id`` that is not yet under way.

    Without it, re-running the skill while one goal is active and a new one
    awaits a verdict would propose blind to the proposal already made.
    """
    for goal in store.goals():
        if goal.goal_id == goal_id or goal.status != "proposed":
            continue
        pending = store.pending(goal.goal_id)
        if pending is not None:
            return pending.model_dump(mode="json")
    return None


def _plan(store: PlanStore) -> dict[str, Any] | None:
    goal = _plan_goal(store)
    if goal is None:
        return None
    accepted = store.accepted(goal.goal_id)
    pending = store.pending(goal.goal_id)
    return {
        "goal_id": goal.goal_id,
        "accepted": None if accepted is None else accepted.model_dump(mode="json"),
        "pending": None if pending is None else pending.model_dump(mode="json"),
        "pending_new_goal": _pending_new_goal(store, goal.goal_id),
    }


def build_context(
    cur: duckdb.DuckDBPyConnection, *, today: date, store: PlanStore
) -> dict[str, Any]:
    """Everything Claude plans from, as of ``today``, ready for ``json.dumps``.

    ``today`` is a parameter rather than read from the clock so that a test
    can stand at any distance from the newest run, and so that the CLI states
    the one date every window here is measured from.
    """
    since = today - timedelta(days=RECENT_DAYS)
    first_week = week_start(today) - timedelta(weeks=WEEKLY_WEEKS - 1)
    context = {
        "generated_for": today,
        "freshness": _freshness(cur, today),
        "profile": {
            "max_hr_bpm": queries.current_max_hr_bpm(cur),
            "zone_boundaries_bpm": queries.current_zone_boundaries(cur),
        },
        "recent_runs": queries.recent_runs(cur, since=since, through=today),
        "weekly": _weekly(cur, today=today, first_week=first_week),
        "zones": _zones(cur, today),
        "load": [
            {k: v for k, v in row.items() if k != "distance_m"}
            for row in queries.load_days(cur, since=since, through=today)
        ],
        "predictions": _predictions(cur),
        "records": _records(cur),
        "fitness_now": queries.fitness_on(cur, on=today),
        "trends": _trends(cur, since, today),
        "plan": _plan(store),
    }
    ready: dict[str, Any] = _json_ready(context)
    return ready
