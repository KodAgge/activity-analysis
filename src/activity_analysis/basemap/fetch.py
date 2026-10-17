"""Fetch the map areas the stored runs need, and the style's fonts and sprites.

The only module in this project that sends requests. An area extract sends
its box to the tile host; nothing else here carries a location.
"""

from __future__ import annotations

import http.client
import importlib.metadata
import io
import json
import re
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
import zlib
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any

import numpy as np
import pandas as pd

from activity_analysis.analysis.pipeline import RUNNING_SPORT
from activity_analysis.basemap.areas import Box, area_id, plan_areas, runs_inside, trace_box
from activity_analysis.basemap.manifest import (
    AreaRecord,
    Manifest,
    read_manifest,
    unreadable_manifest,
    write_manifest,
)
from activity_analysis.config import Paths
from activity_analysis.store.writer import (
    read_activities,
    read_activity_metrics,
    read_derived_stream,
)

PMTILES_VERSION = "1.31.2"
PMTILES_RELEASES = "https://github.com/protomaps/go-pmtiles/releases/tag/v1.31.2"
#: The basemap schema major version `@protomaps/basemaps@5.7.2` targets.
SCHEMA_MAJOR = 4
MAXZOOM = 15
BUILDS_URL = "https://build-metadata.protomaps.dev/builds.json"
BUILD_BASE_URL = "https://build.protomaps.com/"
#: A build's key is joined onto ``BUILD_BASE_URL`` and stored, so it must be
#: a dated archive name and nothing else.
BUILD_KEY = re.compile(r"^\d{8}\.pmtiles$")
ASSETS_COMMIT = "028c18f713baecad011301ff7a69acc39bcc2ae7"
ASSETS_URL = f"https://github.com/protomaps/basemaps-assets/archive/{ASSETS_COMMIT}.tar.gz"
FONT_STACKS = (
    "Noto Sans Regular",
    "Noto Sans Medium",
    "Noto Sans Italic",
    "Noto Sans Devanagari Regular v1",
)
SPRITE_FLAVOURS = ("light", "grayscale")

Fetch = Callable[[str], bytes]


class BasemapError(Exception):
    """A fetch that cannot proceed, with the reason a user can act on."""


def _user_agent() -> str:
    try:
        version = importlib.metadata.version("activity-analysis")
    except importlib.metadata.PackageNotFoundError:
        version = "0.0.0"
    return f"activity-analysis/{version}"


def urllib_fetch(url: str) -> bytes:
    # build-metadata.protomaps.dev answers 403 to Python's default urllib
    # User-Agent (Python-urllib/3.12) but 200 to any explicit one; measured
    # 2026-09-24. Name this program and its installed version instead.
    request = urllib.request.Request(url, headers={"User-Agent": _user_agent()})
    with urllib.request.urlopen(request, timeout=120) as response:  # noqa: S310
        body: bytes = response.read()
        return body


@dataclass(frozen=True)
class Build:
    key: str
    url: str
    version: str


def _major(version: str) -> int | None:
    head = version.split(".", 1)[0]
    return int(head) if head.isdigit() else None


def choose_build(builds: list[dict[str, Any]]) -> Build:
    """The newest listed build whose schema major version is ``SCHEMA_MAJOR``.

    An entry whose key is not a dated archive name is skipped.
    """
    usable = [
        b
        for b in builds
        if _major(str(b.get("version", ""))) == SCHEMA_MAJOR
        and BUILD_KEY.match(str(b.get("key", "")))
    ]
    if not usable:
        raise BasemapError(
            f"no Protomaps build on basemap schema {SCHEMA_MAJOR} is listed at {BUILDS_URL}"
        )
    newest = max(usable, key=lambda b: str(b["key"]))
    key = str(newest["key"])
    return Build(key=key, url=BUILD_BASE_URL + key, version=str(newest["version"]))


def check_pmtiles(binary: str) -> None:
    resolved = shutil.which(binary)
    if resolved is None:
        raise BasemapError(
            f"pmtiles not found at {binary!r}; install {PMTILES_VERSION} from {PMTILES_RELEASES}"
        )
    out = subprocess.run([resolved, "version"], capture_output=True, text=True, check=False)
    parts = out.stdout.split()
    found = parts[1].rstrip(",") if len(parts) > 1 and parts[0] == "pmtiles" else ""

    def as_tuple(v: str) -> tuple[int, ...]:
        return tuple(int(p) for p in v.split(".") if p.isdigit())

    if not found or as_tuple(found) < as_tuple(PMTILES_VERSION):
        raise BasemapError(
            f"pmtiles {found or 'of unknown version'} is older than {PMTILES_VERSION}; "
            f"install it from {PMTILES_RELEASES}"
        )


