"""Which boxes of map the stored runs need.

An area is a box of tiles covering one or more runs. The box rule sets what
the tile host learns from a request: padded, floored at 10 x 10 km and
rounded outward, a box describes a town rather than a route.
"""

from __future__ import annotations

import hashlib
import math
from collections.abc import Mapping
from dataclasses import dataclass, field

import numpy as np

#: WGS84 mean, the constant ``web/src/charts/Route.tsx`` uses too.
METRES_PER_DEGREE_LAT = 111_320.0
PAD_M = 3_000.0
MIN_SIDE_M = 10_000.0
#: Edges round outward to this many degrees.
GRID_DEG = 0.01


@dataclass(frozen=True, order=True)
class Box:
    west: float
    south: float
    east: float
    north: float

    def contains(self, other: Box) -> bool:
        return (
            self.west <= other.west
            and self.south <= other.south
            and self.east >= other.east
            and self.north >= other.north
        )

    def overlaps(self, other: Box) -> bool:
        return not (
            other.west > self.east
            or other.east < self.west
            or other.south > self.north
            or other.north < self.south
        )

    def union(self, other: Box) -> Box:
        return Box(
            west=min(self.west, other.west),
            south=min(self.south, other.south),
            east=max(self.east, other.east),
            north=max(self.north, other.north),
        )

    def as_bbox_arg(self) -> str:
        return f"{self.west:.2f},{self.south:.2f},{self.east:.2f},{self.north:.2f}"


def trace_box(lat: np.ndarray, lon: np.ndarray) -> Box | None:
    """The bounding box of the finite (lat, lon) pairs, or None without a fix."""
    ok = np.isfinite(lat) & np.isfinite(lon)
    if not ok.any():
        return None
    la, lo = lat[ok], lon[ok]
    return Box(
        west=float(lo.min()), south=float(la.min()), east=float(lo.max()), north=float(la.max())
    )


def _floor_grid(x: float) -> float:
    return math.floor(round(x / GRID_DEG, 6)) * GRID_DEG


def _ceil_grid(x: float) -> float:
    return math.ceil(round(x / GRID_DEG, 6)) * GRID_DEG


def area_box(trace: Box) -> Box:
    """``trace`` padded by 3 km, floored at 10 x 10 km, rounded outward."""
    mid_lat = (trace.south + trace.north) / 2
    m_per_deg_lon = METRES_PER_DEGREE_LAT * math.cos(math.radians(mid_lat))
    pad_lat = PAD_M / METRES_PER_DEGREE_LAT
    pad_lon = PAD_M / m_per_deg_lon
    south, north = trace.south - pad_lat, trace.north + pad_lat
    west, east = trace.west - pad_lon, trace.east + pad_lon

    min_lat = MIN_SIDE_M / METRES_PER_DEGREE_LAT
    if north - south < min_lat:
        centre = (south + north) / 2
        south, north = centre - min_lat / 2, centre + min_lat / 2
    min_lon = MIN_SIDE_M / m_per_deg_lon
    if east - west < min_lon:
        centre = (west + east) / 2
        west, east = centre - min_lon / 2, centre + min_lon / 2

    return Box(
        west=round(_floor_grid(west), 2),
        south=round(_floor_grid(south), 2),
        east=round(_ceil_grid(east), 2),
        north=round(_ceil_grid(north), 2),
    )


def area_id(box: Box) -> str:
    """A short, stable name for a box: the same box always gets the same id."""
    return hashlib.sha256(box.as_bbox_arg().encode()).hexdigest()[:12]


@dataclass
class AreaPlan:
    #: Existing areas that stay as they are.
    keep: list[Box] = field(default_factory=list)
    #: Boxes to extract, new or grown.
    fetch: list[Box] = field(default_factory=list)
    #: New area id -> the existing area ids it absorbs and replaces.
    replaced: dict[str, list[str]] = field(default_factory=dict)
    #: New area id -> the activity ids it was grown for. Merge bookkeeping
    #: only: a run already inside an existing area is not listed, so what a
    #: final box holds is ``runs_inside``'s answer, not this.
    covers: dict[str, list[str]] = field(default_factory=dict)


def plan_areas(
    existing: list[Box], traces: Mapping[str, tuple[np.ndarray, np.ndarray]]
) -> AreaPlan:
    """Which areas to keep and which to fetch so every trace lies inside one box."""
    # Each group is (box, existing boxes it absorbed, activity ids it covers).
    groups: list[tuple[Box, list[Box], list[str]]] = [(b, [b], []) for b in existing]
    for activity_id, (lat, lon) in traces.items():
        box = trace_box(lat, lon)
        if box is None:
            continue
        if any(g[0].contains(box) for g in groups):
            continue
        groups.append((area_box(box), [], [activity_id]))

    merged = True
    while merged:
        merged = False
        for i in range(len(groups)):
            for j in range(i + 1, len(groups)):
                if groups[i][0].overlaps(groups[j][0]):
                    a, b = groups[i], groups[j]
                    groups[i] = (a[0].union(b[0]), a[1] + b[1], a[2] + b[2])
                    del groups[j]
                    merged = True
                    break
            if merged:
                break

    plan = AreaPlan()
    for box, absorbed, activity_ids in groups:
        if absorbed == [box]:
            plan.keep.append(box)
            continue
        plan.fetch.append(box)
        new_id = area_id(box)
        plan.covers[new_id] = sorted(activity_ids)
        if absorbed:
            plan.replaced[new_id] = [area_id(b) for b in absorbed]
    return plan


def runs_inside(box: Box, trace_boxes: Mapping[str, Box | None]) -> list[str]:
    """The ids of the traces that lie wholly inside ``box``, sorted.

    ``trace_boxes`` maps each run to its ``trace_box``, None for a run with
    no fix, which no box holds.
    """
    return sorted(k for k, b in trace_boxes.items() if b is not None and box.contains(b))
