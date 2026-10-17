"""Territory: the ground every outdoor loop run has ever enclosed.

A run claims ground when its last position is within ``CLOSURE_MAX_M`` of its
first. The track is closed with a straight segment back to the start, noded
at every self-crossing, and the bounded faces of the result are the ground it
encloses. Slivers, the faces an out-and-back stretch leaves between its
outbound and return lines, are removed by a morphological opening of radius
``SLIVER_RADIUS_M``. Claimed ground is the union over runs in start-time
order, so each run also records how much of its ground was new, and every
hole of the union no disc of that radius fits in is filled as it forms.

Every area is a true area on the WGS84 ellipsoid, computed in this module's
own ellipsoidal Lambert azimuthal equal-area projection (Snyder 1987,
pp. 182-190). The projection is equal-area everywhere, so a planar area in it
is the ellipsoidal area up to the error of drawing each edge as a straight
chord on the plane, which a plane centred on the shape keeps far below the
0.1% this module is held to.

The thresholds, the projection and every measurement behind them are in
docs/reference/math/territory.md.
"""

from __future__ import annotations

import json
import math
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import numpy.typing as npt
import pandas as pd
import shapely
from shapely.geometry import LineString, MultiPolygon, Polygon, mapping
from shapely.geometry.base import BaseGeometry
from shapely.geometry.polygon import orient
from shapely.ops import polygonize, unary_union

from activity_analysis.analysis.places import nearest_place
from activity_analysis.config import ANALYSIS_VERSION
from activity_analysis.models import (
    TERRITORY_CLAIM_SCHEMA,
    TERRITORY_PART_SCHEMA,
    TERRITORY_REGION_SCHEMA,
    empty_frame,
)

FloatArray = npt.NDArray[np.float64]
Box = tuple[float, float, float, float]

#: WGS84 semi-major axis and flattening, the ellipsoid GPS positions are on.
WGS84_A_M = 6_378_137.0
WGS84_F = 1 / 298.257223563
WGS84_E2 = WGS84_F * (2 - WGS84_F)
WGS84_E = math.sqrt(WGS84_E2)

#: A run closes a loop when its last position is at most this far from its
#: first. Decided on 2026-10-02 from the real store: of 238 outdoor GPS runs,
#: 109 end within 50 m of their start, 153 within 100 m, 185 within 200 m,
#: 188 within 300 m and 216 within 1 km.
CLOSURE_MAX_M = 200.0

#: The radius of the opening that removes slivers: a part of a run's
#: enclosed ground survives only where a disc of this radius fits inside it,
#: so a strip narrower than twice this is removed. Chosen from the width
#: distribution of 10 261 faces on the real store; see
#: docs/reference/math/territory.md, "Slivers".
SLIVER_RADIUS_M = 15.0

#: Arc segments per quarter circle in the opening's buffers. Shapely's
#: default is 8; 16 keeps a rounded corner's polygonal arc within
#: ``1 - cos(pi / 64)``, 0.12%, of the radius.
BUFFER_QUAD_SEGMENTS = 16

#: Two claiming runs belong to one region when the bounding boxes of their
#: tracks come within this of each other, linked run to run. Regions are what
#: the view moves between, and each region's union is taken on one plane
#: about its centre. On the real store the longest link inside a city is
#: 31% of this gap and the shortest between two places 2.6 times it.
REGION_GAP_M = 50_000.0

#: The tolerance a part's display outline is simplified at, in metres on
#: the equal-area plane. Under one CSS pixel at the basemap's maximum zoom;
#: see docs/reference/math/territory.md, "The display outline".
DISPLAY_TOLERANCE_M = 1.0

#: Decimal places a served coordinate keeps: 1e-6 degrees is 0.11 m of
#: latitude, a tenth of ``DISPLAY_TOLERANCE_M``. The outline is snapped to
#: this grid as a whole, which keeps it valid; see ``display_outline``.
COORDINATE_DECIMALS = 6

#: Fewer finite positions than this is no track.
MIN_POSITIONS = 10


