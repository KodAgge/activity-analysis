import gzip
from datetime import UTC, datetime
from pathlib import Path

import pytest

from activity_analysis.ingest.gpx_reader import read_gpx


def test_reads_the_reference_activity(reference_gpx: Path):
    parsed = read_gpx(reference_gpx)
    assert parsed.source_format == "gpx"
    assert len(parsed.records) == 626


def test_gpx_has_no_session_or_laps(reference_gpx: Path):
    parsed = read_gpx(reference_gpx)
    assert parsed.session == {}
    assert parsed.laps == []


def test_first_record_matches_the_fit_rendering(reference_gpx: Path):
    first = read_gpx(reference_gpx).records[0]
    assert first["lat_deg"] == pytest.approx(57.7708879)
    assert first["lon_deg"] == pytest.approx(14.1830235)
    assert first["altitude_m"] == pytest.approx(10.8)
    assert first["heart_rate"] == 84
    # Raw single-foot rpm, exactly as the FIT file records it.
    assert first["cadence"] == 50
    assert first["timestamp"] == datetime(2026, 8, 28, 18, 19, 14, tzinfo=UTC)


def test_track_name_is_captured(reference_gpx: Path):
    assert read_gpx(reference_gpx).name == "Löpning på kvällen"


def test_reads_gzipped_gpx(reference_gpx: Path, tmp_path: Path):
    gzipped = tmp_path / "activity.gpx.gz"
    gzipped.write_bytes(gzip.compress(reference_gpx.read_bytes()))
    assert len(read_gpx(gzipped).records) == 626


def test_missing_extensions_do_not_break_parsing(tmp_path: Path):
    minimal = tmp_path / "bare.gpx"
    minimal.write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">'
        "<trk><name>Bare</name><trkseg>"
        '<trkpt lat="57.4" lon="14.1"><ele>10.0</ele>'
        "<time>2026-08-28T18:19:14Z</time></trkpt>"
        "</trkseg></trk></gpx>",
        encoding="utf-8",
    )
    record = read_gpx(minimal).records[0]
    assert record["heart_rate"] is None
    assert record["cadence"] is None
    assert record["altitude_m"] == pytest.approx(10.0)
