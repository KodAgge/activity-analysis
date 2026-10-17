from datetime import UTC, datetime
from pathlib import Path

from activity_analysis.config import Paths
from activity_analysis.ingest.ledger import append_ledger, load_ledger, processed_hashes


def _row(sha: str) -> dict:
    return {
        "source_file_sha256": sha,
        "source_file": f"{sha}.fit",
        "activity_id": "abc123",
        "source": "strava_fit",
        "status": "ingested",
        "ingested_at": datetime(2026, 8, 29, tzinfo=UTC),
    }


def test_empty_ledger_when_absent(tmp_path: Path):
    paths = Paths(root=tmp_path)
    paths.ensure()
    assert load_ledger(paths).empty
    assert processed_hashes(paths) == set()


def test_append_then_read_back(tmp_path: Path):
    paths = Paths(root=tmp_path)
    paths.ensure()
    append_ledger(paths, [_row("aaa")])
    assert processed_hashes(paths) == {"aaa"}


def test_appending_accumulates(tmp_path: Path):
    paths = Paths(root=tmp_path)
    paths.ensure()
    append_ledger(paths, [_row("aaa")])
    append_ledger(paths, [_row("bbb")])
    assert processed_hashes(paths) == {"aaa", "bbb"}
    assert len(load_ledger(paths)) == 2


def test_a_file_that_failed_is_not_counted_as_processed(tmp_path: Path):
    # Otherwise the fix for whatever made it fail never reaches it: a plain
    # re-ingest would skip it, and only --force would try it again.
    paths = Paths(root=tmp_path)
    paths.ensure()
    append_ledger(paths, [_row("aaa"), {**_row("bbb"), "activity_id": None, "status": "error"}])
    assert processed_hashes(paths) == {"aaa"}
