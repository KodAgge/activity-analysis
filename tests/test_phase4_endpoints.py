"""The four phase 4 endpoints answer on a store with nothing to serve.

Each one is exercised in depth by its own module. What this file pins is the
degenerate store: an empty payload rather than a 500, and a 404 rather than a
present-but-empty distance, which is the shape the frontend is built against.
"""

from __future__ import annotations

from fastapi.testclient import TestClient


def test_trends_returns_an_empty_payload(empty_api_client: TestClient) -> None:
    response = empty_api_client.get("/api/trends")
    assert response.status_code == 200
    assert response.json()["items"] == []


def test_fitness_returns_an_empty_payload(empty_api_client: TestClient) -> None:
    response = empty_api_client.get("/api/fitness")
    assert response.status_code == 200
    assert response.json()["items"] == []


def test_predictions_says_insufficient_data_on_an_empty_store(
    empty_api_client: TestClient,
) -> None:
    response = empty_api_client.get("/api/predictions")
    assert response.status_code == 200
    assert response.json()["insufficient_data"] is True


def test_progression_404s_for_a_distance_with_no_efforts(empty_api_client: TestClient) -> None:
    """A distance with no effort is absent, never present and empty. On the
    real store `30k`, `35k` and `marathon` are that case: the extractor knows
    all three but no run has covered them."""
    assert empty_api_client.get("/api/progression/marathon").status_code == 404


def test_progression_404s_for_a_key_the_extractor_does_not_know(
    empty_api_client: TestClient,
) -> None:
    assert empty_api_client.get("/api/progression/42k").status_code == 404


def test_progression_is_present_for_a_distance_the_fixtures_reach(
    api_client: TestClient,
) -> None:
    """The 404 branches must not swallow a distance that has efforts. The
    five fixture runs all cover a kilometre, so `1k` is present and its
    effort count matches the items served."""
    response = api_client.get("/api/progression/1k")
    assert response.status_code == 200
    body = response.json()
    assert body["distance_key"] == "1k"
    assert body["distance_m"] == 1000.0
    assert body["effort_count"] == len(body["items"]) > 0
