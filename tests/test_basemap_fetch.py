from __future__ import annotations

import io
import json
import shutil
import stat
import sys
import tarfile
import urllib.request
from email.message import Message
from http.client import IncompleteRead
from pathlib import Path
from urllib.error import HTTPError, URLError

import numpy as np
import pytest

from activity_analysis.basemap import fetch as fetch_module
from activity_analysis.basemap.areas import Box, area_box, area_id, trace_box
from activity_analysis.basemap.fetch import (
    ASSETS_COMMIT,
    ASSETS_URL,
    BUILDS_URL,
    BasemapError,
    RunTrace,
    check_pmtiles,
    choose_build,
    load_run_traces,
    run_tiles,
    urllib_fetch,
)
from activity_analysis.basemap.manifest import AreaRecord, Manifest, read_manifest, write_manifest
from activity_analysis.config import Paths

FAKE = r"""#!{python}
import json, pathlib, sys
log = pathlib.Path({log!r})
with log.open("a") as f:
    f.write(json.dumps(sys.argv[1:]) + "\n")
cmd = sys.argv[1]
if cmd == "version":
    print("pmtiles {version}, commit abc, built at 2026-07-22T18:59:03Z")
elif cmd == "extract":
    out = pathlib.Path(sys.argv[3])
    bbox = [a for a in sys.argv if a.startswith("--bbox=")][0]
    if {fail_bbox!r} and bbox == "--bbox=" + {fail_bbox!r}:
        sys.stderr.write("fetching tiles\nerror: 403 Forbidden from the build host\n")
        sys.exit(3)
    out.write_bytes(b"PMTiles" + bbox.encode())
elif cmd == "show":
    print({metadata!r} or json.dumps({{"version": {schema!r}}}))
"""


def fake_pmtiles(
    tmp_path: Path,
    *,
    version: str = "1.31.2",
    schema: str = "4.15.2",
    fail_bbox: str = "",
    metadata: str = "",
) -> tuple[str, Path]:
    """A stand-in pmtiles; ``metadata``, if given, is what ``show --metadata`` prints."""
    log = tmp_path / "pmtiles.log"
    script = tmp_path / "pmtiles"
    script.write_text(
        FAKE.format(
            python=sys.executable,
            log=str(log),
            version=version,
            schema=schema,
            fail_bbox=fail_bbox,
            metadata=metadata,
        )
    )
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    return str(script), log


def assets_tarball() -> bytes:
    buf = io.BytesIO()
    root = f"basemaps-assets-{ASSETS_COMMIT}"
    members = {
        f"{root}/fonts/Noto Sans Regular/0-255.pbf": b"glyphs",
        f"{root}/fonts/Noto Sans Bold/0-255.pbf": b"unused stack",
        f"{root}/sprites/v4/light.json": b"{}",
        f"{root}/sprites/v4/light.png": b"png",
        f"{root}/sprites/v4/dark.png": b"unused flavour",
        f"{root}/README.md": b"readme",
    }
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name, data in members.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


BUILDS = [
    {"key": "20260922.pmtiles", "version": "4.15.2"},
    {"key": "20260923.pmtiles", "version": "4.15.2"},
]


def fake_fetch(
    builds: list[dict[str, str]] = BUILDS,
    *,
    builds_body: bytes | Exception | None = None,
    assets_body: bytes | Exception | None = None,
):
    """A stand-in fetch; a ``*_body`` replaces that URL's answer, raised if an exception."""
    calls: list[str] = []

    def answer(body: bytes | Exception | None, default: bytes) -> bytes:
        if isinstance(body, Exception):
            raise body
        return default if body is None else body

    def fetch(url: str) -> bytes:
        calls.append(url)
        if url == BUILDS_URL:
            return answer(builds_body, json.dumps(builds).encode())
        if url == ASSETS_URL:
            return answer(assets_body, assets_tarball())
        raise AssertionError(f"unexpected request: {url}")

    return fetch, calls


def trace(lat: float, lon: float) -> RunTrace:
    return RunTrace(lat=np.array([lat, lat + 0.01]), lon=np.array([lon, lon + 0.01]), locality="X")


def run(paths, traces, binary, fetch, dry_run=False):
    lines: list[str] = []
    result = run_tiles(
        paths, traces, binary=binary, fetch=fetch, dry_run=dry_run, echo=lines.append
    )
    return result, lines


