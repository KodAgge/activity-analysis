"""The distributions endpoint: every run's values for the frontend to bucket.

Unlike every other endpoint in this API, the client needs the whole table at
once rather than a page or an aggregate: the view fixes its axis over every
run, switches variables without a round trip, and lists a bucket's runs, none
of which a server-side aggregate could answer without a parameter per
variable. The synthetic store here mirrors ``tests/test_api_trends.py``'s,
built by hand with only the columns the query reads.
"""

from __future__ import annotations

import duckdb
import pytest
from fastapi.testclient import TestClient

from activity_analysis.api import queries
from activity_analysis.config import Paths


@pytest.fixture
def store() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute(
        """
        CREATE TABLE activities (
            activity_id VARCHAR,
            start_time_utc TIMESTAMPTZ,
            utc_offset_s INTEGER,
            distance_m DOUBLE,
            avg_hr_bpm DOUBLE,
            max_hr_bpm DOUBLE,
            avg_cadence_spm DOUBLE
        );
        CREATE TABLE activity_metrics (
            activity_id VARCHAR,
            is_indoor BOOLEAN,
            distance_m DOUBLE,
            moving_time_s DOUBLE,
            elapsed_time_s DOUBLE,
            avg_speed_mps DOUBLE,
            ascent_per_km_m DOUBLE,
            days_since_previous_run INTEGER
        );
        CREATE TABLE activity_efficiency (
            activity_id VARCHAR,
            hr_at_median_bpm DOUBLE,
            cadence_at_median_spm DOUBLE,
            decoupling_pct DOUBLE,
            is_aerobic_long_run BOOLEAN
        );
        CREATE TABLE athlete_fit (
            ref_median_mps DOUBLE,
            analysis_version INTEGER
        );
        """
    )
    return con


def _populate(con: duckdb.DuckDBPyConnection) -> None:
    con.execute(
        """
        INSERT INTO activities VALUES
            ('feb', '2026-02-01 10:00:00+00', 3600, 10000.0, 150.0, 180.0, 170.0),
            ('jan', '2026-01-01 10:00:00+00', NULL, 5440.0, 140.0, 175.0, 160.0),
            ('walk', '2026-01-15 09:00:00+00', 3600, 3000.0, 110.0, 130.0, NULL);
        INSERT INTO activity_metrics VALUES
            ('feb', FALSE, 9987.0, 3000.0, 3050.0, 3.2, 8.5, 1),
            ('jan', TRUE, 5423.2, 2900.0, 2950.0, 1.87, 0.0, NULL);
        INSERT INTO activity_efficiency VALUES
            ('feb', 151.5, 168.8, 8.39, TRUE);
        INSERT INTO athlete_fit VALUES (2.827, 9);
        """
    )


def test_a_run_with_an_efficiency_row_gets_its_four_fields(
    store: duckdb.DuckDBPyConnection,
) -> None:
    _populate(store)
    _, items = queries.distributions(store.cursor())
    feb = next(item for item in items if item["activity_id"] == "feb")
    assert feb["hr_at_median_bpm"] == 151.5
    assert feb["cadence_at_median_spm"] == 168.8
    assert feb["decoupling_pct"] == 8.39
    assert feb["is_aerobic_long_run"] is True


def test_a_run_with_no_efficiency_row_still_appears_with_nulls(
    store: duckdb.DuckDBPyConnection,
) -> None:
    _populate(store)
    _, items = queries.distributions(store.cursor())
    jan = next(item for item in items if item["activity_id"] == "jan")
    assert jan["hr_at_median_bpm"] is None
    assert jan["cadence_at_median_spm"] is None
    assert jan["decoupling_pct"] is None
    assert jan["is_aerobic_long_run"] is None


def test_a_non_running_activity_is_absent(store: duckdb.DuckDBPyConnection) -> None:
    """``walk`` has no ``activity_metrics`` row, which is what a non-running
    activity looks like: the derived layer covers running only."""
    _populate(store)
    _, items = queries.distributions(store.cursor())
    assert "walk" not in [item["activity_id"] for item in items]
    assert len(items) == 2


def test_order_is_start_time_then_activity_id(store: duckdb.DuckDBPyConnection) -> None:
    _populate(store)
    _, items = queries.distributions(store.cursor())
    assert [item["activity_id"] for item in items] == ["jan", "feb"]


def test_distance_is_the_canonical_column_not_the_grid_s(
    store: duckdb.DuckDBPyConnection,
) -> None:
    """A treadmill run's own ``activity_metrics.distance_m`` is a footpod
    estimate; the session total on ``activities`` is authoritative indoors.
    See docs/reference/math/units.md."""
    _populate(store)
    store.execute(
        "INSERT INTO activity_metrics (activity_id, distance_m) VALUES ('treadmill', 5423.2)"
    )
    store.execute(
        "INSERT INTO activities (activity_id, start_time_utc, distance_m) VALUES "
        "('treadmill', '2026-03-01 10:00:00+00', 5440.0)"
    )
    _, items = queries.distributions(store.cursor())
    treadmill = next(item for item in items if item["activity_id"] == "treadmill")
    assert treadmill["distance_m"] == 5440.0


def test_median_reference_is_the_latest_athlete_fit_row(
    store: duckdb.DuckDBPyConnection,
) -> None:
    _populate(store)
    fit, _ = queries.distributions(store.cursor())
    assert fit == {"ref_median_mps": 2.827}


def test_an_unpopulated_store_gives_no_fit_and_no_items(
    store: duckdb.DuckDBPyConnection,
) -> None:
    assert queries.distributions(store.cursor()) == (None, [])


def test_the_endpoint_serves_every_run_with_a_null_days_since_exactly_once(
    api_client: TestClient,
) -> None:
    response = api_client.get("/api/distributions")
    assert response.status_code == 200
    body = response.json()
    assert body["runs"], "the fixture store should produce at least one run"
    nulls = [run["days_since_previous_run"] is None for run in body["runs"]]
    assert nulls.count(True) == 1


def test_the_endpoint_serves_one_row_per_run_ordered_by_instant(
    api_client: TestClient, ingested_store: Paths
) -> None:
    (expected_count,) = (
        duckdb.connect()
        .execute(f"SELECT count(*) FROM read_parquet('{ingested_store.activity_metrics_parquet}')")
        .fetchone()  # type: ignore[union-attr]
    )

    body = api_client.get("/api/distributions").json()
    assert len(body["runs"]) == expected_count
    instants = [run["start_time_utc"] for run in body["runs"]]
    assert instants == sorted(instants)


def test_an_empty_store_serves_null_references_and_no_runs(
    empty_api_client: TestClient,
) -> None:
    body = empty_api_client.get("/api/distributions").json()
    assert body == {"references": {"median_mps": None}, "runs": []}
