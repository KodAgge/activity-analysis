from datetime import UTC, datetime
from pathlib import Path

import pytest

from activity_analysis.ingest.fit_reader import read_fit
from activity_analysis.ingest.gpx_reader import read_gpx
from activity_analysis.ingest.normalize import normalize
from activity_analysis.ingest.parsed import ParsedActivity
from activity_analysis.models import LAP_SCHEMA, SOURCE_GPX, SOURCE_STRAVA_FIT, STREAM_SCHEMA

INGESTED_AT = datetime(2026, 8, 29, 12, 0, 0, tzinfo=UTC)


def _normalize_fit(path: Path):
    return normalize(
        read_fit(path),
        source=SOURCE_STRAVA_FIT,
        source_file=path.name,
        source_file_sha256="deadbeef",
        athlete_id="default",
        ingested_at=INGESTED_AT,
    )


def test_activity_summary_is_canonical(reference_fit: Path):
    activity = _normalize_fit(reference_fit).activity
    assert activity.sport == "running"
    assert activity.start_time_utc == datetime(2026, 8, 28, 18, 19, 14, tzinfo=UTC)
    assert activity.distance_m == pytest.approx(7456.06)
    assert activity.elapsed_time_s == pytest.approx(2931.205)
    assert activity.avg_speed_mps == pytest.approx(2.544)
    assert activity.max_hr_bpm == 172
    assert activity.ascent_m == pytest.approx(56)
    assert activity.device_product == "venu2_plus"
    assert activity.ingest_version == 3


def test_session_cadence_is_converted_to_steps_per_minute(reference_fit: Path):
    # The session records 81 rpm plus an avg_fractional_cadence of 0.375,
    # so 81.375 rpm for one foot, so 162.75 steps per minute.
    assert _normalize_fit(reference_fit).activity.avg_cadence_spm == pytest.approx(162.75)


def test_streams_match_the_schema_and_row_count(reference_fit: Path):
    streams = _normalize_fit(reference_fit).streams
    assert list(streams.columns) == STREAM_SCHEMA.names
    assert len(streams) == 626


def test_stream_coordinates_are_degrees(reference_fit: Path):
    first = _normalize_fit(reference_fit).streams.iloc[0]
    assert first["lat_deg"] == pytest.approx(57.7708879, abs=1e-7)
    assert first["lon_deg"] == pytest.approx(14.1830235, abs=1e-7)


def test_stream_cadence_is_steps_per_minute(reference_fit: Path):
    # First record is 50 rpm with a 0.5 fractional part.
    assert _normalize_fit(reference_fit).streams.iloc[0]["cadence_spm"] == pytest.approx(101.0)


def test_elapsed_seconds_start_at_zero_and_increase(reference_fit: Path):
    t = _normalize_fit(reference_fit).streams["t_s"]
    assert t.iloc[0] == 0.0
    assert t.is_monotonic_increasing
    assert t.iloc[-1] == pytest.approx(2931.0, abs=1.0)


def test_laps_match_the_schema(reference_fit: Path):
    laps = _normalize_fit(reference_fit).laps
    assert list(laps.columns) == LAP_SCHEMA.names
    assert len(laps) == 8
    assert laps["lap_index"].tolist() == list(range(8))
    assert laps.iloc[0]["distance_m"] == pytest.approx(1000.0)
    assert laps.iloc[0]["trigger"] == "distance"
    # 81 rpm plus an avg_fractional_cadence of 0.0546875.
    assert laps.iloc[0]["avg_cadence_spm"] == pytest.approx(162.109375)


def test_gpx_derives_distance_from_coordinates(reference_gpx: Path):
    result = normalize(
        read_gpx(reference_gpx),
        source=SOURCE_GPX,
        source_file=reference_gpx.name,
        source_file_sha256="cafebabe",
        athlete_id="default",
        ingested_at=INGESTED_AT,
    )
    # The device-measured FIT distance is 7456.06 m; derived must be close.
    assert result.activity.distance_m == pytest.approx(7456.06, rel=0.005)
    assert result.activity.start_time_utc == datetime(2026, 8, 28, 18, 19, 14, tzinfo=UTC)
    assert len(result.streams) == 626
    assert result.laps.empty


def test_fit_and_gpx_of_the_same_run_share_an_identity(reference_fit: Path, reference_gpx: Path):
    from_fit = _normalize_fit(reference_fit).activity
    from_gpx = normalize(
        read_gpx(reference_gpx),
        source=SOURCE_GPX,
        source_file=reference_gpx.name,
        source_file_sha256="cafebabe",
        athlete_id="default",
        ingested_at=INGESTED_AT,
    ).activity
    assert from_fit.activity_id == from_gpx.activity_id