def test_urllib_fetch_sends_a_user_agent_the_metadata_host_accepts(
    monkeypatch: pytest.MonkeyPatch,
):
    """The Protomaps metadata host answers 403 to Python's default urllib User-Agent."""
    captured: dict[str, object] = {}

    class FakeResponse:
        def __enter__(self) -> FakeResponse:
            return self

        def __exit__(self, *exc_info: object) -> bool:
            return False

        def read(self) -> bytes:
            return b"hello world"

    def fake_urlopen(request: object, timeout: float | None = None) -> FakeResponse:
        captured["request"] = request
        captured["timeout"] = timeout
        return FakeResponse()

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)

    body = urllib_fetch("https://build-metadata.protomaps.dev/builds.json")

    assert body == b"hello world"
    assert captured["timeout"] == 120
    request = captured["request"]
    assert isinstance(request, urllib.request.Request)
    assert request.full_url == "https://build-metadata.protomaps.dev/builds.json"
    user_agent = request.get_header("User-agent")
    assert user_agent is not None
    assert user_agent.startswith("activity-analysis/")


def test_choose_build_takes_the_newest_build_on_the_supported_schema():
    builds = [
        {"key": "20260921.pmtiles", "version": "4.15.1"},
        {"key": "20260923.pmtiles", "version": "5.0.0"},
        {"key": "20260922.pmtiles", "version": "4.15.2"},
    ]
    build = choose_build(builds)
    assert build.key == "20260922.pmtiles"
    assert build.url == "https://build.protomaps.com/20260922.pmtiles"


def test_choose_build_fails_clearly_when_no_build_has_the_schema():
    with pytest.raises(BasemapError, match="schema 4"):
        choose_build([{"key": "20260923.pmtiles", "version": "5.0.0"}])


def test_an_old_or_missing_binary_is_refused(tmp_path: Path):
    old, _ = fake_pmtiles(tmp_path, version="1.20.0")
    with pytest.raises(BasemapError, match="1.31.2"):
        check_pmtiles(old)
    with pytest.raises(BasemapError, match="not found"):
        check_pmtiles(str(tmp_path / "missing"))


def test_a_first_run_fetches_each_area_and_the_assets(tmp_path: Path):
    paths = Paths(root=tmp_path)
    binary, log = fake_pmtiles(tmp_path)
    fetch, calls = fake_fetch()
    result, _ = run(
        paths, {"near": trace(57.73, 14.15), "away": trace(56.88, 14.81)}, binary, fetch
    )

    assert result.errors == []
    manifest = read_manifest(paths)
    assert len(manifest.areas) == 2
    assert manifest.assets_commit == ASSETS_COMMIT
    for area in manifest.areas:
        assert paths.basemap_area_path(area.id).read_bytes().startswith(b"PMTiles")
        assert area.build_key == "20260923.pmtiles"
        assert area.schema_version == "4.15.2"
    extracts = [json.loads(line) for line in log.read_text().splitlines()]
    extracts = [a for a in extracts if a[0] == "extract"]
    assert all("--maxzoom=15" in a for a in extracts)
    assert all(a[1] == "https://build.protomaps.com/20260923.pmtiles" for a in extracts)
    assets = paths.basemap_assets_dir
    assert (assets / "fonts" / "Noto Sans Regular" / "0-255.pbf").read_bytes() == b"glyphs"
    assert (assets / "sprites" / "v4" / "light.png").exists()
    assert not (assets / "fonts" / "Noto Sans Bold").exists()
    assert not (assets / "sprites" / "v4" / "dark.png").exists()
    assert not (assets / "README.md").exists()
    assert calls.count(ASSETS_URL) == 1


def test_a_second_run_with_nothing_new_sends_nothing(tmp_path: Path):
    paths = Paths(root=tmp_path)
    binary, log = fake_pmtiles(tmp_path)
    traces = {"near": trace(57.73, 14.15)}
    run(paths, traces, binary, fake_fetch()[0])
    log.write_text("")
    fetch, calls = fake_fetch()
    result, _ = run(paths, traces, binary, fetch)
    assert result.fetched == []
    assert calls == []
    # Nothing to extract, so the binary is not even asked its version.
    assert log.read_text() == ""


