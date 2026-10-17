"""Route geometry and grouping, on synthetic traces with known answers."""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

from activity_analysis.analysis.best_efforts import (
    JUMP_UNCHECKABLE,
    JUMP_UNCONFIRMED,
    JUMP_UNKNOWN,
    best_efforts,
    grid_jump_reason,
)
from activity_analysis.analysis.routes import (
    MAX_MEAN_M,
    MAX_WORST_M,
    TRACE_POINTS,
    PairMetrics,
    RunInput,
    direction,
    group_routes,
    is_out_and_back,
    pair_metrics,
    resample_trace,
    route_tables,
)

LAT0, LON0 = 57.77, 14.18
M_PER_DEG_LAT = 111_320.0

RunTrack = tuple[np.ndarray, np.ndarray, np.ndarray]


def loop_xy(
    radius_m: float = 500.0,
    n: int = 2000,
    *,
    dx_m: float = 0.0,
    dy_m: float = 0.0,
    reverse: bool = False,
    start_frac: float = 0.0,
) -> tuple[np.ndarray, np.ndarray]:
    """A circular loop as metres east and north of (LAT0, LON0), 1 sample per step."""
    theta = 2 * math.pi * (np.arange(n) / (n - 1) + start_frac)
    if reverse:
        theta = -theta
    return radius_m * np.cos(theta) + dx_m, radius_m * np.sin(theta) + dy_m


def track(x: np.ndarray, y: np.ndarray) -> RunTrack:
    """Metres east and north as (distance_m, lat, lon), the odometer summed along the path."""
    lat = LAT0 + y / M_PER_DEG_LAT
    lon = LON0 + x / (M_PER_DEG_LAT * math.cos(math.radians(LAT0)))
    step = np.hypot(np.diff(x), np.diff(y))
    distance = np.concatenate([[0.0], np.cumsum(step)])
    return distance, lat, lon


def loop(
    radius_m: float = 500.0,
    n: int = 2000,
    **kwargs: float | bool,
) -> RunTrack:
    """A circular loop as (distance_m, lat, lon), 1 sample per step."""
    return track(*loop_xy(radius_m, n, **kwargs))  # type: ignore[arg-type]


def trace(**kwargs: float | bool) -> np.ndarray:
    t = resample_trace(*loop(**kwargs))  # type: ignore[arg-type]
    assert t is not None
    return t


def test_a_trace_is_resampled_to_200_points_evenly_by_distance():
    t = trace()
    assert t.shape == (TRACE_POINTS, 2)
    steps = np.hypot(
        np.diff(t[:, 0]) * M_PER_DEG_LAT,
        np.diff(t[:, 1]) * M_PER_DEG_LAT * math.cos(math.radians(LAT0)),
    )
    assert steps.std() / steps.mean() < 0.02


def test_a_trace_ignores_missing_positions_and_starts_at_the_first_fix():
    d, lat, lon = loop()
    lat = lat.copy()
    lon = lon.copy()
    lat[:50] = np.nan
    lon[:50] = np.nan
    t = resample_trace(d, lat, lon)
    assert t is not None
    assert np.isfinite(t).all()
    assert abs(t[0, 0] - lat[50]) < 1e-9


def test_too_few_samples_is_no_trace():
    d, lat, lon = loop(n=9)
    assert resample_trace(d, lat, lon) is None


def test_identical_traces_are_zero_apart():
    m = pair_metrics(trace(), trace())
    assert m.mean_m < 0.5 and m.worst_m < 0.5


def test_a_parallel_offset_reads_as_two_over_pi_of_it():
    # Two circles offset by d << r: the nearest-point distance is |d cos(phi)|,
    # whose mean round the loop is 2d/pi. A 30 m offset reads as 19.1 m.
    m = pair_metrics(trace(), trace(dx_m=30.0))
    assert abs(m.mean_m - 2 * 30.0 / math.pi) < 1.5


