"""The context a training plan is written from, against the ingested fixtures.

Every figure in it is one the app already serves, so the tests compare it with
the endpoint or the stored table it comes from rather than with a number.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import duckdb
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from activity_analysis.analysis.fitness import PREDICTION_WINDOW_DAYS, prediction_anchor
from activity_analysis.analysis.pipeline import recompute
from activity_analysis.api import queries
from activity_analysis.config import Paths
from activity_analysis.plan.context import build_context
from activity_analysis.plan.store import PlanStore
from activity_analysis.store.db import connect
from activity_analysis.store.writer import (
    read_activities,
    read_best_efforts,
    read_fitness_series,
    upsert_activities,
)
from tests.test_pipeline_threshold import write_resting, write_store
from tests.test_plan_models import five_week_draft


@pytest.fixture
def cur(ingested_store: Paths) -> Iterator[duckdb.DuckDBPyConnection]:
    con = connect(ingested_store)
    try:
        yield con
    finally:
        con.close()


def _local_dates(paths: Paths) -> pd.Series:
    """Each stored activity's local date, computed here rather than in SQL."""
    stored = read_activities(paths)
    offsets = pd.to_timedelta(stored["utc_offset_s"].fillna(0), unit="s")
    local = (stored["start_time_utc"].dt.tz_convert("UTC") + offsets).dt.date
    return pd.Series(local.to_numpy(), index=stored["activity_id"].to_numpy())


def _newest_run(paths: Paths) -> date:
    return max(_local_dates(paths))


def _context(cur: duckdb.DuckDBPyConnection, paths: Paths, today: date) -> dict[str, Any]:
    return build_context(cur, today=today, store=PlanStore(paths))


def test_context_predictions_equal_what_the_api_serves(
    cur: duckdb.DuckDBPyConnection, ingested_store: Paths, api_client: TestClient
) -> None:
    context = _context(cur, ingested_store, _newest_run(ingested_store) + timedelta(days=1))
    served = api_client.get("/api/predictions").json()
    assert served["items"], "the fixtures must produce predictions for this to mean anything"
    assert context["predictions"]["items"] == served["items"]
    assert context["predictions"]["insufficient_data"] == served["insufficient_data"]
    assert context["predictions"]["reason"] == served["reason"]


def test_the_anchor_is_the_effort_race_predictions_extrapolates_from(
    cur: duckdb.DuckDBPyConnection, ingested_store: Paths
) -> None:
    context = _context(cur, ingested_store, _newest_run(ingested_store) + timedelta(days=1))
    expected = prediction_anchor(
        queries.recent_eligible_efforts(cur, window_days=PREDICTION_WINDOW_DAYS)
    )
    assert expected is not None
    anchor = context["predictions"]["anchor"]
    assert anchor["elapsed_time_s"] == expected["elapsed_time_s"]
    assert anchor["distance_key"] == expected["distance_key"]

    efforts = read_best_efforts(ingested_store)
    held = efforts[
        (efforts["activity_id"] == anchor["activity_id"])
        & (efforts["distance_key"] == anchor["distance_key"])
    ]
    assert list(held["elapsed_time_s"]) == [anchor["elapsed_time_s"]]
    assert anchor["local_date"] == _local_dates(ingested_store)[anchor["activity_id"]].isoformat()


def test_context_records_carry_the_fitness_in_force_on_their_day(
    cur: duckdb.DuckDBPyConnection, ingested_store: Paths
) -> None:
    context = _context(cur, ingested_store, _newest_run(ingested_store) + timedelta(days=1))
    local = _local_dates(ingested_store)
    series = read_fitness_series(ingested_store)
    series["local_date"] = [local[a] for a in series["activity_id"]]
    series = series.sort_values(["start_time_utc", "activity_id"])

    assert context["records"], "the fixtures must hold records for this to mean anything"
    assert all(record["distance_m"] >= 1000.0 for record in context["records"])
    checked = 0
    for record in context["records"]:
        day = date.fromisoformat(record["local_date"])
        assert day == local[record["activity_id"]]
        then = series[series["local_date"] <= day].iloc[-1]
        assert record["fitness_then"]["vdot"] == then["vdot"]
        assert record["fitness_then"]["hr_vo2max_smoothed"] == then["hr_vo2max_smoothed"]
        checked += record["fitness_then"]["vdot"] is not None
    assert checked, "at least one record must carry a VDOT"


