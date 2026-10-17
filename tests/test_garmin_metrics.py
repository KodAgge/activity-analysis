"""The MaxMet reader: one Garmin VO2max file into one row per running day."""

from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

import pytest

from activity_analysis.ingest.garmin_metrics import (
    METRICS_DIR,
    find_max_met_files,
    read_max_met,
)


def _row(
    day: str,
    max_met: float | None,
    *,
    sport: str | None = "RUNNING",
    reported: float = 49.0,
    updated: str = "2025-01-01T10:00:00.0",
    device: int = 1234567890,
) -> dict[str, object]:
    return {
        "userProfilePK": 1000001,
        "calendarDate": day,
        "deviceId": device,
        "updateTimestamp": updated,
        "sport": sport,
        "subSport": "GENERIC",
        "vo2MaxValue": reported,
        "maxMet": max_met,
        "maxMetCategory": "GENERIC",
        "calibratedData": 1,
    }


def _write(path: Path, rows: object) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(rows))
    return path


def test_only_running_rows_survive(tmp_path: Path) -> None:
    path = _write(
        tmp_path / "m.json",
        [
            _row("2025-01-01", 14.0),
            _row("2025-01-02", 13.0, sport="WALKING"),
            _row("2025-01-03", 13.0, sport=None),
        ],
    )
    frame = read_max_met(path, athlete_id="a", source_file_sha256="h")
    assert frame["calendar_date"].tolist() == [dt.date(2025, 1, 1)]


def test_vo2max_is_max_met_times_three_and_a_half(tmp_path: Path) -> None:
    path = _write(tmp_path / "m.json", [_row("2025-01-01", 13.989395141601562, reported=49.0)])
    (row,) = read_max_met(path, athlete_id="a", source_file_sha256="h").to_dict("records")
    assert row["vo2max"] == pytest.approx(48.96288299560547)
    assert row["vo2max_reported"] == 49
    assert row["device_id"] == "1234567890"
    assert row["athlete_id"] == "a"
    assert row["source_file_sha256"] == "h"


def test_the_later_update_of_a_day_wins(tmp_path: Path) -> None:
    path = _write(
        tmp_path / "m.json",
        [
            _row("2025-01-01", 14.0, updated="2025-01-01T20:00:00.0"),
            _row("2025-01-01", 13.0, updated="2025-01-01T08:00:00.0"),
        ],
    )
    frame = read_max_met(path, athlete_id="a", source_file_sha256="h")
    assert frame["vo2max"].tolist() == [pytest.approx(49.0)]
    assert frame["updated_at"].iloc[0].tzinfo is None


def test_a_running_row_with_no_max_met_is_dropped(tmp_path: Path) -> None:
    path = _write(tmp_path / "m.json", [_row("2025-01-01", None), _row("2025-01-02", 14.0)])
    frame = read_max_met(path, athlete_id="a", source_file_sha256="h")
    assert frame["calendar_date"].tolist() == [dt.date(2025, 1, 2)]


def test_a_file_with_no_running_rows_reads_as_empty(tmp_path: Path) -> None:
    path = _write(tmp_path / "m.json", [_row("2025-01-01", 13.0, sport="WALKING")])
    assert read_max_met(path, athlete_id="a", source_file_sha256="h").empty


def test_a_top_level_that_is_not_an_array_is_refused(tmp_path: Path) -> None:
    path = _write(tmp_path / "m.json", {"rows": []})
    with pytest.raises(ValueError, match="array"):
        read_max_met(path, athlete_id="a", source_file_sha256="h")


def test_files_are_found_under_the_metrics_directory_only(tmp_path: Path) -> None:
    wanted = _write(tmp_path / METRICS_DIR / "MetricsMaxMetData_20250101_20250410_1.json", [])
    _write(tmp_path / METRICS_DIR / "MetricsAcuteTrainingLoad_1.json", [])
    _write(tmp_path / "elsewhere" / "MetricsMaxMetData_x.json", [])
    assert find_max_met_files(tmp_path) == [wanted]
