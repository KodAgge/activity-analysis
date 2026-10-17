import json
import shutil
from pathlib import Path

import pandas as pd
import pytest

from activity_analysis.config import Paths
from activity_analysis.ingest.discover import sha256_file
from activity_analysis.ingest.garmin_metrics import METRICS_DIR
from activity_analysis.ingest.ledger import append_ledger, load_ledger
from activity_analysis.ingest.pipeline import ingest
from activity_analysis.models import SOURCE_GARMIN_FIT, SOURCE_GPX, SOURCE_STRAVA_FIT
from activity_analysis.store.writer import (
    read_activities,
    read_device_vo2max,
    read_laps,
    read_profile_observations,
    read_streams,
)


@pytest.fixture
def dump(tmp_path: Path, reference_fit: Path) -> Path:
    root = tmp_path / "dump"
    root.mkdir()
    shutil.copy(reference_fit, root / reference_fit.name)
    return root


def test_ingests_one_activity(tmp_path: Path, dump: Path):
    paths = Paths(root=tmp_path / "store")
    result = ingest(paths, dump)
    assert result.ingested == 1
    stored = read_activities(paths)
    assert len(stored) == 1
    assert stored.iloc[0]["distance_m"] == pytest.approx(7456.06)
    assert stored.iloc[0]["source"] == SOURCE_STRAVA_FIT


def test_laps_and_streams_are_written(tmp_path: Path, dump: Path):
    paths = Paths(root=tmp_path / "store")
    ingest(paths, dump)
    activity_id = read_activities(paths).iloc[0]["activity_id"]
    assert len(read_laps(paths)) == 8
    assert len(read_streams(paths, activity_id)) == 626


def test_reingesting_the_same_dump_is_a_no_op(tmp_path: Path, dump: Path):
    paths = Paths(root=tmp_path / "store")
    ingest(paths, dump)
    second = ingest(paths, dump)
    assert second.ingested == 0
    assert second.skipped_already_processed == 1
    assert len(read_activities(paths)) == 1


def test_all_five_fixtures_ingest_as_distinct_activities(
    tmp_path: Path, all_fit_fixtures: list[Path]
):
    root = tmp_path / "dump"
    root.mkdir()
    for path in all_fit_fixtures:
        shutil.copy(path, root / path.name)
    paths = Paths(root=tmp_path / "store")
    result = ingest(paths, root)
    assert result.ingested == 5
    stored = read_activities(paths)
    # Five distinct runs, despite two exported under the same activity name.
    assert len(stored) == 5
    assert stored["activity_id"].nunique() == 5
    assert sorted(stored["distance_m"].round(1)) == [
        4069.2,
        6369.1,
        7456.1,
        9234.2,
        10432.2,
    ]


def test_gpx_does_not_displace_the_fit_of_the_same_run(
    tmp_path: Path, reference_fit: Path, reference_gpx: Path
):
    root = tmp_path / "dump"
    root.mkdir()
    shutil.copy(reference_fit, root / reference_fit.name)
    shutil.copy(reference_gpx, root / reference_gpx.name)
    paths = Paths(root=tmp_path / "store")
    result = ingest(paths, root)
    stored = read_activities(paths)
    # One run, even though FIT says 7456.06 m and GPX-derived says 7454.85 m.
    assert len(stored) == 1
    assert stored.iloc[0]["source"] == SOURCE_STRAVA_FIT
    assert result.skipped_lower_priority == 1


def test_fit_displaces_a_previously_ingested_gpx(
    tmp_path: Path, reference_fit: Path, reference_gpx: Path
):
    paths = Paths(root=tmp_path / "store")
    gpx_only = tmp_path / "gpx_dump"
    gpx_only.mkdir()
    shutil.copy(reference_gpx, gpx_only / reference_gpx.name)
    ingest(paths, gpx_only)
    assert read_activities(paths).iloc[0]["source"] == SOURCE_GPX

    fit_only = tmp_path / "fit_dump"
    fit_only.mkdir()
    shutil.copy(reference_fit, fit_only / reference_fit.name)
    result = ingest(paths, fit_only)
    stored = read_activities(paths)
    assert len(stored) == 1
    assert stored.iloc[0]["source"] == SOURCE_STRAVA_FIT
    assert stored.iloc[0]["distance_m"] == pytest.approx(7456.06)
    assert result.replaced == 1