# --- The ellipsoidal Lambert azimuthal equal-area projection -----------------


def _q(sin_phi: Any) -> Any:
    """Snyder's ``q``, eq. 3-12: the area from the equator to ``phi``, over ``pi a^2``."""
    e, e2 = WGS84_E, WGS84_E2
    return (1 - e2) * (
        sin_phi / (1 - e2 * sin_phi**2)
        - (1 / (2 * e)) * np.log((1 - e * sin_phi) / (1 + e * sin_phi))
    )


#: ``q`` at the pole, and the authalic radius ``R_q = a sqrt(q_p / 2)``, the
#: radius of the sphere with the ellipsoid's surface area.
_QP = float(_q(1.0))
AUTHALIC_RADIUS_M = WGS84_A_M * math.sqrt(_QP / 2)


def _authalic(phi: Any) -> Any:
    """The authalic latitude ``beta = asin(q / q_p)``, Snyder eq. 3-11."""
    return np.arcsin(np.clip(_q(np.sin(phi)) / _QP, -1.0, 1.0))


def quadrangle_area_m2(lat1_deg: float, lat2_deg: float, dlon_deg: float) -> float:
    """The ellipsoidal area between two parallels and two meridians ``dlon`` apart.

    ``a^2 dlon |q(phi2) - q(phi1)| / 2``, since the zone from the equator to
    ``phi`` has area ``pi a^2 q(phi)`` over the whole circle of longitude.
    Independent of the projection, which is why the tests hold it to this.
    """
    q1 = float(_q(math.sin(math.radians(lat1_deg))))
    q2 = float(_q(math.sin(math.radians(lat2_deg))))
    return WGS84_A_M**2 * math.radians(abs(dlon_deg)) * abs(q2 - q1) / 2


