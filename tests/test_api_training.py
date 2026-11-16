"""``GET /api/threshold`` and ``GET /api/training-load`` on a synthetic store.

The store is the one tests/test_pipeline_threshold.py writes: three hard runs
whose threshold reading is 180, an easy run, and a run with no heart rate.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import date
from pathlib import Path

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from activity_analysis.analysis.pipeline import recompute
from activity_analysis.api import queries
from activity_analysis.api.main import create_app
from activity_analysis.config import Paths
from activity_analysis.models import ACTIVITY_SCHEMA, PROFILE_OBSERVATION_SCHEMA, empty_frame
from activity_analysis.store.db import connect
from activity_analysis.store.writer import (
    upsert_activities,
    upsert_profile_observations,
    write_streams,
)
from tests.test_pipeline_threshold import (
    GRID_S,
    MAX_HR,
    REST_SETTING,
    T0,
    _activity,
    _stream,
    write_resting,
    write_store,
)

#: Local days: every run starts 23:30 UTC at UTC+1, so on the next day.
DAY = {"a1": "2026-06-02", "a2": "2026-06-03", "a3": "2026-06-04", "b1": "2026-06-06"}


@pytest.fixture
def paths(tmp_path: Path) -> Paths:
    paths = Paths(root=tmp_path)
    write_store(paths)
    assert recompute(paths).errors == []
    return paths


@pytest.fixture
def client(paths: Paths) -> Iterator[TestClient]:
    with TestClient(create_app(paths)) as client:
        yield client


def test_threshold_current_has_four_boundaries(client: TestClient) -> None:
    body = client.get("/api/threshold").json()
    assert body == {
        "current": {
            "lthr_bpm": 180.0,
            "boundaries_bpm": pytest.approx([153.0, 162.0, 171.0, 180.0]),
        }
    }


def test_threshold_is_null_on_an_empty_store(tmp_path: Path) -> None:
    paths = Paths(root=tmp_path)
    paths.ensure()
    with TestClient(create_app(paths)) as client:
        response = client.get("/api/threshold")
        assert response.status_code == 200
        assert response.json() == {"current": None}
        body = client.get("/api/training-load").json()
        assert body == {"days": [], "weeks": [], "runs": []}


def test_training_load_filters_by_local_date(client: TestClient) -> None:
    everything = client.get("/api/training-load").json()
    assert [r["activity_id"] for r in everything["runs"]] == ["a1", "a2", "a3", "b1", "c1"]
    # Every run is in the series, from a1's day to c1's.
    assert [d["local_date"] for d in everything["days"]] == [
        "2026-06-02",
        "2026-06-03",
        "2026-06-04",
        "2026-06-05",
        "2026-06-06",
        "2026-06-07",
    ]
    # Inclusive on both ends. a3 is 2026-06-04 local, 2026-06-03 in UTC.
    body = client.get(
        "/api/training-load", params={"from": "2026-06-03", "to": "2026-06-04"}
    ).json()
    assert [r["activity_id"] for r in body["runs"]] == ["a2", "a3"]
    assert [d["local_date"] for d in body["days"]] == ["2026-06-03", "2026-06-04"]
    only_from = client.get("/api/training-load", params={"from": "2026-06-06"}).json()
    assert [r["activity_id"] for r in only_from["runs"]] == ["b1", "c1"]
    only_to = client.get("/api/training-load", params={"to": "2026-06-02"}).json()
    assert [r["activity_id"] for r in only_to["runs"]] == ["a1"]


def test_run_load_carries_the_histogram_as_parallel_lists(client: TestClient) -> None:
    runs = {r["activity_id"]: r for r in client.get("/api/training-load").json()["runs"]}
    easy = runs["b1"]
    assert len(easy["hr_bpm"]) == len(easy["hr_seconds"]) == 2
    assert easy["hr_bpm"] == [120, 140]
    assert sum(easy["hr_seconds"]) == pytest.approx(GRID_S)
    assert easy["lthr_bpm"] == 180.0
    assert easy["trimp"] > 0
    assert len(easy["zone_seconds"]) == 5
    assert easy["zone_seconds"][0] == pytest.approx(GRID_S)
    # Before any estimate: no threshold and no zones, but TRIMP and the
    # histogram are still there.
    assert runs["a1"]["lthr_bpm"] is None
    assert runs["a1"]["trimp"] > 0
    assert runs["a1"]["zone_seconds"] == []
    # No heart rate channel: the estimate stays, everything else is empty.
    assert runs["c1"]["lthr_bpm"] == 180.0
    assert runs["c1"]["trimp"] is None
    assert runs["c1"]["zone_seconds"] == []
    assert runs["c1"]["hr_bpm"] == [] and runs["c1"]["hr_seconds"] == []


def test_weekly_load_sums_days_and_zone_minutes_per_week(paths: Paths) -> None:
    cur = connect(paths).cursor()
    weeks = queries.weekly_load(cur, since=date(2026, 5, 25), through=date(2026, 6, 8))
    assert [w["period_start"] for w in weeks] == [
        date(2026, 6, 1) - pd.Timedelta(days=7).to_pytimedelta(),
        date(2026, 6, 1),
        date(2026, 6, 8),
    ]
    assert weeks[0]["trimp"] == 0.0 and weeks[0]["zone_minutes"] == [0.0] * 5
    week = weeks[1]
    assert week["trimp"] == pytest.approx(
        sum(d["trimp"] for d in queries.load_days(cur, since=None, through=None))
    )
    # Two runs carry estimated zones, a3 and b1, each GRID_S seconds with heart rate.
    assert sum(week["zone_minutes"]) == pytest.approx(2 * GRID_S / 60.0)
    assert week["zone_minutes"][0] >= GRID_S / 60.0
    assert len(week["zone_minutes"]) == 5
    # The last week has no runs at all: a rest week, zero, not unknown.
    assert weeks[2]["trimp"] == 0.0 and weeks[2]["zone_minutes"] == [0.0] * 5


def test_weekly_load_is_null_for_a_week_whose_runs_lack_heart_rate(paths: Paths) -> None:
    """A week of runs with no heart rate is unknown, not a rest week.

    d1 is the only run of the week of 2026-06-08 and has no heart rate channel,
    so no TRIMP. The week of 2026-06-15 has no run and stays a zero week.
    """
    start = T0 + pd.Timedelta(days=10)
    frame = pd.DataFrame([_activity("d1", start, 3.0)])
    upsert_activities(paths, frame.astype(empty_frame(ACTIVITY_SCHEMA).dtypes.to_dict()))
    write_streams(paths, "d1", _stream("d1", start, 3.0, None))
    assert recompute(paths).errors == []

    weeks = queries.weekly_load(
        connect(paths).cursor(), since=date(2026, 6, 1), through=date(2026, 6, 15)
    )
    by_start = {w["period_start"]: w for w in weeks}
    assert by_start[date(2026, 6, 8)]["trimp"] is None
    assert by_start[date(2026, 6, 8)]["zone_minutes"] is None
    assert by_start[date(2026, 6, 15)]["trimp"] == 0.0
    assert by_start[date(2026, 6, 15)]["zone_minutes"] == [0.0] * 5
    # The week of the hard and easy runs still sums, though c1 there lacks heart rate.
    assert by_start[date(2026, 6, 1)]["trimp"] > 0.0


def test_weekly_zone_minutes_are_null_for_a_week_whose_runs_have_no_zones(
    tmp_path: Path,
) -> None:
    """A week of runs with TRIMP but before the first threshold estimate.

    e0 is a hard run a week before a1, alone in the week of 2026-05-25: it
    carries TRIMP, which needs no estimate, but no estimated zones, so the
    week's zone mix is unknown, as the plan view's ``weeklyZoneMix`` has it.
    The profile is observed on e0 too, so its rest and max settings cover it.
    """
    paths = Paths(root=tmp_path)
    write_store(paths, [("e0", -7, 4.0, 180.0)])
    observation = {name: None for name in PROFILE_OBSERVATION_SCHEMA.names}
    observation.update(
        activity_id="e0",
        athlete_id="tester",
        observed_at=T0 - pd.Timedelta(days=7),
        max_hr_bpm=MAX_HR,
        resting_hr_bpm=REST_SETTING,
    )
    upsert_profile_observations(
        paths,
        pd.DataFrame([observation]).astype(
            empty_frame(PROFILE_OBSERVATION_SCHEMA).dtypes.to_dict()
        ),
    )
    assert recompute(paths).errors == []
    weeks = queries.weekly_load(
        connect(paths).cursor(), since=date(2026, 5, 25), through=date(2026, 6, 1)
    )
    by_start = {w["period_start"]: w for w in weeks}
    assert by_start[date(2026, 5, 25)]["trimp"] > 0.0
    assert by_start[date(2026, 5, 25)]["zone_minutes"] is None
    assert sum(by_start[date(2026, 6, 1)]["zone_minutes"]) > 0.0


def test_trimp_per_minute_leaves_out_the_minutes_without_trimp(tmp_path: Path) -> None:
    """Zone minutes of a run with no TRIMP do not dilute the rate.

    b2, an easy run two days after b1, rests on a measured 195 that leaves no
    reserve below its max, so its zone 1 seconds carry no TRIMP; b1's rest is
    the setting, so its zone 1 rate is the whole of the zone's.
    """
    paths = Paths(root=tmp_path)
    write_store(paths, [("b2", 6, 3.0, 140.0)])
    b2_local = date(2026, 6, 8)
    write_resting(paths, 195.0, [b2_local])
    assert recompute(paths).errors == []
    cur = connect(paths).cursor()
    loads = {r["activity_id"]: r for r in queries.run_loads(cur, since=None, through=None)}
    assert loads["b2"]["trimp"] is None and loads["b2"]["zone_seconds"][0] == GRID_S
    rates = queries.trimp_per_minute_by_zone(cur, since=date(2026, 6, 6), through=b2_local)
    assert rates[0] == pytest.approx(loads["b1"]["trimp"] / (GRID_S / 60.0))


def test_openapi_lists_the_two_endpoints(client: TestClient) -> None:
    paths = client.get("/openapi.json").json()["paths"]
    assert "/api/threshold" in paths
    assert "/api/training-load" in paths
    params = {p["name"] for p in paths["/api/training-load"]["get"]["parameters"]}
    assert params == {"from", "to", "runs"}


def test_training_load_without_runs_keeps_the_series(client: TestClient) -> None:
    everything = client.get("/api/training-load").json()
    body = client.get("/api/training-load", params={"runs": "false"}).json()
    assert everything["runs"]
    assert body == {**everything, "runs": []}


def test_training_load_serves_trimp_ctl_atl_and_form(client: TestClient) -> None:
    days = client.get("/api/training-load").json()["days"]
    assert set(days[0]) == {
        "local_date",
        "trimp",
        "ctl",
        "atl",
        "form",
        "distance_m",
        "distance_7d_m",
    }
    for day in days:
        assert day["form"] == pytest.approx(day["ctl"] - day["atl"])
    assert days[0]["trimp"] > 0
    assert days[-1]["distance_7d_m"] >= days[-1]["distance_m"] >= 0


def test_training_load_serves_weeks(client: TestClient) -> None:
    body = client.get("/api/training-load").json()
    assert [w["week_start"] for w in body["weeks"]] == ["2026-06-01"]
    week = body["weeks"][0]
    assert set(week) == {
        "week_start",
        "days",
        "trimp",
        "ctl_mean",
        "atl_mean",
        "form_mean",
        "distance_m",
    }
    assert week["days"] == 6
    assert week["trimp"] == pytest.approx(sum(d["trimp"] for d in body["days"]))
    assert week["ctl_mean"] == pytest.approx(sum(d["ctl"] for d in body["days"]) / 6)
    # Filtered on week_start, inclusive: a range starting after Monday drops the week.
    later = client.get("/api/training-load", params={"from": "2026-06-02"}).json()
    assert later["weeks"] == []
    same = client.get(
        "/api/training-load", params={"from": "2026-06-01", "to": "2026-06-01"}
    ).json()
    assert [w["week_start"] for w in same["weeks"]] == ["2026-06-01"]


def test_run_load_carries_rest_and_max_and_their_flags(client: TestClient) -> None:
    runs = {r["activity_id"]: r for r in client.get("/api/training-load").json()["runs"]}
    run = runs["b1"]
    assert "load" not in run
    assert run["rest_bpm"] is not None and run["max_bpm"] is not None
    assert isinstance(run["rest_from_setting"], bool)
    assert isinstance(run["max_from_setting"], bool)
    assert run["max_bpm"] > run["rest_bpm"]


def test_trimp_per_minute_by_zone_is_trimp_over_minutes(tmp_path: Path) -> None:
    paths = Paths(root=tmp_path)
    paths.ensure()
    write_store(paths)
    assert recompute(paths).errors == []
    zones = pd.DataFrame(
        {
            "activity_id": ["b1"],
            "zone_index": pd.Series([2], dtype="int32"),
            "low_bpm": [100.0],
            "high_bpm": [120.0],
            "seconds_s": [600.0],
            "trimp": [15.0],
            "analysis_version": pd.Series([1], dtype="int32"),
        }
    )
    zones.to_parquet(paths.zone_time_estimated_parquet)
    cur = connect(paths).cursor()
    got = queries.trimp_per_minute_by_zone(cur, since=date(2026, 6, 1), through=date(2026, 6, 30))
    assert got == [None, None, pytest.approx(1.5), None, None]
    assert (
        queries.trimp_per_minute_by_zone(cur, since=date(2026, 7, 1), through=date(2026, 7, 31))
        == [None] * 5
    )


def test_trimp_per_minute_pools_runs_and_ignores_runs_outside_the_range(tmp_path: Path) -> None:
    paths = Paths(root=tmp_path)
    paths.ensure()
    write_store(paths)
    assert recompute(paths).errors == []

    def zone(activity_id: str, seconds: float, trimp: float) -> dict[str, object]:
        return {
            "activity_id": activity_id,
            "zone_index": 2,
            "low_bpm": 100.0,
            "high_bpm": 120.0,
            "seconds_s": seconds,
            "trimp": trimp,
            "analysis_version": 1,
        }

    # Two runs on the 2nd and 3rd: 10 min at 1.0 and 30 min at 2.0 per minute.
    # The pooled figure is 70 / 40 = 1.75, where a mean of ratios would say 1.5.
    # b1 is dated the 6th, outside the range below, at a ratio of 100.
    rows = [zone("a1", 600.0, 10.0), zone("a2", 1800.0, 60.0), zone("b1", 600.0, 1000.0)]
    frame = pd.DataFrame(rows).astype({"zone_index": "int32", "analysis_version": "int32"})
    frame.to_parquet(paths.zone_time_estimated_parquet)
    cur = connect(paths).cursor()
    got = queries.trimp_per_minute_by_zone(cur, since=date(2026, 6, 2), through=date(2026, 6, 3))
    assert got == [None, None, pytest.approx(1.75), None, None]


def test_trimp_per_minute_is_null_when_a_zone_has_seconds_but_no_trimp(tmp_path: Path) -> None:
    paths = Paths(root=tmp_path)
    paths.ensure()
    write_store(paths)
    assert recompute(paths).errors == []
    frame = pd.DataFrame(
        {
            "activity_id": ["a1"],
            "zone_index": pd.Series([2], dtype="int32"),
            "low_bpm": [100.0],
            "high_bpm": [120.0],
            "seconds_s": [600.0],
            "trimp": pd.Series([None], dtype="float64"),
            "analysis_version": pd.Series([1], dtype="int32"),
        }
    )
    frame.to_parquet(paths.zone_time_estimated_parquet)
    cur = connect(paths).cursor()
    got = queries.trimp_per_minute_by_zone(cur, since=date(2026, 6, 1), through=date(2026, 6, 30))
    assert got == [None] * 5
