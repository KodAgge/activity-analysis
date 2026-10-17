"""The self-hosted basemap: the manifest, the area archives and the style assets.

Every route reads a file ``activity-analysis tiles`` wrote and computes
nothing. An archive is served whole or by byte range, which is how the
frontend's ``pmtiles`` reader takes one tile at a time out of it.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from activity_analysis.api.deps import PathsDep
from activity_analysis.api.models import Basemap, BasemapArea
from activity_analysis.basemap.manifest import (
    ATTRIBUTION,
    Manifest,
    read_manifest,
    unreadable_manifest,
)
from activity_analysis.config import Paths

router = APIRouter(tags=["basemap"])


def _read_manifest(paths: Paths) -> Manifest:
    """503, not an unhandled 500, for a manifest even its own reader cannot parse.

    ``read_manifest`` raises ``ValueError`` on corrupt JSON or a structurally
    bad entry - a file interrupted mid-write, or hand-edited. That is the
    store being unreadable, the same fact ``main.py``'s ``duckdb.Error``
    handler already turns into a 503 elsewhere, so this is a deliberate
    equivalent for the one reader that lives outside DuckDB, not a second
    convention.
    """
    try:
        return read_manifest(paths)
    except ValueError as exc:
        raise HTTPException(status_code=503, detail=unreadable_manifest(paths, exc)) from exc


@router.get("/api/basemap")
def basemap(paths: PathsDep) -> Basemap:
    manifest = _read_manifest(paths)
    return Basemap(
        areas=[
            BasemapArea(
                id=a.id, west=a.box.west, south=a.box.south, east=a.box.east, north=a.box.north
            )
            for a in manifest.areas
        ],
        attribution=ATTRIBUTION,
    )


@router.get(
    "/api/basemap/areas/{area_id}.pmtiles",
    response_class=FileResponse,
    # Read by the frontend's pmtiles reader directly, never through the typed
    # openapi-fetch client, so it stays out of the generated schema.
    include_in_schema=False,
)
def basemap_area(area_id: str, paths: PathsDep) -> FileResponse:
    """404 for an id the manifest does not list, so a path never names another file."""
    if _read_manifest(paths).area(area_id) is None:
        raise HTTPException(status_code=404, detail=f"no basemap area {area_id}")
    path = paths.basemap_area_path(area_id)
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"basemap area {area_id} has no file")
    return FileResponse(path, media_type="application/vnd.pmtiles")


@router.get(
    "/api/basemap/assets/{asset_path:path}",
    response_class=FileResponse,
    # Read by MapLibre directly (fonts, sprites), never through the typed
    # openapi-fetch client, so it stays out of the generated schema.
    include_in_schema=False,
)
def basemap_asset(asset_path: str, paths: PathsDep) -> FileResponse:
    """The style's fonts and sprites, served under the assets directory only.

    ``asset_path`` is client-controlled, so it is resolved against the
    assets directory and checked with ``is_relative_to`` before anything
    is read, closing both a literal ``..`` segment and one that only
    appears after normalisation.
    """
    base = paths.basemap_assets_dir.resolve()
    target = (base / asset_path).resolve()
    if not target.is_relative_to(base) or not target.is_file():
        raise HTTPException(status_code=404, detail="no such basemap asset")
    return FileResponse(Path(target))
