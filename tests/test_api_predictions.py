"""The predictions endpoint.

The two prediction VDOTs are stored per run on `fitness_series` at
recompute and inverted to times when asked, since times are never stored.
Everything that enters them is read from the derived layer under the same
eligibility rule as `records`, and the maths lives in
`analysis.fitness.race_predictions`, which `tests/test_fitness.py` tests on
synthetic VDOTs with known answers. This file tests the queries
that feed it and the response shape.
"""

from __future__ import annotations

import duckdb
import pytest
from fastapi.testclient import TestClient

from activity_analysis.analysis.fitness import (
    PREDICTION_WINDOW_DAYS,
    race_predictions,
    time_for_vdot,
)
from activity_analysis.api import queries
from activity_analysis.api.models import Predictions


@pytest.fixture
def store() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute(
        """
        CREATE TABLE activities (activity_id VARCHAR, sport VARCHAR, start_time_utc TIMESTAMPTZ);
        CREATE TABLE activity_metrics (activity_id VARCHAR, is_indoor BOOLEAN);
        CREATE TABLE best_efforts (
            activity_id VARCHAR,
            distance_key VARCHAR,
            distance_m DOUBLE,
            elapsed_time_s DOUBLE,
            contains_jump BOOLEAN,
            distance_trusted BOOLEAN
        );
        CREATE TABLE fitness_series (
            activity_id VARCHAR,
            start_time_utc TIMESTAMPTZ,
            best_efforts_vdot DOUBLE,
            ordinary_runs_vdot DOUBLE
        );
        """
    )
    return con


def _run(
    con: duckdb.DuckDBPyConnection,
    activity_id: str,
    started: str,
    *,
    indoor: bool | None = False,
    sport: str = "running",
) -> None:
    con.execute(
        "INSERT INTO activities VALUES (?, ?, ?::TIMESTAMPTZ)", [activity_id, sport, started]
    )
    con.execute("INSERT INTO activity_metrics VALUES (?, ?)", [activity_id, indoor])


def _effort(
    con: duckdb.DuckDBPyConnection,
    activity_id: str,
    key: str,
    metres: float,
    seconds: float,
    *,
    jump: bool | None = False,
) -> None:
    # Trusted exactly when the flag alone says so, the rule before the speed check.
    trusted = None if jump is None else not jump
    con.execute(
        "INSERT INTO best_efforts VALUES (?, ?, ?, ?, ?, ?)",
        [activity_id, key, metres, seconds, jump, trusted],
    )


def test_the_window_ends_at_the_most_recent_run(store: duckdb.DuckDBPyConnection) -> None:
    """Anchored on the history rather than on today, so the answer is a
    function of the store alone and an athlete who stopped running still
    sees the prediction their last block of training supports."""
    _run(store, "old", "2025-01-01 10:00:00+00")
    _run(store, "recent", "2026-01-01 10:00:00+00")
    _run(store, "latest", "2026-02-01 10:00:00+00")
    _effort(store, "old", "5k", 5000.0, 1300.0)
    _effort(store, "recent", "5k", 5000.0, 1400.0)
    _effort(store, "latest", "1k", 1000.0, 250.0)
    rows = queries.recent_eligible_efforts(store.cursor(), window_days=PREDICTION_WINDOW_DAYS)
    assert {(row["distance_key"], row["elapsed_time_s"]) for row in rows} == {
        ("5k", 1400.0),
        ("1k", 250.0),
    }


