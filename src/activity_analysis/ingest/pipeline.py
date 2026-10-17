"""Orchestrate ingestion: discover, read, normalize, reconcile, write.

Three mechanisms operate here and should not be conflated.

Idempotency is per source file, keyed on SHA-256 through the ledger, so the
same bytes are never processed twice. Reconciliation is per run, matching a
provisional identity against stored activities within a time and distance
tolerance. Deduplication is per identity, keyed on source priority, so when
two files describe the same run the richer source wins.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pandas as pd

from activity_analysis.config import DEFAULT_ATHLETE_ID, Paths
from activity_analysis.identity import displaces, find_matching_activity
from activity_analysis.ingest.discover import discover, find_unsupported, sha256_file
from activity_analysis.ingest.fit_reader import read_fit
from activity_analysis.ingest.garmin_metrics import find_max_met_files, read_max_met
from activity_analysis.ingest.gpx_reader import read_gpx
from activity_analysis.ingest.ledger import append_ledger, processed_hashes
from activity_analysis.ingest.normalize import normalize
from activity_analysis.models import (
    ACTIVITY_SCHEMA,
    PROFILE_OBSERVATION_SCHEMA,
    SOURCE_GARMIN_FIT,
    SOURCE_GPX,
    SOURCE_STRAVA_FIT,
)
from activity_analysis.progress import SILENT, Progress
from activity_analysis.store.writer import (
    read_activities,
    upsert_activities,
    upsert_device_vo2max,
    upsert_laps,
    upsert_profile_observations,
    write_streams,
)

_KNOWN_COLUMNS = ["activity_id", "athlete_id", "start_time_utc", "distance_m", "source"]


@dataclass
class IngestResult:
    ingested: int = 0
    skipped_already_processed: int = 0
    skipped_lower_priority: int = 0
    skipped_unsupported: int = 0
    skipped_not_an_activity: int = 0
    replaced: int = 0
    vo2max_files: int = 0
    errors: list[tuple[str, str]] = field(default_factory=list)


def _source_for(fmt: str, archive_kind: str) -> str:
    if fmt == "gpx":
        return SOURCE_GPX
    return SOURCE_GARMIN_FIT if archive_kind == "garmin" else SOURCE_STRAVA_FIT


#: The ledger's ``source`` for a file that is a Garmin export's metric
#: history rather than an activity.
SOURCE_GARMIN_EXPORT = "garmin_export"


def _ingest_device_vo2max(
    paths: Paths,
    source_root: Path,
    *,
    athlete_id: str,
    seen: set[str],
    now: datetime,
    result: IngestResult,
    ledger_rows: list[dict[str, object]],
) -> None:
    """Read every MaxMet file not yet in the ledger and upsert its days.

    Ledgered by content hash like a FIT file, so a second ingest of the same
    export reads nothing, and a file that failed is retried next time.
    """
    frames: list[pd.DataFrame] = []
    for path in find_max_met_files(source_root):
        sha256 = sha256_file(path)
        if sha256 in seen:
            result.skipped_already_processed += 1
            continue
        seen.add(sha256)
        try:
            frames.append(read_max_met(path, athlete_id=athlete_id, source_file_sha256=sha256))
            result.vo2max_files += 1
            status = "vo2max"
        except Exception as exc:  # noqa: BLE001 - one bad file must not abort the run
            result.errors.append((str(path), f"{type(exc).__name__}: {exc}"))
            status = "error"
        ledger_rows.append(
            {
                "source_file_sha256": sha256,
                "source_file": path.name,
                "activity_id": None,
                "source": SOURCE_GARMIN_EXPORT,
                "status": status,
                "ingested_at": now,
            }
        )
    non_empty = [frame for frame in frames if not frame.empty]
    if non_empty:
        upsert_device_vo2max(paths, pd.concat(non_empty, ignore_index=True))


def ingest(
    paths: Paths,
    source_root: Path,
    *,
    athlete_id: str = DEFAULT_ATHLETE_ID,
    archive_kind: str = "strava",
    force: bool = False,
    progress: Progress = SILENT,
) -> IngestResult:
    """Ingest every supported file under ``source_root`` into the canonical store."""
    paths.ensure()
    result = IngestResult()
    result.skipped_unsupported = len(find_unsupported(source_root))
    seen = set() if force else processed_hashes(paths)

    # Kept in memory so reconciliation sees activities written earlier in this
    # same run, not only those already on disk.
    known = read_activities(paths)[_KNOWN_COLUMNS].copy()

    # Activities and laps are accumulated and written once at the end.
    # Upserting per activity would re-read and rewrite the whole Parquet file
    # for every file in the dump, which is quadratic over a full export.
    # Streams live in one file per activity, so they are written immediately.
    pending: dict[str, tuple[dict[str, object], pd.DataFrame, dict[str, Any] | None]] = {}
    ledger_rows: list[dict[str, object]] = []
    now = datetime.now(UTC)

    for source_file in progress.track(discover(source_root), "reading files"):
        sha256 = sha256_file(source_file.path)
        if sha256 in seen:
            result.skipped_already_processed += 1
            continue
        seen.add(sha256)

        source = _source_for(source_file.fmt, archive_kind)
        try:
            parsed = (
                read_fit(source_file.path)
                if source_file.fmt == "fit"
                else read_gpx(source_file.path)
            )
            if not parsed.records:
                # A Strava export ships saved routes next to activities.
                # Those are planned courses: track points with no timestamps,
                # so they parse cleanly and are simply not recordings. A
                # Garmin export ships monitoring and sleep files, which the
                # reader stops reading at their file_id.
                result.skipped_not_an_activity += 1
                ledger_rows.append(
                    {
                        "source_file_sha256": sha256,
                        "source_file": source_file.path.name,
                        "activity_id": None,
                        "source": source,
                        "status": "not_an_activity",
                        "ingested_at": now,
                    }
                )
                continue
            normalized = normalize(
                parsed,
                source=source,
                source_file=source_file.path.name,
                source_file_sha256=sha256,
                athlete_id=athlete_id,
                ingested_at=now,
            )
        except Exception as exc:  # noqa: BLE001 - one bad file must not abort the run
            result.errors.append((str(source_file.path), f"{type(exc).__name__}: {exc}"))
            ledger_rows.append(
                {
                    "source_file_sha256": sha256,
                    "source_file": source_file.path.name,
                    "activity_id": None,
                    "source": source,
                    "status": "error",
                    "ingested_at": now,
                }
            )
            continue

        activity = normalized.activity
        matched = find_matching_activity(
            known, athlete_id, activity.start_time_utc, activity.distance_m
        )
        if matched is not None and matched != activity.activity_id:
            normalized = normalized.with_activity_id(matched)
            activity = normalized.activity

        activity_id = activity.activity_id
        incumbent_rows = known[known["activity_id"] == activity_id]
        incumbent = str(incumbent_rows.iloc[0]["source"]) if not incumbent_rows.empty else None

        if incumbent is not None and not displaces(source, incumbent, force=force):
            result.skipped_lower_priority += 1
            status = "skipped_lower_priority"
        else:
            status = "ingested"
            if incumbent is not None:
                result.replaced += 1
            else:
                result.ingested += 1

            pending[activity_id] = (
                vars(activity),
                normalized.laps,
                normalized.profile_observation,
            )
            write_streams(paths, activity_id, normalized.streams)

            known = known[known["activity_id"] != activity_id]
            known = pd.concat(
                [
                    known,
                    pd.DataFrame(
                        [
                            {
                                "activity_id": activity_id,
                                "athlete_id": athlete_id,
                                "start_time_utc": pd.Timestamp(activity.start_time_utc),
                                "distance_m": activity.distance_m,
                                "source": source,
                            }
                        ]
                    ),
                ],
                ignore_index=True,
            )

        ledger_rows.append(
            {
                "source_file_sha256": sha256,
                "source_file": source_file.path.name,
                "activity_id": activity_id,
                "source": source,
                "status": status,
                "ingested_at": now,
            }
        )

    if pending:
        rows = [row for row, _, _ in pending.values()]
        upsert_activities(paths, pd.DataFrame(rows)[ACTIVITY_SCHEMA.names])
        lap_frames = [laps for _, laps, _ in pending.values() if not laps.empty]
        if lap_frames:
            upsert_laps(paths, pd.concat(lap_frames, ignore_index=True))
        observations = [obs for _, _, obs in pending.values() if obs is not None]
        if observations:
            upsert_profile_observations(
                paths, pd.DataFrame(observations)[PROFILE_OBSERVATION_SCHEMA.names]
            )

    if archive_kind == "garmin":
        _ingest_device_vo2max(
            paths,
            source_root,
            athlete_id=athlete_id,
            seen=seen,
            now=now,
            result=result,
            ledger_rows=ledger_rows,
        )

    append_ledger(paths, ledger_rows)
    return result
