"""Rebuild the derived layer from the canonical store.

Always a full rebuild. Measured on 2026-08-29, reading and resampling the
whole running history takes 1.3 seconds, so an incremental path would be more
code than the thing it accelerates, and a stale derived row is a silent bug
rather than a loud one.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pandas as pd

from activity_analysis.analysis.best_efforts import (
    best_efforts,
    grid_jump_reason,
    speed_is_measured,
)
from activity_analysis.analysis.efficiency import (
    ActivitySample,
    efficiency_rows,
    smooth_efficiency,
)
from activity_analysis.analysis.fitness import fitness_rows
from activity_analysis.analysis.metrics import activity_metrics
from activity_analysis.analysis.profile import (
    observations_for_sport,
    profile_at,
    version_profile,
)
from activity_analysis.analysis.reclassification import (
    WALK_SPORT,
    WALK_THRESHOLD_MPS,
    is_walk,
)
from activity_analysis.analysis.resample import resample_to_1hz
from activity_analysis.analysis.rest_days import days_since_previous_run
from activity_analysis.analysis.routes import (
    RunInput,
    group_routes,
    resample_trace,
    route_tables,
)
from activity_analysis.analysis.tags import TagHistory, classify_effort
from activity_analysis.analysis.territory import Track, claim_territory, territory_tables
from activity_analysis.analysis.zones import zone_time
from activity_analysis.config import ANALYSIS_VERSION, Paths
from activity_analysis.models import (
    ACTIVITY_EFFICIENCY_SCHEMA,
    ACTIVITY_METRICS_SCHEMA,
    ACTIVITY_TAG_SCHEMA,
    ATHLETE_FIT_SCHEMA,
    BEST_EFFORT_SCHEMA,
    FITNESS_SERIES_SCHEMA,
    ROUTE_RUN_SCHEMA,
    ROUTE_SCHEMA,
    SPORT_RECLASSIFICATION_SCHEMA,
    TERRITORY_CLAIM_SCHEMA,
    TERRITORY_PART_SCHEMA,
    TERRITORY_REGION_SCHEMA,
    ZONE_TIME_SCHEMA,
    empty_frame,
)
from activity_analysis.progress import SILENT, Progress
from activity_analysis.store.writer import (
    read_activities,
    read_derived_stream,
    read_laps,
    read_profile_observations,
    read_streams,
    write_activity_efficiency,
    write_activity_metrics,
    write_activity_tags,
    write_athlete_fit,
    write_athlete_profile,
    write_best_efforts,
    write_derived_stream,
    write_fitness_series,
    write_route_runs,
    write_routes,
    write_sport_reclassifications,
    write_territory_claims,
    write_territory_parts,
    write_territory_regions,
    write_zone_time,
)

#: The derived layer is a running application. Other sports stay canonical.
RUNNING_SPORT = "running"


@dataclass
class RecomputeResult:
    activities: int = 0
    best_efforts: int = 0
    zone_rows: int = 0
    profile_intervals: int = 0
    tag_rows: int = 0
    efficiency_rows: int = 0
    fitness_rows: int = 0
    routes: int = 0
    #: Runs that claimed ground, and the ground claimed, in m^2.
    territory_claims: int = 0
    territory_area_m2: float = 0.0
    #: Runs counted as walks, which got nothing else from the rebuild.
    reclassified: int = 0
    skipped_no_streams: int = 0
    errors: list[tuple[str, str]] = field(default_factory=list)


def _clear_orphaned_grids(paths: Paths, keep: set[str]) -> None:
    """Remove every derived grid this rebuild did not write.

    A full rebuild that leaves orphans behind is not a full rebuild, and an
    orphan is not only an activity that left the canonical store: an activity
    that failed or had no streams this time round would otherwise keep a grid
    that none of the other derived tables has a row for.
    """
    if not paths.derived_streams_dir.exists():
        return
    for path in paths.derived_streams_dir.glob("*.parquet"):
        if path.stem not in keep:
            path.unlink()


def _start_instants(runs: pd.DataFrame) -> dict[str, pd.Timestamp]:
    """When each run started, by activity id.

    The efficiency tables deliberately carry no instant of their own, so both
    the time term in the shared fit and the trailing windows over the fitted
    rows have to take it from the canonical activities.
    """
    when = pd.to_datetime(runs["start_time_utc"], utc=True)
    return dict(zip(runs["activity_id"].astype(str), when, strict=True))


def _smoothed_in_time_order(rows: pd.DataFrame, runs: pd.DataFrame) -> pd.DataFrame:
    """Put the fitted rows in time order and add their smoothed series.

    ``efficiency_rows`` returns rows in the order the derived grids were
    walked in, which is not the order the runs were run in, and a trailing
    window over the wrong order would average over the future. Both the order
    and the instants are therefore established here rather than assumed.
    """
    instants = pd.to_datetime(rows["activity_id"].map(_start_instants(runs)), utc=True)
    order = instants.sort_values(kind="stable").index
    return smooth_efficiency(
        rows.loc[order].reset_index(drop=True),
        instants.loc[order].reset_index(drop=True),
    )


def _samples_with_years(samples: list[ActivitySample], runs: pd.DataFrame) -> list[ActivitySample]:
    """Fill each sample's ``years`` from the start of the history.

    The shared fit carries a time term so that the athlete getting fitter is
    not absorbed into the speed coefficient, and the origin has to be the
    same for every sample for that term to mean anything.
    """
    if not samples:
        return []
    by_id = _start_instants(runs)
    if not by_id:
        return []
    earliest = min(by_id.values())
    return [
        ActivitySample(
            activity_id=sample.activity_id,
            effort_tag=sample.effort_tag,
            speed=sample.speed,
            hr=sample.hr,
            cadence=sample.cadence,
            years=float((by_id[sample.activity_id] - earliest).days) / 365.25,
            moving_speed_mps=sample.moving_speed_mps,
        )
        for sample in samples
        if sample.activity_id in by_id
    ]


def derived_is_behind(paths: Paths) -> bool:
    """Whether the canonical store holds activities no finished recompute has seen.

    Read from modification times: ``recompute`` writes every derived table in
    one burst at its end, ``territory_parts`` last, so a ``territory_parts``
    older than ``activities.parquet``, or missing beside it, means the last
    recompute was interrupted or never run since the last ingest.
    """
    canonical = paths.activities_parquet
    last_written = paths.territory_parts_parquet
    if not canonical.is_file():
        return False
    return not last_written.is_file() or last_written.stat().st_mtime < canonical.stat().st_mtime


def recompute(paths: Paths, progress: Progress = SILENT) -> RecomputeResult:
    """Rebuild every derived table from the canonical layer."""
    paths.ensure()
    result = RecomputeResult()

    activities = read_activities(paths)
    runs = activities[activities["sport"] == RUNNING_SPORT]

    # Scoped to running because zone settings are per sport in FIT. See
    # observations_for_sport for what happens when they are not scoped.
    profile = version_profile(
        observations_for_sport(read_profile_observations(paths), activities, RUNNING_SPORT)
    )
    profile["analysis_version"] = ANALYSIS_VERSION
    write_athlete_profile(paths, profile)
    result.profile_intervals = len(profile)

    laps_all = read_laps(paths)
    tag_rows: list[dict[str, Any]] = []

    effort_frames: list[pd.DataFrame] = []
    zone_frames: list[pd.DataFrame] = []
    metric_rows: list[dict[str, Any]] = []
    reclassification_rows: list[dict[str, Any]] = []
    efficiency_samples: list[ActivitySample] = []
    written: set[str] = set()
    # Read here, from the raw stream, because the 1 Hz grid the route pass
    # reads back has interpolated away the identity that shows a derived
    # speed channel; see best_efforts.speed_is_measured.
    speed_measured: set[str] = set()

    for _, activity in progress.track(list(runs.iterrows()), "computing each run"):
        activity_id = str(activity["activity_id"])
        try:
            streams = read_streams(paths, activity_id)
            if streams.empty:
                result.skipped_no_streams += 1
                continue

            grid = resample_to_1hz(streams)
            grid.insert(0, "activity_id", activity_id)

            # First, because it decides whether this is a run at all. A walk
            # recorded on the running profile gets its row here and nothing
            # else: no grid, no efforts, no zones, no tags, and below, no
            # place in any population a run is judged against.
            metrics = {**activity_metrics(grid, activity), "analysis_version": ANALYSIS_VERSION}
            if is_walk(metrics["avg_speed_mps"]):
                reclassification_rows.append(
                    {
                        "activity_id": activity_id,
                        "recorded_sport": RUNNING_SPORT,
                        "sport": WALK_SPORT,
                        "avg_speed_mps": metrics["avg_speed_mps"],
                        "threshold_mps": WALK_THRESHOLD_MPS,
                        "analysis_version": ANALYSIS_VERSION,
                    }
                )
                continue

            measured = speed_is_measured(streams)
            if measured:
                speed_measured.add(activity_id)
            efforts = best_efforts(grid, speed_is_measured=measured)
            if not efforts.empty:
                efforts.insert(0, "activity_id", activity_id)
                efforts["analysis_version"] = ANALYSIS_VERSION

            settings = profile_at(
                profile, str(activity["athlete_id"]), pd.Timestamp(activity["start_time_utc"])
            )
            boundaries = (
                []
                if settings is None or settings["hr_zone_boundaries"] is None
                else list(settings["hr_zone_boundaries"])
            )
            zones = zone_time(grid, boundaries)
            if not zones.empty:
                zones.insert(0, "activity_id", activity_id)
                zones["analysis_version"] = ANALYSIS_VERSION

            # The fallback is a threshold input to interval_reps, not a pace: a
            # rep needs lap pace <= avg_moving_pace * REP_PACE_FRACTION, so a
            # high fallback (e.g. infinity) makes that threshold unreachably
            # loose and lets every qualifying-cadence lap score as a rep with
            # no reliable average behind it. 0.0 makes the threshold
            # unreachable in the correct direction instead: no positive lap
            # pace is at or below zero, so a missing or zero distance yields
            # no reps rather than every lap being "fast".
            avg_moving_pace = (
                metrics["moving_time_s"] / (metrics["distance_m"] / 1000.0)
                if metrics["distance_m"] > 0
                else 0.0
            )
            # interval_reps reads adjacency between consecutive rows, so this
            # order is load-bearing rather than cosmetic: a rep is a lap with
            # a recovery lap immediately beside it in recorded order, not in
            # whatever order the laps Parquet happens to store them.
            activity_laps = laps_all[laps_all["activity_id"] == activity_id].sort_values(
                "lap_index"
            )
            max_hr = None if settings is None else settings.get("max_hr_bpm")
            effort = classify_effort(activity_laps, grid, avg_moving_pace, max_hr)

            # Nothing is recorded until every computation for this activity
            # has succeeded, so an activity in streams_1hz is an activity in
            # activity_metrics.
            write_derived_stream(paths, activity_id, grid)
            written.add(activity_id)
            result.activities += 1
            if not efforts.empty:
                effort_frames.append(efforts)
            if not zones.empty:
                zone_frames.append(zones)
            metric_rows.append(metrics)
            if effort.tag is not None:
                tag_rows.append(
                    {
                        "activity_id": activity_id,
                        "kind": "effort",
                        "tag": effort.tag,
                        "distance_key": None,
                        "rep_count": effort.rep_count,
                        "rep_pattern": effort.rep_pattern,
                        "reason": effort.reason,
                        "analysis_version": ANALYSIS_VERSION,
                    }
                )
            # Indoor runs are excluded here rather than inside efficiency.py,
            # because that module reads no store and cannot know. A treadmill
            # distance comes from an uncalibrated footpod, so its speed is not
            # comparable with an outdoor run's, and this fit exists precisely
            # to compare across runs.
            if not bool(metrics.get("is_indoor")):
                window = grid.loc[~grid["paused"] & ~grid["outage"]]
                efficiency_samples.append(
                    ActivitySample(
                        activity_id=activity_id,
                        effort_tag=effort.tag,
                        speed=window["speed_mps"].to_numpy(dtype=float),
                        hr=window["hr_bpm"].to_numpy(dtype=float),
                        cadence=window["cadence_spm"].to_numpy(dtype=float),
                        years=0.0,  # filled in by _samples_with_years below
                        # `activity_metrics` already stores this division, so
                        # it is read rather than repeated: two copies of one
                        # definition would be free to drift, and the fit's
                        # reading of None as "not known" depends on the null
                        # rule being the same one. See `analysis/metrics.py`.
                        moving_speed_mps=metrics.get("avg_speed_mps"),
                    )
                )
        except Exception as exc:  # noqa: BLE001 - one bad activity must not abort the rebuild
            result.errors.append((activity_id, f"{type(exc).__name__}: {exc}"))

    _clear_orphaned_grids(paths, written)

    # Every whole-history pass below reads `runs`, so a walk leaves it here:
    # it is not the previous run of the next one, not one of the runs a long
    # run is measured against, and not a start in the efficiency fit's time
    # term. A run with no streams, or one that failed, stays, because it was
    # not judged and so is still a run.
    walks = {str(row["activity_id"]) for row in reclassification_rows}
    runs = runs[~runs["activity_id"].astype(str).isin(walks)]
    reclassifications_all = (
        pd.DataFrame(reclassification_rows)
        if reclassification_rows
        else empty_frame(SPORT_RECLASSIFICATION_SCHEMA)
    )

    efforts_all = (
        pd.concat(effort_frames, ignore_index=True)
        if effort_frames
        else empty_frame(BEST_EFFORT_SCHEMA)
    )
    zones_all = (
        pd.concat(zone_frames, ignore_index=True) if zone_frames else empty_frame(ZONE_TIME_SCHEMA)
    )
    metrics_all = pd.DataFrame(metric_rows) if metric_rows else empty_frame(ACTIVITY_METRICS_SCHEMA)

    # Whole-history, like the tag flags and the phase 4 passes below, and
    # contained the same way: a failure here must still leave every table
    # rewritten, with the column left null rather than guessed. Over every
    # running activity rather than only `written`: a run with no streams, or
    # one whose grid failed, still happened, so it is still the next run's
    # previous run, though it gets no row of its own.
    try:
        gaps = days_since_previous_run(runs)
        metrics_all["days_since_previous_run"] = (
            metrics_all["activity_id"].map(gaps).astype("Int32")
        )
    except Exception as exc:  # noqa: BLE001 - the table still has to be written
        result.errors.append(("rest_days", f"{type(exc).__name__}: {exc}"))
        metrics_all["days_since_previous_run"] = pd.array([pd.NA] * len(metrics_all), dtype="Int32")

    # A treadmill effort's distance comes from an uncalibrated footpod, so it
    # must not become a personal record, and it must not become the baseline a
    # later outdoor record has to beat either. See the invariant under "Best
    # efforts" in docs/reference/derived-layer.md. A null flag means not known
    # rather than outdoor, so it is excluded on the same side as a treadmill.
    not_known_outdoors = set(
        metrics_all.loc[~metrics_all["is_indoor"].eq(False), "activity_id"].astype(str)
    )

    progress.stage("comparing runs across the history")
    # The history flags run after the per-activity loop because they need the
    # whole history, but they stay inside the same containment: every derived
    # grid is already on disk at this point, so an exception escaping here
    # would leave fresh grids against derived tables that were never
    # rewritten, which is precisely the state the loop above exists to avoid.
    history: TagHistory | None = None
    try:
        history = TagHistory(runs, efforts_all, excluded_activity_ids=not_known_outdoors)
    except Exception as exc:  # noqa: BLE001 - the tables still have to be written
        result.errors.append(("activity_tags", f"{type(exc).__name__}: {exc}"))

    if history is not None:
        for activity_id in sorted(written):
            try:
                flags = history.flags(activity_id)
            except Exception as exc:  # noqa: BLE001 - one bad activity must not abort the rebuild
                result.errors.append((activity_id, f"{type(exc).__name__}: {exc}"))
                continue
            for flag in flags:
                tag_rows.append(
                    {
                        "activity_id": activity_id,
                        "kind": "flag",
                        "tag": flag.tag,
                        "distance_key": flag.distance_key,
                        "rep_count": None,
                        "rep_pattern": None,
                        "reason": flag.reason,
                        "analysis_version": ANALYSIS_VERSION,
                    }
                )

    tags_all = pd.DataFrame(tag_rows) if tag_rows else empty_frame(ACTIVITY_TAG_SCHEMA)

    # The efficiency pass needs every activity before any activity's own
    # slope can be shrunk, so it runs here rather than in the loop. Contained
    # the same way the tag history is, and for the same reason: every derived
    # grid is already on disk at this point, so an exception escaping would
    # leave fresh grids against tables that were never rewritten.
    efficiency_frame = empty_frame(ACTIVITY_EFFICIENCY_SCHEMA)
    fit_frame = empty_frame(ATHLETE_FIT_SCHEMA)
    try:
        rows, fit = efficiency_rows(_samples_with_years(efficiency_samples, runs))
        if not rows.empty:
            rows = _smoothed_in_time_order(rows, runs)
            rows["analysis_version"] = ANALYSIS_VERSION
            efficiency_frame = rows
        fit_frame = pd.DataFrame([{**fit, "analysis_version": ANALYSIS_VERSION}]).astype(
            {"activities_in_fit": "int32", "analysis_version": "int32"}
        )
    except Exception as exc:  # noqa: BLE001 - the tables still have to be written
        result.errors.append(("efficiency", f"{type(exc).__name__}: {exc}"))

    # The fitness pass. Whole-history like the tag flags above, and inside the
    # same containment: every grid is already on disk, so a failure here must
    # still leave every table rewritten, with this one empty rather than
    # stale. The grids are read back from the derived layer rather than kept
    # from the loop, so that this block depends on nothing above it except
    # what the loop wrote.
    fitness_all = empty_frame(FITNESS_SERIES_SCHEMA)
    try:
        grids: dict[str, tuple[Any, Any]] = {}
        max_hr_by_activity: dict[str, float] = {}
        for _, activity in runs.iterrows():
            activity_id = str(activity["activity_id"])
            if activity_id not in written:
                continue
            grid = read_derived_stream(paths, activity_id)
            grids[activity_id] = (
                grid["speed_mps"].to_numpy(dtype=float),
                grid["hr_bpm"].to_numpy(dtype=float),
            )
            settings = profile_at(
                profile, str(activity["athlete_id"]), pd.Timestamp(activity["start_time_utc"])
            )
            max_hr = None if settings is None else settings.get("max_hr_bpm")
            max_hr_by_activity[activity_id] = (
                float("nan") if max_hr is None or pd.isna(max_hr) else float(max_hr)
            )
        fitness_all = fitness_rows(runs, efforts_all, grids, max_hr_by_activity, not_known_outdoors)
        if fitness_all.empty:
            fitness_all = empty_frame(FITNESS_SERIES_SCHEMA)
        else:
            fitness_all["analysis_version"] = ANALYSIS_VERSION
    except Exception as exc:  # noqa: BLE001 - the tables still have to be written
        result.errors.append(("fitness", f"{type(exc).__name__}: {exc}"))
        fitness_all = empty_frame(FITNESS_SERIES_SCHEMA)

    progress.stage("finding recurring routes")
    # Routes need every run's grid and the whole history's efforts, so they
    # run here, contained like the passes above: a failure still leaves every
    # table rewritten, the route tables empty rather than stale.
    routes_frame, route_runs_frame = empty_frame(ROUTE_SCHEMA), empty_frame(ROUTE_RUN_SCHEMA)
    try:
        route_inputs = []
        jumped: dict[str, str] = {}
        outdoor = metrics_all[metrics_all["has_gps"].eq(True) & metrics_all["is_indoor"].eq(False)]
        by_id = runs.set_index("activity_id")
        for activity_id in sorted(set(outdoor["activity_id"].astype(str)) & written):
            grid = read_derived_stream(paths, activity_id)
            trace = resample_trace(
                grid["distance_m"].to_numpy(dtype=float),
                grid["lat_deg"].to_numpy(dtype=float),
                grid["lon_deg"].to_numpy(dtype=float),
            )
            if trace is None:
                continue
            reason = grid_jump_reason(grid, speed_is_measured=activity_id in speed_measured)
            if reason is not None:
                jumped[activity_id] = reason
            row = outdoor.loc[outdoor["activity_id"] == activity_id].iloc[0]
            route_inputs.append(
                RunInput(
                    activity_id,
                    pd.Timestamp(by_id["start_time_utc"].loc[activity_id]),
                    float(row["distance_m"]),
                    None if pd.isna(row["locality"]) else str(row["locality"]),
                    trace,
                )
            )
        routes_frame, route_runs_frame = route_tables(
            group_routes(route_inputs), runs, metrics_all, efforts_all, jumped
        )
    except Exception as exc:  # noqa: BLE001 - the tables still have to be written
        result.errors.append(("routes", f"{type(exc).__name__}: {exc}"))

    progress.stage("mapping territory")
    # Territory needs every outdoor run's positions in start-time order, so it
    # runs here, contained like the passes above: a failure leaves its three
    # tables empty rather than stale. Outdoor is the routes rule, `has_gps`
    # and explicitly not `is_indoor`; GPX-sourced runs count, because the
    # ground a track encloses does not divide by its noisy speed.
    claims_frame = empty_frame(TERRITORY_CLAIM_SCHEMA)
    regions_frame = empty_frame(TERRITORY_REGION_SCHEMA)
    parts_frame = empty_frame(TERRITORY_PART_SCHEMA)
    try:
        outdoor = metrics_all[metrics_all["has_gps"].eq(True) & metrics_all["is_indoor"].eq(False)]
        starts = runs.set_index("activity_id")["start_time_utc"]
        tracks = []
        for _, row in outdoor.iterrows():
            activity_id = str(row["activity_id"])
            if activity_id not in written:
                continue
            grid = read_derived_stream(paths, activity_id)
            tracks.append(
                Track(
                    activity_id,
                    pd.Timestamp(starts.loc[activity_id]),
                    grid["lat_deg"].to_numpy(dtype=float),
                    grid["lon_deg"].to_numpy(dtype=float),
                    None if pd.isna(row["locality"]) else str(row["locality"]),
                    None if pd.isna(row["country"]) else str(row["country"]),
                )
            )
        territory = claim_territory(tracks)
        claims_frame, regions_frame, parts_frame = territory_tables(territory)
        result.territory_claims = int(claims_frame["region_id"].notna().sum())
        result.territory_area_m2 = float(regions_frame["area_m2"].sum())
    except Exception as exc:  # noqa: BLE001 - the tables still have to be written
        result.errors.append(("territory", f"{type(exc).__name__}: {exc}"))
        claims_frame = empty_frame(TERRITORY_CLAIM_SCHEMA)
        regions_frame = empty_frame(TERRITORY_REGION_SCHEMA)
        parts_frame = empty_frame(TERRITORY_PART_SCHEMA)

    write_sport_reclassifications(paths, reclassifications_all)
    write_best_efforts(paths, efforts_all)
    write_zone_time(paths, zones_all)
    write_activity_metrics(paths, metrics_all)
    write_activity_tags(paths, tags_all)

    # The three phase 4 tables, filled by the efficiency and fitness passes
    # above. Empty rather than absent when a pass produced nothing, so every
    # consumer reads a table with no rows instead of branching on existence.
    write_activity_efficiency(paths, efficiency_frame)
    write_athlete_fit(paths, fit_frame)
    write_fitness_series(paths, fitness_all)

    write_routes(paths, routes_frame)
    write_route_runs(paths, route_runs_frame)

    write_territory_claims(paths, claims_frame)
    write_territory_regions(paths, regions_frame)
    # Last, and kept last: derived_is_behind reads its modification time as
    # the moment this recompute finished.
    write_territory_parts(paths, parts_frame)

    result.reclassified = len(reclassifications_all)
    result.best_efforts = len(efforts_all)
    result.efficiency_rows = len(efficiency_frame)
    result.zone_rows = len(zones_all)
    result.tag_rows = len(tags_all)
    result.fitness_rows = len(fitness_all)
    result.routes = len(routes_frame)
    return result
