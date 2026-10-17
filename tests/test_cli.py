import json
import shutil
import zipfile
from pathlib import Path

import duckdb
import pandas as pd
import pyarrow.parquet as pq
import pytest
from typer.testing import CliRunner

from activity_analysis.analysis.places import place_count
from activity_analysis.cli import LOCAL_START_SQL, app
from activity_analysis.config import Paths
from activity_analysis.store.writer import read_activities, upsert_activities

runner = CliRunner()


def test_info_reports_zero_before_ingestion(tmp_path: Path):
    result = runner.invoke(app, ["info", "--root", str(tmp_path)])
    assert result.exit_code == 0
    assert "activities: 0" in result.stdout


def test_info_reports_the_bundled_place_table_apart_from_the_store(tmp_path: Path):
    """The one input that is not ingested, shown where "what do I have" is asked.

    An empty store must still report the full bundled table, and the line
    must say it is reference data rather than read as a tenth store table.
    """
    result = runner.invoke(app, ["info", "--root", str(tmp_path)])
    assert result.exit_code == 0
    lines = result.stdout.splitlines()
    assert f"  places: {place_count()}" in lines
    # Under the reference heading, not among the store rows: `test_api_health`
    # compares the store section against `/api/health` table for table, and a
    # bundled figure counted there would read as a store table that endpoint
    # had forgotten.
    assert lines.index("bundled reference data:") > lines.index("store rows:")
    assert f"  places: {place_count()}" not in lines[: lines.index("bundled reference data:")]
    assert place_count() > 150_000


def test_ingest_then_list(tmp_path: Path, reference_fit: Path):
    dump = tmp_path / "dump"
    dump.mkdir()
    shutil.copy(reference_fit, dump / reference_fit.name)
    store = tmp_path / "store"

    ingested = runner.invoke(
        app, ["ingest", str(dump), "--archive-kind", "strava", "--root", str(store)]
    )
    assert ingested.exit_code == 0
    assert "ingested 1" in ingested.stdout

    listed = runner.invoke(app, ["activities", "--root", str(store)])
    assert listed.exit_code == 0
    assert "2026-08-28" in listed.stdout
    assert "7456" in listed.stdout


def test_ingest_reports_a_missing_directory(tmp_path: Path):
    result = runner.invoke(
        app, ["ingest", str(tmp_path / "nope"), "--archive-kind", "strava", "--root", str(tmp_path)]
    )
    assert result.exit_code == 1
    assert "does not exist" in result.stdout


def test_ingest_names_files_it_cannot_read(tmp_path: Path, reference_fit: Path):
    dump = tmp_path / "dump"
    dump.mkdir()
    shutil.copy(reference_fit, dump / reference_fit.name)
    (dump / "old.tcx.gz").write_bytes(b"x")
    result = runner.invoke(
        app, ["ingest", str(dump), "--archive-kind", "strava", "--root", str(tmp_path / "store")]
    )
    assert result.exit_code == 0
    assert "unsupported" in result.stdout


def test_recompute_reports_what_it_built(tmp_path: Path, all_fit_fixtures: list[Path]):
    source = tmp_path / "fixtures"
    source.mkdir()
    for fixture in all_fit_fixtures:
        shutil.copy(fixture, source / fixture.name)

    runner.invoke(app, ["ingest", str(source), "--archive-kind", "strava", "--root", str(tmp_path)])
    result = runner.invoke(app, ["recompute", "--root", str(tmp_path)])

    assert result.exit_code == 0
    assert "5 activities" in result.stdout
    assert "0 run(s) counted as walks" in result.stdout


def test_info_reports_the_derived_tables(tmp_path: Path):
    result = runner.invoke(app, ["info", "--root", str(tmp_path)])
    assert result.exit_code == 0
    assert "activity_metrics" in result.stdout
    assert "sport_reclassifications: 0" in result.stdout