def with_lead_in(lead_m: float = 100.0) -> np.ndarray:
    """The loop with a straight lead-in from ``lead_m`` outside its start."""
    d, lat, lon = loop()
    k = 100
    lat_in = np.full(k, lat[0])
    step_lon = lead_m / (M_PER_DEG_LAT * math.cos(math.radians(LAT0)))
    lon_in = lon[0] + np.linspace(step_lon, 0.0, k, endpoint=False)
    d_in = np.linspace(0.0, lead_m, k, endpoint=False)
    t = resample_trace(
        np.concatenate([d_in, d + lead_m]),
        np.concatenate([lat_in, lat]),
        np.concatenate([lon_in, lon]),
    )
    assert t is not None
    return t


def test_a_lead_in_at_the_start_is_trimmed_out_of_the_worst_point():
    # 100 m is 3% of the 3.2 km trace, inside the 5% trimmed at each end, so
    # the watch started 100 m off the loop does not count against the pair.
    m = pair_metrics(trace(), with_lead_in(100.0))
    assert m.worst_m < 20.0


def test_a_lead_in_longer_than_the_trim_is_not_trimmed():
    m = pair_metrics(trace(), with_lead_in(400.0))
    assert m.worst_m > 150.0


def detour(height_m: float = 200.0) -> np.ndarray:
    """The default loop with a radial bump over its middle tenth, peaking at ``height_m``."""
    x, y = loop_xy()
    bump = np.zeros(len(x))
    k = len(x) // 10
    start = (len(x) - k) // 2
    bump[start : start + k] = height_m * np.sin(np.linspace(0, math.pi, k))
    # Pushed out along the radius, perpendicular to the path, so the bump
    # leaves the loop rather than sliding along it.
    scale = 1 + bump / np.hypot(x, y)
    t = resample_trace(*track(x * scale, y * scale))
    assert t is not None
    return t


def test_a_mid_route_detour_shows_in_the_worst_point():
    m = pair_metrics(trace(), detour(200.0))
    assert m.worst_m > 150.0


def test_the_earliest_run_read_backwards_decides_a_loop_run_the_other_way():
    assert direction(trace(), trace(reverse=True)) == "reverse"
    assert direction(trace(), trace(dx_m=5.0)) == "forward"


def half_loop_and_back(turn_frac: float) -> np.ndarray:
    """Round the default loop the other way for ``turn_frac`` of it, then back the way it came."""
    x, y = loop_xy(reverse=True)
    k = int(turn_frac * len(x))
    idx = np.concatenate([np.arange(k), np.arange(k - 1, -1, -1)[: len(x) - k]])
    t = resample_trace(*track(x[idx], y[idx]))
    assert t is not None
    return t


def test_a_near_tie_is_forward():
    # Measured on this trace: 463 m from the loop read forwards and 310 m
    # from it read backwards. Backward is the smaller, but not under half.
    first, run_trace = trace(), half_loop_and_back(0.55)
    assert direction(first, run_trace) == "forward"
    # Past the turn the run heads back, so the backward reading is under half.
    assert direction(first, half_loop_and_back(0.7)) == "reverse"


def lollipop(
    stem_m: float = 1500.0, loop_r_m: float = 40.0, *, clockwise: bool = False
) -> RunTrack:
    """Out along a straight stem, round a small turnaround loop and back the same way."""
    n = 2000
    out = np.linspace(0.0, stem_m, n)
    theta = np.linspace(0.0, 2 * math.pi, n)
    side = -1.0 if clockwise else 1.0
    x = np.concatenate([out, stem_m + side * loop_r_m * np.sin(theta), out[::-1]])
    y = np.concatenate([np.zeros(n), loop_r_m - loop_r_m * np.cos(theta), np.zeros(n)])
    return track(x, y)