def test_dry_run_prints_the_plan_and_sends_nothing(tmp_path: Path):
    paths = Paths(root=tmp_path)
    binary, log = fake_pmtiles(tmp_path)
    fetch, calls = fake_fetch()
    result, lines = run(paths, {"near": trace(57.73, 14.15)}, binary, fetch, dry_run=True)
    assert calls == []
    assert not paths.basemap_dir.exists()
    assert any("fetch" in line for line in lines)
    assert result.fetched == []


def test_a_grown_area_replaces_the_one_it_absorbs(tmp_path: Path):
    paths = Paths(root=tmp_path)
    binary, _ = fake_pmtiles(tmp_path)
    old_box = Box(13.90, 57.60, 14.40, 57.85)
    old = AreaRecord(area_id(old_box), old_box, "20260920.pmtiles", "u", "4.15.2", 7)
    paths.basemap_areas_dir.mkdir(parents=True)
    paths.basemap_area_path(old.id).write_bytes(b"PMTiles old")
    write_manifest(paths, Manifest(areas=(old,), assets_commit=ASSETS_COMMIT))

    result, _ = run(paths, {"east": trace(57.67, 14.43)}, binary, fake_fetch()[0])

    assert result.removed == [old.id]
    assert not paths.basemap_area_path(old.id).exists()
    (grown,) = read_manifest(paths).areas
    assert grown.box.contains(old_box)


def test_a_failed_extract_keeps_the_others_and_a_valid_manifest(tmp_path: Path):
    paths = Paths(root=tmp_path)
    away = trace(56.88, 14.81)
    away_box = area_box(trace_box(away.lat, away.lon))  # type: ignore[arg-type]
    binary, _ = fake_pmtiles(tmp_path, fail_bbox=away_box.as_bbox_arg())
    result, _ = run(paths, {"near": trace(57.73, 14.15), "away": away}, binary, fake_fetch()[0])

    assert [area for area, _ in result.errors] == [area_id(away_box)]
    manifest = read_manifest(paths)
    assert len(manifest.areas) == 1
    assert paths.basemap_area_path(manifest.areas[0].id).exists()
    assert sorted(p.name for p in paths.basemap_areas_dir.iterdir()) == [
        f"{manifest.areas[0].id}.pmtiles"
    ]


def test_an_extract_on_the_wrong_schema_is_rejected(tmp_path: Path):
    paths = Paths(root=tmp_path)
    binary, _ = fake_pmtiles(tmp_path, schema="5.0.0")
    result, _ = run(paths, {"near": trace(57.73, 14.15)}, binary, fake_fetch()[0])
    assert len(result.errors) == 1
    assert "schema" in result.errors[0][1]
    assert read_manifest(paths).areas == ()


def test_the_run_traces_are_the_outdoor_gps_runs(ingested_store: Paths):
    traces = load_run_traces(ingested_store)
    assert len(traces) == 5
    for t in traces.values():
        assert np.isfinite(t.lat).any() and np.isfinite(t.lon).any()


OLD_BOX = Box(13.90, 57.60, 14.40, 57.85)


def with_existing_area(paths: Paths, box: Box = OLD_BOX) -> AreaRecord:
    """A manifest listing one fetched area, with its file."""
    old = AreaRecord(area_id(box), box, "20260920.pmtiles", "u", "4.15.2", 11)
    paths.basemap_areas_dir.mkdir(parents=True, exist_ok=True)
    paths.basemap_area_path(old.id).write_bytes(b"PMTiles old")
    write_manifest(paths, Manifest(areas=(old,), assets_commit=ASSETS_COMMIT))
    return old


def grown_box(traces: dict[str, RunTrace]) -> Box:
    east = traces["east"]
    box = trace_box(east.lat, east.lon)
    assert box is not None
    return area_box(box).union(OLD_BOX)


def test_the_plan_counts_every_run_a_fetched_area_holds(tmp_path: Path):
    # "inside" lies in the existing area and "east" grows it: the grown area
    # holds both, although only "east" caused the growth.
    paths = Paths(root=tmp_path)
    with_existing_area(paths)
    binary, _ = fake_pmtiles(tmp_path)
    traces = {
        "inside": RunTrace(np.array([57.73, 57.74]), np.array([14.15, 14.16]), "Jönköping"),
        "east": RunTrace(np.array([57.67, 57.68]), np.array([14.43, 14.44]), "Huskvarna"),
    }
    _, lines = run(paths, traces, binary, fake_fetch()[0], dry_run=True)
    (fetch_line,) = [line for line in lines if line.startswith("fetch ")]
    assert fetch_line.endswith(": 2 run(s), Huskvarna, Jönköping")


