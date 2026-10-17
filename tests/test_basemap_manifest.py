from __future__ import annotations

import json
from pathlib import Path

import pytest

from activity_analysis.basemap.areas import Box
from activity_analysis.basemap.manifest import (
    AreaRecord,
    Manifest,
    read_manifest,
    write_manifest,
)
from activity_analysis.config import Paths

RECORD = AreaRecord(
    id="abc123def456",
    box=Box(14.79, 56.83, 14.97, 56.94),
    build_key="20260923.pmtiles",
    build_url="https://build.protomaps.com/20260923.pmtiles",
    schema_version="4.15.2",
    size_bytes=1234,
)


def test_the_paths_live_under_data_basemap(tmp_path: Path):
    paths = Paths(root=tmp_path)
    assert paths.basemap_manifest == tmp_path / "data" / "basemap" / "manifest.json"
    assert paths.basemap_area_path("abc") == tmp_path / "data" / "basemap" / "areas" / "abc.pmtiles"
    assert paths.basemap_assets_dir == tmp_path / "data" / "basemap" / "assets"


def test_a_store_with_no_basemap_reads_as_an_empty_manifest(tmp_path: Path):
    assert read_manifest(Paths(root=tmp_path)) == Manifest()


def test_the_manifest_round_trips(tmp_path: Path):
    paths = Paths(root=tmp_path)
    manifest = Manifest(areas=(RECORD,), assets_commit="028c18f7")
    write_manifest(paths, manifest)
    assert read_manifest(paths) == manifest
    assert read_manifest(paths).area("abc123def456") == RECORD
    assert read_manifest(paths).area("nope") is None


def test_a_write_leaves_no_temporary_file_behind(tmp_path: Path):
    paths = Paths(root=tmp_path)
    write_manifest(paths, Manifest(areas=(RECORD,)))
    assert sorted(p.name for p in paths.basemap_dir.iterdir()) == ["manifest.json"]


def test_a_malformed_manifest_raises_rather_than_reading_as_empty(tmp_path: Path):
    paths = Paths(root=tmp_path)
    paths.basemap_dir.mkdir(parents=True)
    paths.basemap_manifest.write_text(json.dumps({"areas": [{"id": 1}]}))
    with pytest.raises(ValueError):
        read_manifest(paths)