def test_replacing_an_activity_rewrites_its_streams(
    tmp_path: Path, reference_fit: Path, reference_gpx: Path
):
    paths = Paths(root=tmp_path / "store")
    for name, source in ((reference_gpx, "gpx"), (reference_fit, "fit")):
        dump_dir = tmp_path / f"dump_{source}"
        dump_dir.mkdir()
        shutil.copy(name, dump_dir / name.name)
        ingest(paths, dump_dir)

    stored = read_activities(paths)
    activity_id = stored.iloc[0]["activity_id"]
    streams = read_streams(paths, activity_id)
    # The FIT copy carries device distance; the GPX copy would not have.
    assert len(streams) == 626
    assert streams["distance_m"].iloc[-1] == pytest.approx(7456.06, abs=1.0)
    assert len(read_laps(paths)) == 8


def test_unreadable_file_is_reported_without_aborting_the_run(tmp_path: Path, reference_fit: Path):
    root = tmp_path / "dump"
    root.mkdir()
    shutil.copy(reference_fit, root / reference_fit.name)
    (root / "corrupt.fit").write_bytes(b"this is not a FIT file")
    paths = Paths(root=tmp_path / "store")
    result = ingest(paths, root)
    assert result.ingested == 1
    assert len(result.errors) == 1
    assert "corrupt.fit" in result.errors[0][0]


def test_unreadable_formats_are_counted_rather_than_ignored(tmp_path: Path, reference_fit: Path):
    # A real Strava export holds a couple of TCX runs. No reader handles them
    # yet, so the run must say so rather than quietly leaving them out.
    root = tmp_path / "dump"
    root.mkdir()
    shutil.copy(reference_fit, root / reference_fit.name)
    (root / "old.tcx.gz").write_bytes(b"x")
    paths = Paths(root=tmp_path / "store")
    result = ingest(paths, root)
    assert result.ingested == 1
    assert result.skipped_unsupported == 1


def test_planned_routes_are_not_reported_as_errors(tmp_path: Path, reference_fit: Path):
    # A Strava export ships saved routes alongside activities. They are
    # track points with no timestamps, so they are not recordings and must
    # not be counted as failures.
    root = tmp_path / "dump"
    root.mkdir()
    shutil.copy(reference_fit, root / reference_fit.name)
    (root / "route.gpx").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">'
        "<trk><name>Planned</name><trkseg>"
        '<trkpt lat="57.4" lon="14.1"><ele>10.0</ele></trkpt>'
        '<trkpt lat="57.5" lon="14.2"><ele>11.0</ele></trkpt>'
        "</trkseg></trk></gpx>",
        encoding="utf-8",
    )
    paths = Paths(root=tmp_path / "store")
    result = ingest(paths, root)
    assert result.ingested == 1
    assert result.errors == []
    assert result.skipped_not_an_activity == 1


def test_ingestion_writes_profile_observations(tmp_path: Path, all_fit_fixtures: list[Path]):
    paths = Paths(root=tmp_path)
    source = tmp_path / "fixtures"
    source.mkdir()
    for fixture in all_fit_fixtures:
        shutil.copy(fixture, source / fixture.name)

    ingest(paths, source, athlete_id="tester")

    observations = read_profile_observations(paths)
    assert len(observations) == 5
    assert observations["max_hr_bpm"].eq(207.0).all()
    assert list(observations["hr_zone_boundaries"].iloc[0]) == [
        104.0,
        124.0,
        145.0,
        166.0,
        186.0,
        207.0,
    ]


def test_reingesting_does_not_duplicate_profile_observations(
    tmp_path: Path, all_fit_fixtures: list[Path]
):
    paths = Paths(root=tmp_path)
    source = tmp_path / "fixtures"
    source.mkdir()
    for fixture in all_fit_fixtures:
        shutil.copy(fixture, source / fixture.name)

    ingest(paths, source, athlete_id="tester")
    ingest(paths, source, athlete_id="tester", force=True)

    assert len(read_profile_observations(paths)) == 5