def test_the_plan_names_each_kept_area_and_its_box(tmp_path: Path):
    paths = Paths(root=tmp_path)
    old = with_existing_area(paths)
    binary, _ = fake_pmtiles(tmp_path)
    _, lines = run(paths, {"near": trace(57.73, 14.15)}, binary, fake_fetch()[0], dry_run=True)
    assert f"keep {old.id} 13.90,57.60,14.40,57.85: 1 run(s), X" in lines


def test_dry_run_needs_no_pmtiles_binary(tmp_path: Path):
    paths = Paths(root=tmp_path)
    fetch, calls = fake_fetch()
    missing = str(tmp_path / "missing")
    _, lines = run(paths, {"near": trace(57.73, 14.15)}, missing, fetch, dry_run=True)
    assert any(line.startswith("fetch ") for line in lines)
    assert calls == []


def test_a_real_fetch_refuses_a_missing_binary_before_any_request(tmp_path: Path):
    paths = Paths(root=tmp_path)
    fetch, calls = fake_fetch()
    with pytest.raises(BasemapError, match="not found"):
        run(paths, {"near": trace(57.73, 14.15)}, str(tmp_path / "missing"), fetch)
    assert calls == []
    assert not paths.basemap_dir.exists()


def test_a_failed_grown_extract_restores_the_area_it_would_have_absorbed(tmp_path: Path):
    paths = Paths(root=tmp_path)
    old = with_existing_area(paths)
    traces = {"east": trace(57.67, 14.43)}
    binary, _ = fake_pmtiles(tmp_path, fail_bbox=grown_box(traces).as_bbox_arg())

    result, _ = run(paths, traces, binary, fake_fetch()[0])

    assert [area for area, _ in result.errors] == [area_id(grown_box(traces))]
    assert result.removed == []
    assert result.kept == [old.id]
    assert [a.id for a in read_manifest(paths).areas] == [old.id]
    assert paths.basemap_area_path(old.id).read_bytes() == b"PMTiles old"


def test_an_interrupted_run_leaves_the_previous_manifest_naming_existing_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    # Killed after the grown area's file is written, before the manifest is.
    paths = Paths(root=tmp_path)
    old = with_existing_area(paths)
    binary, _ = fake_pmtiles(tmp_path)

    def interrupted(*_: object) -> None:
        raise KeyboardInterrupt

    monkeypatch.setattr(fetch_module, "write_manifest", interrupted)
    traces = {"east": trace(57.67, 14.43)}
    with pytest.raises(KeyboardInterrupt):
        run(paths, traces, binary, fake_fetch()[0])

    assert paths.basemap_area_path(area_id(grown_box(traces))).exists()
    manifest = read_manifest(paths)
    assert [a.id for a in manifest.areas] == [old.id]
    assert all(paths.basemap_area_path(a.id).is_file() for a in manifest.areas)


def test_a_listed_area_whose_file_is_missing_is_fetched_again(tmp_path: Path):
    paths = Paths(root=tmp_path)
    near = trace(57.73, 14.15)
    box = area_box(trace_box(near.lat, near.lon))  # type: ignore[arg-type]
    old = with_existing_area(paths, box)
    paths.basemap_area_path(old.id).unlink()
    binary, _ = fake_pmtiles(tmp_path)

    result, _ = run(paths, {"near": near}, binary, fake_fetch()[0])

    assert result.fetched == [old.id]
    (area,) = read_manifest(paths).areas
    assert area.build_key == "20260923.pmtiles"
    assert paths.basemap_area_path(old.id).read_bytes().startswith(b"PMTiles--bbox=")