@dataclass(frozen=True)
class EqualArea:
    """The oblique ellipsoidal Lambert azimuthal equal-area plane about one centre.

    ``forward`` takes degrees to metres east and north of the centre,
    ``inverse`` the reverse. Snyder 1987, eqs. 24-13 to 24-21, and 3-18 for
    the series from authalic back to geodetic latitude.
    """

    lat0_deg: float
    lon0_deg: float
    _sin_beta1: float = field(init=False, repr=False)
    _cos_beta1: float = field(init=False, repr=False)
    _d: float = field(init=False, repr=False)

    def __post_init__(self) -> None:
        phi1 = math.radians(self.lat0_deg)
        beta1 = float(_authalic(phi1))
        m1 = math.cos(phi1) / math.sqrt(1 - WGS84_E2 * math.sin(phi1) ** 2)
        object.__setattr__(self, "_sin_beta1", math.sin(beta1))
        object.__setattr__(self, "_cos_beta1", math.cos(beta1))
        object.__setattr__(self, "_d", WGS84_A_M * m1 / (AUTHALIC_RADIUS_M * math.cos(beta1)))

    def forward(self, lat_deg: Any, lon_deg: Any) -> tuple[FloatArray, FloatArray]:
        beta = np.asarray(_authalic(np.radians(np.asarray(lat_deg, dtype=np.float64))))
        dlam = np.radians(np.asarray(lon_deg, dtype=np.float64) - self.lon0_deg)
        sb1, cb1, d = self._sin_beta1, self._cos_beta1, self._d
        cos_c = sb1 * np.sin(beta) + cb1 * np.cos(beta) * np.cos(dlam)
        b = AUTHALIC_RADIUS_M * np.sqrt(2 / (1 + cos_c))
        x = b * d * np.cos(beta) * np.sin(dlam)
        y = (b / d) * (cb1 * np.sin(beta) - sb1 * np.cos(beta) * np.cos(dlam))
        return np.asarray(x, dtype=np.float64), np.asarray(y, dtype=np.float64)

    def inverse(self, x: Any, y: Any) -> tuple[FloatArray, FloatArray]:
        x = np.asarray(x, dtype=np.float64)
        y = np.asarray(y, dtype=np.float64)
        sb1, cb1, d = self._sin_beta1, self._cos_beta1, self._d
        rho = np.hypot(x / d, d * y)
        c = 2 * np.arcsin(np.clip(rho / (2 * AUTHALIC_RADIUS_M), -1.0, 1.0))
        sc, cc = np.sin(c), np.cos(c)
        safe = np.where(rho > 0, rho, 1.0)
        beta = np.arcsin(np.clip(cc * sb1 + np.where(rho > 0, d * y * sc * cb1 / safe, 0.0), -1, 1))
        lam = np.arctan2(x * sc, d * cb1 * cc * rho - d * d * y * sb1 * sc)
        e2 = WGS84_E2
        e4, e6 = e2 * e2, e2 * e2 * e2
        phi = (
            beta
            + (e2 / 3 + 31 * e4 / 180 + 517 * e6 / 5040) * np.sin(2 * beta)
            + (23 * e4 / 360 + 251 * e6 / 3780) * np.sin(4 * beta)
            + (761 * e6 / 45360) * np.sin(6 * beta)
        )
        # The series stops at e^6, which leaves up to a millimetre; two
        # Newton steps on q (Snyder eq. 3-16) take it to rounding.
        q = _QP * np.sin(beta)
        for _ in range(2):
            s = np.sin(phi)
            w = 1 - e2 * s * s
            phi = phi + w * w / (2 * np.cos(phi)) * (
                q / (1 - e2) - s / w + np.log((1 - WGS84_E * s) / (1 + WGS84_E * s)) / (2 * WGS84_E)
            )
        return (
            np.asarray(np.degrees(phi), dtype=np.float64),
            np.asarray(self.lon0_deg + np.degrees(lam), dtype=np.float64),
        )

    def geometry_from(self, geom: BaseGeometry, other: EqualArea) -> BaseGeometry:
        """``geom``, given on ``other``'s plane, on this one."""
        if other == self or geom.is_empty:
            return geom

        def move(xy: FloatArray) -> FloatArray:
            lat, lon = other.inverse(xy[:, 0], xy[:, 1])
            x, y = self.forward(lat, lon)
            return np.column_stack([x, y])

        moved: BaseGeometry = shapely.transform(geom, move)
        return moved


def box_centre(box: Box) -> tuple[float, float]:
    """The middle of a ``(min_lat, min_lon, max_lat, max_lon)`` box, in degrees."""
    return (box[0] + box[2]) / 2, (box[1] + box[3]) / 2


def ellipsoidal_distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Distance between two nearby points on the ellipsoid, in metres.

    The local plane at the mean latitude, scaled by the meridional radius
    ``M`` north-south and by ``N cos(phi)``, the radius of the parallel,
    east-west. At the 200 m ``CLOSURE_MAX_M`` asks about it agrees with the
    WGS84 geodesic to 0.1 micrometre at every latitude to 80 degrees, where
    the sphere ``geo.haversine_m`` models is off by up to 0.56%, 1.1 m.
    """
    phi = math.radians((lat1 + lat2) / 2)
    w = 1 - WGS84_E2 * math.sin(phi) ** 2
    m = WGS84_A_M * (1 - WGS84_E2) / w**1.5
    n = WGS84_A_M / math.sqrt(w)
    return math.hypot(n * math.cos(phi) * math.radians(lon2 - lon1), m * math.radians(lat2 - lat1))


# --- One run's enclosed ground ----------------------------------------------


@dataclass(frozen=True)
class Track:
    """One outdoor run's positions in recorded order, and where it started."""

    activity_id: str
    start_time_utc: pd.Timestamp
    lat: FloatArray
    lon: FloatArray
    locality: str | None = None
    country: str | None = None


def finite_positions(lat: FloatArray, lon: FloatArray) -> tuple[FloatArray, FloatArray]:
    """The positions where both coordinates are finite, in recorded order."""
    ok = np.isfinite(lat) & np.isfinite(lon)
    return np.asarray(lat[ok], dtype=np.float64), np.asarray(lon[ok], dtype=np.float64)