def test_fitness_on_a_day_before_any_run_is_all_none(cur: duckdb.DuckDBPyConnection) -> None:
    assert queries.fitness_on(cur, on=date(2000, 1, 1)) == {
        "hr_vo2max_smoothed": None,
        "vdot": None,
        "garmin_vo2max": None,
    }


def test_context_reports_how_old_the_newest_run_is(
    cur: duckdb.DuckDBPyConnection, ingested_store: Paths
) -> None:
    newest = _newest_run(ingested_store)
    context = _context(cur, ingested_store, newest + timedelta(days=10))
    assert context["generated_for"] == (newest + timedelta(days=10)).isoformat()
    # The fixtures are single-run files, which carry no resting heart rate.
    assert context["freshness"] == {
        "newest_run_local_date": newest.isoformat(),
        "days_since_newest_run": 10,
        "resting_hr_measured_through": None,
        "days_since_resting_hr": None,
    }
    # Ten days on, every fixture run is still inside the 84-day window.
    assert len(context["recent_runs"]) == len(_local_dates(ingested_store))


def test_recent_runs_files_a_late_evening_run_under_its_local_day(
    ingested_store: Paths,
) -> None:
    """22:30Z at +01:00 is 23:30 on the 28th; 23:30Z is half past midnight on the 29th.

    The session runs in a timezone far from UTC so that a local date taken
    from the session's own rendering of the instant would land on the wrong
    day for both.
    """
    stored = read_activities(ingested_store)
    late, later = (str(a) for a in stored["activity_id"].iloc[:2])
    for activity_id, instant in ((late, "2026-03-28T22:30:00Z"), (later, "2026-03-28T23:30:00Z")):
        row = stored["activity_id"] == activity_id
        stored.loc[row, "start_time_utc"] = pd.Timestamp(instant)
        stored.loc[row, "utc_offset_s"] = 3600
    upsert_activities(ingested_store, stored)

    con = connect(ingested_store)
    try:
        con.execute("SET TimeZone = 'Pacific/Auckland'")
        rows = queries.recent_runs(con, since=date(2026, 3, 28), through=date(2026, 3, 29))
        through_first = queries.recent_runs(con, since=date(2026, 3, 28), through=date(2026, 3, 28))
    finally:
        con.close()
    days = {row["activity_id"]: row["local_date"] for row in rows}
    assert days[late] == date(2026, 3, 28)
    assert days[later] == date(2026, 3, 29)
    # A run after ``through`` is left out, as the context's freshness leaves it out.
    assert [row["activity_id"] for row in through_first] == [late]
    assert [row["local_date"] for row in rows] == sorted(row["local_date"] for row in rows)


def test_recent_runs_carry_the_fields_a_plan_is_judged_on(
    cur: duckdb.DuckDBPyConnection, ingested_store: Paths
) -> None:
    rows = queries.recent_runs(cur, since=date(2000, 1, 1), through=date(2100, 1, 1))
    assert len(rows) == len(_local_dates(ingested_store))
    for row in rows:
        assert set(row) == {
            "activity_id",
            "local_date",
            "distance_m",
            "moving_time_s",
            "avg_speed_mps",
            "avg_hr_bpm",
            "indoor",
            "tags",
            "zone_time_s",
            "decoupling_pct",
            "trimp",
            "rest_from_setting",
            "estimated_zone_s",
        }
        assert isinstance(row["tags"], list) and row["tags"]
        assert isinstance(row["zone_time_s"], list)
    assert any(row["zone_time_s"] for row in rows)