def test_unnamed_enum_values_become_text(reference_fit: Path):
    # fitdecode returns the raw integer for an enum value it cannot name, and
    # a full export contains plenty of them: strength training sports, lap
    # triggers from other devices. The canonical schema says these are strings.
    parsed = read_fit(reference_fit)
    parsed.session["sport"] = 10
    parsed.session["sub_sport"] = 20
    parsed.laps[0]["lap_trigger"] = 7
    parsed.device["manufacturer"] = 294

    result = normalize(
        parsed,
        source=SOURCE_STRAVA_FIT,
        source_file="x.fit",
        source_file_sha256="deadbeef",
        athlete_id="default",
        ingested_at=INGESTED_AT,
    )
    assert result.activity.sport == "10"
    assert result.activity.sub_sport == "20"
    assert result.activity.device_manufacturer == "294"
    assert result.laps.iloc[0]["trigger"] == "7"


def test_normalize_emits_a_profile_observation(reference_fit: Path):
    normalized = _normalize_fit(reference_fit)
    observation = normalized.profile_observation
    assert observation is not None
    assert observation["weight_kg"] == pytest.approx(70.0)
    assert observation["height_m"] == pytest.approx(1.75)
    assert observation["resting_hr_bpm"] == pytest.approx(67.0)
    assert observation["max_hr_bpm"] == pytest.approx(207.0)
    assert observation["hr_zone_boundaries"] == [104.0, 124.0, 145.0, 166.0, 186.0, 207.0]
    assert observation["observed_at"] == normalized.activity.start_time_utc
    assert observation["activity_id"] == normalized.activity.activity_id


def test_a_source_with_no_profile_messages_emits_no_observation(reference_gpx: Path):
    # GPX carries no athlete profile at all, and neither do the 84 oldest runs
    # in the real export. Absence is normal and must not be invented.
    normalized = normalize(
        read_gpx(reference_gpx),
        source=SOURCE_GPX,
        source_file=reference_gpx.name,
        source_file_sha256="cafe",
        athlete_id="default",
        ingested_at=INGESTED_AT,
    )
    assert normalized.profile_observation is None


def test_a_negative_utc_offset_survives_normalisation():
    """The whole point of the column is runs recorded away from the usual zone.

    15 of the athlete's 307 runs were recorded outside his usual band of
    offsets, most of them west of it, so a westward offset is the case that
    matters, and it is the one no fixture covers: all five were recorded in
    Swedish summer time.
    """
    parsed = ParsedActivity(
        source_format="fit",
        session={"start_time": datetime(2026, 3, 10, 20, 0, 0, tzinfo=UTC), "sport": "running"},
        activity_message={
            "timestamp": datetime(2026, 3, 10, 20, 40, 0, tzinfo=UTC),
            # fitdecode labels the local one UTC too. It is wall-clock time.
            "local_timestamp": datetime(2026, 3, 10, 12, 40, 0, tzinfo=UTC),
        },
        records=[
            {"timestamp": datetime(2026, 3, 10, 20, 0, 0, tzinfo=UTC), "distance": 0.0},
            {"timestamp": datetime(2026, 3, 10, 20, 0, 1, tzinfo=UTC), "distance": 3.0},
        ],
    )

    result = normalize(
        parsed,
        source=SOURCE_STRAVA_FIT,
        source_file="run.fit",
        source_file_sha256="0" * 64,
        athlete_id="default",
        ingested_at=datetime(2026, 8, 30, tzinfo=UTC),
    )

    assert result.activity.utc_offset_s == -8 * 3600


def test_an_undecodable_local_timestamp_is_no_offset_at_all():
    """A difference that cannot be an offset must not be stored as one.

    A device that writes a ``local_timestamp`` decoding to the FIT epoch gives
    a difference of some 36 years. It survives both type checks and fits in
    int32, so nothing downstream would question it, and the listing would
    render the run in 1990 with no marker. Null instead sends it down the same
    path as a source that recorded no offset, which is shown as UTC and said
    to be UTC.
    """
    parsed = ParsedActivity(
        source_format="fit",
        session={"start_time": datetime(2026, 8, 28, 18, 19, 14, tzinfo=UTC), "sport": "running"},
        activity_message={
            "timestamp": datetime(2026, 8, 28, 19, 8, 5, tzinfo=UTC),
            "local_timestamp": datetime(1989, 12, 31, 0, 0, 0, tzinfo=UTC),
        },
        records=[
            {"timestamp": datetime(2026, 8, 28, 18, 19, 14, tzinfo=UTC), "distance": 0.0},
            {"timestamp": datetime(2026, 8, 28, 18, 19, 15, tzinfo=UTC), "distance": 3.0},
        ],
    )

    result = normalize(
        parsed,
        source=SOURCE_STRAVA_FIT,
        source_file="run.fit",
        source_file_sha256="0" * 64,
        athlete_id="default",
        ingested_at=datetime(2026, 8, 30, tzinfo=UTC),
    )

    assert result.activity.utc_offset_s is None


def test_an_activity_that_records_no_distance_normalises(garmin_breathing_fit: Path):
    # A breathing session, like a bouldering one, records heart rate with
    # neither distance nor position. Deriving speed from a distance column
    # that is entirely null once failed every such file.
    normalized = _normalize_fit(garmin_breathing_fit)
    assert normalized.activity.sport == "training"
    assert normalized.activity.distance_m is None
    assert normalized.streams["distance_m"].isna().all()
    assert normalized.streams["speed_mps"].isna().all()
    assert normalized.streams["hr_bpm"].notna().any()
