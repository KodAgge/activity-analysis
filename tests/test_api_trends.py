"""The trends endpoint: a projection of `activity_efficiency` and `athlete_fit`.

The efficiency pass fills both tables. On a store where it produced nothing
they are written empty, so the endpoint serves an empty list and null
references rather than failing, and the synthetic store here is populated by
hand to test the join and the order.
"""

from __future__ import annotations

import duckdb
import pyarrow.parquet as pq
import pytest
from fastapi.testclient import TestClient

from activity_analysis.api import queries
from activity_analysis.api.main import create_app
from activity_analysis.config import Paths


@pytest.fixture
def store() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute(
        """
        CREATE TABLE activities (
            activity_id VARCHAR, start_time_utc TIMESTAMPTZ, utc_offset_s INTEGER
        );
        CREATE TABLE activity_efficiency (
            activity_id VARCHAR,
            effort_tag VARCHAR,
            hr_slope_own_bpm_per_mps DOUBLE,
            hr_slope_se_bpm_per_mps DOUBLE,
            hr_slope_weight DOUBLE,
            hr_slope_shrunk_bpm_per_mps DOUBLE,
            hr_at_slow_bpm DOUBLE,
            hr_at_median_bpm DOUBLE,
            hr_at_fast_bpm DOUBLE,
            hr_at_slow_smoothed_bpm DOUBLE,
            hr_at_median_smoothed_bpm DOUBLE,
            hr_at_fast_smoothed_bpm DOUBLE,
            cadence_slope_own_spm_per_mps DOUBLE,
            cadence_slope_se_spm_per_mps DOUBLE,
            cadence_slope_weight DOUBLE,
            cadence_slope_shrunk_spm_per_mps DOUBLE,
            cadence_at_slow_spm DOUBLE,
            cadence_at_median_spm DOUBLE,
            cadence_at_fast_spm DOUBLE,
            cadence_at_slow_smoothed_spm DOUBLE,
            cadence_at_median_smoothed_spm DOUBLE,
            cadence_at_fast_smoothed_spm DOUBLE,
            decoupling_pct DOUBLE,
            is_aerobic_long_run BOOLEAN,
            decoupling_smoothed_pct DOUBLE,
            fit_seconds INTEGER,
            analysis_version INTEGER
        );
        CREATE TABLE athlete_fit (
            ref_slow_mps DOUBLE,
            ref_median_mps DOUBLE,
            ref_fast_mps DOUBLE,
            hr_slope_shared_bpm_per_mps DOUBLE,
            hr_slope_tau DOUBLE,
            cadence_slope_shared_spm_per_mps DOUBLE,
            cadence_slope_tau DOUBLE,
            activities_in_fit INTEGER,
            analysis_version INTEGER
        );
        """
    )
    return con


def _populate(con: duckdb.DuckDBPyConnection) -> None:
    con.execute(
        """
        INSERT INTO activities VALUES
            ('feb', '2026-02-01 10:00:00+00', 3600),
            ('jan', '2026-01-01 10:00:00+00', NULL);
        INSERT INTO activity_efficiency VALUES
            ('feb', 'steady', 12.0, 9.0, 0.6, 11.0, 150.0, 151.5, 153.1,
             149.2, 150.7, 152.3, 11.0, 4.0, 0.7, 11.2, 160.0, 161.6, 163.2,
             159.0, 160.6, 162.2, 4.5, TRUE, 4.8, 2400, 6),
            ('jan', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
             NULL, NULL, NULL, 12.0, 4.5, 0.6, 11.5, 158.0, 159.6, 161.3,
             158.0, 159.6, 161.3, NULL, FALSE, NULL, 1800, 6);
        INSERT INTO athlete_fit VALUES (2.6, 2.8, 3.0, 9.5, 10.5, 11.4, 6.0, 212, 6);
        """
    )


def test_trends_are_served_oldest_first_with_the_activity_s_instant_and_offset(
    store: duckdb.DuckDBPyConnection,
) -> None:
    _populate(store)
    _, items = queries.trends(store.cursor())
    assert [item["activity_id"] for item in items] == ["jan", "feb"]
    assert items[0]["utc_offset_s"] is None
    assert items[1]["utc_offset_s"] == 3600
    assert items[1]["effort_tag"] == "steady"
    assert items[1]["hr_at_median_bpm"] == 151.5
    assert items[1]["hr_slope_weight"] == 0.6
    assert items[1]["fit_seconds"] == 2400


def test_a_run_with_no_heart_rate_fit_still_has_its_cadence(
    store: duckdb.DuckDBPyConnection,
) -> None:
    """84 early runs on the real history have no heart rate at all. Each
    channel is nullable on its own."""
    _populate(store)
    _, (jan, _) = queries.trends(store.cursor())
    assert jan["hr_at_median_bpm"] is None
    assert jan["cadence_at_median_spm"] == 159.6


def test_the_shared_fit_is_served_beside_the_points(store: duckdb.DuckDBPyConnection) -> None:
    _populate(store)
    fit, _ = queries.trends(store.cursor())
    assert fit == {
        "ref_slow_mps": 2.6,
        "ref_median_mps": 2.8,
        "ref_fast_mps": 3.0,
        "hr_slope_shared_bpm_per_mps": 9.5,
        "cadence_slope_shared_spm_per_mps": 11.4,
    }