def test_context_trends_are_the_served_trends_of_the_last_twelve_weeks(
    cur: duckdb.DuckDBPyConnection, ingested_store: Paths, api_client: TestClient
) -> None:
    newest = _newest_run(ingested_store)
    served = api_client.get("/api/trends").json()
    context = _context(cur, ingested_store, newest + timedelta(days=1))
    assert context["trends"]["references"] == served["references"]
    assert context["trends"]["items"] == served["items"]

    far = _context(cur, ingested_store, newest + timedelta(days=200))
    assert far["trends"]["references"] == served["references"]
    assert far["trends"]["items"] == []


def test_context_weekly_volume_is_26_weeks_ending_with_today(
    cur: duckdb.DuckDBPyConnection, ingested_store: Paths
) -> None:
    today = _newest_run(ingested_store) + timedelta(days=3)
    weekly = _context(cur, ingested_store, today)["weekly"]
    starts = [date.fromisoformat(week["period_start"]) for week in weekly]
    this_monday = today - timedelta(days=today.weekday())
    assert starts[-1] == this_monday
    assert len(starts) <= 26
    assert starts[0] >= this_monday - timedelta(weeks=25)
    assert sum(week["runs"] for week in weekly) == len(_local_dates(ingested_store))


def test_context_is_json_serialisable(
    cur: duckdb.DuckDBPyConnection, ingested_store: Paths
) -> None:
    context = _context(cur, ingested_store, _newest_run(ingested_store) + timedelta(days=1))
    assert set(context) == {
        "generated_for",
        "freshness",
        "profile",
        "zones",
        "load",
        "recent_runs",
        "weekly",
        "predictions",
        "records",
        "fitness_now",
        "trends",
        "plan",
    }
    json.dumps(context, allow_nan=False)
    assert context["plan"] is None
    assert context["profile"]["max_hr_bpm"] is not None
    assert context["profile"]["zone_boundaries_bpm"] == queries.current_zone_boundaries(cur)


def test_context_carries_the_active_plan(
    cur: duckdb.DuckDBPyConnection, ingested_store: Paths
) -> None:
    today = _newest_run(ingested_store) + timedelta(days=1)
    store = PlanStore(ingested_store)
    draft = five_week_draft(goal=five_week_draft().goal.model_dump() | {"goal_id": "5k-2027-03-13"})
    store.propose(
        draft,
        build_context(cur, today=today, store=store),
        now=datetime(2026, 11, 14, 12, 0, tzinfo=UTC),
    )

    context = build_context(cur, today=today, store=store)
    assert context["plan"]["goal_id"] == "5k-2027-03-13"
    assert context["plan"]["accepted"] is None
    assert context["plan"]["pending"]["goal"]["goal_id"] == "5k-2027-03-13"
    assert context["plan"]["pending_new_goal"] is None
    json.dumps(context, allow_nan=False)

    store.accept("5k-2027-03-13")
    accepted = build_context(cur, today=today, store=store)["plan"]
    assert accepted["accepted"]["goal"]["goal_id"] == "5k-2027-03-13"
    assert accepted["pending"] is None


def test_context_shows_a_new_goal_proposed_while_another_is_active(
    cur: duckdb.DuckDBPyConnection, ingested_store: Paths
) -> None:
    today = _newest_run(ingested_store) + timedelta(days=1)
    store = PlanStore(ingested_store)
    base = five_week_draft().goal.model_dump()
    now = datetime(2026, 11, 14, 12, 0, tzinfo=UTC)
    store.propose(
        five_week_draft(goal=base | {"goal_id": "5k-2027-03-13"}),
        build_context(cur, today=today, store=store),
        now=now,
    )
    store.accept("5k-2027-03-13")
    store.propose(
        five_week_draft(goal=base | {"goal_id": "10k-2027-03-01"}),
        build_context(cur, today=today, store=store),
        now=now + timedelta(days=1),
    )

    plan = build_context(cur, today=today, store=store)["plan"]
    assert plan["goal_id"] == "5k-2027-03-13"
    assert plan["accepted"]["goal"]["goal_id"] == "5k-2027-03-13"
    assert plan["pending"] is None
    assert plan["pending_new_goal"]["goal"]["goal_id"] == "10k-2027-03-01"

    store.reject("10k-2027-03-01")
    assert build_context(cur, today=today, store=store)["plan"]["pending_new_goal"] is None