def test_only_the_best_eligible_effort_per_distance_is_kept(
    store: duckdb.DuckDBPyConnection,
) -> None:
    _run(store, "a", "2026-01-01 10:00:00+00")
    _run(store, "b", "2026-01-10 10:00:00+00")
    _run(store, "treadmill", "2026-01-20 10:00:00+00", indoor=True)
    _run(store, "unknown", "2026-01-21 10:00:00+00", indoor=None)
    _effort(store, "a", "5k", 5000.0, 1500.0)
    _effort(store, "b", "5k", 5000.0, 1450.0)
    _effort(store, "b", "5k", 5000.0, 1200.0, jump=True)
    _effort(store, "b", "1k", 1000.0, 260.0, jump=None)
    _effort(store, "treadmill", "5k", 5000.0, 1100.0)
    _effort(store, "unknown", "5k", 5000.0, 1000.0)
    rows = queries.recent_eligible_efforts(store.cursor(), window_days=PREDICTION_WINDOW_DAYS)
    assert [(row["distance_key"], row["elapsed_time_s"]) for row in rows] == [("5k", 1450.0)]


def test_only_the_model_set_distances_reach_the_race_models(
    store: duckdb.DuckDBPyConnection,
) -> None:
    """A distance on the records ladder but outside `VDOT_DISTANCES_M` is not
    an input to a prediction.

    `race_predictions` anchors on the highest-VDOT effort it is handed, so
    letting every extracted distance through would make adding a rung to the
    ladder move every predicted time.
    The 2 km here is by far the strongest performance, so it would take the
    anchor if it reached the models.
    """
    _run(store, "a", "2026-01-01 10:00:00+00")
    _effort(store, "a", "2k", 2000.0, 300.0)
    _effort(store, "a", "10mi", 16093.44, 4000.0)
    _effort(store, "a", "5k", 5000.0, 1450.0)
    _effort(store, "a", "10k", 10000.0, 3000.0)
    rows = queries.recent_eligible_efforts(store.cursor(), window_days=PREDICTION_WINDOW_DAYS)
    assert [row["distance_key"] for row in rows] == ["5k", "10k"]


def test_a_non_running_activity_does_not_anchor_the_window(
    store: duckdb.DuckDBPyConnection,
) -> None:
    _run(store, "run", "2026-01-01 10:00:00+00")
    _run(store, "ride", "2026-09-01 10:00:00+00", sport="cycling")
    _effort(store, "run", "5k", 5000.0, 1500.0)
    rows = queries.recent_eligible_efforts(store.cursor(), window_days=PREDICTION_WINDOW_DAYS)
    assert len(rows) == 1


def test_the_newest_row_with_either_vdot_is_read(store: duckdb.DuckDBPyConnection) -> None:
    store.execute(
        """
        INSERT INTO fitness_series VALUES
            ('a', '2026-01-01 10:00:00+00', 40.0, 38.0),
            ('b', '2026-02-01 10:00:00+00', NULL, 41.0),
            ('c', '2026-03-01 10:00:00+00', NULL, NULL)
        """
    )
    assert queries.latest_prediction_vdots(store.cursor()) == (None, 41.0)


def test_nothing_in_the_store_is_no_vdot(store: duckdb.DuckDBPyConnection) -> None:
    assert queries.recent_eligible_efforts(store.cursor(), window_days=90) == []
    assert queries.latest_prediction_vdots(store.cursor()) == (None, None)


def test_the_response_validates_with_a_band_on_the_ordinary_run_model(
    store: duckdb.DuckDBPyConnection,
) -> None:
    """End to end through the response model, whose validator refuses an
    ordinary_runs prediction without a band."""
    store.execute("INSERT INTO fitness_series VALUES ('a', '2026-01-01 10:00:00+00', 45.0, 40.0)")
    body = Predictions.model_validate(
        race_predictions(*queries.latest_prediction_vdots(store.cursor()))
    )
    assert body.insufficient_data is False
    assert body.reason is None
    for item in body.items:
        by_model = {m.model: m for m in item.models}
        assert set(by_model) == {"best_efforts", "ordinary_runs"}
        assert by_model["ordinary_runs"].low_s is not None
        assert by_model["ordinary_runs"].high_s is not None
        assert by_model["best_efforts"].low_s is None