def closure_m(lat: FloatArray, lon: FloatArray) -> float | None:
    """How far the last finite position is from the first, or None for no track."""
    la, lo = finite_positions(lat, lon)
    if la.size < MIN_POSITIONS:
        return None
    return ellipsoidal_distance_m(float(la[0]), float(lo[0]), float(la[-1]), float(lo[-1]))


def polygons(geom: BaseGeometry) -> list[Polygon]:
    """Every polygon in ``geom``, whatever collection shapely returned it in."""
    if geom.is_empty:
        return []
    if isinstance(geom, Polygon):
        return [geom]
    if isinstance(geom, MultiPolygon):
        return list(geom.geoms)
    out: list[Polygon] = []
    for part in getattr(geom, "geoms", []):
        out.extend(polygons(part))
    return out


def bounded_faces(x: FloatArray, y: FloatArray) -> list[Polygon]:
    """Every bounded face of the track closed back to its start.

    The closing segment is straight, end to start. Noding the closed line
    splits it at every self-crossing, so each face is a region the track
    goes around, with no two faces overlapping.
    """
    coords = np.column_stack([x, y])
    if len(coords) < 3:
        return []
    noded = unary_union(LineString(np.vstack([coords, coords[:1]])))
    return list(polygonize(noded))


def faces(x: FloatArray, y: FloatArray) -> BaseGeometry:
    """The union of every bounded face of the track closed back to its start.

    This is the ground the track encloses, however many times and in
    whichever direction it went round. The shoelace area of the raw ring is
    not this: a figure of eight's two lobes cancel in it, and a loop run
    twice counts double.
    """
    found = bounded_faces(x, y)
    return unary_union(found) if found else Polygon()


def open_slivers(geom: BaseGeometry, radius_m: float = SLIVER_RADIUS_M) -> BaseGeometry:
    """``geom`` less every strip narrower than ``2 * radius_m``.

    An opening: erode by ``radius_m``, then dilate back by it. What survives
    the erosion grows back to its own outline except at each convex corner,
    which rounds to the radius: a corner of interior angle ``theta`` loses
    ``r^2 (cot(theta / 2) - (pi - theta) / 2)``, ``(1 - pi / 4) r^2`` at a
    right angle, 48 m^2 at 15 m.
    """
    if radius_m <= 0 or geom.is_empty:
        return geom
    eroded = geom.buffer(-radius_m, quad_segs=BUFFER_QUAD_SEGMENTS)
    if eroded.is_empty:
        return Polygon()
    # Not intersected with the input afterwards, though an opening is always
    # inside what it opens: every buffer vertex lies on its true arc, so the
    # only overshoot is where the erosion's chords round a reflex corner, by
    # the sagitta ``r (1 - cos(pi / 64))``, 1.8 cm at 15 m. The intersection
    # that would remove it cost half the whole pass on the real store.
    opened: BaseGeometry = eroded.buffer(radius_m, quad_segs=BUFFER_QUAD_SEGMENTS)
    return opened


def enclosed_ground(
    x: FloatArray, y: FloatArray, radius_m: float = SLIVER_RADIUS_M
) -> tuple[BaseGeometry, float]:
    """The ground a closed track on a plane encloses, and the sliver area taken off it."""
    raw = faces(x, y)
    kept = open_slivers(raw, radius_m)
    return kept, max(float(raw.area) - float(kept.area), 0.0)


# --- Regions -----------------------------------------------------------------