def test_force_rewrites_rows_from_an_equally_ranked_source(tmp_path: Path, dump: Path):
    """--force must actually redo the work, not reprocess and then discard it.

    Ties normally keep the incumbent so that re-ingesting an equivalent file is
    inert. Under --force the operator has explicitly asked for the work to be
    redone, so a tie has to displace instead, or the flag rewrites nothing.
    """
    paths = Paths(root=tmp_path)
    ingest(paths, dump, athlete_id="tester")

    # Drop a canonical table, as a metric or schema change would.
    paths.profile_observations_parquet.unlink()

    result = ingest(paths, dump, athlete_id="tester", force=True)

    assert result.skipped_lower_priority == 0
    assert result.replaced == 1
    assert len(read_profile_observations(paths)) == 1


def test_force_still_refuses_to_let_gpx_displace_fit(
    tmp_path: Path, reference_fit: Path, reference_gpx: Path
):
    # Source priority is about which copy is richer, and --force does not
    # change which copy is richer.
    paths = Paths(root=tmp_path)
    source = tmp_path / "both"
    source.mkdir()
    shutil.copy(reference_fit, source / reference_fit.name)
    ingest(paths, source, athlete_id="tester")

    shutil.copy(reference_gpx, source / reference_gpx.name)
    ingest(paths, source, athlete_id="tester", force=True)

    activities = read_activities(paths)
    assert len(activities) == 1
    assert activities["source"].iloc[0] == SOURCE_STRAVA_FIT


def test_the_athletes_utc_offset_is_stored(tmp_path: Path, dump: Path):
    """A UTC instant alone cannot say what time of day a run happened.

    The FIT ``activity`` message carries ``local_timestamp`` beside the UTC
    ``timestamp``; their difference is the offset the watch was set to. All
    five fixtures were recorded in Swedish summer time, so +2 hours.
    """
    paths = Paths(root=tmp_path / "store")
    ingest(paths, dump)
    assert read_activities(paths).iloc[0]["utc_offset_s"] == 7200


def test_gpx_has_no_utc_offset_to_report(tmp_path: Path, reference_gpx: Path):
    """GPX timestamps are UTC with no offset anywhere in the format.

    Null is the honest answer. Guessing one from the coordinates would be a
    derived value dressed up as a recorded one.
    """
    paths = Paths(root=tmp_path / "store")
    source = tmp_path / "gpx_only"
    source.mkdir()
    shutil.copy(reference_gpx, source / reference_gpx.name)
    ingest(paths, source)
    stored = read_activities(paths)
    assert stored.iloc[0]["source"] == SOURCE_GPX
    assert pd.isna(stored.iloc[0]["utc_offset_s"])


def test_a_file_that_failed_is_retried_on_the_next_run(tmp_path: Path, dump: Path):
    paths = Paths(root=tmp_path / "store")
    source_file = next(dump.iterdir())
    append_ledger(
        paths,
        [
            {
                "source_file_sha256": sha256_file(source_file),
                "source_file": source_file.name,
                "activity_id": None,
                "source": SOURCE_STRAVA_FIT,
                "status": "error",
                "ingested_at": pd.Timestamp("2026-10-01", tz="UTC"),
            }
        ],
    )
    result = ingest(paths, dump)
    assert result.ingested == 1
    assert result.skipped_already_processed == 0


def test_a_garmin_export_ingests_its_activities_and_passes_over_wellness_files(
    tmp_path: Path, garmin_breathing_fit: Path, garmin_monitoring_fit: Path
):
    root = tmp_path / "dump"
    root.mkdir()
    shutil.copy(garmin_breathing_fit, root / garmin_breathing_fit.name)
    shutil.copy(garmin_monitoring_fit, root / garmin_monitoring_fit.name)
    paths = Paths(root=tmp_path / "store")
    result = ingest(paths, root, archive_kind="garmin")
    assert result.errors == []
    assert result.ingested == 1
    assert result.skipped_not_an_activity == 1
    stored = read_activities(paths)
    assert stored.iloc[0]["source"] == SOURCE_GARMIN_FIT
    assert stored.iloc[0]["sub_sport"] == "breathing"


