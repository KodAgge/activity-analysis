from datetime import UTC, datetime
from pathlib import Path

import pandas as pd

from activity_analysis.config import Paths
from activity_analysis.models import ACTIVITY_SCHEMA, STREAM_SCHEMA, empty_frame
from activity_analysis.store.writer import (
    read_activities,
    read_streams,
    upsert_activities,
    write_streams,
)


def _activity(activity_id: str, distance: float) -> pd.DataFrame:
    frame = empty_frame(ACTIVITY_SCHEMA)
    row = {name: None for name in ACTIVITY_SCHEMA.names}
    row.update(
        activity_id=activity_id,
        athlete_id="default",
        source="strava_fit",
        source_file=f"{activity_id}.fit",
        source_file_sha256="x",
        start_time_utc=datetime(2026, 8, 28, 18, 19, 14, tzinfo=UTC),
        distance_m=distance,
        ingest_version=1,
    )
    return pd.concat([frame, pd.DataFrame([row])], ignore_index=True)


def test_reading_before_writing_gives_an_empty_frame(tmp_path: Path):
    paths = Paths(root=tmp_path)
    paths.ensure()
    result = read_activities(paths)
    assert result.empty
    assert list(result.columns) == ACTIVITY_SCHEMA.names


def test_upsert_inserts(tmp_path: Path):
    paths = Paths(root=tmp_path)
    paths.ensure()
    upsert_activities(paths, _activity("aaa", 1000.0))
    assert len(read_activities(paths)) == 1


def test_upsert_replaces_rather_than_duplicating(tmp_path: Path):
    paths = Paths(root=tmp_path)
    paths.ensure()
    upsert_activities(paths, _activity("aaa", 1000.0))
    upsert_activities(paths, _activity("aaa", 2000.0))
    stored = read_activities(paths)
    assert len(stored) == 1
    assert stored.iloc[0]["distance_m"] == 2000.0


def test_upsert_keeps_other_activities(tmp_path: Path):
    paths = Paths(root=tmp_path)
    paths.ensure()
    upsert_activities(paths, _activity("aaa", 1000.0))
    upsert_activities(paths, _activity("bbb", 3000.0))
    assert set(read_activities(paths)["activity_id"]) == {"aaa", "bbb"}


def test_streams_round_trip(tmp_path: Path):
    paths = Paths(root=tmp_path)
    paths.ensure()
    frame = empty_frame(STREAM_SCHEMA)
    frame = pd.concat(
        [
            frame,
            pd.DataFrame(
                [
                    {
                        **{name: None for name in STREAM_SCHEMA.names},
                        "activity_id": "aaa",
                        "t_s": 0.0,
                        "timestamp_utc": datetime(2026, 8, 28, 18, 19, 14, tzinfo=UTC),
                        "speed_mps": 2.5,
                        "moving": True,
                    }
                ]
            ),
        ],
        ignore_index=True,
    )
    write_streams(paths, "aaa", frame)
    assert paths.stream_path("aaa").exists()
    assert read_streams(paths, "aaa").iloc[0]["speed_mps"] == 2.5