def test_the_endpoint_answers_on_the_ingested_store(api_client: TestClient) -> None:
    body = api_client.get("/api/predictions").json()
    assert isinstance(body["insufficient_data"], bool)
    assert body["insufficient_data"] == (body["reason"] is not None)
    for item in body["items"]:
        assert item["distance_m"] >= 1000.0
        for model in item["models"]:
            assert model["predicted_time_s"] > 0
            if model["source"] == "ordinary_runs":
                assert model["low_s"] < model["predicted_time_s"] < model["high_s"]


def test_the_endpoint_says_insufficient_data_on_an_empty_store(
    empty_api_client: TestClient,
) -> None:
    body = empty_api_client.get("/api/predictions").json()
    assert body == {
        "items": [],
        "insufficient_data": True,
        "reason": body["reason"],
    }
    assert "eligible best effort" in body["reason"]


def _history(client: TestClient, distance_m: float) -> dict:
    response = client.get("/api/predictions/history", params={"distance_m": distance_m})
    assert response.status_code == 200, response.text
    return response.json()


def test_history_inverts_each_row_at_the_requested_distance(api_client: TestClient) -> None:
    body = _history(api_client, 7500)
    assert body["distance_m"] == 7500
    points = body["points"]
    assert points
    assert [p["start_time_utc"] for p in points] == sorted(p["start_time_utc"] for p in points)
    for p in points:
        assert p["best_efforts_vdot"] is not None or p["ordinary_runs_s"] is not None
        if p["best_efforts_vdot"] is None:
            assert p["best_efforts_s"] is None
        else:
            assert p["best_efforts_s"] == pytest.approx(
                time_for_vdot(7500.0, p["best_efforts_vdot"])
            )
        if p["ordinary_runs_s"] is not None:
            assert p["ordinary_runs_low_s"] < p["ordinary_runs_s"] < p["ordinary_runs_high_s"]
        else:
            assert p["ordinary_runs_low_s"] is None
            assert p["ordinary_runs_high_s"] is None


def test_history_last_point_matches_api_predictions(api_client: TestClient) -> None:
    last = _history(api_client, 5000)["points"][-1]
    item = next(
        i for i in api_client.get("/api/predictions").json()["items"] if i["distance_m"] == 5000
    )
    by_model = {m["model"]: m for m in item["models"]}
    if "best_efforts" in by_model:
        assert last["best_efforts_s"] == pytest.approx(by_model["best_efforts"]["predicted_time_s"])
    if "ordinary_runs" in by_model:
        ordinary = by_model["ordinary_runs"]
        assert last["ordinary_runs_s"] == pytest.approx(ordinary["predicted_time_s"])
        assert last["ordinary_runs_low_s"] == pytest.approx(ordinary["low_s"])
        assert last["ordinary_runs_high_s"] == pytest.approx(ordinary["high_s"])


def test_history_carries_each_runs_own_offset(api_client: TestClient) -> None:
    """A point is dated by its own run's offset, so a view needs no other source."""
    offsets = {
        i["activity_id"]: i["utc_offset_s"]
        for i in api_client.get("/api/activities").json()["items"]
    }
    points = _history(api_client, 5000)["points"]
    assert points
    for p in points:
        assert p["utc_offset_s"] == offsets[p["activity_id"]]


def test_history_refuses_under_1_km(api_client: TestClient) -> None:
    assert api_client.get("/api/predictions/history", params={"distance_m": 400}).status_code == 422


@pytest.mark.parametrize("distance_m", ["inf", "nan", "1e308", "100001"])
def test_history_refuses_a_non_finite_or_huge_distance(
    api_client: TestClient, distance_m: str
) -> None:
    response = api_client.get("/api/predictions/history", params={"distance_m": distance_m})
    assert response.status_code == 422


def test_history_accepts_100_km(api_client: TestClient) -> None:
    assert (
        api_client.get("/api/predictions/history", params={"distance_m": 100_000}).status_code
        == 200
    )


def test_history_on_an_empty_store_has_no_points(empty_api_client: TestClient) -> None:
    assert _history(empty_api_client, 5000) == {"distance_m": 5000, "points": []}
