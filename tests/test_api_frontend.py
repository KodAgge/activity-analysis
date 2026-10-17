"""The built frontend, served by the API process so ``serve`` is one command."""

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from activity_analysis.api import frontend
from activity_analysis.api.main import create_app
from activity_analysis.config import Paths

INDEX = "<!doctype html><title>app</title>"


@pytest.fixture
def build(tmp_path: Path) -> Path:
    """The shape of a Vite build: an index, hashed assets, and a public file."""
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text(INDEX)
    (dist / "assets" / "index-abc123.js").write_text("console.log(1)")
    (dist / "favicon.svg").write_text("<svg/>")
    return dist


@pytest.fixture
def client(tmp_path: Path, build: Path) -> Iterator[TestClient]:
    with TestClient(create_app(Paths(root=tmp_path / "store"), frontend=build)) as client:
        yield client


def test_the_root_serves_the_index(client: TestClient):
    response = client.get("/")
    assert response.status_code == 200
    assert response.text == INDEX


def test_built_files_are_served(client: TestClient):
    assert client.get("/assets/index-abc123.js").text == "console.log(1)"
    assert client.get("/favicon.svg").text == "<svg/>"


def test_a_client_side_route_gets_the_index(client: TestClient):
    """TanStack Router resolves these in the browser, so a reload must not 404."""
    for route in ("/activities/0123456789abcdef", "/trends", "/territory"):
        response = client.get(route)
        assert response.status_code == 200, route
        assert response.text == INDEX, route


def test_a_missing_file_is_a_404_not_the_index(client: TestClient):
    """A stale asset reference served as HTML would fail as a script parse error instead."""
    assert client.get("/assets/index-gone.js").status_code == 404


def test_the_api_still_answers_and_its_misses_stay_json(client: TestClient):
    assert client.get("/api/health").status_code == 200
    missing = client.get("/api/no-such-endpoint")
    assert missing.status_code == 404
    assert missing.headers["content-type"] == "application/json"


def test_the_api_docs_are_not_shadowed(client: TestClient):
    assert "swagger" in client.get("/docs").text.lower()
    assert client.get("/openapi.json").json()["info"]["title"] == "activity-analysis"


def test_without_a_build_only_the_api_is_served(empty_api_client: TestClient):
    assert empty_api_client.get("/").status_code == 404
    assert empty_api_client.get("/api/health").status_code == 200


def test_the_mount_leaves_the_openapi_schema_alone(tmp_path: Path, build: Path):
    """``check:api`` diffs the generated types against this schema."""
    store = Paths(root=tmp_path / "store")
    assert create_app(store, frontend=build).openapi() == create_app(store).openapi()


def test_the_packaged_build_is_preferred_over_a_checkout_build(
    tmp_path: Path, build: Path, monkeypatch
):
    checkout = tmp_path / "checkout"
    (checkout / "web" / "dist").mkdir(parents=True)
    (checkout / "web" / "dist" / "index.html").write_text(INDEX)

    monkeypatch.setattr(frontend, "PACKAGED_BUILD", build)
    monkeypatch.setattr(frontend, "CHECKOUT_BUILD", checkout / "web" / "dist")
    assert frontend.find_build() == build

    monkeypatch.setattr(frontend, "PACKAGED_BUILD", tmp_path / "not-installed")
    assert frontend.find_build() == checkout / "web" / "dist"

    monkeypatch.setattr(frontend, "CHECKOUT_BUILD", tmp_path / "never-built")
    assert frontend.find_build() is None


def test_the_index_is_revalidated_and_hashed_assets_are_cached(client: TestClient):
    """An index cached past an upgrade names hashed assets that no longer exist."""
    for route in ("/", "/index.html", "/trends"):
        assert client.get(route).headers["cache-control"] == "no-cache", route
    asset = client.get("/assets/index-abc123.js").headers["cache-control"]
    assert "immutable" in asset


def test_api_misses_stay_json_whatever_the_platform_separator(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    """StaticFiles normalises with os.path, which on Windows turns api/nope into api\\nope."""

    def windows_get_path(self: object, scope: dict[str, str]) -> str:
        return "\\".join(part for part in scope["path"].split("/") if part)

    monkeypatch.setattr(frontend.SinglePageApp, "get_path", windows_get_path)
    assert client.get("/trends").text == INDEX
    missing = client.get("/api/no-such-endpoint")
    assert missing.status_code == 404
    assert missing.headers["content-type"] == "application/json"
