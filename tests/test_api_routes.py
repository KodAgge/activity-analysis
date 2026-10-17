"""The routes API: what a route's summary and its runs carry, and how an
activity's own route membership reads.

`analysis.routes` decides what a route is and what an eligible run on one is
- see `docs/reference/derived-layer.md`'s "Routes, routes.parquet and
route_runs.parquet" and `docs/reference/math/routes.md` for the grouping rule
itself. This file writes synthetic `routes` and `route_runs` rows straight
through the real writers into a real ingested store, so it only has to prove
the API serves what is stored, not that the grouping is right - `tests/test_routes.py`
already covers that on synthetic traces with known answers.
"""

from __future__ import annotations

from collections.abc import Iterator

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from activity_analysis.api.main import create_app
from activity_analysis.config import ANALYSIS_VERSION, Paths
from activity_analysis.store.writer import read_activities, write_route_runs, write_routes

ROUTE_ID = "route-a"
ROUTE_NAME = "Test Loop 7.4 km"


def _run_ids(paths: Paths) -> list[str]:
    """The ingested store's five real activity ids, oldest first."""
    stored = read_activities(paths).sort_values("start_time_utc")
    return [str(activity_id) for activity_id in stored["activity_id"]]


def _write_synthetic_route(paths: Paths, a: str, b: str, c: str) -> None:
    """One route of three runs, oldest first: `a` sets the first record, `b`
    beats it and holds the current one, and `c` is a faster but GPX-sourced
    run that must neither rank nor become the baseline `is_record` measures -
    the two-sided eligibility rule `docs/reference/derived-layer.md` states.
    """
    routes = pd.DataFrame(
        [
            {
                "route_id": ROUTE_ID,
                "name": ROUTE_NAME,
                "locality": "Jönköping",
                "run_count": 3,
                "reference_activity_id": b,
                "median_distance_m": 7400.0,
                "first_run_utc": pd.Timestamp("2026-01-01T10:00:00Z"),
                "last_run_utc": pd.Timestamp("2026-03-01T10:00:00Z"),
                "analysis_version": ANALYSIS_VERSION,
            }
        ]
    )
    runs = pd.DataFrame(
        [
            {
                "route_id": ROUTE_ID,
                "activity_id": a,
                "start_time_utc": pd.Timestamp("2026-01-01T10:00:00Z"),
                "distance_m": 7400.0,
                "elapsed_time_s": 2500.0,
                "speed_mps": 2.96,
                "direction": "forward",
                "eligible": True,
                "ineligible_reason": None,
                "rank": 2,
                "is_record": True,
                "mean_distance_m": 0.0,
                "worst_distance_m": 0.0,
                "analysis_version": ANALYSIS_VERSION,
            },
            {
                "route_id": ROUTE_ID,
                "activity_id": b,
                "start_time_utc": pd.Timestamp("2026-02-01T10:00:00Z"),
                "distance_m": 7380.0,
                "elapsed_time_s": 2200.0,
                "speed_mps": 3.35,
                "direction": "reverse",
                "eligible": True,
                "ineligible_reason": None,
                "rank": 1,
                "is_record": True,
                "mean_distance_m": 5.0,
                "worst_distance_m": 40.0,
                "analysis_version": ANALYSIS_VERSION,
            },
            {
                "route_id": ROUTE_ID,
                "activity_id": c,
                "start_time_utc": pd.Timestamp("2026-03-01T10:00:00Z"),
                "distance_m": 7300.0,
                "elapsed_time_s": 1900.0,
                "speed_mps": 3.84,
                "direction": "forward",
                "eligible": False,
                "ineligible_reason": "GPX-sourced",
                "rank": None,
                "is_record": False,
                "mean_distance_m": 8.0,
                "worst_distance_m": 60.0,
                "analysis_version": ANALYSIS_VERSION,
            },
        ]
    )
    write_routes(paths, routes)
    write_route_runs(paths, runs)


@pytest.fixture
def route_ids(ingested_store: Paths) -> list[str]:
    ids = _run_ids(ingested_store)
    assert len(ids) == 5
    return ids


@pytest.fixture
def store_with_route(ingested_store: Paths, route_ids: list[str]) -> Paths:
    a, b, c = route_ids[:3]
    _write_synthetic_route(ingested_store, a, b, c)
    return ingested_store


@pytest.fixture
def route_client(store_with_route: Paths) -> Iterator[TestClient]:
    with TestClient(create_app(store_with_route)) as client:
        yield client


def test_the_list_carries_the_route_and_its_record(
    route_client: TestClient, route_ids: list[str]
) -> None:
    _, b, _ = route_ids[:3]
    body = route_client.get("/api/routes").json()
    assert len(body) == 1
    route = body[0]
    assert route["route_id"] == ROUTE_ID
    assert route["name"] == ROUTE_NAME
    assert route["locality"] == "Jönköping"
    assert route["run_count"] == 3
    assert route["median_distance_m"] == 7400.0
    assert route["first_run_utc"] == "2026-01-01T10:00:00Z"
    assert route["last_run_utc"] == "2026-03-01T10:00:00Z"
    assert route["record_activity_id"] == b
    assert route["record_speed_mps"] == pytest.approx(3.35)
    assert route["record_start_time_utc"] == "2026-02-01T10:00:00Z"