def _garmin_export(root: Path, files: dict[str, object]) -> Path:
    for name, rows in files.items():
        target = root / METRICS_DIR / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(rows) if not isinstance(rows, str) else rows)
    return root


def _max_met(day: str, max_met: float, updated: str = "2025-01-01T10:00:00.0") -> dict[str, object]:
    return {
        "calendarDate": day,
        "deviceId": 1,
        "updateTimestamp": updated,
        "sport": "RUNNING",
        "vo2MaxValue": round(max_met * 3.5),
        "maxMet": max_met,
    }


def test_a_garmin_export_writes_its_vo2max_history(tmp_path: Path) -> None:
    export = _garmin_export(
        tmp_path / "export",
        {
            "MetricsMaxMetData_a.json": [
                _max_met("2025-01-01", 14.0),
                _max_met("2025-01-02", 14.1),
            ],
        },
    )
    paths = Paths(root=tmp_path / "store")
    result = ingest(paths, export, archive_kind="garmin")
    assert result.vo2max_files == 1
    assert len(read_device_vo2max(paths)) == 2
    ledger = load_ledger(paths)
    assert ledger.loc[ledger["status"] == "vo2max", "source"].tolist() == ["garmin_export"]


def test_reingesting_a_garmin_export_reads_no_vo2max_file_twice(tmp_path: Path) -> None:
    export = _garmin_export(
        tmp_path / "export", {"MetricsMaxMetData_a.json": [_max_met("2025-01-01", 14.0)]}
    )
    paths = Paths(root=tmp_path / "store")
    ingest(paths, export, archive_kind="garmin")
    again = ingest(paths, export, archive_kind="garmin")
    assert again.vo2max_files == 0
    assert again.skipped_already_processed == 1
    assert len(read_device_vo2max(paths)) == 1


def test_force_rereads_vo2max_without_duplicating_a_day(tmp_path: Path) -> None:
    export = _garmin_export(
        tmp_path / "export", {"MetricsMaxMetData_a.json": [_max_met("2025-01-01", 14.0)]}
    )
    paths = Paths(root=tmp_path / "store")
    ingest(paths, export, archive_kind="garmin")
    forced = ingest(paths, export, archive_kind="garmin", force=True)
    assert forced.vo2max_files == 1
    assert len(read_device_vo2max(paths)) == 1


def test_a_strava_export_writes_no_vo2max(tmp_path: Path) -> None:
    export = _garmin_export(
        tmp_path / "export", {"MetricsMaxMetData_a.json": [_max_met("2025-01-01", 14.0)]}
    )
    paths = Paths(root=tmp_path / "store")
    result = ingest(paths, export, archive_kind="strava")
    assert result.vo2max_files == 0
    assert not paths.device_vo2max_parquet.exists()
    assert "vo2max" not in set(load_ledger(paths)["status"])


def test_a_broken_vo2max_file_is_reported_and_retried(tmp_path: Path) -> None:
    export = _garmin_export(
        tmp_path / "export",
        {
            "MetricsMaxMetData_a.json": [_max_met("2025-01-01", 14.0)],
            "MetricsMaxMetData_b.json": '[{"calendarDate": ',
        },
    )
    paths = Paths(root=tmp_path / "store")
    first = ingest(paths, export, archive_kind="garmin")
    assert [Path(path).name for path, _ in first.errors] == ["MetricsMaxMetData_b.json"]
    assert len(read_device_vo2max(paths)) == 1
    second = ingest(paths, export, archive_kind="garmin")
    assert second.vo2max_files == 0
    assert [Path(path).name for path, _ in second.errors] == ["MetricsMaxMetData_b.json"]


def test_territory_parts_is_the_last_table_recompute_writes(ingested_store: Paths):
    """``derived_is_behind`` reads its modification time as when the recompute finished."""
    from activity_analysis.analysis.pipeline import derived_is_behind

    tables = list(ingested_store.derived.glob("*.parquet"))
    last = max(tables, key=lambda table: table.stat().st_mtime_ns)
    assert last == ingested_store.territory_parts_parquet
    assert not derived_is_behind(ingested_store)