def test_an_out_and_back_is_recognised_by_its_own_trace_read_backwards():
    out_and_back = resample_trace(*lollipop())
    assert out_and_back is not None
    assert is_out_and_back(out_and_back)
    assert not is_out_and_back(trace())


def test_the_projection_is_local_wherever_the_pair_is():
    # The same 30 m offset measured near the equator and at 58 N reads the same.
    north = pair_metrics(trace(), trace(dx_m=30.0)).mean_m
    global LAT0
    saved = LAT0
    try:
        LAT0 = 9.9
        south = pair_metrics(trace(), trace(dx_m=30.0)).mean_m
    finally:
        LAT0 = saved
    assert abs(north - south) < 1.0


def run(
    activity_id: str, day: int, *, locality: str = "Jönköping", **kwargs: float | bool
) -> RunInput:
    d, lat, lon = loop(**kwargs)  # type: ignore[arg-type]
    t = resample_trace(d, lat, lon)
    assert t is not None
    return RunInput(
        activity_id,
        pd.Timestamp("2026-01-01", tz="UTC") + pd.Timedelta(days=day),
        float(d[-1]),
        locality,
        t,
    )


def test_three_runs_of_one_loop_are_a_route_named_after_place_and_distance():
    # b is the earliest run, not the medoid, so route_id and reference_activity_id
    # cannot both come out right by accident.
    routes = group_routes([run("b", 1, dx_m=5.0), run("a", 2), run("c", 3, dx_m=-5.0)])
    (r,) = routes
    assert set(r.run_ids) == {"a", "b", "c"}
    assert r.route_id == "b"
    assert r.name == "Jönköping 3.1 km"
    assert r.reference_activity_id == "a"  # the medoid: b and c sit either side of it


def test_two_runs_are_not_a_route():
    assert group_routes([run("a", 1), run("b", 2)]) == []


def test_a_run_offset_by_40_m_is_not_the_same_route():
    # 40 m apart reads as 2 * 40 / pi = 25.5 m on the mean, over the 20 m limit.
    routes = group_routes([run("a", 1), run("b", 2), run("c", 3), run("far", 4, dx_m=40.0)])
    (r,) = routes
    assert "far" not in r.run_ids


def test_complete_linkage_refuses_a_chain():
    # a-b and b-c read 12.7 m apart on the mean, a-c 25.5 m: no route of all three.
    runs = [
        run("a", 1),
        run("b", 2, dx_m=20.0),
        run("c", 3, dx_m=40.0),
        run("a2", 4),
        run("c2", 5, dx_m=40.0),
    ]
    for r in group_routes(runs):
        assert not {"a", "c"} <= set(r.run_ids)


def test_a_reversed_run_joins_the_route_marked_reverse():
    routes = group_routes([run("a", 1), run("b", 2), run("rev", 3, reverse=True)])
    (r,) = routes
    assert r.directions["rev"] == "reverse"
    assert r.directions["a"] == "forward"


def lollipop_run(activity_id: str, day: int, *, clockwise: bool = False) -> RunInput:
    d, lat, lon = lollipop(clockwise=clockwise)
    t = resample_trace(d, lat, lon)
    assert t is not None
    return RunInput(
        activity_id,
        pd.Timestamp("2026-01-01", tz="UTC") + pd.Timedelta(days=day),
        float(d[-1]),
        "Jönköping",
        t,
    )


def test_every_run_of_an_out_and_back_is_forward_even_one_run_backwards():
    # Round the turnaround loop the other way, the whole run read backwards is
    # the first run to within a millimetre: `direction` alone calls it reverse.
    first, again, backwards = (
        lollipop_run("a", 1),
        lollipop_run("b", 2),
        lollipop_run("c", 3, clockwise=True),
    )
    assert direction(first.trace, backwards.trace) == "reverse"
    (r,) = group_routes([first, again, backwards])
    assert r.directions == {"a": "forward", "b": "forward", "c": "forward"}


