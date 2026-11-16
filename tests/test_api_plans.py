"""``GET /api/plans``: the plan files served read-only, with speeds in m/s."""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from activity_analysis.analysis.fitness import time_for_vdot
from activity_analysis.api.main import create_app
from activity_analysis.config import Paths
from activity_analysis.plan.models import PlanDraft
from activity_analysis.plan.store import PlanStore
from tests.test_plan_models import five_week_draft

GOAL = "5k-2027-03-13"
NOW = datetime(2027, 2, 6, 12, 0, tzinfo=UTC)
CONTEXT: dict[str, Any] = {
    "freshness": {"newest_run_local_date": "2027-02-05"},
    "predictions": {"items": [{"distance_key": "5k", "distance_m": 5000.0, "models": []}]},
}


def _draft(goal_id: str = GOAL, target_time_s: float = 1500.0) -> PlanDraft:
    data = five_week_draft().model_dump(mode="json")
    data["goal"] |= {"goal_id": goal_id, "target_time_s": target_time_s}
    if target_time_s != 1500.0:
        data["changes"] = [{"title": "Faster target", "reason": "Fit", "goal_change": True}]
    data["weeks"][0]["sessions"][1]["steps"] = [
        {"role": "work", "distance_m": 5000.0, "speed": {"low_mps": 3.0, "high_mps": 3.4}}
    ]
    return PlanDraft.model_validate(data)


@pytest.fixture
def paths(tmp_path: Path) -> Paths:
    return Paths(tmp_path)


@pytest.fixture
def client(paths: Paths) -> Iterator[TestClient]:
    with TestClient(create_app(paths)) as client:
        yield client


def _two_versions(paths: Paths) -> None:
    store = PlanStore(paths)
    store.propose(_draft(), CONTEXT, now=NOW)
    store.accept(GOAL)
    store.propose(_draft(target_time_s=1450.0), CONTEXT, now=NOW)


def test_no_plans_is_an_empty_list(empty_api_client: TestClient) -> None:
    response = empty_api_client.get("/api/plans")
    assert response.status_code == 200
    assert response.json() == {"items": []}


def test_plans_lists_a_goal_with_its_accepted_and_pending_versions(
    paths: Paths, client: TestClient
) -> None:
    _two_versions(paths)
    items = client.get("/api/plans").json()["items"]
    assert items == [
        {
            "goal_id": GOAL,
            "status": "active",
            "distance_m": 5000.0,
            "target_time_s": 1450.0,
            "race_date": "2027-03-13",
            "accepted_version": 1,
            "pending_version": 2,
        }
    ]


def test_plan_detail_serves_every_version_oldest_first(paths: Paths, client: TestClient) -> None:
    _two_versions(paths)
    body = client.get(f"/api/plans/{GOAL}").json()
    assert body["goal_id"] == GOAL
    assert body["status"] == "active"
    assert [(v["number"], v["status"]) for v in body["versions"]] == [
        (1, "accepted"),
        (2, "proposed"),
    ]
    assert body["versions"][1]["plan"]["provenance"]["number"] == 2


def test_plan_endpoint_serves_expected_prediction_at_the_goal_distance(
    paths: Paths, client: TestClient
) -> None:
    data = _draft().model_dump(mode="json")
    data["goal"]["distance_m"] = 10000.0
    data["weeks"][0]["expected_vdot"] = 44.0
    data["weeks"][4]["expected_vdot"] = 45.0
    PlanStore(paths).propose(PlanDraft.model_validate(data), CONTEXT, now=NOW)
    points = client.get(f"/api/plans/{GOAL}").json()["versions"][0]["expected_prediction"]
    assert len(points) == 5
    # The first Sunday, and the race on the final week's Saturday, not its Sunday.
    assert points[0]["local_date"] == "2027-02-14"
    assert points[-1]["local_date"] == "2027-03-13"
    assert points[0]["time_s"] == pytest.approx(time_for_vdot(10000.0, 44.0))
    assert points[-1]["time_s"] == pytest.approx(time_for_vdot(10000.0, 45.0))


