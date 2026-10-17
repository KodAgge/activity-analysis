"""The canonical device_vo2max table: one row per athlete and day, later update wins."""

from __future__ import annotations

import datetime as dt
from pathlib import Path

import pandas as pd

from activity_analysis.config import Paths
from activity_analysis.store.db import connect
from activity_analysis.store.writer import read_device_vo2max, upsert_device_vo2max


def _frame(*rows: tuple[str, float, str]) -> pd.DataFrame:
    return pd.DataFrame(
        [
            {
                "athlete_id": "a",
                "calendar_date": dt.date.fromisoformat(day),
                "vo2max": value,
                "vo2max_reported": round(value),
                "device_id": "d",
                "updated_at": pd.Timestamp(updated),
                "source_file_sha256": "h",
            }
            for day, value, updated in rows
        ]
    )


def test_an_overlapping_later_file_replaces_only_the_days_it_shares(tmp_path: Path) -> None:
    paths = Paths(root=tmp_path)
    upsert_device_vo2max(
        paths,
        _frame(("2025-01-01", 48.0, "2025-01-01T09:00"), ("2025-01-02", 48.5, "2025-01-02T09:00")),
    )
    upsert_device_vo2max(
        paths,
        _frame(("2025-01-02", 49.0, "2025-01-02T21:00"), ("2025-01-03", 49.5, "2025-01-03T09:00")),
    )
    stored = read_device_vo2max(paths)
    assert stored["calendar_date"].tolist() == [dt.date(2025, 1, d) for d in (1, 2, 3)]
    assert stored["vo2max"].tolist() == [48.0, 49.0, 49.5]


def test_an_older_update_does_not_overwrite_a_newer_one(tmp_path: Path) -> None:
    paths = Paths(root=tmp_path)
    upsert_device_vo2max(paths, _frame(("2025-01-02", 49.0, "2025-01-02T21:00")))
    upsert_device_vo2max(paths, _frame(("2025-01-02", 48.5, "2025-01-02T09:00")))
    assert read_device_vo2max(paths)["vo2max"].tolist() == [49.0]


def test_upserting_the_same_rows_twice_changes_nothing(tmp_path: Path) -> None:
    paths = Paths(root=tmp_path)
    rows = _frame(("2025-01-01", 48.0, "2025-01-01T09:00"))
    upsert_device_vo2max(paths, rows)
    upsert_device_vo2max(paths, rows)
    assert len(read_device_vo2max(paths)) == 1


def test_the_view_is_empty_but_typed_on_a_store_without_the_table(tmp_path: Path) -> None:
    con = connect(Paths(root=tmp_path))
    columns = {name: kind for name, kind, *_ in con.execute("DESCRIBE device_vo2max").fetchall()}
    assert columns["calendar_date"] == "DATE"
    assert columns["vo2max"] == "DOUBLE"
    assert con.execute("SELECT count(*) FROM device_vo2max").fetchone() == (0,)


def test_the_view_reads_the_stored_table(tmp_path: Path) -> None:
    paths = Paths(root=tmp_path)
    upsert_device_vo2max(paths, _frame(("2025-01-01", 48.0, "2025-01-01T09:00")))
    con = connect(paths)
    assert con.execute("SELECT calendar_date, vo2max FROM device_vo2max").fetchall() == [
        (dt.date(2025, 1, 1), 48.0)
    ]
