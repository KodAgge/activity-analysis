"""Parquet reads and writes with schema enforcement."""

from __future__ import annotations

from pathlib import Path

import pandas as pd
import pyarrow as pa

from activity_analysis.config import Paths
from activity_analysis.models import (
    ACTIVITY_EFFICIENCY_SCHEMA,
    ACTIVITY_METRICS_SCHEMA,
    ACTIVITY_SCHEMA,
    ACTIVITY_TAG_SCHEMA,
    ATHLETE_FIT_SCHEMA,
    ATHLETE_PROFILE_SCHEMA,
    BEST_EFFORT_SCHEMA,
    DEVICE_VO2MAX_SCHEMA,
    FITNESS_SERIES_SCHEMA,
    GRID_SCHEMA,
    LAP_SCHEMA,
    PROFILE_OBSERVATION_SCHEMA,
    ROUTE_RUN_SCHEMA,
    ROUTE_SCHEMA,
    SPORT_RECLASSIFICATION_SCHEMA,
    STREAM_SCHEMA,
    TERRITORY_CLAIM_SCHEMA,
    TERRITORY_PART_SCHEMA,
    TERRITORY_REGION_SCHEMA,
    ZONE_TIME_SCHEMA,
    empty_frame,
)


def _read(path: Path, schema: pa.Schema) -> pd.DataFrame:
    if not path.exists():
        return empty_frame(schema)
    frame: pd.DataFrame = pd.read_parquet(path)
    return frame


def _upsert(path: Path, schema: pa.Schema, incoming: pd.DataFrame) -> None:
    """Replace rows sharing an activity_id with ``incoming``, then write."""
    if incoming.empty:
        return
    existing = _read(path, schema)
    replaced_ids = set(incoming["activity_id"].unique())
    kept = existing[~existing["activity_id"].isin(replaced_ids)]
    combined = pd.concat([kept, incoming[schema.names]], ignore_index=True)
    path.parent.mkdir(parents=True, exist_ok=True)
    combined.to_parquet(path, index=False, schema=schema)


def read_activities(paths: Paths) -> pd.DataFrame:
    return _read(paths.activities_parquet, ACTIVITY_SCHEMA)


def read_laps(paths: Paths) -> pd.DataFrame:
    return _read(paths.laps_parquet, LAP_SCHEMA)


def upsert_activities(paths: Paths, frame: pd.DataFrame) -> None:
    _upsert(paths.activities_parquet, ACTIVITY_SCHEMA, frame)


def upsert_laps(paths: Paths, frame: pd.DataFrame) -> None:
    _upsert(paths.laps_parquet, LAP_SCHEMA, frame)


def read_profile_observations(paths: Paths) -> pd.DataFrame:
    return _read(paths.profile_observations_parquet, PROFILE_OBSERVATION_SCHEMA)


def upsert_profile_observations(paths: Paths, frame: pd.DataFrame) -> None:
    _upsert(paths.profile_observations_parquet, PROFILE_OBSERVATION_SCHEMA, frame)


def read_device_vo2max(paths: Paths) -> pd.DataFrame:
    return _read(paths.device_vo2max_parquet, DEVICE_VO2MAX_SCHEMA)


def upsert_device_vo2max(paths: Paths, frame: pd.DataFrame) -> None:
    """Merge ``frame`` in, one row per athlete and day, the later update winning.

    Keyed on the day rather than on ``activity_id`` like ``_upsert``: these
    rows belong to no activity. A newer export overlapping an older one
    replaces the days they share, and an older file ingested after a newer
    one cannot roll a day back.
    """
    if frame.empty:
        return
    existing = _read(paths.device_vo2max_parquet, DEVICE_VO2MAX_SCHEMA)
    combined = pd.concat([existing, frame[DEVICE_VO2MAX_SCHEMA.names]], ignore_index=True)
    combined = combined.sort_values("updated_at", kind="stable")
    combined = combined.drop_duplicates(["athlete_id", "calendar_date"], keep="last")
    combined = combined.sort_values(["athlete_id", "calendar_date"]).reset_index(drop=True)
    paths.device_vo2max_parquet.parent.mkdir(parents=True, exist_ok=True)
    combined.to_parquet(paths.device_vo2max_parquet, index=False, schema=DEVICE_VO2MAX_SCHEMA)


def write_streams(paths: Paths, activity_id: str, frame: pd.DataFrame) -> None:
    """Write one activity's stream, replacing any previous file."""
    paths.streams_dir.mkdir(parents=True, exist_ok=True)
    frame[STREAM_SCHEMA.names].to_parquet(
        paths.stream_path(activity_id), index=False, schema=STREAM_SCHEMA
    )


def read_streams(paths: Paths, activity_id: str) -> pd.DataFrame:
    return _read(paths.stream_path(activity_id), STREAM_SCHEMA)


def write_derived_stream(paths: Paths, activity_id: str, frame: pd.DataFrame) -> None:
    paths.derived_streams_dir.mkdir(parents=True, exist_ok=True)
    frame[GRID_SCHEMA.names].to_parquet(
        paths.derived_stream_path(activity_id), index=False, schema=GRID_SCHEMA
    )


def read_derived_stream(paths: Paths, activity_id: str) -> pd.DataFrame:
    return _read(paths.derived_stream_path(activity_id), GRID_SCHEMA)