def test_plan_endpoint_serves_an_old_version_without_expected_vdot(
    paths: Paths, client: TestClient
) -> None:
    store = PlanStore(paths)
    store.propose(_draft(), CONTEXT, now=NOW)
    # A version stored before expected_vdot existed: strip it from the file.
    path = paths.plan_dir(GOAL) / "v001.json"
    stored = json.loads(path.read_text())
    for week in stored["weeks"]:
        del week["expected_vdot"]
    path.write_text(json.dumps(stored))
    body = client.get(f"/api/plans/{GOAL}").json()
    assert body["versions"][0]["expected_prediction"] == []


def test_speeds_cross_the_boundary_in_mps(paths: Paths, client: TestClient) -> None:
    _two_versions(paths)
    body = client.get(f"/api/plans/{GOAL}").json()
    step = body["versions"][0]["plan"]["weeks"][0]["sessions"][1]["steps"][0]
    assert step["speed"] == {"low_mps": 3.0, "high_mps": 3.4}

    def keys(node: Any) -> list[str]:
        if isinstance(node, dict):
            return [*node, *(k for v in node.values() for k in keys(v))]
        if isinstance(node, list):
            return [k for v in node for k in keys(v)]
        return []

    assert not [k for k in keys(body) if "pace" in k]


def test_an_unknown_goal_is_404(client: TestClient) -> None:
    assert client.get("/api/plans/nope").status_code == 404


def test_a_goal_id_with_a_slash_is_404(client: TestClient) -> None:
    assert client.get("/api/plans/..%2Fsecret").status_code == 404


def test_a_goal_id_outside_the_pattern_is_404_even_with_a_directory(
    paths: Paths, client: TestClient
) -> None:
    # The directory and its index exist, so only the id check refuses it.
    for goal_id in ("Bad_Id", "a" * 101):
        directory = paths.plan_dir(goal_id)
        directory.mkdir(parents=True)
        (directory / "index.json").write_text("{}", encoding="utf-8")
        assert client.get(f"/api/plans/{goal_id}").status_code == 404


def test_a_corrupt_plan_file_is_503_naming_it(paths: Paths, client: TestClient) -> None:
    _two_versions(paths)
    index = paths.plan_dir(GOAL) / "index.json"
    index.write_text('{"goal_id": ', encoding="utf-8")
    for url in ("/api/plans", f"/api/plans/{GOAL}"):
        response = client.get(url)
        assert response.status_code == 503
        assert str(index) in response.json()["detail"]


def test_the_server_never_writes_to_the_plans_directory(paths: Paths, client: TestClient) -> None:
    _two_versions(paths)
    before = {p: p.read_bytes() for p in paths.plans_dir.rglob("*") if p.is_file()}
    client.get("/api/plans")
    client.get(f"/api/plans/{GOAL}")
    after = {p: p.read_bytes() for p in paths.plans_dir.rglob("*") if p.is_file()}
    assert before == after
    assert json.loads((paths.plan_dir(GOAL) / "index.json").read_text())["goal_id"] == GOAL


def test_a_goal_directory_without_an_index_is_404(paths: Paths, client: TestClient) -> None:
    paths.plan_dir(GOAL).mkdir(parents=True)
    assert client.get(f"/api/plans/{GOAL}").status_code == 404
    assert client.get("/api/plans").json() == {"items": []}


def test_a_corrupt_version_file_is_503_naming_it(paths: Paths, client: TestClient) -> None:
    _two_versions(paths)
    version = paths.plan_dir(GOAL) / "v001.json"
    version.write_text('{"goal": ', encoding="utf-8")
    for url in ("/api/plans", f"/api/plans/{GOAL}"):
        response = client.get(url)
        assert response.status_code == 503
        assert str(version) in response.json()["detail"]


def test_plans_summarises_a_goal_from_its_accepted_version_after_a_rejection(
    paths: Paths, client: TestClient
) -> None:
    _two_versions(paths)
    PlanStore(paths).reject(GOAL)
    (item,) = client.get("/api/plans").json()["items"]
    assert (item["target_time_s"], item["accepted_version"], item["pending_version"]) == (
        1500.0,
        1,
        None,
    )


def test_plans_summarises_a_goal_whose_only_version_was_rejected(
    paths: Paths, client: TestClient
) -> None:
    store = PlanStore(paths)
    store.propose(_draft(target_time_s=1450.0), CONTEXT, now=NOW)
    store.reject(GOAL)
    (item,) = client.get("/api/plans").json()["items"]
    assert (item["status"], item["target_time_s"]) == ("proposed", 1450.0)
