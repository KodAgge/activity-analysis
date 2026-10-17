from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from activity_analysis.api.main import create_app
from activity_analysis.basemap.areas import Box
from activity_analysis.basemap.manifest import AreaRecord, Manifest, write_manifest
from activity_analysis.config import Paths

AREA = AreaRecord("abc123def456", Box(14.79, 56.83, 14.97, 56.94), "k", "u", "4.15.2", 0)
BODY = bytes(range(256)) * 64  # 16 KiB, above the gzip threshold


@pytest.fixture
def basemap_client(tmp_path: Path) -> Iterator[TestClient]:
    paths = Paths(root=tmp_path)
    paths.basemap_areas_dir.mkdir(parents=True)
    paths.basemap_area_path(AREA.id).write_bytes(BODY)
    glyphs = paths.basemap_assets_dir / "fonts" / "Noto Sans Regular"
    glyphs.mkdir(parents=True)
    (glyphs / "0-255.pbf").write_bytes(b"glyphs")
    (tmp_path / "secret.txt").write_text("not an asset")
    write_manifest(paths, Manifest(areas=(AREA,)))
    with TestClient(create_app(paths)) as client:
        yield client


def test_the_manifest_lists_areas_and_attribution(basemap_client: TestClient):
    body = basemap_client.get("/api/basemap").json()
    assert body["areas"] == [
        {"id": AREA.id, "west": 14.79, "south": 56.83, "east": 14.97, "north": 56.94}
    ]
    assert "OpenStreetMap" in body["attribution"]


def test_a_store_without_a_basemap_lists_no_areas(empty_api_client: TestClient):
    assert empty_api_client.get("/api/basemap").json()["areas"] == []


def test_an_archive_is_served_by_range_and_left_uncompressed(basemap_client: TestClient):
    r = basemap_client.get(
        f"/api/basemap/areas/{AREA.id}.pmtiles",
        headers={"Range": "bytes=100-4199", "Accept-Encoding": "gzip"},
    )
    assert r.status_code == 206
    assert r.headers["content-range"] == f"bytes 100-4199/{len(BODY)}"
    assert r.headers.get("content-encoding") in (None, "identity")
    assert r.content == BODY[100:4200]


def test_an_area_the_manifest_does_not_list_is_404(basemap_client: TestClient):
    assert basemap_client.get("/api/basemap/areas/ffffffffffff.pmtiles").status_code == 404


def test_a_listed_area_whose_file_is_missing_is_404(basemap_client: TestClient, tmp_path: Path):
    Paths(root=tmp_path).basemap_area_path(AREA.id).unlink()
    assert basemap_client.get(f"/api/basemap/areas/{AREA.id}.pmtiles").status_code == 404


def test_an_asset_is_served(basemap_client: TestClient):
    r = basemap_client.get("/api/basemap/assets/fonts/Noto Sans Regular/0-255.pbf")
    assert r.status_code == 200
    assert r.content == b"glyphs"


@pytest.mark.parametrize(
    "path", ["../../secret.txt", "..%2F..%2Fsecret.txt", "fonts/../../../secret.txt"]
)
def test_an_asset_path_cannot_leave_the_assets_directory(basemap_client: TestClient, path: str):
    assert basemap_client.get(f"/api/basemap/assets/{path}").status_code == 404


@pytest.mark.parametrize(
    "body", ["not json{{{", '{"areas": [{"id": 1}]}'], ids=["corrupt-json", "bad-entry"]
)
def test_a_malformed_manifest_is_a_deliberate_503(tmp_path: Path, body: str):
    paths = Paths(root=tmp_path)
    paths.basemap_dir.mkdir(parents=True)
    paths.basemap_manifest.write_text(body)
    with TestClient(create_app(paths)) as client:
        for response in (
            client.get("/api/basemap"),
            client.get(f"/api/basemap/areas/{AREA.id}.pmtiles"),
        ):
            assert response.status_code == 503
            detail = response.json()["detail"]
            assert str(paths.basemap_manifest) in detail
            assert "delete it and rerun `activity-analysis tiles`" in detail
