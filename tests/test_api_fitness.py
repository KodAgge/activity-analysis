"""The fitness endpoint: a projection of `fitness_series`, oldest first."""

from __future__ import annotations

import datetime as dt

import duckdb
import pytest
from fastapi.testclient import TestClient

from activity_analysis.api import queries


@pytest.fixture
def store() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute(
        """
        CREATE TABLE fitness_series (
            activity_id VARCHAR,
            start_time_utc TIMESTAMPTZ,
            hr_vo2max DOUBLE,
            hr_vo2max_smoothed DOUBLE,
            vdot DOUBLE,
            vdot_distance_key VARCHAR,
            vdot_smoothed DOUBLE,
            qualifying_segments INTEGER,
            analysis_version INTEGER
        );
        INSERT INTO fitness_series VALUES
            ('later', '2026-02-01 10:00:00+00', 52.0, 51.0, NULL, NULL, 40.0, 30, 6),
            ('earlier', '2026-01-01 10:00:00+00', 50.0, 50.0, 40.0, '5k', 40.0, 25, 6);
        """
    )
    return con


def test_fitness_is_served_oldest_first(store: duckdb.DuckDBPyConnection) -> None:
    rows = queries.fitness(store.cursor())
    assert [row["activity_id"] for row in rows] == ["earlier", "later"]


def test_fitness_projects_every_column_the_model_reads(store: duckdb.DuckDBPyConnection) -> None:
    (row, _) = queries.fitness(store.cursor())
    assert row == {
        "activity_id": "earlier",
        "start_time_utc": row["start_time_utc"],
        "hr_vo2max": 50.0,
        "hr_vo2max_smoothed": 50.0,
        "vdot": 40.0,
        "vdot_distance_key": "5k",
        "vdot_smoothed": 40.0,
        "qualifying_segments": 25,
    }


def test_a_missing_estimate_is_null_not_zero(store: duckdb.DuckDBPyConnection) -> None:
    (_, later) = queries.fitness(store.cursor())
    assert later["vdot"] is None
    assert later["vdot_distance_key"] is None


def test_the_endpoint_serves_the_ingested_store(api_client: TestClient) -> None:
    body = api_client.get("/api/fitness").json()
    assert body["items"], "the five outdoor fixture runs must contribute at least a VDOT"
    instants = [item["start_time_utc"] for item in body["items"]]
    assert instants == sorted(instants)
    for item in body["items"]:
        assert item["start_time_utc"].endswith("Z")
        assert item["hr_vo2max"] is not None or item["vdot"] is not None
        if item["vdot"] is not None:
            assert isinstance(item["vdot_distance_key"], str)


def test_the_endpoint_is_empty_on_an_empty_store(empty_api_client: TestClient) -> None:
    assert empty_api_client.get("/api/fitness").json() == {"items": [], "device": []}


@pytest.fixture
def device_store() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute(
        """
        CREATE TABLE device_vo2max (
            athlete_id VARCHAR, calendar_date DATE, vo2max DOUBLE, vo2max_reported BIGINT,
            device_id VARCHAR, updated_at TIMESTAMP, source_file_sha256 VARCHAR
        );
        INSERT INTO device_vo2max VALUES
            ('a', '2026-02-01', 50.38, 50, 'd', '2026-02-01 10:00:00', 'h'),
            ('a', '2023-09-10', 49.02, 49, 'd', '2023-09-10 10:00:00', 'h');
        """
    )
    return con


def test_the_device_series_is_served_oldest_first(device_store: duckdb.DuckDBPyConnection) -> None:
    rows = queries.device_vo2max(device_store.cursor())
    assert rows == [
        {"calendar_date": dt.date(2023, 9, 10), "vo2max": 49.02, "vo2max_reported": 49},
        {"calendar_date": dt.date(2026, 2, 1), "vo2max": 50.38, "vo2max_reported": 50},
    ]


def test_the_endpoint_serves_an_empty_device_list_when_no_garmin_export_was_ingested(
    api_client: TestClient,
) -> None:
    assert api_client.get("/api/fitness").json()["device"] == []
