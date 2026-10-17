import pandas as pd
import pyarrow as pa

from activity_analysis.models import (
    ACTIVITY_METRICS_SCHEMA,
    ACTIVITY_SCHEMA,
    ATHLETE_PROFILE_SCHEMA,
    BEST_EFFORT_SCHEMA,
    GRID_SCHEMA,
    LAP_SCHEMA,
    LEDGER_SCHEMA,
    PROFILE_OBSERVATION_SCHEMA,
    SOURCE_GPX,
    SOURCE_PRIORITY,
    SOURCE_STRAVA_FIT,
    STREAM_SCHEMA,
    ZONE_TIME_SCHEMA,
    Activity,
    empty_frame,
)


def test_fit_outranks_gpx():
    assert SOURCE_PRIORITY[SOURCE_STRAVA_FIT] > SOURCE_PRIORITY[SOURCE_GPX]


def test_garmin_fit_is_the_highest_priority_source():
    assert max(SOURCE_PRIORITY, key=lambda k: SOURCE_PRIORITY[k]) == "garmin_fit"


def test_activity_dataclass_fields_match_the_arrow_schema():
    from dataclasses import fields

    assert [f.name for f in fields(Activity)] == ACTIVITY_SCHEMA.names


def test_timestamps_are_utc_microsecond():
    for schema, column in [
        (ACTIVITY_SCHEMA, "start_time_utc"),
        (LAP_SCHEMA, "start_time_utc"),
        (STREAM_SCHEMA, "timestamp_utc"),
    ]:
        assert schema.field(column).type == pa.timestamp("us", tz="UTC")


def test_streams_carry_no_pace_column():
    # Pace is a presentation concern. Storing it would invite unit drift.
    assert not any("pace" in name for name in STREAM_SCHEMA.names)


def test_empty_frame_has_schema_columns_and_no_rows():
    frame = empty_frame(LEDGER_SCHEMA)
    assert isinstance(frame, pd.DataFrame)
    assert list(frame.columns) == LEDGER_SCHEMA.names
    assert len(frame) == 0


def test_grid_schema_carries_the_gap_flags_and_no_derived_speed_columns():
    assert GRID_SCHEMA.names == [
        "activity_id",
        "t_s",
        "timestamp_utc",
        "lat_deg",
        "lon_deg",
        "altitude_m",
        "distance_m",
        "speed_mps",
        "hr_bpm",
        "cadence_spm",
        "paused",
        "outage",
    ]
    assert GRID_SCHEMA.field("paused").type == pa.bool_()
    assert GRID_SCHEMA.field("outage").type == pa.bool_()


def test_zone_boundaries_are_a_list_because_zone_count_is_device_defined():
    assert PROFILE_OBSERVATION_SCHEMA.field("hr_zone_boundaries").type == pa.list_(pa.float64())
    assert ATHLETE_PROFILE_SCHEMA.field("hr_zone_boundaries").type == pa.list_(pa.float64())


def test_every_new_schema_makes_an_empty_frame():
    for schema in (
        GRID_SCHEMA,
        BEST_EFFORT_SCHEMA,
        ZONE_TIME_SCHEMA,
        ACTIVITY_METRICS_SCHEMA,
        ATHLETE_PROFILE_SCHEMA,
        PROFILE_OBSERVATION_SCHEMA,
    ):
        assert list(empty_frame(schema).columns) == schema.names