def test_recompute_exits_non_zero_when_an_activity_fails(
    tmp_path: Path, all_fit_fixtures: list[Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    """A partial rebuild has to be loud.

    Otherwise a scripted `recompute && <next step>` proceeds against a derived
    layer that is missing activities.
    """
    source = tmp_path / "fixtures"
    source.mkdir()
    for fixture in all_fit_fixtures:
        shutil.copy(fixture, source / fixture.name)
    runner.invoke(app, ["ingest", str(source), "--archive-kind", "strava", "--root", str(tmp_path)])

    from activity_analysis.analysis.metrics import activity_metrics

    doomed: list[str] = []

    def explode(grid: pd.DataFrame, activity: pd.Series) -> dict[str, object]:
        if not doomed:
            doomed.append(str(activity["activity_id"]))
        if str(activity["activity_id"]) == doomed[0]:
            raise TypeError("hr_zone_boundaries was not iterable")
        return activity_metrics(grid, activity)

    monkeypatch.setattr("activity_analysis.analysis.pipeline.activity_metrics", explode)
    result = runner.invoke(app, ["recompute", "--root", str(tmp_path)])

    assert result.exit_code == 1
    assert "error:" in result.stdout
    assert "hr_zone_boundaries was not iterable" in result.stdout
    # The rebuild still finished the other four and still reported them.
    assert "4 activities" in result.stdout


def test_ingest_exits_non_zero_when_a_file_fails(tmp_path: Path, reference_fit: Path) -> None:
    dump = tmp_path / "dump"
    dump.mkdir()
    shutil.copy(reference_fit, dump / reference_fit.name)
    (dump / "broken.fit").write_bytes(b"not a fit file at all")

    result = runner.invoke(
        app, ["ingest", str(dump), "--archive-kind", "strava", "--root", str(tmp_path / "store")]
    )

    assert result.exit_code == 1
    assert "error:" in result.stdout
    # The good file still landed; the exit code is additional, not a rollback.
    assert "ingested 1" in result.stdout


def test_listing_renders_the_offset_the_run_was_recorded_under(tmp_path: Path, reference_fit: Path):
    """A run's time of day belongs to where it was run, not to where it is read.

    The reference activity started at 18:19 UTC. Rewriting its stored offset
    to UTC-8 stands in for the 15 runs the athlete recorded outside his usual
    band of offsets, and is chosen because it cannot coincide with the
    timezone the test machine happens to be in: only code that reads
    ``utc_offset_s`` can produce 10:19.
    """
    dump = tmp_path / "dump"
    dump.mkdir()
    shutil.copy(reference_fit, dump / reference_fit.name)
    store = tmp_path / "store"
    runner.invoke(app, ["ingest", str(dump), "--archive-kind", "strava", "--root", str(store)])

    paths = Paths(root=store)
    stored = read_activities(paths)
    stored["utc_offset_s"] = -8 * 3600
    upsert_activities(paths, stored)

    listed = runner.invoke(app, ["activities", "--root", str(store)])
    assert listed.exit_code == 0
    assert "2026-08-28 10:19" in listed.stdout


def test_listing_marks_a_gpx_activity_as_utc(tmp_path: Path, reference_gpx: Path):
    """GPX records no offset, so the instant is all there is to show.

    Rendering it at the reader's own timezone would be a guess presented as a
    fact, so the listing shows the UTC instant and says that is what it is.
    """
    dump = tmp_path / "dump"
    dump.mkdir()
    shutil.copy(reference_gpx, dump / reference_gpx.name)
    store = tmp_path / "store"
    runner.invoke(app, ["ingest", str(dump), "--archive-kind", "strava", "--root", str(store)])

    listed = runner.invoke(app, ["activities", "--root", str(store)])
    assert listed.exit_code == 0
    assert "2026-08-28 18:19 UTC" in listed.stdout


def test_info_still_reports_a_store_whose_stream_files_are_stale(
    tmp_path: Path, reference_fit: Path
):
    """Diagnosing a stale store is exactly when 'info' has to work.

    A canonical stream file written before a column was added makes that column
    unreadable across the glob, but the row counts 'info' reports do not name
    it. Failing when the connection opens would take the diagnostic tool down
    along with the thing being diagnosed.
    """
    dump = tmp_path / "dump"
    dump.mkdir()
    shutil.copy(reference_fit, dump / reference_fit.name)
    store = tmp_path / "store"
    runner.invoke(app, ["ingest", str(dump), "--archive-kind", "strava", "--root", str(store)])

    paths = Paths(root=store)
    current = next(iter(paths.streams_dir.glob("*.parquet")))
    stale = pq.read_table(current).drop_columns(["hr_bpm"])
    pq.write_table(stale, paths.streams_dir / "0000_stale.parquet")

    result = runner.invoke(app, ["info", "--root", str(store)])
    assert result.exit_code == 0
    assert "activities: 1" in result.stdout
    assert f"streams: {2 * stale.num_rows}" in result.stdout


def test_the_start_renders_the_same_wall_clock_in_any_session_timezone():
    """The rendered hour must belong to the run, not to whoever is reading.

    DuckDB renders a TIMESTAMPTZ in the session timezone, so the listing's
    ``AT TIME ZONE 'UTC'`` is what makes the stored offset the only thing that
    moves the clock. Every CLI test in this file runs against one process-wide
    timezone and so cannot see that: drop the guard and they stay green on a
    UTC machine. Evaluating the expression under several sessions can.

    The reference activity's 18:19:14 UTC start, recorded at UTC-8, is 10:19
    local. Without the guard a UTC session still renders 10:19 - which is why
    CI would never notice - while Pacific/Kiritimati gives 00:19 the next day
    and Europe/Stockholm 12:19.
    """
    rendered = {}
    for zone in ("UTC", "Pacific/Kiritimati", "Europe/Stockholm"):
        with duckdb.connect() as con:
            con.execute(f"SET TimeZone='{zone}'")
            con.execute(
                """
                CREATE TABLE activities (start_time_utc TIMESTAMPTZ, utc_offset_s INTEGER)
                """
            )
            con.execute(
                "INSERT INTO activities VALUES (TIMESTAMPTZ '2026-08-28 18:19:14+00', -28800)"
            )
            row = con.execute(f"SELECT {LOCAL_START_SQL} FROM activities").fetchone()
            assert row is not None
            rendered[zone] = row[0]

    assert set(rendered.values()) == {"2026-08-28 10:19"}, rendered


def test_serve_is_offered_and_discoverable():
    """A test that bound a port would be testing uvicorn."""
    result = runner.invoke(app, ["serve", "--help"])
    assert result.exit_code == 0
    assert "Serve the store over HTTP" in result.stdout


def _serve_without_binding(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, host: str) -> str:
    """Run ``serve`` far enough to echo, with nothing listening afterwards."""
    import uvicorn

    monkeypatch.setattr(uvicorn, "run", lambda app, **kwargs: None)
    result = runner.invoke(app, ["serve", "--host", host, "--root", str(tmp_path)])
    assert result.exit_code == 0, result.stdout
    return result.stdout


def test_serving_beyond_loopback_says_what_is_being_exposed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The API has no authentication, and the store is real GPS traces.

    Binding anything but loopback makes the API reference's premise false, so the one
    typed argument that does it has to say so rather than start quietly.
    """
    output = _serve_without_binding(monkeypatch, tmp_path, "0.0.0.0")
    assert "WARNING" in output
    assert "no authentication" in output
    assert "GPS traces" in output


@pytest.mark.parametrize("host", ["127.0.0.1", "127.0.0.2", "::1", "localhost"])
def test_serving_on_any_loopback_address_is_quiet(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, host: str
):
    """Loopback is the documented normal case, so it must not cry wolf.

    Parameterised over the forms a loopback bind actually takes, because a
    string comparison against ``127.0.0.1`` would warn on three of these four.
    """
    assert "WARNING" not in _serve_without_binding(monkeypatch, tmp_path, host)


def test_serve_says_the_store_is_read_once_at_startup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The mitigation for the connection-at-startup model, so it has to be said.

    The store is read when the server comes up, so a recompute while it runs
    is not picked up. The symptom is a number that does not move, which reads
    exactly like a bug in the metric that was just changed - which is why the
    API reference and the README both state it rather than treating the
    restart as folklore.
    """
    output = _serve_without_binding(monkeypatch, tmp_path, "127.0.0.1")
    assert "read once, at startup" in output
    assert "restart after an ingest or a recompute" in output


def _serve_capturing_app(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, build: Path | None
) -> tuple[str, object]:
    import uvicorn

    from activity_analysis.api import frontend

    served: list[object] = []
    monkeypatch.setattr(uvicorn, "run", lambda app, **kwargs: served.append(app))
    monkeypatch.setattr(frontend, "find_build", lambda: build)
    result = runner.invoke(app, ["serve", "--root", str(tmp_path / "store")])
    assert result.exit_code == 0, result.stdout
    return result.stdout, served[0]


def test_serve_serves_the_built_frontend_when_there_is_one(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    from fastapi.testclient import TestClient

    build = tmp_path / "dist"
    build.mkdir()
    (build / "index.html").write_text("<!doctype html>")
    output, served = _serve_capturing_app(monkeypatch, tmp_path, build)
    assert f"frontend: {build}" in output
    with TestClient(served) as client:  # type: ignore[arg-type]
        assert client.get("/trends").text == "<!doctype html>"


def test_open_waits_for_the_server_then_opens_the_app(monkeypatch: pytest.MonkeyPatch):
    import socket
    import webbrowser

    from activity_analysis import cli

    opened: list[str] = []
    monkeypatch.setattr(webbrowser, "open", opened.append)
    with socket.create_server(("127.0.0.1", 0)) as listening:
        port = listening.getsockname()[1]
        cli._open_once_listening("127.0.0.1", port).join(timeout=10)
    assert opened == [f"http://127.0.0.1:{port}"]


def test_open_reaches_a_wildcard_bind_through_loopback(monkeypatch: pytest.MonkeyPatch):
    import socket
    import webbrowser

    from activity_analysis import cli

    opened: list[str] = []
    monkeypatch.setattr(webbrowser, "open", opened.append)
    with socket.create_server(("127.0.0.1", 0)) as listening:
        port = listening.getsockname()[1]
        cli._open_once_listening("0.0.0.0", port).join(timeout=10)
    assert opened == [f"http://127.0.0.1:{port}"]


def test_open_gives_up_quietly_when_nothing_listens(monkeypatch: pytest.MonkeyPatch):
    """A browser opened on a port nobody serves shows only a connection error."""
    import socket
    import webbrowser

    from activity_analysis import cli

    opened: list[str] = []
    monkeypatch.setattr(webbrowser, "open", opened.append)
    with socket.create_server(("127.0.0.1", 0)) as reserved:
        port = reserved.getsockname()[1]
    cli._open_once_listening("127.0.0.1", port, timeout_s=0.5).join(timeout=10)
    assert opened == []


def test_serve_opens_the_browser_only_when_asked(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    import uvicorn

    from activity_analysis import cli

    asked: list[tuple[str, int]] = []
    monkeypatch.setattr(uvicorn, "run", lambda app, **kwargs: None)
    monkeypatch.setattr(cli, "_open_once_listening", lambda host, port: asked.append((host, port)))
    runner.invoke(app, ["serve", "--root", str(tmp_path)])
    assert asked == []
    result = runner.invoke(app, ["serve", "--open", "--port", "8123", "--root", str(tmp_path)])
    assert result.exit_code == 0, result.stdout
    assert asked == [("127.0.0.1", 8123)]


def test_serve_without_a_build_says_how_to_get_one(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """A checkout has no build until one is made, and a blank 404 at / says nothing."""
    output, _ = _serve_capturing_app(monkeypatch, tmp_path, None)
    assert "no built frontend" in output
    assert "npm run build" in output


def test_tiles_refuses_without_a_pmtiles_binary(ingested_store: Paths, tmp_path: Path):
    root = str(ingested_store.root)
    result = runner.invoke(app, ["tiles", "--root", root, "--pmtiles", str(tmp_path / "missing")])
    assert result.exit_code == 1
    assert "pmtiles not found" in result.stdout
    assert not ingested_store.basemap_dir.exists()


def test_tiles_dry_run_previews_the_plan_without_a_pmtiles_binary(
    ingested_store: Paths, tmp_path: Path
):
    root = str(ingested_store.root)
    result = runner.invoke(
        app, ["tiles", "--root", root, "--pmtiles", str(tmp_path / "missing"), "--dry-run"]
    )
    assert result.exit_code == 0
    assert "fetch " in result.stdout
    assert not ingested_store.basemap_dir.exists()


def test_tiles_dry_run_on_an_empty_store_plans_nothing(tmp_path: Path):
    from tests.test_basemap_fetch import fake_pmtiles

    binary, _ = fake_pmtiles(tmp_path)
    result = runner.invoke(
        app, ["tiles", "--root", str(tmp_path), "--pmtiles", binary, "--dry-run"]
    )
    assert result.exit_code == 0
    assert "keep 0 area(s)" in result.stdout
    assert not (tmp_path / "data" / "basemap").exists()


def test_tiles_reports_an_unreadable_manifest_without_a_traceback(tmp_path: Path):
    from tests.test_basemap_fetch import fake_pmtiles

    paths = Paths(root=tmp_path)
    paths.basemap_dir.mkdir(parents=True)
    paths.basemap_manifest.write_text("not json{{{")
    binary, _ = fake_pmtiles(tmp_path)
    result = runner.invoke(app, ["tiles", "--root", str(tmp_path), "--pmtiles", binary])
    assert result.exit_code == 1
    assert result.exception is None or isinstance(result.exception, SystemExit)
    assert f"error: {paths.basemap_manifest} is unreadable" in result.stdout
    assert "delete it and rerun `activity-analysis tiles`" in result.stdout


def test_ingest_recognises_a_garmin_export_without_being_told(
    tmp_path: Path, garmin_breathing_fit: Path
):
    export = tmp_path / "export"
    unpacked = export / "DI_CONNECT" / "DI-Connect-Uploaded-Files" / "UploadedFiles_0-_Part1"
    unpacked.mkdir(parents=True)
    shutil.copy(garmin_breathing_fit, unpacked / garmin_breathing_fit.name)
    store = tmp_path / "store"

    result = runner.invoke(app, ["ingest", str(export), "--root", str(store)])

    assert result.exit_code == 0, result.stdout
    assert "garmin" in result.stdout
    assert read_activities(Paths(root=store)).iloc[0]["source"] == "garmin_fit"


def test_ingest_will_not_guess_what_kind_of_export_it_was_given(
    tmp_path: Path, reference_fit: Path
):
    # Guessing Strava for a Garmin export labels every file strava_fit, and at
    # equal priority not one of them displaces the Strava copy already stored.
    dump = tmp_path / "dump"
    dump.mkdir()
    shutil.copy(reference_fit, dump / reference_fit.name)

    result = runner.invoke(app, ["ingest", str(dump), "--root", str(tmp_path / "store")])

    assert result.exit_code == 1
    assert "--archive-kind" in result.stdout
    assert read_activities(Paths(root=tmp_path / "store")).empty


def test_ingest_unpacks_a_garmin_exports_zipped_activities(
    tmp_path: Path, garmin_breathing_fit: Path
):
    """Garmin's export leaves its activities in zips inside the zip; unpacking them is ours."""
    uploads = tmp_path / "export" / "DI_CONNECT" / "DI-Connect-Uploaded-Files"
    uploads.mkdir(parents=True)
    with zipfile.ZipFile(uploads / "UploadedFiles_0-_Part1.zip", "w") as archive:
        archive.write(garmin_breathing_fit, garmin_breathing_fit.name)
    store = tmp_path / "store"

    result = runner.invoke(
        app, ["ingest", str(tmp_path / "export"), "--root", str(store), "--no-recompute"]
    )

    assert result.exit_code == 0, result.stdout
    assert "unpacked 1 Garmin upload zip(s)" in result.stdout
    assert "ingested 1" in result.stdout
    assert read_activities(Paths(root=store)).iloc[0]["source"] == "garmin_fit"


def test_ingest_names_a_garmin_upload_zip_it_cannot_read_and_ingests_the_rest(
    tmp_path: Path, garmin_breathing_fit: Path
):
    uploads = tmp_path / "export" / "DI_CONNECT" / "DI-Connect-Uploaded-Files"
    uploads.mkdir(parents=True)
    (uploads / "UploadedFiles_0-_Part1.zip").write_bytes(b"not a zip")
    with zipfile.ZipFile(uploads / "UploadedFiles_0-_Part2.zip", "w") as archive:
        archive.write(garmin_breathing_fit, garmin_breathing_fit.name)

    result = runner.invoke(
        app,
        ["ingest", str(tmp_path / "export"), "--root", str(tmp_path / "store"), "--no-recompute"],
    )

    assert result.exit_code == 1
    assert "UploadedFiles_0-_Part1.zip" in result.stdout
    assert "ingested 1" in result.stdout


def _strava_export_zip(path: Path, fit: Path) -> Path:
    """The layout Strava's bulk export zip has at its top."""
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("activities.csv", "Activity ID\n")
        archive.write(fit, f"activities/{fit.name}")
    return path


def test_ingest_takes_the_export_zip_and_recomputes(tmp_path: Path, reference_fit: Path):
    """The new-user path: the zip the provider emailed, then serve, nothing between."""
    zipped = _strava_export_zip(tmp_path / "export_123.zip", reference_fit)
    store = Paths(root=tmp_path / "store")

    result = runner.invoke(app, ["ingest", str(zipped), "--root", str(store.root)])

    assert result.exit_code == 0, result.stdout
    assert f"unpacking {zipped} into {store.raw / 'export_123'}" in result.stdout
    assert "as a strava export" in result.stdout
    assert "ingested 1" in result.stdout
    assert "1 activities" in result.stdout
    assert (store.raw / "export_123" / "activities" / reference_fit.name).is_file()
    assert store.activity_metrics_parquet.is_file()


def test_ingest_names_each_step_as_it_starts(tmp_path: Path, reference_fit: Path):
    """A full export takes minutes, so every long step says it has begun.

    Off a terminal, as here, each bar prints its label once instead of drawing.
    """
    zipped = _strava_export_zip(tmp_path / "export_123.zip", reference_fit)

    result = runner.invoke(app, ["ingest", str(zipped), "--root", str(tmp_path / "store")])

    assert result.exit_code == 0, result.stdout
    steps = [
        "unpacking the export",
        "reading files",
        "computing each run",
        "comparing runs across the history",
        "finding recurring routes",
        "mapping territory",
    ]
    lines = result.stdout.splitlines()
    assert [line for line in lines if line in steps] == steps


def test_ingesting_the_same_zip_again_does_nothing_and_skips_the_recompute(
    tmp_path: Path, reference_fit: Path
):
    zipped = _strava_export_zip(tmp_path / "export_123.zip", reference_fit)
    root = str(tmp_path / "store")
    runner.invoke(app, ["ingest", str(zipped), "--root", root])

    again = runner.invoke(app, ["ingest", str(zipped), "--root", root])

    assert again.exit_code == 0, again.stdout
    assert "already processed 1" in again.stdout
    assert "recomputing" not in again.stdout


def test_no_recompute_leaves_the_derived_layer_alone(tmp_path: Path, reference_fit: Path):
    zipped = _strava_export_zip(tmp_path / "export.zip", reference_fit)
    store = Paths(root=tmp_path / "store")

    result = runner.invoke(
        app, ["ingest", str(zipped), "--root", str(store.root), "--no-recompute"]
    )

    assert result.exit_code == 0, result.stdout
    assert "recomputing" not in result.stdout
    assert not store.activity_metrics_parquet.exists()


def test_ingest_finishes_a_recompute_an_earlier_run_never_completed(
    tmp_path: Path, reference_fit: Path
):
    """An interrupted recompute must not leave a re-run of the same ingest silent and stale."""
    zipped = _strava_export_zip(tmp_path / "export.zip", reference_fit)
    store = Paths(root=tmp_path / "store")
    runner.invoke(app, ["ingest", str(zipped), "--root", str(store.root), "--no-recompute"])

    again = runner.invoke(app, ["ingest", str(zipped), "--root", str(store.root)])

    assert again.exit_code == 0, again.stdout
    assert "ingested 0" in again.stdout
    assert "recomputing" in again.stdout
    assert store.activity_metrics_parquet.is_file()


def test_ingest_exits_non_zero_when_its_recompute_fails(
    tmp_path: Path, reference_fit: Path, monkeypatch: pytest.MonkeyPatch
):
    from activity_analysis import cli
    from activity_analysis.analysis.pipeline import RecomputeResult

    failed = RecomputeResult()
    failed.errors.append(("abc", "boom"))
    monkeypatch.setattr(cli, "run_recompute", lambda paths, progress: failed)
    zipped = _strava_export_zip(tmp_path / "export.zip", reference_fit)

    result = runner.invoke(app, ["ingest", str(zipped), "--root", str(tmp_path / "store")])

    assert result.exit_code == 1
    assert "ingested 1" in result.stdout
    assert "error: abc: boom" in result.stdout


def test_a_zip_that_fails_to_unpack_is_reported_without_a_traceback(
    tmp_path: Path, reference_fit: Path, monkeypatch: pytest.MonkeyPatch
):
    """A full disk is the ordinary way a 500 MB export fails to unpack."""
    zipped = _strava_export_zip(tmp_path / "export.zip", reference_fit)

    def full_disk(*args: object, **kwargs: object) -> None:
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(zipfile.ZipFile, "extract", full_disk)
    result = runner.invoke(app, ["ingest", str(zipped), "--root", str(tmp_path / "store")])

    assert result.exit_code == 1
    assert result.exception is None or isinstance(result.exception, SystemExit)
    assert "No space left on device" in result.stdout


def test_a_garmin_upload_zip_that_fails_to_unpack_leaves_the_rest_ingested(
    tmp_path: Path, garmin_breathing_fit: Path, monkeypatch: pytest.MonkeyPatch
):
    uploads = tmp_path / "export" / "DI_CONNECT" / "DI-Connect-Uploaded-Files"
    unpacked = uploads / "UploadedFiles_0-_Part1"
    unpacked.mkdir(parents=True)
    shutil.copy(garmin_breathing_fit, unpacked / garmin_breathing_fit.name)
    with zipfile.ZipFile(uploads / "UploadedFiles_0-_Part2.zip", "w") as archive:
        archive.writestr("b_1.fit", b"x")

    def unwritable(*args: object, **kwargs: object) -> None:
        raise PermissionError(13, "Permission denied")

    monkeypatch.setattr(zipfile.ZipFile, "extract", unwritable)
    result = runner.invoke(
        app,
        ["ingest", str(tmp_path / "export"), "--root", str(tmp_path / "store"), "--no-recompute"],
    )

    assert result.exit_code == 1
    assert "UploadedFiles_0-_Part2.zip" in result.stdout
    assert "Permission denied" in result.stdout
    assert "ingested 1" in result.stdout


def test_ingest_refuses_a_zip_that_would_write_outside_the_store(tmp_path: Path):
    zipped = tmp_path / "export.zip"
    with zipfile.ZipFile(zipped, "w") as archive:
        archive.writestr("activities.csv", "Activity ID\n")
        archive.writestr("../../escaped.fit", b"x")

    result = runner.invoke(app, ["ingest", str(zipped), "--root", str(tmp_path / "store")])

    assert result.exit_code == 1
    assert "escaped.fit" in result.stdout
    assert not list(tmp_path.rglob("escaped.fit"))


def test_ingest_says_what_it_takes_when_given_some_other_file(tmp_path: Path):
    other = tmp_path / "export.tar.gz"
    other.write_bytes(b"x")

    result = runner.invoke(app, ["ingest", str(other), "--root", str(tmp_path / "store")])

    assert result.exit_code == 1
    assert "a .zip" in result.stdout


def test_ingest_reports_the_vo2max_files_it_read(tmp_path: Path) -> None:
    export = tmp_path / "export"
    target = export / "DI_CONNECT" / "DI-Connect-Metrics" / "MetricsMaxMetData_a.json"
    target.parent.mkdir(parents=True)
    target.write_text(
        json.dumps(
            [
                {
                    "calendarDate": "2025-01-01",
                    "deviceId": 1,
                    "updateTimestamp": "2025-01-01T10:00:00.0",
                    "sport": "RUNNING",
                    "vo2MaxValue": 49,
                    "maxMet": 14.0,
                }
            ]
        )
    )
    result = runner.invoke(app, ["ingest", str(export), "--root", str(tmp_path / "store")])
    assert result.exit_code == 0, result.output
    assert "1 Garmin VO2max file(s) read" in result.output
