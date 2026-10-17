import gzip
import hashlib
from pathlib import Path

from activity_analysis.ingest.discover import discover, find_unsupported, sha256_file


def test_sha256_matches_hashlib(tmp_path: Path):
    target = tmp_path / "a.fit"
    target.write_bytes(b"hello")
    assert sha256_file(target) == hashlib.sha256(b"hello").hexdigest()


def test_discovers_all_supported_formats(tmp_path: Path):
    (tmp_path / "a.fit").write_bytes(b"x")
    (tmp_path / "b.fit.gz").write_bytes(gzip.compress(b"x"))
    (tmp_path / "c.gpx").write_bytes(b"x")
    (tmp_path / "d.gpx.gz").write_bytes(gzip.compress(b"x"))
    found = {f.path.name: f.fmt for f in discover(tmp_path)}
    assert found == {"a.fit": "fit", "b.fit.gz": "fit", "c.gpx": "gpx", "d.gpx.gz": "gpx"}


def test_recurses_into_subdirectories(tmp_path: Path):
    nested = tmp_path / "export" / "activities"
    nested.mkdir(parents=True)
    (nested / "a.fit").write_bytes(b"x")
    assert [f.path.name for f in discover(tmp_path)] == ["a.fit"]


def test_ignores_unsupported_and_artifact_files(tmp_path: Path):
    (tmp_path / "a.fit").write_bytes(b"x")
    (tmp_path / "activities.csv").write_text("id\n1\n")
    (tmp_path / "a.fit:Zone.Identifier").write_text("[ZoneTransfer]")
    (tmp_path / ".hidden.fit").write_bytes(b"x")
    assert [f.path.name for f in discover(tmp_path)] == ["a.fit"]


def test_result_is_sorted(tmp_path: Path):
    for name in ("c.fit", "a.fit", "b.fit"):
        (tmp_path / name).write_bytes(b"x")
    assert [f.path.name for f in discover(tmp_path)] == ["a.fit", "b.fit", "c.fit"]


def test_missing_root_yields_nothing(tmp_path: Path):
    assert discover(tmp_path / "nope") == []


def test_recognised_but_unreadable_formats_are_reported_not_dropped(tmp_path: Path):
    # A real Strava export contains a couple of TCX activities. Dropping them
    # silently would lose runs without anyone noticing.
    (tmp_path / "a.fit").write_bytes(b"x")
    (tmp_path / "b.tcx.gz").write_bytes(gzip.compress(b"x"))
    (tmp_path / "c.tcx").write_bytes(b"x")
    (tmp_path / "activities.csv").write_text("id\n1\n")
    assert [p.name for p in find_unsupported(tmp_path)] == ["b.tcx.gz", "c.tcx"]


def test_unrelated_files_are_not_reported_as_unsupported(tmp_path: Path):
    (tmp_path / "activities.csv").write_text("id\n1\n")
    (tmp_path / "profile.jpg").write_bytes(b"x")
    assert find_unsupported(tmp_path) == []