def test_the_record_carries_its_run_s_offset(
    route_client: TestClient, store_with_route: Paths, route_ids: list[str]
) -> None:
    """The rank 1 run's own `activities.utc_offset_s`, so the record's day
    can be stated in the athlete's wall clock rather than as a UTC day."""
    _, b, _ = route_ids[:3]
    stored = read_activities(store_with_route).set_index("activity_id")
    expected = int(stored.loc[b, "utc_offset_s"])
    listed = route_client.get("/api/routes").json()[0]
    detail = route_client.get(f"/api/routes/{ROUTE_ID}").json()["route"]
    assert listed["record_utc_offset_s"] == expected
    assert detail["record_utc_offset_s"] == expected


def test_a_route_with_no_eligible_run_has_no_record_at_all(
    ingested_store: Paths, route_ids: list[str]
) -> None:
    """Every record field null together, the offset included: there is no
    rank 1 row to read any of them from."""
    a, b, c = route_ids[:3]
    _write_synthetic_route(ingested_store, a, b, c)
    runs = pd.read_parquet(ingested_store.route_runs_parquet)
    runs["eligible"] = False
    runs["ineligible_reason"] = "GPX-sourced"
    runs["rank"] = None
    runs["is_record"] = False
    write_route_runs(ingested_store, runs)

    with TestClient(create_app(ingested_store)) as client:
        listed = client.get("/api/routes").json()[0]
        detail = client.get(f"/api/routes/{ROUTE_ID}").json()["route"]
    for route in (listed, detail):
        assert route["record_speed_mps"] is None
        assert route["record_activity_id"] is None
        assert route["record_start_time_utc"] is None
        assert route["record_utc_offset_s"] is None


def test_an_empty_store_lists_no_routes(empty_api_client: TestClient) -> None:
    assert empty_api_client.get("/api/routes").json() == []


def test_recompute_over_the_committed_fixtures_lists_no_routes(api_client: TestClient) -> None:
    """The five fixtures, ingested and recomputed, are too few and too
    different to form a route, so the real pipeline's tables serve none."""
    assert api_client.get("/api/routes").json() == []


def _summary_row(route_id: str, name: str, run_count: int) -> dict[str, object]:
    return {
        "route_id": route_id,
        "name": name,
        "locality": "Jönköping",
        "run_count": run_count,
        "reference_activity_id": route_id,
        "median_distance_m": 5000.0,
        "first_run_utc": pd.Timestamp("2026-01-01T10:00:00Z"),
        "last_run_utc": pd.Timestamp("2026-03-01T10:00:00Z"),
        "analysis_version": ANALYSIS_VERSION,
    }


def test_the_list_orders_by_run_count_then_name(ingested_store: Paths) -> None:
    # Stored in neither order, with ids whose own order is a third one.
    write_routes(
        ingested_store,
        pd.DataFrame(
            [
                _summary_row("r1", "Jönköping 5.0 km B", 3),
                _summary_row("r2", "Jönköping 8.0 km", 5),
                _summary_row("r9", "Jönköping 5.0 km A", 3),
                _summary_row("r3", "Växjö 4.0 km", 4),
            ]
        ),
    )
    with TestClient(create_app(ingested_store)) as client:
        names = [r["name"] for r in client.get("/api/routes").json()]
    assert names == [
        "Jönköping 8.0 km",
        "Växjö 4.0 km",
        "Jönköping 5.0 km A",
        "Jönköping 5.0 km B",
    ]


def test_the_detail_serves_runs_oldest_first_with_rank_record_and_direction(
    route_client: TestClient, route_ids: list[str]
) -> None:
    a, b, c = route_ids[:3]
    body = route_client.get(f"/api/routes/{ROUTE_ID}").json()
    assert body["reference_activity_id"] == b
    assert body["route"]["route_id"] == ROUTE_ID
    assert [r["activity_id"] for r in body["runs"]] == [a, b, c]
    assert [r["rank"] for r in body["runs"]] == [2, 1, None]
    assert [r["is_record"] for r in body["runs"]] == [True, True, False]
    assert [r["direction"] for r in body["runs"]] == ["forward", "reverse", "forward"]


def test_an_unknown_route_id_is_404(route_client: TestClient) -> None:
    assert route_client.get("/api/routes/does-not-exist").status_code == 404


def test_an_ineligible_run_has_no_rank_and_names_the_reason(
    route_client: TestClient, route_ids: list[str]
) -> None:
    c = route_ids[2]
    body = route_client.get(f"/api/routes/{ROUTE_ID}").json()
    c_row = next(r for r in body["runs"] if r["activity_id"] == c)
    assert c_row["eligible"] is False
    assert c_row["rank"] is None
    assert c_row["is_record"] is False
    assert c_row["ineligible_reason"] == "GPX-sourced"


def test_an_activity_detail_carries_its_route(
    route_client: TestClient, route_ids: list[str]
) -> None:
    a = route_ids[0]
    body = route_client.get(f"/api/activities/{a}").json()
    assert body["route"] == {
        "route_id": ROUTE_ID,
        "name": ROUTE_NAME,
        "run_count": 3,
        "rank": 2,
        "direction": "forward",
    }


def test_a_run_in_no_route_carries_a_null_route(
    route_client: TestClient, route_ids: list[str]
) -> None:
    not_in_a_route = route_ids[3]
    body = route_client.get(f"/api/activities/{not_in_a_route}").json()
    assert body["route"] is None