def test_context_lists_the_recent_best_effort_at_every_distance(
    cur: duckdb.DuckDBPyConnection, ingested_store: Paths
) -> None:
    context = _context(cur, ingested_store, _newest_run(ingested_store) + timedelta(days=1))
    listed = context["predictions"]["recent_best_efforts"]
    expected = [
        row
        for row in queries.recent_eligible_efforts(cur, window_days=PREDICTION_WINDOW_DAYS)
        if row["distance_m"] >= 1000
    ]
    assert listed, "the fixtures must hold a recent effort for this to mean anything"
    assert [e["distance_key"] for e in listed] == [r["distance_key"] for r in expected]
    assert [e["distance_m"] for e in listed] == sorted(e["distance_m"] for e in listed)
    dates = _local_dates(ingested_store)
    for entry, row in zip(listed, expected, strict=True):
        assert entry["elapsed_time_s"] == row["elapsed_time_s"]
        assert entry["distance_m"] == row["distance_m"]
        assert entry["activity_id"] in dates.index
        assert entry["local_date"] == dates[entry["activity_id"]].isoformat()


#: The synthetic store's runs, as local days: each starts 23:30Z at UTC+1.
SYNTH_DAY = {"a1": date(2026, 6, 2), "a3": date(2026, 6, 4), "b1": date(2026, 6, 6)}


def _synthetic_store(root: Path, extra: list[tuple[str, int, float, float | None]]) -> Paths:
    paths = Paths(root=root)
    write_store(paths, extra)
    assert recompute(paths).errors == []
    return paths


@pytest.fixture
def synthetic(tmp_path: Path) -> Iterator[tuple[Paths, duckdb.DuckDBPyConnection]]:
    paths = _synthetic_store(tmp_path, [])
    con = connect(paths)
    try:
        yield paths, con
    finally:
        con.close()


def test_context_carries_zones_and_daily_load(
    synthetic: tuple[Paths, duckdb.DuckDBPyConnection],
) -> None:
    paths, con = synthetic
    today = date(2026, 6, 10)
    context = _context(con, paths, today)
    zones = context["zones"]
    assert zones["lthr_bpm"] == 180.0
    assert zones["boundaries_bpm"] == pytest.approx([153.0, 162.0, 171.0, 180.0])
    assert sorted(r["activity_id"] for r in zones["readings"]) == ["a1", "a2", "a3"]
    expected = queries.load_days(con, since=today - timedelta(days=84), through=today)
    assert expected
    # The skill reads the rolling distance, so the day's own is left out.
    assert context["load"] == _json_ready_rows(
        [{k: v for k, v in row.items() if k != "distance_m"} for row in expected]
    )
    assert set(context["load"][0]) == {
        "local_date",
        "trimp",
        "ctl",
        "atl",
        "form",
        "distance_7d_m",
    }


def test_context_zones_carry_trimp_per_minute(
    synthetic: tuple[Paths, duckdb.DuckDBPyConnection],
) -> None:
    paths, con = synthetic
    today = date(2026, 6, 10)
    zones = _context(con, paths, today)["zones"]
    expected = queries.trimp_per_minute_by_zone(
        con, since=today - timedelta(days=84), through=today
    )
    assert len(zones["trimp_per_minute"]) == 5
    assert zones["trimp_per_minute"] == expected
    assert any(v is not None for v in expected)
    # A window with no run gives five nulls, not a missing key.
    later = _context(con, paths, date(2027, 1, 1))["zones"]
    assert later["trimp_per_minute"] == [None] * 5