@dataclass(frozen=True)
class RunTrace:
    lat: np.ndarray
    lon: np.ndarray
    locality: str | None


def load_run_traces(paths: Paths) -> dict[str, RunTrace]:
    """Every outdoor running activity with GPS, as its 1 Hz positions.

    The same rule ``ActivityDetail`` uses to decide an activity has a route:
    ``has_gps`` and not ``is_indoor``.
    """
    activities = read_activities(paths)
    metrics = read_activity_metrics(paths)
    if activities.empty or metrics.empty:
        return {}
    runs = activities.loc[activities["sport"] == RUNNING_SPORT, ["activity_id"]].merge(
        metrics[["activity_id", "has_gps", "is_indoor", "locality"]], on="activity_id"
    )
    runs = runs[
        runs["has_gps"].fillna(False).astype(bool) & ~runs["is_indoor"].fillna(False).astype(bool)
    ]
    traces: dict[str, RunTrace] = {}
    for row in runs.itertuples(index=False):
        stream = read_derived_stream(paths, str(row.activity_id))
        lat = pd.to_numeric(stream["lat_deg"], errors="coerce").to_numpy(dtype=float)
        lon = pd.to_numeric(stream["lon_deg"], errors="coerce").to_numpy(dtype=float)
        locality = None if pd.isna(row.locality) else str(row.locality)
        traces[str(row.activity_id)] = RunTrace(lat=lat, lon=lon, locality=locality)
    return traces


@dataclass
class TilesResult:
    fetched: list[str] = field(default_factory=list)
    kept: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    errors: list[tuple[str, str]] = field(default_factory=list)


def _fetch(fetch: Fetch, url: str) -> bytes:
    """``fetch(url)``, with a network or HTTP failure raised as a ``BasemapError``."""
    try:
        return fetch(url)
    except (OSError, http.client.HTTPException) as exc:
        # URLError, HTTPError and a timeout are OSErrors; a body cut short
        # mid-read is an IncompleteRead, an HTTPException.
        raise BasemapError(f"could not download {url}: {exc}") from exc


def _fetch_builds(fetch: Fetch) -> list[dict[str, Any]]:
    body = _fetch(fetch, BUILDS_URL)
    try:
        builds = json.loads(body)
    except ValueError as exc:
        raise BasemapError(f"the build listing at {BUILDS_URL} is not JSON: {exc}") from exc
    if not isinstance(builds, list) or not all(isinstance(b, dict) for b in builds):
        raise BasemapError(f"the build listing at {BUILDS_URL} is not a list of builds")
    return builds


def _failure(exc: subprocess.CalledProcessError) -> str:
    """What a failed pmtiles run said, trimmed to its last lines."""
    stderr = (exc.stderr or "").strip()
    tail = " | ".join(stderr.splitlines()[-3:])[-500:]
    command = exc.cmd[1] if isinstance(exc.cmd, list) and len(exc.cmd) > 1 else "pmtiles"
    return f"pmtiles {command} exited {exc.returncode}" + (f": {tail}" if tail else "")


def _schema_of(binary: str, archive: Path) -> str:
    out = subprocess.run(
        [binary, "show", str(archive), "--metadata"], capture_output=True, text=True, check=True
    )
    try:
        metadata = json.loads(out.stdout)
    except ValueError as exc:
        raise BasemapError(f"cannot read the metadata of {archive}: {exc}") from exc
    if not isinstance(metadata, dict):
        raise BasemapError(f"the metadata of {archive} is not a JSON object")
    return str(metadata.get("version", ""))


