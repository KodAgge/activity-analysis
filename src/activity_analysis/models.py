"""Canonical data model.

Everything here is SI. Pace, formatted local times and imperial units are
presentation concerns handled at the API boundary or in the frontend.

``utc_offset_s`` is the exception that proves the rule: it is not a rendering
of anything, it is a fact the device recorded and the only evidence of what
time of day a run happened. Storing it is what lets the boundary format a
local time instead of guessing one from the reader's own clock.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

import pandas as pd
import pyarrow as pa

from activity_analysis.config import INGEST_VERSION

SOURCE_GARMIN_FIT = "garmin_fit"
SOURCE_STRAVA_FIT = "strava_fit"
SOURCE_GPX = "gpx"

#: Higher wins when two source files resolve to the same activity identity.
SOURCE_PRIORITY: dict[str, int] = {
    SOURCE_GARMIN_FIT: 3,
    SOURCE_STRAVA_FIT: 2,
    SOURCE_GPX: 1,
}

_TS = pa.timestamp("us", tz="UTC")


@dataclass
class Activity:
    """One recorded session. Field order matches ACTIVITY_SCHEMA."""

    activity_id: str
    athlete_id: str
    source: str
    source_file: str
    source_file_sha256: str
    start_time_utc: datetime
    utc_offset_s: int | None = None
    sport: str | None = None
    sub_sport: str | None = None
    name: str | None = None
    elapsed_time_s: float | None = None
    timer_time_s: float | None = None
    moving_time_s: float | None = None
    distance_m: float | None = None
    ascent_m: float | None = None
    descent_m: float | None = None
    avg_speed_mps: float | None = None
    max_speed_mps: float | None = None
    avg_hr_bpm: float | None = None
    max_hr_bpm: float | None = None
    avg_cadence_spm: float | None = None
    calories: float | None = None
    device_manufacturer: str | None = None
    device_product: str | None = None
    ingested_at: datetime | None = None
    ingest_version: int = INGEST_VERSION


ACTIVITY_SCHEMA = pa.schema(
    [
        ("activity_id", pa.string()),
        ("athlete_id", pa.string()),
        ("source", pa.string()),
        ("source_file", pa.string()),
        ("source_file_sha256", pa.string()),
        ("start_time_utc", _TS),
        ("utc_offset_s", pa.int32()),
        ("sport", pa.string()),
        ("sub_sport", pa.string()),
        ("name", pa.string()),
        ("elapsed_time_s", pa.float64()),
        ("timer_time_s", pa.float64()),
        ("moving_time_s", pa.float64()),
        ("distance_m", pa.float64()),
        ("ascent_m", pa.float64()),
        ("descent_m", pa.float64()),
        ("avg_speed_mps", pa.float64()),
        ("max_speed_mps", pa.float64()),
        ("avg_hr_bpm", pa.float64()),
        ("max_hr_bpm", pa.float64()),
        ("avg_cadence_spm", pa.float64()),
        ("calories", pa.float64()),
        ("device_manufacturer", pa.string()),
        ("device_product", pa.string()),
        ("ingested_at", _TS),
        ("ingest_version", pa.int32()),
    ]
)

LAP_SCHEMA = pa.schema(
    [
        ("activity_id", pa.string()),
        ("lap_index", pa.int32()),
        ("start_time_utc", _TS),
        ("trigger", pa.string()),
        ("elapsed_time_s", pa.float64()),
        ("distance_m", pa.float64()),
        ("avg_speed_mps", pa.float64()),
        ("avg_hr_bpm", pa.float64()),
        ("max_hr_bpm", pa.float64()),
        ("avg_cadence_spm", pa.float64()),
        ("ascent_m", pa.float64()),
        ("descent_m", pa.float64()),
        ("calories", pa.float64()),
    ]
)

STREAM_SCHEMA = pa.schema(
    [
        ("activity_id", pa.string()),
        ("t_s", pa.float64()),
        ("timestamp_utc", _TS),
        ("lat_deg", pa.float64()),
        ("lon_deg", pa.float64()),
        ("altitude_m", pa.float64()),
        ("distance_m", pa.float64()),
        ("speed_mps", pa.float64()),
        ("hr_bpm", pa.float64()),
        ("cadence_spm", pa.float64()),
        ("power_w", pa.float64()),
        ("temperature_c", pa.float64()),
        ("moving", pa.bool_()),
    ]
)

#: The 1 Hz derived grid. One row per second of elapsed time, including
#: seconds spent standing still: the clock never stops, so best-effort
#: windows can span a pause. Across a gap `distance_m` interpolates and the
#: measured channels are null; `paused` and `outage` say which kind of gap.
GRID_SCHEMA = pa.schema(
    [
        ("activity_id", pa.string()),
        ("t_s", pa.float64()),
        ("timestamp_utc", _TS),
        ("lat_deg", pa.float64()),
        ("lon_deg", pa.float64()),
        ("altitude_m", pa.float64()),
        ("distance_m", pa.float64()),
        ("speed_mps", pa.float64()),
        ("hr_bpm", pa.float64()),
        ("cadence_spm", pa.float64()),
        ("paused", pa.bool_()),
        ("outage", pa.bool_()),
    ]
)

BEST_EFFORT_SCHEMA = pa.schema(
    [
        ("activity_id", pa.string()),
        ("distance_key", pa.string()),
        ("distance_m", pa.float64()),
        ("elapsed_time_s", pa.float64()),
        ("start_t_s", pa.float64()),
        ("end_t_s", pa.float64()),
        ("avg_hr_bpm", pa.float64()),
        ("contains_pause", pa.bool_()),
        ("contains_outage", pa.bool_()),
        ("contains_jump", pa.bool_()),
        ("speed_distance_m", pa.float64()),
        ("distance_trusted", pa.bool_()),
        ("analysis_version", pa.int32()),
    ]
)

#: Long rather than wide: a week's zone distribution is a GROUP BY, and the
#: number of zones is a device setting rather than a constant.
ZONE_TIME_SCHEMA = pa.schema(
    [
        ("activity_id", pa.string()),
        ("zone_index", pa.int32()),
        ("low_bpm", pa.float64()),
        ("high_bpm", pa.float64()),
        ("seconds_s", pa.float64()),
        ("analysis_version", pa.int32()),
    ]
)

#: Derived. One row per tag, so an activity can carry an exclusive effort
#: classification and any number of additive flags without parallel list
#: columns that can fall out of step with each other.
ACTIVITY_TAG_SCHEMA = pa.schema(
    [
        ("activity_id", pa.string()),
        #: "effort" for the exclusive classification, "flag" for an additive fact.
        ("kind", pa.string()),
        ("tag", pa.string()),
        #: The best-effort distance a "pr" row fired at, so a run that records
        #: at five distances carries five distinguishable rows. Null on every
        #: tag that is not about one distance.
        ("distance_key", pa.string()),
        #: The rep count an "intervals" effort row fired at, so a client does
        #: not have to parse it out of "reason". Null on every tag that is
        #: not an "intervals" effort.
        ("rep_count", pa.int32()),
        #: The raw per-lap "R"/"W"/"-" pattern `interval_reps` found, in
        #: recorded order, one character per lap - added ANALYSIS_VERSION 4.
        #: Lets a client colour individual recorded laps without recomputing
        #: analysis.tags's own cadence-and-pace classification. Null on
        #: every tag that is not an "intervals" effort, and on every row
        #: written before this column existed.
        ("rep_pattern", pa.string()),
        #: The numbers that fired it. A classifier whose reasoning is hidden
        #: stops being trusted the first time it is wrong.
        ("reason", pa.string()),
        ("analysis_version", pa.int32()),
    ]
)

ACTIVITY_METRICS_SCHEMA = pa.schema(
    [
        ("activity_id", pa.string()),
        ("elapsed_time_s", pa.float64()),
        ("moving_time_s", pa.float64()),
        ("paused_time_s", pa.float64()),
        ("distance_m", pa.float64()),
        #: The canonical ``activities.distance_m`` over the
        #: ``moving_time_s`` above, null rather than zero unless both are
        #: strictly positive.
        #:
        #: **Not this table's own ``distance_m``**, which sits one line up and
        #: is the grid's odometer. On a treadmill run the stream's distance is
        #: a footpod estimate and the session total is the authoritative
        #: figure, the maintainer's ruling of 2026-09-12, so the two are
        #: deliberately not a matched pair and dividing one by the other does
        #: not give this column back. See docs/reference/math/units.md.
        #:
        #: This project's own rather than the device's: the canonical
        #: ``activities.avg_speed_mps`` is null on 224 of the 307 real runs
        #: because the device began writing it only in late January 2026, and
        #: where it exists it is an average over the device's own auto-paused
        #: timer rather than over this project's moving time.
        ("avg_speed_mps", pa.float64()),
        ("ascent_per_km_m", pa.float64()),
        ("is_indoor", pa.bool_()),
        ("has_hr", pa.bool_()),
        ("has_gps", pa.bool_()),
        ("is_gpx_sourced", pa.bool_()),
        #: Where the activity started, resolved offline from its first fixed
        #: position against the bundled GeoNames extract - see
        #: ``analysis/places.py``. All four are null together for an activity
        #: with no position at all: every indoor run, and any other whose grid
        #: has no coordinates - 86 of the 307 real ones together.
        ("locality", pa.string()),
        ("country_code", pa.string()),
        ("country", pa.string()),
        #: How far the start was from the place named above. Kept because a
        #: match is not always close - the worst on the real history is
        #: 27.9 km, a remote start with nothing closer in the table - so a
        #: consumer can name the place, name only the country, or say
        #: nothing, rather than having that choice made silently in the
        #: derived layer.
        ("locality_distance_m", pa.float64()),
        #: Local calendar days from the previous running activity's start to
        #: this one's, null for the first run in the history. Whole-history
        #: and instant-ordered, so a filtered read must not recompute it -
        #: see ``analysis/rest_days.py`` and
        #: ``docs/reference/math/rest-days.md``.
        ("days_since_previous_run", pa.int32()),
        ("analysis_version", pa.int32()),
    ]
)

#: Canonical. What the device was configured with when one activity was
#: recorded. These are settings the athlete entered, not measurements.
PROFILE_OBSERVATION_SCHEMA = pa.schema(
    [
        ("activity_id", pa.string()),
        ("athlete_id", pa.string()),
        ("observed_at", _TS),
        ("weight_kg", pa.float64()),
        ("height_m", pa.float64()),
        ("resting_hr_bpm", pa.float64()),
        ("max_hr_bpm", pa.float64()),
        ("hr_zone_boundaries", pa.list_(pa.float64())),
        ("hr_calc_type", pa.string()),
    ]
)

#: Canonical. Garmin's own running VO2max, one row per athlete and calendar
#: day, from a Garmin export's MaxMet files. ``updated_at`` is Garmin's
#: ``updateTimestamp``, which states no zone, so it carries none.
DEVICE_VO2MAX_SCHEMA = pa.schema(
    [
        ("athlete_id", pa.string()),
        ("calendar_date", pa.date32()),
        ("vo2max", pa.float64()),
        ("vo2max_reported", pa.int64()),
        ("device_id", pa.string()),
        ("updated_at", pa.timestamp("us")),
        ("source_file_sha256", pa.string()),
    ]
)

#: Derived. Consecutive identical observations collapsed into one interval.
#: `effective_to` is null for the interval still in force.
ATHLETE_PROFILE_SCHEMA = pa.schema(
    [
        ("athlete_id", pa.string()),
        ("effective_from", _TS),
        ("effective_to", _TS),
        ("weight_kg", pa.float64()),
        ("height_m", pa.float64()),
        ("resting_hr_bpm", pa.float64()),
        ("max_hr_bpm", pa.float64()),
        ("hr_zone_boundaries", pa.list_(pa.float64())),
        ("hr_calc_type", pa.string()),
        ("analysis_version", pa.int32()),
    ]
)

#: Derived. One row per activity that carried enough signal to fit.
#:
#: Three reference paces rather than one because a single shared slope makes
#: more than one reference redundant: the values would differ by a constant
#: identical for every activity. Each activity's own slope is kept, shrunk
#: toward the shared one by its own precision, so the gap between the slow
#: and fast columns varies run to run and is a real measurement.
ACTIVITY_EFFICIENCY_SCHEMA = pa.schema(
    [
        ("activity_id", pa.string()),
        #: The session classification this row was fitted under, copied from
        #: activity_tags so a consumer can narrow the trend without a join.
        ("effort_tag", pa.string()),
        #: The activity's own OLS slope, before shrinkage. Kept so a reader
        #: can see how far shrinkage moved it.
        ("hr_slope_own_bpm_per_mps", pa.float64()),
        #: Moving-block bootstrap, NOT ordinary least squares. Consecutive
        #: grid seconds are autocorrelated and the OLS error is about eight
        #: times too small, which would drive every weight to 1.
        ("hr_slope_se_bpm_per_mps", pa.float64()),
        #: tau^2 / (tau^2 + se^2). Zero means the activity took the shared
        #: slope entirely, which is what a run held at one pace should do.
        ("hr_slope_weight", pa.float64()),
        ("hr_slope_shrunk_bpm_per_mps", pa.float64()),
        ("hr_at_slow_bpm", pa.float64()),
        ("hr_at_median_bpm", pa.float64()),
        ("hr_at_fast_bpm", pa.float64()),
        #: Trailing 42-day means of the three columns above. The raw values
        #: are 3.4 times noisier than the gap between the three references, so
        #: only the smoothed form is readable as three separate series.
        #: See docs/reference/math/efficiency.md.
        ("hr_at_slow_smoothed_bpm", pa.float64()),
        ("hr_at_median_smoothed_bpm", pa.float64()),
        ("hr_at_fast_smoothed_bpm", pa.float64()),
        ("cadence_slope_own_spm_per_mps", pa.float64()),
        ("cadence_slope_se_spm_per_mps", pa.float64()),
        ("cadence_slope_weight", pa.float64()),
        ("cadence_slope_shrunk_spm_per_mps", pa.float64()),
        ("cadence_at_slow_spm", pa.float64()),
        ("cadence_at_median_spm", pa.float64()),
        ("cadence_at_fast_spm", pa.float64()),
        #: Trailing 42-day means of the three columns above, for the same
        #: reason the heart rate ones have them.
        ("cadence_at_slow_smoothed_spm", pa.float64()),
        ("cadence_at_median_smoothed_spm", pa.float64()),
        ("cadence_at_fast_smoothed_spm", pa.float64()),
        #: First-half efficiency against second-half, as a percentage change.
        #: Positive means the second half cost more heart rate per unit
        #: speed, which is the usual direction.
        ("decoupling_pct", pa.float64()),
        #: The mean speed and mean heart rate of each half of the seconds
        #: decoupling_pct compares, so a reader can see which of the two
        #: moved: the percentage rises when heart rate climbs and also when
        #: pace drops. Null together with decoupling_pct.
        ("decoupling_first_speed_mps", pa.float64()),
        ("decoupling_second_speed_mps", pa.float64()),
        ("decoupling_first_hr_bpm", pa.float64()),
        ("decoupling_second_hr_bpm", pa.float64()),
        #: Whether this run is in the population decoupling is interpretable
        #: over: an easy or steady run of at least 40 fitted minutes.
        ("is_aerobic_long_run", pa.bool_()),
        #: Trailing 90-day mean of decoupling over that population only, so
        #: null on every run outside it.
        ("decoupling_smoothed_pct", pa.float64()),
        #: Seconds that survived every filter and entered the fit, so a
        #: consumer can tell a fit over 40 minutes from one over 6.
        ("fit_seconds", pa.int32()),
        ("analysis_version", pa.int32()),
    ]
)

#: Derived, and whole-history: one row, rewritten on every recompute.
#:
#: These are properties of the athlete rather than of any activity, and they
#: are stored rather than recomputed at read time so that every stored
#: efficiency row says which fit it was measured against. They drift as
#: history grows, which is why the analysis version travels with them.
ATHLETE_FIT_SCHEMA = pa.schema(
    [
        ("ref_slow_mps", pa.float64()),
        ("ref_median_mps", pa.float64()),
        ("ref_fast_mps", pa.float64()),
        ("hr_slope_shared_bpm_per_mps", pa.float64()),
        #: Between-activity standard deviation of true slopes, the numerator
        #: of the shrinkage weight. Floored at zero.
        ("hr_slope_tau", pa.float64()),
        ("cadence_slope_shared_spm_per_mps", pa.float64()),
        ("cadence_slope_tau", pa.float64()),
        ("activities_in_fit", pa.int32()),
        ("analysis_version", pa.int32()),
    ]
)

#: Derived. One row per activity that produced at least one VO2max estimate.
#:
#: Both methods live in one table rather than two because they are indexed
#: identically and are read together on one chart. A run may carry one, the
#: other or both: the heart rate estimate needs a qualifying intensity and a
#: known maximum heart rate, while VDOT needs an eligible best effort, and
#: those are different sets. 84 early runs have no heart rate at all.
FITNESS_SERIES_SCHEMA = pa.schema(
    [
        ("activity_id", pa.string()),
        ("start_time_utc", _TS),
        #: Garmin's method. Null when the run did not qualify.
        ("hr_vo2max", pa.float64()),
        #: Trailing 42-day mean of hr_vo2max. This is the reported number;
        #: the raw column above is what a chart draws faintly underneath.
        ("hr_vo2max_smoothed", pa.float64()),
        #: The best VDOT among this activity's eligible best efforts.
        ("vdot", pa.float64()),
        #: The distance key that VDOT came from, so a reader can see whether
        #: a peak came from a 400 m or a half marathon.
        ("vdot_distance_key", pa.string()),
        ("vdot_smoothed", pa.float64()),
        #: Qualifying 30 s segments behind hr_vo2max, so a consumer can tell
        #: an estimate from 10 minutes of data from one from an hour.
        ("qualifying_segments", pa.int32()),
        ("analysis_version", pa.int32()),
    ]
)

#: Derived. One row per recurring route, grouped by ``analysis.routes.group_routes``.
ROUTE_SCHEMA = pa.schema(
    [
        #: The earliest run's activity_id, so the id holds as later runs join.
        ("route_id", pa.string()),
        #: Place and median distance, "Jönköping 7.4 km", with " A"/" B" on a collision.
        ("name", pa.string()),
        ("locality", pa.string()),
        ("run_count", pa.int32()),
        #: The medoid run, drawn on the map. Direction is against the earliest run.
        ("reference_activity_id", pa.string()),
        ("median_distance_m", pa.float64()),
        ("first_run_utc", _TS),
        ("last_run_utc", _TS),
        ("analysis_version", pa.int32()),
    ]
)

#: Derived. One row per run that belongs to a route.
ROUTE_RUN_SCHEMA = pa.schema(
    [
        ("route_id", pa.string()),
        ("activity_id", pa.string()),
        ("start_time_utc", _TS),
        ("distance_m", pa.float64()),
        ("elapsed_time_s", pa.float64()),
        #: distance over elapsed time, spanning pauses. Pace is never stored.
        ("speed_mps", pa.float64()),
        #: "forward" or "reverse" against the earliest run, the route_id run.
        ("direction", pa.string()),
        ("eligible", pa.bool_()),
        ("ineligible_reason", pa.string()),
        #: 1 for the fastest eligible run; null when ineligible.
        ("rank", pa.int32()),
        #: The fastest eligible run so far when it was run, the first included.
        ("is_record", pa.bool_()),
        ("mean_distance_m", pa.float64()),
        ("worst_distance_m", pa.float64()),
        ("analysis_version", pa.int32()),
    ]
)

#: Derived. One row per outdoor GPS running activity, in start-time order:
#: whether it closed a loop and, if so, the ground it claimed. Areas are
#: ellipsoidal square metres; km^2 is presentation.
TERRITORY_CLAIM_SCHEMA = pa.schema(
    [
        ("activity_id", pa.string()),
        ("start_time_utc", _TS),
        #: Metres from the last finite position to the first. Null without a track.
        ("closure_m", pa.float64()),
        #: closure_m at most CLOSURE_MAX_M, 200 m.
        ("closes_loop", pa.bool_()),
        #: The region the run claimed ground in; null when it claimed none.
        ("region_id", pa.string()),
        #: The ground the closed track encloses, slivers removed. Null when no loop.
        ("enclosed_m2", pa.float64()),
        #: The sliver area the opening removed from the enclosed faces.
        ("sliver_m2", pa.float64()),
        #: Of enclosed_m2, the part no earlier run had claimed.
        ("new_m2", pa.float64()),
        #: All ground claimed so far, this run included. Null when no loop.
        ("cumulative_m2", pa.float64()),
        ("analysis_version", pa.int32()),
    ]
)

#: Derived. One row per region: claimed ground whose runs' boxes lie within
#: REGION_GAP_M, 50 km, of each other, linked run to run.
TERRITORY_REGION_SCHEMA = pa.schema(
    [
        #: The earliest claiming run's activity_id.
        ("region_id", pa.string()),
        #: The locality most of its runs started in, " A"/" B" on a collision.
        ("name", pa.string()),
        ("locality", pa.string()),
        ("country", pa.string()),
        ("area_m2", pa.float64()),
        ("part_count", pa.int32()),
        ("claim_count", pa.int32()),
        ("first_claim_utc", _TS),
        ("last_claim_utc", _TS),
        #: The box of its parts' display outlines, in degrees.
        ("min_lat", pa.float64()),
        ("min_lon", pa.float64()),
        ("max_lat", pa.float64()),
        ("max_lon", pa.float64()),
        ("analysis_version", pa.int32()),
    ]
)

#: Derived. One row per connected part of the claimed ground.
TERRITORY_PART_SCHEMA = pa.schema(
    [
        ("region_id", pa.string()),
        #: 0 for the region's largest part.
        ("part_index", pa.int32()),
        #: The part's true area, before the display simplification.
        ("area_m2", pa.float64()),
        #: Vertices in the display outline, holes included.
        ("vertex_count", pa.int32()),
        ("min_lat", pa.float64()),
        ("min_lon", pa.float64()),
        ("max_lat", pa.float64()),
        ("max_lon", pa.float64()),
        #: A valid GeoJSON Polygon, or MultiPolygon where the grid cuts a neck, in
        #: degrees: simplified at DISPLAY_TOLERANCE_M, 1 m, then snapped to the
        #: COORDINATE_DECIMALS grid.
        ("geometry_geojson", pa.string()),
        ("analysis_version", pa.int32()),
    ]
)


#: One row per activity recorded as a run and counted as a walk; see
#: ``analysis.reclassification``. Such an activity has no row in any other
#: derived table.
SPORT_RECLASSIFICATION_SCHEMA = pa.schema(
    [
        ("activity_id", pa.string()),
        #: What the device wrote, ``running``.
        ("recorded_sport", pa.string()),
        #: What the activity is counted as, ``walking``.
        ("sport", pa.string()),
        #: ``activity_metrics.avg_speed_mps`` as it would have been: the
        #: canonical distance over the grid's moving time.
        ("avg_speed_mps", pa.float64()),
        #: The threshold it was judged against, so a row says what rule made it.
        ("threshold_mps", pa.float64()),
        ("analysis_version", pa.int32()),
    ]
)

LEDGER_SCHEMA = pa.schema(
    [
        ("source_file_sha256", pa.string()),
        ("source_file", pa.string()),
        ("activity_id", pa.string()),
        ("source", pa.string()),
        ("status", pa.string()),
        ("ingested_at", _TS),
    ]
)


def empty_frame(schema: pa.Schema) -> pd.DataFrame:
    """An empty DataFrame with the columns and dtypes of ``schema``."""
    frame: pd.DataFrame = schema.empty_table().to_pandas()
    return frame