def test_direction_does_not_change_when_a_later_run_becomes_the_medoid():
    early = [run("a", 1), run("b", 2), run("c", 3, dx_m=10.0, reverse=True)]
    (before,) = group_routes(early)
    assert before.reference_activity_id == "a"
    # Two more runs the other way, 10 m over, pull the medoid onto c.
    (after,) = group_routes(
        early + [run("d", 4, dx_m=10.0, reverse=True), run("e", 5, dx_m=10.0, reverse=True)]
    )
    assert after.reference_activity_id == "c"
    assert before.directions == {"a": "forward", "b": "forward", "c": "reverse"}
    assert after.directions == {**before.directions, "d": "reverse", "e": "reverse"}


def test_each_run_keeps_the_metrics_of_the_link_that_admitted_it():
    runs = [run("b", 1, dx_m=5.0), run("a", 2), run("c", 3, dx_m=-5.0)]
    (r,) = group_routes(runs)
    assert r.reference_activity_id == "a"
    assert r.metrics["a"] == PairMetrics(0.0, 0.0)
    # Links are measured with the earlier run first, on its own plane.
    assert r.metrics["b"] == pair_metrics(runs[0].trace, runs[1].trace)
    assert r.metrics["c"] == pair_metrics(runs[1].trace, runs[2].trace)


def test_two_routes_that_would_share_a_name_get_A_and_B_by_run_count():
    near = [run(f"n{i}", i) for i in range(4)]
    other = [run(f"o{i}", 10 + i, dx_m=2000.0) for i in range(3)]
    names = {len(r.run_ids): r.name for r in group_routes(other + near)}
    assert names == {4: "Jönköping 3.1 km A", 3: "Jönköping 3.1 km B"}


def test_the_route_id_is_the_earliest_run_not_the_first_by_name():
    routes = group_routes([run("a-last", 9), run("z-first", 1), run("m-mid", 5)])
    assert routes[0].route_id == "z-first"
    assert routes[0].run_ids == ("z-first", "m-mid", "a-last")


def test_grouping_is_the_same_whatever_order_the_runs_arrive_in():
    # The chain: b is 12.7 m from both {a, a2} and {c, c2}, a tie that only
    # the time-ordered tie-break settles.
    runs = [
        run("a", 1),
        run("b", 2, dx_m=20.0),
        run("c", 3, dx_m=40.0),
        run("a2", 4),
        run("c2", 5, dx_m=40.0),
    ]
    expected = group_routes(runs)
    assert len(expected) == 1
    for order in (runs[::-1], runs[2:] + runs[:2], [runs[i] for i in (3, 1, 4, 0, 2)]):
        assert group_routes(order) == expected


def test_a_run_whose_worst_point_strays_too_far_is_not_in_the_route():
    d, lat, lon = loop()
    detoured = detour(200.0)
    link = pair_metrics(trace(), detoured)
    # The mean alone would admit it; the worst point is what keeps it out.
    assert link.mean_m <= MAX_MEAN_M and link.worst_m > MAX_WORST_M
    runs = [run("a", 1), run("b", 2), run("c", 3)]
    runs.append(
        RunInput(
            "detour",
            runs[-1].start_time_utc + pd.Timedelta(days=1),
            float(d[-1]),
            "Jönköping",
            detoured,
        )
    )
    (r,) = group_routes(runs)
    assert r.run_ids == ("a", "b", "c")


def test_the_candidate_filter_keeps_out_a_far_start_and_a_different_distance():
    runs = [run("a", 1), run("b", 2), run("c", 3)]
    # The same loop started a tenth of the way round: 309 m from the others'
    # start, over the 300 m limit, though every point lies on their path.
    far_start = run("far-start", 4, start_frac=0.1)
    link = pair_metrics(runs[0].trace, far_start.trace)
    assert link.mean_m <= MAX_MEAN_M and link.worst_m <= MAX_WORST_M
    # The same trace with an odometer that read 20% long, over the 15% limit.
    long_odometer = RunInput(
        "long",
        runs[0].start_time_utc + pd.Timedelta(days=4),
        runs[0].distance_m * 1.2,
        "Jönköping",
        runs[0].trace,
    )
    (r,) = group_routes(runs + [far_start, long_odometer])
    assert r.run_ids == ("a", "b", "c")