def _box_gap_m(a: Box, b: Box) -> float:
    """Ground distance between two ``(min_lat, min_lon, max_lat, max_lon)`` boxes.

    Zero when they overlap. The distance between the boxes' nearest points:
    the facing corners when the boxes are apart in latitude, read on the
    local plane at the middle of the latitude gap; otherwise the two points
    on the parallel where their latitudes overlap farthest from the equator,
    where a degree of longitude is shortest. At gaps of 40 to 60 km it agrees
    with the WGS84 geodesic between the nearest points to 0.004% up to 60
    degrees and 0.010% up to 70; see docs/reference/math/territory.md,
    "Regions".
    """
    lon_gap = max(0.0, max(a[1], b[1]) - min(a[3], b[3]))
    top_of_lower = min(a[2], b[2])
    bottom_of_upper = max(a[0], b[0])
    if bottom_of_upper > top_of_lower:
        return ellipsoidal_distance_m(top_of_lower, 0.0, bottom_of_upper, lon_gap)
    poleward = max(top_of_lower, bottom_of_upper, key=abs)
    return ellipsoidal_distance_m(poleward, 0.0, poleward, lon_gap)


def group_regions(boxes: Sequence[Box]) -> list[int]:
    """A region index for each box: single linkage at ``REGION_GAP_M``.

    Regions are numbered from 0 in the order of each region's first box.
    """
    parent = list(range(len(boxes)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(len(boxes)):
        for j in range(i + 1, len(boxes)):
            if _box_gap_m(boxes[i], boxes[j]) <= REGION_GAP_M:
                ri, rj = find(i), find(j)
                parent[max(ri, rj)] = min(ri, rj)
    number: dict[int, int] = {}
    return [number.setdefault(find(i), len(number)) for i in range(len(boxes))]


# --- Holes and the display outline --------------------------------------------


def fill_thin_holes(geom: BaseGeometry, radius_m: float = SLIVER_RADIUS_M) -> BaseGeometry:
    """``geom`` with every hole no disc of radius ``radius_m`` fits in filled.

    The sliver rule turned inward: a hole the opening that removes slivers
    would erase entirely is unclaimed ground narrower than ``2 * radius_m``
    everywhere, which is no more ground than a sliver is. The union leaves
    such holes wherever two claims meet along a seam their tracks drew a few
    centimetres apart.

    The unclaimed ground a hole holds, its pocket, is the hole less the
    filled outline of every other part of ``geom`` inside it, an island. The
    outline and not the island itself, because an island's own holes are
    ground of their own, judged as holes of the island: subtracting only the
    island would leave its courtyard in the pocket, and a narrow moat round
    a wide courtyard would test as wide. A thin pocket is filled by adding
    it to ``geom``, so the island merges with the part round it and keeps
    its courtyards, which a part rebuilt without the hole would paint over.

    An island touching the ring at points cuts the pocket into pieces, and
    each piece is unclaimed ground of its own, judged on its own: a disc
    fitting in one piece does not keep a thin one. A piece a disc does fit
    in is kept whole, as the tracks drew it.
    """
    if radius_m <= 0 or geom.is_empty:
        return geom
    parts = polygons(geom)
    pockets: list[BaseGeometry] = []
    for poly in parts:
        for ring in poly.interiors:
            hole = Polygon(ring)
            islands = [
                Polygon(q.exterior)
                for q in parts
                if q is not poly and hole.contains(q.representative_point())
            ]
            pocket = hole.difference(unary_union(islands)) if islands else hole
            pockets.extend(
                piece
                for piece in polygons(pocket)
                if piece.buffer(-radius_m, quad_segs=BUFFER_QUAD_SEGMENTS).is_empty
            )
    if not pockets:
        return geom
    filled: BaseGeometry = unary_union([geom, *pockets])
    return filled


def display_outline(poly: Polygon, plane: EqualArea, tolerance_m: float) -> BaseGeometry:
    """A part's outline for the map: valid ``[lon, lat]`` degrees on the served grid.

    Simplified at ``tolerance_m`` on ``plane``, taken back to degrees, then
    snapped to the ``10^-COORDINATE_DECIMALS`` degree grid with GEOS's
    precision reducer, which keeps the result valid where plain rounding
    would not: two edges closer than a grid step, as at a seam, can cross
    once each vertex is rounded on its own, and a ring thinner than a step
    collapses to a line. Collapsed rings are dropped, and a neck thinner
    than a step splits the part, so the result is a Polygon or, rarely, a
    MultiPolygon. Every exterior is anticlockwise and every hole clockwise,
    the winding RFC 7946 asks for.
    """
    shown = poly.simplify(tolerance_m, preserve_topology=True)
    if not isinstance(shown, Polygon) or shown.is_empty:
        shown = poly

    def to_degrees(xy: FloatArray) -> FloatArray:
        lat, lon = plane.inverse(xy[:, 0], xy[:, 1])
        return np.column_stack([lon, lat])

    degrees = shapely.transform(shown, to_degrees)
    snapped = shapely.set_precision(degrees, 10.0**-COORDINATE_DECIMALS)
    pieces = [orient(p, sign=1.0) for p in polygons(snapped) if p.area > 0]
    if len(pieces) == 1:
        return pieces[0]
    return MultiPolygon(pieces)


# --- The whole history -------------------------------------------------------


@dataclass
class Territory:
    """What ``claim_territory`` found, one list of rows per derived table."""

    claims: list[dict[str, Any]]
    regions: list[dict[str, Any]]
    parts: list[dict[str, Any]]


@dataclass
class _Claim:
    track: Track
    box: Box
    plane: EqualArea
    ground: BaseGeometry


def _most_common(values: Sequence[str | None]) -> str | None:
    counted = Counter(v for v in values if v)
    return min(counted, key=lambda v: (-counted[v], v)) if counted else None


def claim_territory(
    tracks: Sequence[Track],
    *,
    radius_m: float = SLIVER_RADIUS_M,
    tolerance_m: float = DISPLAY_TOLERANCE_M,
) -> Territory:
    """Every run's claim, and the union they build, in start-time order.

    ``claims`` has one row per track: its closure and, for a loop, its
    enclosed, new and cumulative area. ``regions`` and ``parts`` describe
    the union at the end of the history.
    """
    ordered = sorted(tracks, key=lambda t: (t.start_time_utc, t.activity_id))
    rows: dict[str, dict[str, Any]] = {}
    claiming: list[_Claim] = []
    for t in ordered:
        gap = closure_m(t.lat, t.lon)
        closes = gap is not None and gap <= CLOSURE_MAX_M
        row: dict[str, Any] = {
            "activity_id": t.activity_id,
            "start_time_utc": t.start_time_utc,
            "closure_m": gap,
            "closes_loop": closes,
            "region_id": None,
            "enclosed_m2": None,
            "sliver_m2": None,
            "new_m2": None,
            "cumulative_m2": None,
        }
        rows[t.activity_id] = row
        if not closes:
            continue
        la, lo = finite_positions(t.lat, t.lon)
        box = (float(la.min()), float(lo.min()), float(la.max()), float(lo.max()))
        # Each run on a plane centred on its own track first, so its own
        # area is read where the chord error is smallest.
        plane = EqualArea(*box_centre(box))
        ground, sliver = enclosed_ground(*plane.forward(la, lo), radius_m)
        row["enclosed_m2"] = float(ground.area)
        row["sliver_m2"] = sliver
        row["new_m2"] = 0.0
        if ground.area > 0:
            claiming.append(_Claim(t, box, plane, ground))

    region_of = group_regions([c.box for c in claiming])
    members: dict[int, list[_Claim]] = {}
    for claim, r in zip(claiming, region_of, strict=True):
        members.setdefault(r, []).append(claim)

    # One plane per region, about the middle of its runs' boxes, so that its
    # union is taken on a single plane.
    region_planes: dict[int, EqualArea] = {}
    for r, cs in members.items():
        lat0, lon0 = box_centre(
            (
                min(c.box[0] for c in cs),
                min(c.box[1] for c in cs),
                max(c.box[2] for c in cs),
                max(c.box[3] for c in cs),
            )
        )
        region_planes[r] = EqualArea(lat0, lon0)

    unions: dict[int, BaseGeometry] = {r: Polygon() for r in members}
    total = 0.0
    loops = [rows[t.activity_id] for t in ordered if rows[t.activity_id]["closes_loop"]]
    by_id = {c.track.activity_id: (c, r) for c, r in zip(claiming, region_of, strict=True)}
    for row in loops:
        hit = by_id.get(row["activity_id"])
        if hit is not None:
            claim, r = hit
            ground = region_planes[r].geometry_from(claim.ground, claim.plane)
            before = float(unions[r].area)
            unions[r] = fill_thin_holes(unions[r].union(ground), radius_m)
            new = max(float(unions[r].area) - before, 0.0)
            total += new
            row["new_m2"] = new
            row["region_id"] = members[r][0].track.activity_id
        row["cumulative_m2"] = total

    regions: list[dict[str, Any]] = []
    parts: list[dict[str, Any]] = []
    for r in sorted(members):
        cs = members[r]
        region_id = cs[0].track.activity_id
        plane = region_planes[r]
        part_rows: list[dict[str, Any]] = []
        for poly in polygons(unions[r]):
            shown = display_outline(poly, plane, tolerance_m)
            min_lon, min_lat, max_lon, max_lat = shown.bounds
            part_rows.append(
                {
                    "region_id": region_id,
                    "area_m2": float(poly.area),
                    "vertex_count": int(shapely.get_num_coordinates(shown)),
                    "min_lat": float(min_lat),
                    "min_lon": float(min_lon),
                    "max_lat": float(max_lat),
                    "max_lon": float(max_lon),
                    "geometry_geojson": json.dumps(mapping(shown), separators=(",", ":")),
                }
            )
        part_rows.sort(key=lambda p: (-p["area_m2"], p["min_lon"], p["min_lat"]))
        for k, p in enumerate(part_rows):
            p["part_index"] = k
        parts.extend(part_rows)
        box = (
            min(p["min_lat"] for p in part_rows),
            min(p["min_lon"] for p in part_rows),
            max(p["max_lat"] for p in part_rows),
            max(p["max_lon"] for p in part_rows),
        )
        locality = _most_common([c.track.locality for c in cs])
        country = _most_common([c.track.country for c in cs])
        if locality is None:
            place = nearest_place(*box_centre(box))
            locality = None if place is None else place.locality
            country = country if place is None else place.country
        regions.append(
            {
                "region_id": region_id,
                "name": locality or "Region",
                "locality": locality,
                "country": country,
                "area_m2": float(sum(p["area_m2"] for p in part_rows)),
                "part_count": len(part_rows),
                "claim_count": len(cs),
                "first_claim_utc": cs[0].track.start_time_utc,
                "last_claim_utc": cs[-1].track.start_time_utc,
                "min_lat": box[0],
                "min_lon": box[1],
                "max_lat": box[2],
                "max_lon": box[3],
            }
        )

    # Two regions that would share a name take " A", " B" by area, the
    # convention route names follow.
    counts = Counter(reg["name"] for reg in regions)
    seen: Counter[str] = Counter()
    for reg in sorted(regions, key=lambda g: (-g["area_m2"], g["region_id"])):
        base = reg["name"]
        if counts[base] > 1:
            reg["name"] = f"{base} {chr(ord('A') + seen[base])}"
            seen[base] += 1
    regions.sort(key=lambda g: (-g["area_m2"], g["region_id"]))

    return Territory(claims=[rows[t.activity_id] for t in ordered], regions=regions, parts=parts)


def territory_tables(territory: Territory) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """The ``territory_claims``, ``territory_regions`` and ``territory_parts`` rows."""
    frames = []
    for rows, schema in (
        (territory.claims, TERRITORY_CLAIM_SCHEMA),
        (territory.regions, TERRITORY_REGION_SCHEMA),
        (territory.parts, TERRITORY_PART_SCHEMA),
    ):
        if not rows:
            frames.append(empty_frame(schema))
            continue
        frame = pd.DataFrame([{**row, "analysis_version": ANALYSIS_VERSION} for row in rows])
        frames.append(frame[schema.names])
    return frames[0], frames[1], frames[2]