def _extract(binary: str, build: Build, box: Box, dest: Path) -> str:
    """Extract ``box`` into ``dest`` and return its schema version."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".pmtiles.part")
    tmp.unlink(missing_ok=True)
    try:
        subprocess.run(
            [
                binary,
                "extract",
                build.url,
                str(tmp),
                f"--bbox={box.as_bbox_arg()}",
                f"--maxzoom={MAXZOOM}",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        schema = _schema_of(binary, tmp)
        if _major(schema) != SCHEMA_MAJOR:
            raise BasemapError(f"extract is on basemap schema {schema}, expected {SCHEMA_MAJOR}")
        tmp.replace(dest)
        return schema
    finally:
        tmp.unlink(missing_ok=True)


def _install_assets(fetch: Fetch, assets_dir: Path) -> None:
    root = f"basemaps-assets-{ASSETS_COMMIT}"
    wanted_fonts = {f"{root}/fonts/{stack}" for stack in FONT_STACKS}
    wanted_sprites = f"{root}/sprites/v4/"
    body = _fetch(fetch, ASSETS_URL)
    staging = Path(tempfile.mkdtemp(dir=assets_dir.parent, prefix="assets."))
    try:
        try:
            with tarfile.open(fileobj=io.BytesIO(body), mode="r:gz") as tar:
                for member in tar.getmembers():
                    if not member.isfile():
                        continue
                    name = PurePosixPath(member.name)
                    if ".." in name.parts:
                        continue
                    keep = str(name.parent) in wanted_fonts or (
                        member.name.startswith(wanted_sprites)
                        and name.name.split("@", 1)[0].split(".", 1)[0] in SPRITE_FLAVOURS
                    )
                    if not keep:
                        continue
                    target = staging.joinpath(*name.parts[1:])
                    target.parent.mkdir(parents=True, exist_ok=True)
                    source = tar.extractfile(member)
                    if source is None:
                        continue
                    target.write_bytes(source.read())
        except (tarfile.TarError, EOFError, zlib.error, OSError) as exc:
            # A truncated or corrupt download, or a full disk while unpacking.
            raise BasemapError(f"could not unpack the assets tarball {ASSETS_URL}: {exc}") from exc
        if assets_dir.exists():
            shutil.rmtree(assets_dir)
        staging.replace(assets_dir)
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def _describe(box: Box, runs: list[str], traces: dict[str, RunTrace]) -> str:
    places = sorted({traces[r].locality or "?" for r in runs})
    return f"{area_id(box)} {box.as_bbox_arg()}: {len(runs)} run(s), " + ", ".join(places)


def run_tiles(
    paths: Paths,
    traces: dict[str, RunTrace],
    *,
    binary: str,
    fetch: Fetch,
    dry_run: bool,
    echo: Callable[[str], None],
) -> TilesResult:
    """Plan the areas the runs need, print the plan, and fetch it unless ``dry_run``.

    The plan is printed before any request, and a dry run sends none and
    needs no pmtiles binary. A listed area whose file is missing is planned
    as if it had never been fetched, and missing assets are installed again.
    """
    try:
        manifest = read_manifest(paths)
    except ValueError as exc:
        raise BasemapError(unreadable_manifest(paths, exc)) from exc
    assets_current = manifest.assets_commit == ASSETS_COMMIT and paths.basemap_assets_dir.is_dir()
    present = [a for a in manifest.areas if paths.basemap_area_path(a.id).is_file()]
    missing = [a for a in manifest.areas if a not in present]
    records = {a.id: a for a in present}
    plan = plan_areas([a.box for a in present], {k: (t.lat, t.lon) for k, t in traces.items()})
    trace_boxes = {k: trace_box(t.lat, t.lon) for k, t in traces.items()}
    result = TilesResult(kept=[area_id(b) for b in plan.keep])

    for area in missing:
        echo(f"missing {area.id} {area.box.as_bbox_arg()}: listed but its file is gone")
    if manifest.assets_commit == ASSETS_COMMIT and not assets_current:
        echo(f"missing assets: listed but {paths.basemap_assets_dir} is gone")
    for box in plan.fetch:
        echo("fetch " + _describe(box, runs_inside(box, trace_boxes), traces))
    for box in plan.keep:
        echo("keep " + _describe(box, runs_inside(box, trace_boxes), traces))
    echo(f"keep {len(plan.keep)} area(s) already fetched")
    if dry_run or (not plan.fetch and not missing and assets_current):
        return result

    build = None
    if plan.fetch:
        check_pmtiles(binary)
        build = choose_build(_fetch_builds(fetch))
    paths.basemap_areas_dir.mkdir(parents=True, exist_ok=True)
    if not assets_current:
        _install_assets(fetch, paths.basemap_assets_dir)

    kept = [records[i] for i in result.kept]
    for box in plan.fetch:
        new_id = area_id(box)
        assert build is not None
        try:
            schema = _extract(binary, build, box, paths.basemap_area_path(new_id))
        except (subprocess.CalledProcessError, BasemapError) as exc:
            message = _failure(exc) if isinstance(exc, subprocess.CalledProcessError) else str(exc)
            result.errors.append((new_id, message))
            # The areas this one would have replaced stay as they were.
            restored = [i for i in plan.replaced.get(new_id, []) if i in records]
            kept.extend(records[i] for i in restored)
            result.kept.extend(restored)
            continue
        size = paths.basemap_area_path(new_id).stat().st_size
        kept.append(AreaRecord(new_id, box, build.key, build.url, schema, size))
        result.fetched.append(new_id)
        result.removed.extend(plan.replaced.get(new_id, []))

    write_manifest(
        paths, Manifest(areas=tuple(sorted(kept, key=lambda a: a.id)), assets_commit=ASSETS_COMMIT)
    )
    for old in result.removed:
        paths.basemap_area_path(old).unlink(missing_ok=True)
    return result
