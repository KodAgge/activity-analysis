"""The record of what the tiles command fetched.

Written last and atomically, so an interrupted fetch leaves the previous
manifest valid and naming only files that exist.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any

from activity_analysis.basemap.areas import Box
from activity_analysis.config import Paths

#: Carried by every served map. OpenStreetMap's licence requires it visible.
ATTRIBUTION = (
    '<a href="https://protomaps.com" target="_blank">Protomaps</a> '
    '<a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap</a>'
)


@dataclass(frozen=True)
class AreaRecord:
    id: str
    box: Box
    build_key: str
    build_url: str
    schema_version: str
    size_bytes: int


@dataclass(frozen=True)
class Manifest:
    areas: tuple[AreaRecord, ...] = ()
    assets_commit: str | None = None

    def area(self, area_id: str) -> AreaRecord | None:
        return next((a for a in self.areas if a.id == area_id), None)


def _record_from_json(raw: Any) -> AreaRecord:
    try:
        box = raw["box"]
        return AreaRecord(
            id=str(raw["id"]),
            box=Box(float(box[0]), float(box[1]), float(box[2]), float(box[3])),
            build_key=str(raw["build_key"]),
            build_url=str(raw["build_url"]),
            schema_version=str(raw["schema_version"]),
            size_bytes=int(raw["size_bytes"]),
        )
    except (KeyError, TypeError, IndexError, ValueError) as exc:
        raise ValueError(f"malformed basemap manifest entry: {raw!r}") from exc


def read_manifest(paths: Paths) -> Manifest:
    if not paths.basemap_manifest.exists():
        return Manifest()
    raw = json.loads(paths.basemap_manifest.read_text())
    if not isinstance(raw, dict) or not isinstance(raw.get("areas"), list):
        raise ValueError(f"malformed basemap manifest: {paths.basemap_manifest}")
    commit = raw.get("assets_commit")
    return Manifest(
        areas=tuple(_record_from_json(a) for a in raw["areas"]),
        assets_commit=str(commit) if commit is not None else None,
    )


def unreadable_manifest(paths: Paths, exc: ValueError) -> str:
    """What to tell a user whose manifest ``read_manifest`` refused."""
    return (
        f"{paths.basemap_manifest} is unreadable: {exc}; "
        "delete it and rerun `activity-analysis tiles` to rebuild it"
    )


def write_manifest(paths: Paths, manifest: Manifest) -> None:
    paths.basemap_dir.mkdir(parents=True, exist_ok=True)
    body = {
        "areas": [
            {
                "id": a.id,
                "box": [a.box.west, a.box.south, a.box.east, a.box.north],
                "build_key": a.build_key,
                "build_url": a.build_url,
                "schema_version": a.schema_version,
                "size_bytes": a.size_bytes,
            }
            for a in manifest.areas
        ],
        "assets_commit": manifest.assets_commit,
    }
    tmp = paths.basemap_manifest.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(body, indent=2) + "\n")
    os.replace(tmp, paths.basemap_manifest)
