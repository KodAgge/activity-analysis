"""The daily resting heart rate, from a Garmin Connect export.

The export keeps its daily summaries in
``DI_CONNECT/DI-Connect-Aggregator/UDSFile_*.json``, one file per roughly
100-day range, each a JSON array with one record per calendar day.
``restingHeartRate`` is the day's resting heart rate in bpm and is null on a
day the watch recorded none. ``version`` counts revisions of the same day's
record, so a day that appears in two overlapping files keeps the higher one.
A record without one counts as version 0.
"""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

from activity_analysis.models import RESTING_HR_SCHEMA

#: Where a Garmin export keeps its daily summaries.
AGGREGATOR_DIR = Path("DI_CONNECT") / "DI-Connect-Aggregator"


def find_uds_files(root: Path) -> list[Path]:
    """Every daily-summary file of the Garmin export unpacked at ``root``."""
    return sorted((root / AGGREGATOR_DIR).glob("UDSFile_*.json"))


def parse_uds_file(path: Path, *, athlete_id: str, source_file_sha256: str) -> pd.DataFrame:
    """One row per day with a resting heart rate, in ``RESTING_HR_SCHEMA``."""
    records = json.loads(path.read_text())
    if not isinstance(records, list):
        raise ValueError(
            f"{path.name}: expected a JSON array of records, got {type(records).__name__}"
        )
    kept = [
        {
            "athlete_id": athlete_id,
            "calendar_date": pd.Timestamp(record["calendarDate"]).date(),
            "resting_hr_bpm": float(record["restingHeartRate"]),
            "record_version": int(record.get("version", 0)),
            "source_file_sha256": source_file_sha256,
        }
        for record in records
        if record.get("restingHeartRate") is not None
    ]
    frame = pd.DataFrame(kept, columns=RESTING_HR_SCHEMA.names)
    return frame.astype({"resting_hr_bpm": "float64", "record_version": "int64"})
