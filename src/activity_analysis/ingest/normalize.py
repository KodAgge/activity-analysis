"""Convert a ParsedActivity into the canonical SI model.

Every unit conversion in the project happens here or in a reader, exactly
once. Downstream code assumes metres, seconds, m/s, bpm and spm.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime
from typing import Any

import numpy as np
import pandas as pd

from activity_analysis.config import INGEST_VERSION
from activity_analysis.geo import cumulative_distance_m
from activity_analysis.identity import compute_activity_id
from activity_analysis.ingest.parsed import ParsedActivity
from activity_analysis.models import LAP_SCHEMA, STREAM_SCHEMA, Activity
from activity_analysis.units import fit_cadence_to_spm, semicircles_to_degrees

#: The range real UTC offsets span, Baker Island to the Line Islands. A
#: difference outside it is not an offset, whatever the file says.
MIN_UTC_OFFSET_S = -12 * 3600
MAX_UTC_OFFSET_S = 14 * 3600


@dataclass
class NormalizedActivity:
    activity: Activity
    laps: pd.DataFrame
    streams: pd.DataFrame
    profile_observation: dict[str, Any] | None = None

    def with_activity_id(self, activity_id: str) -> NormalizedActivity:
        """A copy re-keyed to ``activity_id``.

        The pipeline uses this when reconciliation finds that this file
        describes a run already in the store under a different provisional id.
        """
        return NormalizedActivity(
            activity=replace(self.activity, activity_id=activity_id),
            laps=self.laps.assign(activity_id=activity_id),
            streams=self.streams.assign(activity_id=activity_id),
            profile_observation=(
                None
                if self.profile_observation is None
                else {**self.profile_observation, "activity_id": activity_id}
            ),
        )


def _as_text(value: Any) -> str | None:
    """Coerce an enum-like field to the string the canonical schema expects.

    fitdecode names the enum values it knows and returns the raw integer for
    the rest, so sport, sub_sport and lap_trigger arrive as either. Keeping
    the number as text preserves it instead of discarding an unnamed value.
    """
    if value is None:
        return None
    return str(value)


def _as_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _profile_observation(
    parsed: ParsedActivity,
    *,
    activity_id: str,
    athlete_id: str,
    observed_at: datetime,
) -> dict[str, Any] | None:
    """What the device was configured with when this activity was recorded.

    These are settings the athlete entered, not measurements, so they are
    recorded per activity and collapsed into intervals in the derived layer.
    A source carrying neither message yields nothing: GPX never does, and
    neither do the 84 oldest runs in the real export.
    """
    profile = parsed.profile or {}
    zones = parsed.zones or {}
    if not profile and not zones:
        return None

    boundaries = zones.get("hr_zone_high_boundary")
    return {
        "activity_id": activity_id,
        "athlete_id": athlete_id,
        "observed_at": observed_at,
        "weight_kg": _as_float(profile.get("weight")),
        "height_m": _as_float(profile.get("height")),
        "resting_hr_bpm": _as_float(profile.get("resting_heart_rate")),
        "max_hr_bpm": _as_float(zones.get("max_heart_rate")),
        "hr_zone_boundaries": None if boundaries is None else [float(v) for v in boundaries],
        "hr_calc_type": _as_text(zones.get("hr_calc_type")),
    }


def _first(mapping: dict[str, Any], *names: str) -> Any:
    """Value of the first present, non-null key. Prefers enhanced fields."""
    for name in names:
        value = mapping.get(name)
        if value is not None:
            return value
    return None


def _stream_frame(parsed: ParsedActivity) -> pd.DataFrame:
    rows: list[dict[str, Any]] = []
    for record in parsed.records:
        if parsed.source_format == "fit":
            lat = semicircles_to_degrees(record.get("position_lat"))
            lon = semicircles_to_degrees(record.get("position_long"))
            cadence = fit_cadence_to_spm(record.get("cadence"), record.get("fractional_cadence"))
        else:
            lat = record.get("lat_deg")
            lon = record.get("lon_deg")
            cadence = fit_cadence_to_spm(record.get("cadence"))
        rows.append(
            {
                "timestamp_utc": record.get("timestamp"),
                "lat_deg": lat,
                "lon_deg": lon,
                "altitude_m": _first(record, "enhanced_altitude", "altitude", "altitude_m"),
                "distance_m": record.get("distance"),
                "speed_mps": _first(record, "enhanced_speed", "speed"),
                "hr_bpm": record.get("heart_rate"),
                "cadence_spm": cadence,
                "power_w": record.get("power"),
                "temperature_c": record.get("temperature"),
                "moving": record.get("moving"),
            }
        )

    frame = pd.DataFrame(rows, columns=[c for c in STREAM_SCHEMA.names if c != "activity_id"])
    if frame.empty:
        return frame.assign(t_s=pd.Series(dtype="float64"))

    frame["timestamp_utc"] = pd.to_datetime(frame["timestamp_utc"], utc=True)
    frame = frame.sort_values("timestamp_utc").reset_index(drop=True)
    start = frame["timestamp_utc"].iloc[0]
    frame["t_s"] = (frame["timestamp_utc"] - start).dt.total_seconds()

    # GPX has no distance or speed; derive both from the track.
    if frame["distance_m"].isna().all() and frame["lat_deg"].notna().all():
        frame["distance_m"] = cumulative_distance_m(
            frame["lat_deg"].to_numpy(dtype=np.float64),
            frame["lon_deg"].to_numpy(dtype=np.float64),
        )
    # A breathing or bouldering session records neither, and has no speed to derive.
    if frame["speed_mps"].isna().all() and frame["distance_m"].notna().any():
        dt = frame["t_s"].diff()
        dd = frame["distance_m"].diff()
        frame["speed_mps"] = (dd / dt.where(dt > 0)).bfill()

    return frame


def _lap_frame(parsed: ParsedActivity) -> pd.DataFrame:
    rows = []
    for index, lap in enumerate(parsed.laps):
        rows.append(
            {
                "lap_index": index,
                "start_time_utc": lap.get("start_time"),
                "trigger": _as_text(lap.get("lap_trigger")),
                "elapsed_time_s": lap.get("total_elapsed_time"),
                "distance_m": lap.get("total_distance"),
                "avg_speed_mps": _first(lap, "enhanced_avg_speed", "avg_speed"),
                "avg_hr_bpm": lap.get("avg_heart_rate"),
                "max_hr_bpm": lap.get("max_heart_rate"),
                "avg_cadence_spm": fit_cadence_to_spm(
                    _first(lap, "avg_running_cadence", "avg_cadence"),
                    lap.get("avg_fractional_cadence"),
                ),
                "ascent_m": lap.get("total_ascent"),
                "descent_m": lap.get("total_descent"),
                "calories": lap.get("total_calories"),
            }
        )
    columns = [c for c in LAP_SCHEMA.names if c != "activity_id"]
    frame = pd.DataFrame(rows, columns=columns)
    if not frame.empty:
        frame["start_time_utc"] = pd.to_datetime(frame["start_time_utc"], utc=True)
    return frame


def _utc_offset_s(activity_message: dict[str, Any]) -> int | None:
    """The offset the watch was set to, from FIT's ``activity`` message.

    ``local_timestamp`` is the same instant as ``timestamp`` written in the
    athlete's own wall clock, so the difference is the offset. fitdecode
    labels both as UTC, which is wrong for the local one, so both are
    compared naively rather than as instants.

    This is read at the end of the activity, because that is where the
    ``activity`` message sits. A run that crosses a daylight-saving boundary
    is therefore attributed the offset it finished under.

    Null when the source has no such field, which is every GPX file: GPX
    timestamps are UTC and the format records no offset anywhere. Null too
    when the difference falls outside the range real offsets span, because a
    device that writes an undecodable ``local_timestamp`` has not recorded an
    offset either. Storing one would render the run at a fabricated wall clock
    with nothing to mark it as wrong, where null renders it as UTC and says so.
    """
    utc = activity_message.get("timestamp")
    local = activity_message.get("local_timestamp")
    if not isinstance(utc, datetime) or not isinstance(local, datetime):
        return None
    offset_s = round((local.replace(tzinfo=None) - utc.replace(tzinfo=None)).total_seconds())
    if not MIN_UTC_OFFSET_S <= offset_s <= MAX_UTC_OFFSET_S:
        return None
    return offset_s


def _summarise(session: dict[str, Any], streams: pd.DataFrame) -> dict[str, Any]:
    """Session values, falling back to the stream when there is no session."""
    if session:
        return {
            "sport": _as_text(session.get("sport")),
            "sub_sport": _as_text(session.get("sub_sport")),
            "start_time_utc": session.get("start_time"),
            "elapsed_time_s": session.get("total_elapsed_time"),
            "timer_time_s": session.get("total_timer_time"),
            "distance_m": session.get("total_distance"),
            "ascent_m": session.get("total_ascent"),
            "descent_m": session.get("total_descent"),
            "avg_speed_mps": _first(session, "enhanced_avg_speed", "avg_speed"),
            "max_speed_mps": _first(session, "enhanced_max_speed", "max_speed"),
            "avg_hr_bpm": session.get("avg_heart_rate"),
            "max_hr_bpm": session.get("max_heart_rate"),
            "avg_cadence_spm": fit_cadence_to_spm(
                _first(session, "avg_running_cadence", "avg_cadence"),
                session.get("avg_fractional_cadence"),
            ),
            "calories": session.get("total_calories"),
        }

    if streams.empty:
        raise ValueError("cannot summarise an activity with no session and no stream data")

    altitude = streams["altitude_m"].dropna()
    climbs = altitude.diff()
    return {
        "sport": None,
        "sub_sport": None,
        "start_time_utc": streams["timestamp_utc"].iloc[0].to_pydatetime(),
        "elapsed_time_s": float(streams["t_s"].iloc[-1]),
        "timer_time_s": None,
        "distance_m": float(streams["distance_m"].iloc[-1]),
        "ascent_m": float(climbs[climbs > 0].sum()) if not climbs.empty else None,
        "descent_m": float(-climbs[climbs < 0].sum()) if not climbs.empty else None,
        "avg_speed_mps": float(streams["speed_mps"].mean()),
        "max_speed_mps": float(streams["speed_mps"].max()),
        "avg_hr_bpm": float(streams["hr_bpm"].mean()) if streams["hr_bpm"].notna().any() else None,
        "max_hr_bpm": float(streams["hr_bpm"].max()) if streams["hr_bpm"].notna().any() else None,
        "avg_cadence_spm": (
            float(streams["cadence_spm"].mean()) if streams["cadence_spm"].notna().any() else None
        ),
        "calories": None,
    }


def normalize(
    parsed: ParsedActivity,
    *,
    source: str,
    source_file: str,
    source_file_sha256: str,
    athlete_id: str,
    ingested_at: datetime,
) -> NormalizedActivity:
    """Convert a parsed source file into canonical activity, laps and streams."""
    streams = _stream_frame(parsed)
    summary = _summarise(parsed.session, streams)

    start_time = pd.Timestamp(summary["start_time_utc"]).tz_convert("UTC").to_pydatetime()
    # Provisional. The pipeline reconciles it against what is already stored.
    activity_id = compute_activity_id(athlete_id, start_time)

    activity = Activity(
        activity_id=activity_id,
        athlete_id=athlete_id,
        source=source,
        source_file=source_file,
        source_file_sha256=source_file_sha256,
        start_time_utc=start_time,
        utc_offset_s=_utc_offset_s(parsed.activity_message),
        name=_as_text(parsed.name),
        moving_time_s=summary.get("timer_time_s"),
        device_manufacturer=_as_text(parsed.device.get("manufacturer")),
        device_product=_as_text(parsed.device.get("garmin_product")),
        ingested_at=ingested_at,
        ingest_version=INGEST_VERSION,
        **{
            k: summary[k]
            for k in (
                "sport",
                "sub_sport",
                "elapsed_time_s",
                "timer_time_s",
                "distance_m",
                "ascent_m",
                "descent_m",
                "avg_speed_mps",
                "max_speed_mps",
                "avg_hr_bpm",
                "max_hr_bpm",
                "avg_cadence_spm",
                "calories",
            )
        },
    )

    laps = _lap_frame(parsed)
    laps.insert(0, "activity_id", activity_id)
    streams.insert(0, "activity_id", activity_id)
    return NormalizedActivity(
        activity=activity,
        laps=laps[LAP_SCHEMA.names],
        streams=streams[STREAM_SCHEMA.names],
        profile_observation=_profile_observation(
            parsed,
            activity_id=activity_id,
            athlete_id=athlete_id,
            observed_at=start_time,
        ),
    )