def _write_table(path: Path, schema: pa.Schema, frame: pd.DataFrame) -> None:
    """Replace a derived table wholesale. Recompute is always a full rebuild."""
    path.parent.mkdir(parents=True, exist_ok=True)
    ordered = frame[schema.names] if not frame.empty else empty_frame(schema)
    ordered.to_parquet(path, index=False, schema=schema)


def write_best_efforts(paths: Paths, frame: pd.DataFrame) -> None:
    _write_table(paths.best_efforts_parquet, BEST_EFFORT_SCHEMA, frame)


def read_best_efforts(paths: Paths) -> pd.DataFrame:
    return _read(paths.best_efforts_parquet, BEST_EFFORT_SCHEMA)


def write_zone_time(paths: Paths, frame: pd.DataFrame) -> None:
    _write_table(paths.zone_time_parquet, ZONE_TIME_SCHEMA, frame)


def read_zone_time(paths: Paths) -> pd.DataFrame:
    return _read(paths.zone_time_parquet, ZONE_TIME_SCHEMA)


def write_activity_metrics(paths: Paths, frame: pd.DataFrame) -> None:
    _write_table(paths.activity_metrics_parquet, ACTIVITY_METRICS_SCHEMA, frame)


def read_activity_metrics(paths: Paths) -> pd.DataFrame:
    return _read(paths.activity_metrics_parquet, ACTIVITY_METRICS_SCHEMA)


def write_athlete_profile(paths: Paths, frame: pd.DataFrame) -> None:
    _write_table(paths.athlete_profile_parquet, ATHLETE_PROFILE_SCHEMA, frame)


def read_athlete_profile(paths: Paths) -> pd.DataFrame:
    return _read(paths.athlete_profile_parquet, ATHLETE_PROFILE_SCHEMA)


def write_activity_tags(paths: Paths, frame: pd.DataFrame) -> None:
    _write_table(paths.activity_tags_parquet, ACTIVITY_TAG_SCHEMA, frame)


def read_activity_tags(paths: Paths) -> pd.DataFrame:
    return _read(paths.activity_tags_parquet, ACTIVITY_TAG_SCHEMA)


def write_activity_efficiency(paths: Paths, frame: pd.DataFrame) -> None:
    _write_table(paths.activity_efficiency_parquet, ACTIVITY_EFFICIENCY_SCHEMA, frame)


def read_activity_efficiency(paths: Paths) -> pd.DataFrame:
    return _read(paths.activity_efficiency_parquet, ACTIVITY_EFFICIENCY_SCHEMA)


def write_athlete_fit(paths: Paths, frame: pd.DataFrame) -> None:
    _write_table(paths.athlete_fit_parquet, ATHLETE_FIT_SCHEMA, frame)


def read_athlete_fit(paths: Paths) -> pd.DataFrame:
    return _read(paths.athlete_fit_parquet, ATHLETE_FIT_SCHEMA)


def write_fitness_series(paths: Paths, frame: pd.DataFrame) -> None:
    _write_table(paths.fitness_series_parquet, FITNESS_SERIES_SCHEMA, frame)


def read_fitness_series(paths: Paths) -> pd.DataFrame:
    return _read(paths.fitness_series_parquet, FITNESS_SERIES_SCHEMA)


def write_routes(paths: Paths, frame: pd.DataFrame) -> None:
    _write_table(paths.routes_parquet, ROUTE_SCHEMA, frame)


def read_routes(paths: Paths) -> pd.DataFrame:
    return _read(paths.routes_parquet, ROUTE_SCHEMA)


def write_route_runs(paths: Paths, frame: pd.DataFrame) -> None:
    _write_table(paths.route_runs_parquet, ROUTE_RUN_SCHEMA, frame)


def read_route_runs(paths: Paths) -> pd.DataFrame:
    return _read(paths.route_runs_parquet, ROUTE_RUN_SCHEMA)


def write_territory_claims(paths: Paths, frame: pd.DataFrame) -> None:
    _write_table(paths.territory_claims_parquet, TERRITORY_CLAIM_SCHEMA, frame)


def read_territory_claims(paths: Paths) -> pd.DataFrame:
    return _read(paths.territory_claims_parquet, TERRITORY_CLAIM_SCHEMA)


def write_territory_regions(paths: Paths, frame: pd.DataFrame) -> None:
    _write_table(paths.territory_regions_parquet, TERRITORY_REGION_SCHEMA, frame)


def read_territory_regions(paths: Paths) -> pd.DataFrame:
    return _read(paths.territory_regions_parquet, TERRITORY_REGION_SCHEMA)


def write_territory_parts(paths: Paths, frame: pd.DataFrame) -> None:
    _write_table(paths.territory_parts_parquet, TERRITORY_PART_SCHEMA, frame)


def read_territory_parts(paths: Paths) -> pd.DataFrame:
    return _read(paths.territory_parts_parquet, TERRITORY_PART_SCHEMA)


def write_sport_reclassifications(paths: Paths, frame: pd.DataFrame) -> None:
    _write_table(paths.sport_reclassifications_parquet, SPORT_RECLASSIFICATION_SCHEMA, frame)


def read_sport_reclassifications(paths: Paths) -> pd.DataFrame:
    return _read(paths.sport_reclassifications_parquet, SPORT_RECLASSIFICATION_SCHEMA)