@pytest.mark.parametrize(
    "body", ["not json{{{", '{"areas": [{"id": 1}]}'], ids=["corrupt-json", "bad-entry"]
)
def test_an_unreadable_manifest_is_refused_and_rebuilt_once_deleted(tmp_path: Path, body: str):
    paths = Paths(root=tmp_path)
    paths.basemap_dir.mkdir(parents=True)
    paths.basemap_manifest.write_text(body)
    binary, log = fake_pmtiles(tmp_path)
    traces = {"near": trace(57.73, 14.15)}
    fetch, calls = fake_fetch()

    with pytest.raises(BasemapError, match="delete it and rerun") as refused:
        run(paths, traces, binary, fetch)
    assert str(paths.basemap_manifest) in str(refused.value)
    assert calls == []
    assert not log.exists()
    assert paths.basemap_manifest.read_text() == body

    paths.basemap_manifest.unlink()
    result, _ = run(paths, traces, binary, fetch)

    assert result.errors == []
    assert [a.id for a in read_manifest(paths).areas] == result.fetched
    assert read_manifest(paths).assets_commit == ASSETS_COMMIT


def test_assets_whose_directory_is_gone_are_fetched_again(tmp_path: Path):
    paths = Paths(root=tmp_path)
    binary, log = fake_pmtiles(tmp_path)
    traces = {"near": trace(57.73, 14.15)}
    run(paths, traces, binary, fake_fetch()[0])
    shutil.rmtree(paths.basemap_assets_dir)
    log.write_text("")
    fetch, calls = fake_fetch()

    result, lines = run(paths, traces, binary, fetch)

    assert result.fetched == []
    assert calls == [ASSETS_URL]
    assert log.read_text() == ""
    assert any(line.startswith("missing assets") for line in lines)
    assert (paths.basemap_assets_dir / "sprites" / "v4" / "light.png").exists()
    assert read_manifest(paths).assets_commit == ASSETS_COMMIT


def test_choose_build_skips_a_key_that_is_not_a_dated_archive():
    builds = [
        {"key": "20260922.pmtiles", "version": "4.15.2"},
        {"key": "../../etc/passwd", "version": "4.15.2"},
        {"key": "20260999.pmtiles?x=1", "version": "4.15.2"},
        {"key": "99999999", "version": "4.15.2"},
    ]
    assert choose_build(builds).key == "20260922.pmtiles"
    with pytest.raises(BasemapError, match="schema 4"):
        choose_build([{"key": "latest.pmtiles", "version": "4.15.2"}])


def test_a_failed_extract_reports_what_pmtiles_said(tmp_path: Path):
    paths = Paths(root=tmp_path)
    near = trace(57.73, 14.15)
    box = area_box(trace_box(near.lat, near.lon))  # type: ignore[arg-type]
    binary, _ = fake_pmtiles(tmp_path, fail_bbox=box.as_bbox_arg())
    result, _ = run(paths, {"near": near}, binary, fake_fetch()[0])
    ((_, message),) = result.errors
    assert "exited 3" in message
    assert "403 Forbidden from the build host" in message


def test_unreadable_extract_metadata_is_a_basemap_error(tmp_path: Path):
    paths = Paths(root=tmp_path)
    binary, _ = fake_pmtiles(tmp_path, metadata="not json")
    result, _ = run(paths, {"near": trace(57.73, 14.15)}, binary, fake_fetch()[0])
    ((_, message),) = result.errors
    assert "metadata" in message
    assert read_manifest(paths).areas == ()


@pytest.mark.parametrize(
    ("failure", "url", "expected"),
    [
        ({"builds_body": URLError("Name or service not known")}, BUILDS_URL, "service not known"),
        ({"builds_body": b"<html>not json</html>"}, BUILDS_URL, "not JSON"),
        ({"builds_body": b'{"builds": []}'}, BUILDS_URL, "not a list"),
        (
            {"assets_body": HTTPError(ASSETS_URL, 404, "Not Found", Message(), None)},
            ASSETS_URL,
            "404",
        ),
        ({"assets_body": IncompleteRead(b"partial", 100)}, ASSETS_URL, "IncompleteRead"),
        ({"assets_body": b"not a tarball"}, ASSETS_URL, "tarball"),
    ],
)
def test_a_failed_listing_or_assets_download_is_a_basemap_error(
    tmp_path: Path, failure: dict[str, bytes | Exception], url: str, expected: str
):
    paths = Paths(root=tmp_path)
    binary, _ = fake_pmtiles(tmp_path)
    fetch, _ = fake_fetch(**failure)  # type: ignore[arg-type]
    with pytest.raises(BasemapError) as caught:
        run(paths, {"near": trace(57.73, 14.15)}, binary, fetch)
    assert url in str(caught.value)
    assert expected in str(caught.value)
    assert not paths.basemap_manifest.exists()