def test_an_efficiency_row_without_an_activity_is_dropped(
    store: duckdb.DuckDBPyConnection,
) -> None:
    """The instant comes from the canonical row, so a derived row whose
    activity left the store has nothing to be plotted at."""
    _populate(store)
    store.execute("DELETE FROM activities WHERE activity_id = 'jan'")
    _, items = queries.trends(store.cursor())
    assert [item["activity_id"] for item in items] == ["feb"]


def test_empty_tables_give_no_fit_and_no_items(store: duckdb.DuckDBPyConnection) -> None:
    assert queries.trends(store.cursor()) == (None, [])


def test_the_endpoint_serves_null_references_until_the_fit_exists(
    api_client: TestClient,
) -> None:
    """Whether or not the efficiency pass produced anything for the ingested
    store, the shape holds and nothing 500s."""
    body = api_client.get("/api/trends").json()
    assert set(body) == {
        "references",
        "hr_slope_shared_bpm_per_mps",
        "cadence_slope_shared_spm_per_mps",
        "items",
    }
    instants = [item["start_time_utc"] for item in body["items"]]
    assert instants == sorted(instants)
    if not body["items"]:
        assert body["references"] == {"slow_mps": None, "median_mps": None, "fast_mps": None}


def test_the_smoothed_columns_are_served(store: duckdb.DuckDBPyConnection) -> None:
    """The smoothed series is the one the trend views plot.

    The raw values are 3.4 times noisier than the gap between the three
    references, so a client given only the raw ones would have to smooth them
    itself, which docs/reference/frontend.md forbids.
    """
    _populate(store)
    _, (jan, feb) = queries.trends(store.cursor())

    assert feb["hr_at_median_smoothed_bpm"] == 150.7
    assert feb["cadence_at_fast_smoothed_spm"] == 162.2
    assert feb["is_aerobic_long_run"] is True
    assert feb["decoupling_smoothed_pct"] == 4.8
    # A run outside the decoupling population carries no smoothed value.
    # The null smoothed heart rate is this fixture's shape, not a rule of the
    # metric: `trailing_mean` skips nulls, so a run with no heart rate fit of
    # its own still takes the mean of every other run inside its 42 days.
    # `jan` is null because it is the earliest row and its trailing window
    # therefore holds no heart rate at all. On the real store of 2026-10-16
    # every one of the 227 fitted runs has a raw heart rate and a smoothed one.
    assert jan["is_aerobic_long_run"] is False
    assert jan["decoupling_smoothed_pct"] is None
    assert jan["hr_at_median_smoothed_bpm"] is None


def test_every_trend_point_field_reaches_the_endpoint(api_client: TestClient) -> None:
    """The query and the response model are two lists that have to agree.

    A field added to one and not the other is either a validation error or a
    column nobody can read, and neither shows up in the synthetic-store tests
    above, which call ``queries.trends`` directly.
    """
    body = api_client.get("/api/trends").json()
    assert body["items"], "the fixture store should produce at least one trend point"

    point = body["items"][0]
    for field in (
        "hr_at_slow_smoothed_bpm",
        "hr_at_median_smoothed_bpm",
        "hr_at_fast_smoothed_bpm",
        "cadence_at_slow_smoothed_spm",
        "cadence_at_median_smoothed_spm",
        "cadence_at_fast_smoothed_spm",
        "is_aerobic_long_run",
        "decoupling_smoothed_pct",
    ):
        assert field in point


def test_a_store_written_before_the_smoothed_columns_serves_nulls_not_a_500(
    ingested_store: Paths,
) -> None:
    """An ANALYSIS_VERSION 6 store must degrade to nulls, not fail.

    A user who pulls this change and runs ``serve`` without ``recompute`` has
    an ``activity_efficiency.parquet`` that predates every column task 3 and 4
    added. ``store/db.py`` projects each of them as a typed null so the store
    degrades rather than raising, and ``docs/reference/api.md`` states that a
    null flag means not known and is never coalesced to false. A non-nullable
    ``is_aerobic_long_run`` on the response model turned that deliberate null
    into a pydantic validation error and a 500.

    Dropping the columns and rewriting the file reproduces the version 6 file
    exactly as it sits on disk.
    """
    added = [
        "hr_at_slow_smoothed_bpm",
        "hr_at_median_smoothed_bpm",
        "hr_at_fast_smoothed_bpm",
        "cadence_at_slow_smoothed_spm",
        "cadence_at_median_smoothed_spm",
        "cadence_at_fast_smoothed_spm",
        "is_aerobic_long_run",
        "decoupling_smoothed_pct",
    ]
    stored = pq.read_table(ingested_store.activity_efficiency_parquet)
    assert set(added) <= set(stored.column_names), "the fixture store is not version 7"
    pq.write_table(stored.drop_columns(added), ingested_store.activity_efficiency_parquet)

    with TestClient(create_app(ingested_store)) as client:
        response = client.get("/api/trends")

    assert response.status_code == 200
    items = response.json()["items"]
    assert items, "the fixture store should still produce trend points"
    for point in items:
        assert point["is_aerobic_long_run"] is None
        for field in added:
            assert point[field] is None