def _tables(
    speeds: dict[str, float],
    jumps: dict[str, bool | None] | None = None,
    jumped: dict[str, str] | None = None,
):
    ids = list(speeds)
    routes = group_routes([run(i, k) for k, i in enumerate(ids, start=1)])
    runs = pd.DataFrame(
        {
            "activity_id": ids,
            "start_time_utc": [
                pd.Timestamp("2026-01-01", tz="UTC") + pd.Timedelta(days=k)
                for k in range(1, len(ids) + 1)
            ],
        }
    )
    metrics = pd.DataFrame(
        {
            "activity_id": ids,
            "distance_m": [3000.0] * len(ids),
            "elapsed_time_s": [3000.0 / speeds[i] for i in ids],
            "is_gpx_sourced": [False] * len(ids),
        }
    )
    jumps = jumps or {}
    flags = [jumps.get(i, False) for i in ids]
    efforts = pd.DataFrame(
        {
            "activity_id": ids,
            "contains_jump": flags,
            "speed_distance_m": [np.nan] * len(ids),
            "distance_trusted": [None if flag is None else not flag for flag in flags],
        }
    )
    return route_tables(routes, runs, metrics, efforts, jumped or {})


def test_speed_is_distance_over_elapsed_time_and_pace_is_never_stored():
    route_df, runs_df = _tables({"a": 3.0, "b": 3.2, "c": 3.1})
    assert "pace_s_per_km" not in runs_df.columns
    assert runs_df.set_index("activity_id").loc["b", "speed_mps"] == 3.2
    assert route_df.loc[0, "run_count"] == 3


def test_rank_and_record_follow_eligible_speed_in_time_order():
    _, t = _tables({"a": 3.0, "b": 3.2, "c": 3.1, "d": 3.3})
    t = t.set_index("activity_id")
    assert t["rank"].to_dict() == {"a": 4, "b": 2, "c": 3, "d": 1}
    assert t["is_record"].to_dict() == {"a": True, "b": True, "c": False, "d": True}


def test_an_ineligible_fastest_run_neither_ranks_nor_sets_the_baseline():
    _, t = _tables({"a": 3.0, "jump": 9.9, "c": 3.1}, jumps={"jump": True})
    t = t.set_index("activity_id")
    assert not t.loc["jump", "eligible"]
    assert pd.isna(t.loc["jump", "rank"])
    assert not t.loc["jump", "is_record"]
    # No speed channel measured the flagged effort, so nothing checked it.
    assert t.loc["jump", "ineligible_reason"] == JUMP_UNCHECKABLE
    assert t.loc["c", "is_record"]  # beats 3.0, the jump does not count as the bar


def test_a_run_whose_jump_flag_is_unknown_is_ineligible():
    _, t = _tables({"a": 3.0, "b": 3.1, "u": 3.2}, jumps={"u": None})
    assert t.set_index("activity_id").loc["u", "ineligible_reason"] == JUMP_UNKNOWN


def test_a_flagged_effort_the_measured_speed_confirms_leaves_the_run_eligible():
    ids = ["a", "ok", "c"]
    routes = group_routes([run(i, k) for k, i in enumerate(ids, start=1)])
    runs = pd.DataFrame(
        {
            "activity_id": ids,
            "start_time_utc": [
                pd.Timestamp("2026-01-01", tz="UTC") + pd.Timedelta(days=k) for k in (1, 2, 3)
            ],
        }
    )
    metrics = pd.DataFrame(
        {
            "activity_id": ids,
            "distance_m": [3000.0] * 3,
            "elapsed_time_s": [1000.0, 900.0, 950.0],
            "is_gpx_sourced": [False] * 3,
        }
    )
    efforts = pd.DataFrame(
        {
            "activity_id": ids,
            "contains_jump": [False, True, False],
            "speed_distance_m": [3000.0, 2990.0, 3000.0],
            "distance_trusted": [True, True, True],
        }
    )
    _, t = route_tables(routes, runs, metrics, efforts, {})
    t = t.set_index("activity_id")
    assert t.loc["ok", "eligible"]
    assert t.loc["ok", "rank"] == 1


