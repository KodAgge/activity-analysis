"""Garmin's own VO2max history, from a Garmin Connect export.

The export keeps it in ``DI_CONNECT/DI-Connect-Metrics/MetricsMaxMetData_*.json``,
one file per roughly 100-day range, each a JSON array with one row per update.
Only running rows are kept. ``vo2MaxValue`` is the whole number the watch
shows; ``maxMet`` is the same estimate in METs, unrounded, and times 3.5 it
rounds to ``vo2MaxValue`` on every running row of the 2026-10-04 export. See
``docs/reference/math/vo2max.md``, "Against Garmin's own".
"""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

#: Where a Garmin export keeps its metric histories.
METRICS_DIR = Path("DI_CONNECT") / "DI-Connect-Metrics"

#: Oxygen uptake of one MET, ml/kg/min.
ML_PER_KG_MIN_PER_MET = 3.5

_RUNNING = "RUNNING"
_COLUMNS = [
    "athlete_id",
    "calendar_date",
    "vo2max",
    "vo2max_reported",
    "device_id",
    "updated_at",
    "source_file_sha256",
]


def find_max_met_files(root: Path) -> list[Path]:
    """Every VO2max history file of the Garmin export unpacked at ``root``."""
    return sorted((root / METRICS_DIR).glob("MetricsMaxMetData_*.json"))


def read_max_met(path: Path, *, athlete_id: str, source_file_sha256: str) -> pd.DataFrame:
    """One row per running day, the day's last update, VO2max in ml/kg/min.

    A running row with no ``maxMet`` has no value to store and is dropped.
    ``updateTimestamp`` states no zone, so it is kept naive and used only to
    order one day's updates.
    """
    rows = json.loads(path.read_text())
    if not isinstance(rows, list):
        raise ValueError(f"{path.name}: expected a JSON array of rows, got {type(rows).__name__}")
    kept = [
        {
            "athlete_id": athlete_id,
            "calendar_date": pd.Timestamp(row["calendarDate"]).date(),
            "vo2max": float(row["maxMet"]) * ML_PER_KG_MIN_PER_MET,
            "vo2max_reported": int(row["vo2MaxValue"]),
            "device_id": str(row["deviceId"]),
            "updated_at": pd.Timestamp(row["updateTimestamp"]),
            "source_file_sha256": source_file_sha256,
        }
        for row in rows
        if row.get("sport") == _RUNNING and row.get("maxMet") is not None
    ]
    frame = pd.DataFrame(kept, columns=_COLUMNS)
    if frame.empty:
        return frame
    frame = frame.sort_values("updated_at", kind="stable")
    frame = frame.drop_duplicates("calendar_date", keep="last")
    return frame.sort_values("calendar_date").reset_index(drop=True)