def test_propose_stamps_five_trimp_per_minute_values(
    synthetic: tuple[Paths, duckdb.DuckDBPyConnection],
) -> None:
    paths, con = synthetic
    store = PlanStore(paths)
    context = build_context(con, today=date(2026, 6, 10), store=store)
    version = store.propose(
        five_week_draft(), context, now=datetime(2026, 6, 10, 12, 0, tzinfo=UTC)
    )
    stamped = version.provenance.trimp_per_minute
    assert stamped is not None
    assert len(stamped) == 5
    assert stamped == context["zones"]["trimp_per_minute"]
    assert any(v is not None for v in stamped)


def _json_ready_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{**row, "local_date": row["local_date"].isoformat()} for row in rows]


def test_context_zones_is_null_without_an_estimate(
    cur: duckdb.DuckDBPyConnection, ingested_store: Paths
) -> None:
    context = _context(cur, ingested_store, _newest_run(ingested_store) + timedelta(days=1))
    assert context["zones"] is None


def test_recent_runs_carry_trimp_and_estimated_zones(
    synthetic: tuple[Paths, duckdb.DuckDBPyConnection],
) -> None:
    paths, con = synthetic
    runs = {r["activity_id"]: r for r in _context(con, paths, date(2026, 6, 10))["recent_runs"]}
    stored = {r["activity_id"]: r for r in queries.run_loads(con, since=None, through=None)}
    assert runs["a3"]["trimp"] == stored["a3"]["trimp"] > 0
    assert len(runs["a3"]["estimated_zone_s"]) == 5
    assert runs["a3"]["estimated_zone_s"] == stored["a3"]["zone_seconds"]
    # No heart rate: no TRIMP and no zone seconds.
    assert runs["c1"]["trimp"] is None
    assert runs["c1"]["estimated_zone_s"] == []


def test_weekly_rows_carry_trimp(tmp_path: Path) -> None:
    # A run without heart rate two weeks after the others.
    paths = _synthetic_store(tmp_path, [("d1", 15, 3.0, None)])
    con = connect(paths)
    try:
        today = date(2026, 6, 24)
        weekly = {w["period_start"]: w for w in _context(con, paths, today)["weekly"]}
        expected = {
            w["period_start"]: w
            for w in queries.weekly_load(con, since=date(2026, 6, 1), through=today)
        }
    finally:
        con.close()
    first = weekly["2026-06-01"]
    assert first["trimp"] == expected[date(2026, 6, 1)]["trimp"] > 0
    assert first["zone_minutes"] == expected[date(2026, 6, 1)]["zone_minutes"]
    assert len(first["zone_minutes"]) == 5
    # A week of runs without heart rate is unknown, a week without runs is zero.
    assert weekly["2026-06-15"]["runs"] == 1
    assert weekly["2026-06-15"]["trimp"] is None
    assert weekly["2026-06-15"]["zone_minutes"] is None
    assert weekly["2026-06-08"]["trimp"] == 0.0
    assert weekly["2026-06-08"]["zone_minutes"] == [0.0] * 5


def test_context_reports_how_old_the_measured_resting_heart_rate_is(tmp_path: Path) -> None:
    """The newest measured resting day on or before today, and each run's fallback.

    One measured day 90 days before a1's local day: a1 carries its rest
    forward, every later run falls back to the device setting, and a measured
    day after today is not counted.
    """
    paths = Paths(root=tmp_path)
    write_store(paths)
    measured = SYNTH_DAY["a1"] - timedelta(days=90)
    write_resting(paths, 46.0, [measured])
    write_resting(paths, 44.0, [date(2026, 7, 1)])
    assert recompute(paths).errors == []
    con = connect(paths)
    try:
        context = _context(con, paths, date(2026, 6, 10))
    finally:
        con.close()
    freshness = context["freshness"]
    assert freshness["resting_hr_measured_through"] == measured.isoformat()
    assert freshness["days_since_resting_hr"] == (date(2026, 6, 10) - measured).days
    flags = {r["activity_id"]: r["rest_from_setting"] for r in context["recent_runs"]}
    assert flags == {"a1": False, "a2": True, "a3": True, "b1": True, "c1": True}
