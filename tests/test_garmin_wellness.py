"""The UDS reader: Garmin's daily summary files into one resting heart rate per day."""

from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

import pandas as pd

from activity_analysis.config import Paths
from activity_analysis.ingest.garmin_wellness import (
    AGGREGATOR_DIR,
    find_uds_files,
    parse_uds_file,
)
from activity_analysis.models import RESTING_HR_SCHEMA
from activity_analysis.store.writer import read_resting_hr, upsert_resting_hr


def _record(day: str, resting: int | None, version: int = 1) -> dict[str, object]:
    return {
        "uuid": f"uuid-{day}",
        "calendarDate": day,
        "version": version,
        "restingHeartRate": resting,
        "totalSteps": 1000,
    }


def _write(root: Path, name: str, rows: object) -> Path:
    path = root / AGGREGATOR_DIR / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(rows))
    return path


def test_find_uds_files_is_sorted_and_ignores_other_files(tmp_path: Path) -> None:
    _write(tmp_path, "UDSFile_b.json", [])
    _write(tmp_path, "UDSFile_a.json", [])
    _write(tmp_path, "HydrationLogFile_a.json", [])
    assert [p.name for p in find_uds_files(tmp_path)] == ["UDSFile_a.json", "UDSFile_b.json"]


def test_parse_keeps_days_with_a_resting_heart_rate(tmp_path: Path) -> None:
    path = _write(
        tmp_path,
        "UDSFile_a.json",
        [_record("2025-01-01", 50), _record("2025-01-02", None), _record("2025-01-03", 52, 3)],
    )
    frame = parse_uds_file(path, athlete_id="a", source_file_sha256="h")
    assert frame["calendar_date"].tolist() == [dt.date(2025, 1, 1), dt.date(2025, 1, 3)]
    assert frame["resting_hr_bpm"].tolist() == [50.0, 52.0]
    assert frame["record_version"].tolist() == [1, 3]
    assert set(frame["athlete_id"]) == {"a"}
    assert set(frame["source_file_sha256"]) == {"h"}


def _frame(day: str, bpm: float, version: int) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "athlete_id": ["a"],
            "calendar_date": [dt.date.fromisoformat(day)],
            "resting_hr_bpm": [bpm],
            "record_version": [version],
            "source_file_sha256": [f"h{version}"],
        }
    )[RESTING_HR_SCHEMA.names]


def test_upsert_keeps_the_higher_record_version(tmp_path: Path) -> None:
    paths = Paths(root=tmp_path)
    upsert_resting_hr(paths, _frame("2025-01-01", 50.0, 1))
    upsert_resting_hr(paths, _frame("2025-01-01", 48.0, 2))
    assert read_resting_hr(paths)["resting_hr_bpm"].tolist() == [48.0]
    upsert_resting_hr(paths, _frame("2025-01-01", 50.0, 1))
    assert read_resting_hr(paths)["resting_hr_bpm"].tolist() == [48.0]


def test_upsert_keeps_the_stored_row_on_a_tie(tmp_path: Path) -> None:
    paths = Paths(root=tmp_path)
    upsert_resting_hr(paths, _frame("2025-01-01", 50.0, 2))
    upsert_resting_hr(paths, _frame("2025-01-01", 49.0, 2))
    assert read_resting_hr(paths)["resting_hr_bpm"].tolist() == [50.0]


def test_read_resting_hr_is_empty_and_typed_when_absent(tmp_path: Path) -> None:
    frame = read_resting_hr(Paths(root=tmp_path))
    assert frame.empty
    assert list(frame.columns) == RESTING_HR_SCHEMA.names


def test_a_record_without_a_version_is_version_zero(tmp_path: Path) -> None:
    record = _record("2025-01-01", 50)
    del record["version"]
    path = _write(tmp_path, "UDSFile_a.json", [record])
    frame = parse_uds_file(path, athlete_id="a", source_file_sha256="h")
    assert frame["record_version"].tolist() == [0]
