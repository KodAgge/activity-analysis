"""Area geometry for the basemap: synthetic traces with known answers."""

from __future__ import annotations

import math

import numpy as np

from activity_analysis.basemap.areas import (
    METRES_PER_DEGREE_LAT,
    Box,
    area_box,
    area_id,
    plan_areas,
    runs_inside,
    trace_box,
)


def _width_m(box: Box) -> float:
    mid = math.radians((box.south + box.north) / 2)
    return (box.east - box.west) * METRES_PER_DEGREE_LAT * math.cos(mid)


def _height_m(box: Box) -> float:
    return (box.north - box.south) * METRES_PER_DEGREE_LAT


def test_trace_box_ignores_missing_samples():
    lat = np.array([57.70, np.nan, 57.74, 57.72])
    lon = np.array([14.10, 14.60, np.nan, 14.14])
    assert trace_box(lat, lon) == Box(west=14.10, south=57.70, east=14.14, north=57.72)


def test_trace_box_of_no_fix_is_none():
    assert trace_box(np.array([np.nan]), np.array([np.nan])) is None


def test_a_small_trace_grows_to_the_ten_kilometre_floor_and_rounds_outward():
    trace = Box(west=14.150, south=57.730, east=14.156, north=57.733)
    box = area_box(trace)
    assert _width_m(box) >= 10_000
    assert _height_m(box) >= 10_000
    for edge in (box.west, box.south, box.east, box.north):
        assert math.isclose(edge * 100, round(edge * 100), abs_tol=1e-6)
    assert box.contains(trace)


def test_a_large_trace_is_padded_by_three_kilometres_on_every_side():
    trace = Box(west=14.00, south=57.60, east=14.40, north=57.85)
    box = area_box(trace)
    pad_lat = 3000 / METRES_PER_DEGREE_LAT
    assert box.south <= trace.south - pad_lat
    assert box.north >= trace.north + pad_lat
    # Outward rounding adds at most 0.01 degrees beyond the pad.
    assert box.south > trace.south - pad_lat - 0.0101


def test_the_same_box_always_gets_the_same_id():
    box = Box(west=14.79, south=56.83, east=14.97, north=56.94)
    assert area_id(box) == area_id(Box(14.79, 56.83, 14.97, 56.94))
    assert len(area_id(box)) == 12
    assert area_id(box) != area_id(Box(14.79, 56.83, 14.97, 56.95))


def _square(lat: float, lon: float, half_deg: float) -> tuple[np.ndarray, np.ndarray]:
    return (
        np.array([lat - half_deg, lat + half_deg]),
        np.array([lon - half_deg, lon + half_deg]),
    )


def test_a_run_inside_an_existing_area_fetches_nothing():
    existing = Box(13.90, 57.60, 14.50, 57.85)
    plan = plan_areas([existing], {"a": _square(57.73, 14.15, 0.01)})
    assert plan.fetch == []
    assert plan.keep == [existing]


def test_two_runs_far_apart_become_two_areas():
    traces = {
        "near": _square(57.73, 14.15, 0.01),
        "away": _square(56.88, 14.81, 0.01),
    }
    plan = plan_areas([], traces)
    assert len(plan.fetch) == 2
    assert sorted(len(v) for v in plan.covers.values()) == [1, 1]


def test_two_overlapping_runs_merge_into_one_area():
    plan = plan_areas([], {"a": _square(57.70, 14.10, 0.01), "b": _square(57.80, 14.20, 0.01)})
    assert len(plan.fetch) == 1
    assert sorted(plan.covers[area_id(plan.fetch[0])]) == ["a", "b"]


def test_a_run_past_an_existing_edge_absorbs_the_existing_area():
    existing = Box(13.90, 57.60, 14.40, 57.85)
    plan = plan_areas([existing], {"east": _square(57.67, 14.43, 0.01)})
    assert plan.keep == []
    assert len(plan.fetch) == 1
    grown = plan.fetch[0]
    assert grown.contains(existing)
    assert plan.replaced[area_id(grown)] == [area_id(existing)]


def test_no_two_planned_boxes_overlap():
    traces = {f"r{i}": _square(57.70 + 0.05 * i, 14.1 + 0.05 * i, 0.005) for i in range(8)}
    plan = plan_areas([], traces)
    boxes = plan.keep + plan.fetch
    for i, a in enumerate(boxes):
        for b in boxes[i + 1 :]:
            assert not a.overlaps(b)


def test_a_run_inside_an_existing_area_does_not_appear_in_covers():
    existing = Box(13.90, 57.60, 14.40, 57.85)
    traces = {
        "inside": _square(57.73, 14.15, 0.01),
        "east": _square(57.67, 14.43, 0.01),
    }
    plan = plan_areas([existing], traces)
    assert plan.keep == []
    assert len(plan.fetch) == 1
    grown = plan.fetch[0]
    assert grown.contains(existing)
    grown_id = area_id(grown)
    assert plan.covers[grown_id] == ["east"]


def test_runs_inside_counts_every_trace_the_final_box_holds():
    # `covers` records only the run that grew the box; what the grown box
    # holds is every trace inside it, the one already inside the old area too.
    existing = Box(13.90, 57.60, 14.40, 57.85)
    traces = {
        "inside": _square(57.73, 14.15, 0.01),
        "east": _square(57.67, 14.43, 0.01),
        "far": _square(56.88, 14.81, 0.01),
        "no-fix": (np.array([np.nan]), np.array([np.nan])),
    }
    plan = plan_areas([existing], traces)
    grown = next(b for b in plan.fetch if b.contains(existing))
    boxes = {k: trace_box(lat, lon) for k, (lat, lon) in traces.items()}
    assert runs_inside(grown, boxes) == ["east", "inside"]


def test_runs_inside_leaves_out_a_trace_that_crosses_the_edge():
    box = Box(14.10, 57.70, 14.20, 57.80)
    boxes = {
        "in": Box(14.11, 57.71, 14.15, 57.75),
        "across": Box(14.15, 57.75, 14.22, 57.78),
        "none": None,
    }
    assert runs_inside(box, boxes) == ["in"]