def grid_with_a_late_jump(jump_m: float = 40.0) -> pd.DataFrame:
    """3.2 km at 4 m/s, then 2.5 m/s with a ``jump_m`` jump at 4.45 km.

    The jump is past every best effort's end: the fastest window at each
    standard distance starts at 0 and ends by 4 km, since every slow metre
    costs more than a fast one.
    """
    t = np.arange(1401, dtype=float)
    speed = np.where(t <= 800, 4.0, 2.5)
    step = np.concatenate([[0.0], speed[1:]])
    step[1300] += jump_m
    return pd.DataFrame(
        {
            "t_s": t,
            "distance_m": np.cumsum(step),
            "hr_bpm": np.full(len(t), 150.0),
            "paused": np.zeros(len(t), dtype=bool),
            "outage": np.zeros(len(t), dtype=bool),
        }
    )


def test_a_jump_outside_every_best_effort_window_makes_the_run_ineligible():
    grid = grid_with_a_late_jump()
    efforts = best_efforts(grid)
    assert not efforts.empty and not efforts["contains_jump"].any()
    assert grid_jump_reason(grid, speed_is_measured=False) == JUMP_UNCHECKABLE
    _, t = _tables({"a": 3.0, "late": 3.2, "c": 3.1}, jumped={"late": JUMP_UNCHECKABLE})
    t = t.set_index("activity_id")
    assert t.loc["late", "ineligible_reason"] == JUMP_UNCHECKABLE
    assert pd.isna(t.loc["late", "rank"])


def test_the_same_grid_without_the_jump_has_none():
    assert grid_jump_reason(grid_with_a_late_jump(jump_m=0.0), speed_is_measured=False) is None


def test_a_whole_run_jump_the_measured_speed_confirms_is_trusted():
    """40 m over a 4.7 km run is under 1% ahead of a speed channel that never jumped.

    The speed channel is the grid's own steady speeds: 800 s at 4 m/s, the
    one interval across the change averaged to 3.25 m/s by the trapezoid, and
    599 s at 2.5 m/s, 4700.75 m in all, against 4740 m recorded, 0.83% ahead.
    """
    grid = grid_with_a_late_jump()
    grid["speed_mps"] = np.where(grid["t_s"] <= 800, 4.0, 2.5)
    assert grid_jump_reason(grid, speed_is_measured=True) is None


def test_a_whole_run_jump_the_measured_speed_does_not_confirm_is_not_trusted():
    grid = grid_with_a_late_jump(jump_m=200.0)
    grid["speed_mps"] = np.where(grid["t_s"] <= 800, 4.0, 2.5)
    assert grid_jump_reason(grid, speed_is_measured=True) == JUMP_UNCONFIRMED


def test_no_routes_is_two_empty_tables_with_the_columns():
    route_df, runs_df = route_tables(
        [],
        pd.DataFrame(columns=["activity_id", "start_time_utc"]),
        pd.DataFrame(columns=["activity_id", "distance_m", "elapsed_time_s", "is_gpx_sourced"]),
        pd.DataFrame(
            columns=["activity_id", "contains_jump", "speed_distance_m", "distance_trusted"]
        ),
        frozenset(),
    )
    assert route_df.empty and runs_df.empty
    assert "speed_mps" in runs_df.columns and "reference_activity_id" in route_df.columns
