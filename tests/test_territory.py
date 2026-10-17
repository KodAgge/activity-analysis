"""Territory geometry and accounting, on synthetic loops with analytic answers."""

from __future__ import annotations

import json
import math

import numpy as np
import pandas as pd
import pytest
from shapely.geometry import Polygon, box, shape
from shapely.ops import unary_union

from activity_analysis.analysis.territory import (
    BUFFER_QUAD_SEGMENTS,
    CLOSURE_MAX_M,
    SLIVER_RADIUS_M,
    WGS84_A_M,
    WGS84_E2,
    EqualArea,
    Track,
    _box_gap_m,
    bounded_faces,
    claim_territory,
    closure_m,
    display_outline,
    ellipsoidal_distance_m,
    enclosed_ground,
    fill_thin_holes,
    group_regions,
    polygons,
    quadrangle_area_m2,
    territory_tables,
)
from activity_analysis.models import (
    TERRITORY_CLAIM_SCHEMA,
    TERRITORY_PART_SCHEMA,
    TERRITORY_REGION_SCHEMA,
)
from tests.territory_outlines import assert_valid_outlines, shoelace

JONKOPING = (57.77, 14.18)
VAXJO = (56.88, 14.81)
T0 = pd.Timestamp("2026-01-01T08:00:00Z")
#: What a right-angled corner loses to the opening: ``(1 - pi / 4) r^2``.
RIGHT_CORNER_M2 = (1 - math.pi / 4) * SLIVER_RADIUS_M**2


def corner_loss_m2(theta: float, r: float = SLIVER_RADIUS_M) -> float:
    """The area an opening of radius ``r`` takes off a convex corner of interior angle ``theta``."""
    return r * r * (1 / math.tan(theta / 2) - (math.pi - theta) / 2)


def meridional_radius_m(lat_deg: float) -> float:
    return WGS84_A_M * (1 - WGS84_E2) / (1 - WGS84_E2 * math.sin(math.radians(lat_deg)) ** 2) ** 1.5


def densify(points: list[tuple[float, float]], step: float) -> tuple[np.ndarray, np.ndarray]:
    """A polyline through ``points`` with a vertex at least every ``step``, first to last."""
    xs: list[float] = []
    ys: list[float] = []
    for (x0, y0), (x1, y1) in zip(points[:-1], points[1:], strict=True):
        n = max(1, math.ceil(math.hypot(x1 - x0, y1 - y0) / step))
        t = np.arange(n) / n
        xs.extend(x0 + (x1 - x0) * t)
        ys.extend(y0 + (y1 - y0) * t)
    xs.append(points[-1][0])
    ys.append(points[-1][1])
    return np.array(xs), np.array(ys)


def track_from_xy(
    x: np.ndarray,
    y: np.ndarray,
    *,
    centre: tuple[float, float] = JONKOPING,
    activity_id: str = "a",
    start: pd.Timestamp = T0,
    locality: str | None = "Jönköping",
) -> Track:
    """Metres east and north of ``centre`` as a track, through the module's own plane."""
    lat, lon = EqualArea(*centre).inverse(x, y)
    return Track(activity_id, start, lat, lon, locality, "Sweden")


def square(side: float, *, dx: float = 0.0, dy: float = 0.0, step: float = 3.0):
    """An anticlockwise square loop starting and ending at its south-west corner."""
    corners = [(0, 0), (side, 0), (side, side), (0, side), (0, 0)]
    return densify([(cx + dx, cy + dy) for cx, cy in corners], step)


def rectangle(x0: float, y0: float, x1: float, y1: float, step: float = 3.0):
    """An anticlockwise rectangular loop starting and ending at ``(x0, y0)``."""
    return densify([(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)], step)


# --- The projection ----------------------------------------------------------


def test_the_quadrangle_formula_gives_the_wgs84_surface_area():
    """An independent check on ``q``: the whole ellipsoid is 510 065 621.7 km^2."""
    assert quadrangle_area_m2(-90, 90, 360) == pytest.approx(5.100656217e14, rel=1e-9)


@pytest.mark.parametrize("lat0", [0.0, 37.0, 57.77, 69.0, -34.0])
def test_the_projection_round_trips_to_under_a_micrometre(lat0: float):
    plane = EqualArea(lat0, 14.0)
    rng = np.random.default_rng(1)
    lat = lat0 + rng.uniform(-0.3, 0.3, 500)
    lon = 14.0 + rng.uniform(-0.5, 0.5, 500)
    back_lat, back_lon = plane.inverse(*plane.forward(lat, lon))
    m = meridional_radius_m(lat0)
    assert np.abs(back_lat - lat).max() * math.pi / 180 * m < 1e-6
    assert np.abs(back_lon - lon).max() * math.pi / 180 * m < 1e-6


def test_the_centre_projects_to_the_origin():
    x, y = EqualArea(*JONKOPING).forward(np.array([JONKOPING[0]]), np.array([JONKOPING[1]]))
    assert abs(x[0]) < 1e-9 and abs(y[0]) < 1e-9


@pytest.mark.parametrize(
    ("lat1", "dlat", "dlon"), [(57.8, 0.01, 0.02), (0.0, 0.1, 0.1), (45, 0.3, 0.4)]
)
def test_a_planar_area_on_the_projection_is_the_ellipsoidal_area(lat1, dlat, dlon):
    """A quadrangle bounded by parallels and meridians, drawn densely, centred off its middle."""
    n = 400
    lat = np.concatenate(
        [
            np.full(n, lat1),
            np.linspace(lat1, lat1 + dlat, n),
            np.full(n, lat1 + dlat),
            np.linspace(lat1 + dlat, lat1, n),
        ]
    )
    lon = np.concatenate(
        [
            np.linspace(10, 10 + dlon, n),
            np.full(n, 10 + dlon),
            np.linspace(10 + dlon, 10, n),
            np.full(n, 10.0),
        ]
    )
    plane = EqualArea(lat1 + dlat * 0.8, 10 + dlon * 0.1)
    area = Polygon(np.column_stack(plane.forward(lat, lon))).area
    assert area == pytest.approx(quadrangle_area_m2(lat1, lat1 + dlat, dlon), rel=1e-6)


def test_the_ellipsoidal_distance_matches_the_textbook_degree_lengths():
    """1 degree of latitude is 110 574 m at the equator and 111 412 m at 60 N."""
    assert ellipsoidal_distance_m(0, 0, 0.001, 0) * 1000 == pytest.approx(110_574, abs=1)
    assert ellipsoidal_distance_m(60, 0, 60.001, 0) * 1000 == pytest.approx(111_412, abs=1)
    assert ellipsoidal_distance_m(0, 0, 0, 0.001) * 1000 == pytest.approx(111_319, abs=1)


# --- One run's enclosed ground -----------------------------------------------


def test_a_geodesic_box_claims_its_ellipsoidal_area():
    """A box between two parallels and two meridians, about 1.1 x 1.2 km near Jönköping."""
    lat1, lon1, dlat, dlon = 57.77, 14.18, 0.01, 0.02
    lat, lon = [], []
    for (a0, o0), (a1, o1) in [
        ((lat1, lon1), (lat1, lon1 + dlon)),
        ((lat1, lon1 + dlon), (lat1 + dlat, lon1 + dlon)),
        ((lat1 + dlat, lon1 + dlon), (lat1 + dlat, lon1)),
        ((lat1 + dlat, lon1), (lat1, lon1)),
    ]:
        lat.extend(np.linspace(a0, a1, 400, endpoint=False))
        lon.extend(np.linspace(o0, o1, 400, endpoint=False))
    lat.append(lat1)
    lon.append(lon1)
    expected = quadrangle_area_m2(lat1, lat1 + dlat, dlon)
    run = Track("box", T0, np.array(lat), np.array(lon), "Jönköping")

    exact = claim_territory([run], radius_m=0.0)
    assert exact.claims[0]["enclosed_m2"] == pytest.approx(expected, rel=1e-6)
    assert exact.regions[0]["area_m2"] == pytest.approx(expected, rel=1e-6)

    opened = claim_territory([run]).claims[0]["enclosed_m2"]
    assert opened == pytest.approx(expected, rel=1e-3)
    assert opened == pytest.approx(expected - 4 * RIGHT_CORNER_M2, abs=5.0)


def test_a_figure_of_eight_claims_both_lobes_though_its_shoelace_cancels():
    """The lemniscate of Gerono, ``x = a cos t, y = a sin t cos t``, encloses ``4 a^2 / 3``."""
    a = 500.0
    t = np.linspace(0, 2 * math.pi, 4001)
    x, y = a * np.cos(t), a * np.sin(t) * np.cos(t)
    shoelace = 0.5 * float(np.sum(x[:-1] * y[1:] - x[1:] * y[:-1]))
    assert abs(shoelace) < 1.0

    ground, _ = enclosed_ground(x, y, 0.0)
    assert ground.area == pytest.approx(4 * a * a / 3, rel=1e-5)
    # Both lobes taper to a right angle at the crossing, which the opening rounds.
    opened, _ = enclosed_ground(x, y)
    assert opened.area == pytest.approx(4 * a * a / 3, rel=1e-3)


def test_a_loop_crossing_its_own_start_claims_both_faces_and_no_hole():
    """An alpha: a square, entered across its bottom edge, left down its left edge.

    The crossing at the square's corner closes a small right triangle with the
    closing segment, wound the other way round from the square, so the shoelace
    area is ``L^2 - a^2 / 2`` while the ground enclosed is ``L^2 + a^2 / 2``.
    """
    side, a = 1000.0, 100.0
    x, y = densify([(-a, 0), (side, 0), (side, side), (0, side), (0, -a)], 3.0)
    shoelace = 0.5 * float(np.sum(x[:-1] * y[1:] - x[1:] * y[:-1]) + (x[-1] * y[0] - x[0] * y[-1]))
    assert shoelace == pytest.approx(side * side - a * a / 2, rel=1e-9)

    ground, _ = enclosed_ground(x, y, 0.0)
    assert ground.area == pytest.approx(side * side + a * a / 2, rel=1e-9)
    assert all(len(p.interiors) == 0 for p in getattr(ground, "geoms", [ground]))

    # Four right corners on the square, and the triangle's right angle and
    # two 45 degree corners.
    opened, _ = enclosed_ground(x, y)
    expected = side * side + a * a / 2 - 5 * RIGHT_CORNER_M2 - 2 * corner_loss_m2(math.pi / 4)
    assert opened.area == pytest.approx(expected, abs=5.0)


def test_a_loop_run_twice_claims_its_ground_once():
    x1, y1 = square(1000.0)
    x, y = np.concatenate([x1, x1[1:]]), np.concatenate([y1, y1[1:]])
    ground, _ = enclosed_ground(x, y, 0.0)
    assert ground.area == pytest.approx(1e6, rel=1e-9)


def test_the_faces_are_the_regions_the_noded_track_bounds_one_by_one():
    """Each face once: two lobes of ``2 a^2 / 3``, a square and a triangle, one square."""
    a = 500.0
    t = np.linspace(0, 2 * math.pi, 4001)
    lobes = sorted(f.area for f in bounded_faces(a * np.cos(t), a * np.sin(t) * np.cos(t)))
    assert lobes == pytest.approx([2 * a * a / 3] * 2, rel=1e-5)

    side, leg = 1000.0, 100.0
    x, y = densify([(-leg, 0), (side, 0), (side, side), (0, side), (0, -leg)], 3.0)
    alpha = sorted(f.area for f in bounded_faces(x, y))
    assert alpha == pytest.approx([leg * leg / 2, side * side], rel=1e-9)

    x1, y1 = square(1000.0)
    twice = bounded_faces(np.concatenate([x1, x1[1:]]), np.concatenate([y1, y1[1:]]))
    assert [f.area for f in twice] == pytest.approx([1e6], rel=1e-9)

    assert bounded_faces(np.array([0.0, 1.0]), np.array([0.0, 1.0])) == []


@pytest.mark.parametrize(("end_offset_m", "closes"), [(199.0, True), (201.0, False)])
def test_a_loop_closes_at_200_m_and_not_beyond(end_offset_m: float, closes: bool):
    """The last position moved due north of the first by a meridian arc of known length."""
    x, y = square(1000.0)
    run = track_from_xy(x, y)
    lat, lon = run.lat.copy(), run.lon.copy()
    lat[-1] = lat[0] + math.degrees(end_offset_m / meridional_radius_m(lat[0]))
    lon[-1] = lon[0]
    assert closure_m(lat, lon) == pytest.approx(end_offset_m, abs=0.01)

    claim = claim_territory([Track("a", T0, lat, lon, "Jönköping")]).claims[0]
    assert claim["closes_loop"] is closes
    assert (claim["enclosed_m2"] is not None) is closes
    assert CLOSURE_MAX_M == 200.0


def test_an_out_and_back_encloses_only_a_sliver_and_claims_nothing():
    """Outbound and return 8 m apart, the gap GPS noise leaves on one path."""
    x, y = densify([(0, 0), (2000, 0), (2000, 8), (0, 8), (0, 0)], 3.0)
    run = track_from_xy(x, y)
    territory = claim_territory([run])
    claim = territory.claims[0]
    assert claim["closes_loop"] is True
    assert claim["enclosed_m2"] == 0.0
    assert claim["sliver_m2"] == pytest.approx(2000 * 8, rel=1e-6)
    assert claim["region_id"] is None
    assert territory.regions == [] and territory.parts == []


def test_a_strip_wider_than_twice_the_radius_is_kept():
    width = 2 * SLIVER_RADIUS_M + 10
    x, y = densify([(0, 0), (2000, 0), (2000, width), (0, width), (0, 0)], 3.0)
    ground, sliver = enclosed_ground(x, y)
    assert ground.area == pytest.approx(2000 * width - 4 * RIGHT_CORNER_M2, abs=5.0)
    assert sliver == pytest.approx(4 * RIGHT_CORNER_M2, abs=5.0)


def test_a_track_with_too_few_positions_is_not_a_loop():
    run = Track("a", T0, np.full(5, JONKOPING[0]), np.full(5, JONKOPING[1]))
    claim = claim_territory([run]).claims[0]
    assert claim["closure_m"] is None and claim["closes_loop"] is False


def test_positions_missing_from_the_grid_are_skipped():
    x, y = square(1000.0)
    run = track_from_xy(x, y)
    lat, lon = run.lat.copy(), run.lon.copy()
    lat[:3] = np.nan
    lon[-3:] = np.nan
    claim = claim_territory([Track("a", T0, lat, lon)], radius_m=0.0).claims[0]
    assert claim["closes_loop"] is True
    assert claim["enclosed_m2"] == pytest.approx(1e6, rel=1e-3)


# --- The union over the history ------------------------------------------------


def test_two_overlapping_loops_count_the_overlap_once():
    side = 1000.0
    first = track_from_xy(*square(side), activity_id="first", start=T0)
    second = track_from_xy(
        *square(side, dx=side / 2), activity_id="second", start=T0 + pd.Timedelta(days=1)
    )
    territory = claim_territory([first, second])
    a, b = territory.claims
    assert a["new_m2"] == pytest.approx(side * side, rel=1e-3)
    assert b["enclosed_m2"] == pytest.approx(side * side, rel=1e-3)
    assert b["new_m2"] == pytest.approx(side * side / 2, rel=1e-3)
    assert b["cumulative_m2"] == pytest.approx(1.5 * side * side, rel=1e-3)
    assert territory.regions[0]["area_m2"] == pytest.approx(b["cumulative_m2"], rel=1e-9)
    assert len(territory.parts) == 1


def test_claims_are_accounted_in_start_time_order_whatever_order_they_arrive_in():
    side = 1000.0
    early = track_from_xy(*square(side, dx=side / 2), activity_id="zzz", start=T0)
    late = track_from_xy(*square(side), activity_id="aaa", start=T0 + pd.Timedelta(hours=1))
    territory = claim_territory([late, early])
    assert [c["activity_id"] for c in territory.claims] == ["zzz", "aaa"]
    assert territory.claims[0]["new_m2"] == pytest.approx(side * side, rel=1e-3)
    assert territory.claims[1]["new_m2"] == pytest.approx(side * side / 2, rel=1e-3)
    assert territory.regions[0]["region_id"] == "zzz"


def test_a_loop_inside_earlier_ground_claims_nothing_new():
    outer = track_from_xy(*square(2000.0), activity_id="outer", start=T0)
    inner = track_from_xy(
        *square(500.0, dx=500, dy=500), activity_id="inner", start=T0 + pd.Timedelta(days=1)
    )
    territory = claim_territory([outer, inner])
    claim = territory.claims[1]
    assert claim["enclosed_m2"] > 0
    assert claim["new_m2"] == pytest.approx(0.0, abs=1e-3)
    assert claim["region_id"] == "outer"
    assert claim["cumulative_m2"] == pytest.approx(territory.claims[0]["cumulative_m2"])


def test_distant_loops_are_separate_regions_and_near_ones_separate_parts():
    near_a = track_from_xy(*square(1000.0), activity_id="jkpg1", start=T0)
    near_b = track_from_xy(
        *square(1000.0, dx=5000), activity_id="jkpg2", start=T0 + pd.Timedelta(days=1)
    )
    far = track_from_xy(
        *square(1000.0),
        centre=VAXJO,
        activity_id="vaxjo",
        start=T0 + pd.Timedelta(days=2),
        locality="Växjö",
    )
    territory = claim_territory([near_a, near_b, far])
    regions = {r["region_id"]: r for r in territory.regions}
    assert set(regions) == {"jkpg1", "vaxjo"}
    assert regions["jkpg1"]["name"] == "Jönköping"
    assert regions["vaxjo"]["name"] == "Växjö"
    assert regions["jkpg1"]["part_count"] == 2 and regions["jkpg1"]["claim_count"] == 2
    assert regions["vaxjo"]["part_count"] == 1
    assert regions["jkpg1"]["area_m2"] == pytest.approx(2e6, rel=1e-3)
    assert regions["jkpg1"]["min_lat"] <= JONKOPING[0] <= regions["jkpg1"]["max_lat"]
    assert regions["vaxjo"]["min_lon"] <= VAXJO[1] <= regions["vaxjo"]["max_lon"]
    assert [c["region_id"] for c in territory.claims] == ["jkpg1", "jkpg1", "vaxjo"]
    assert territory.claims[-1]["cumulative_m2"] == pytest.approx(3e6, rel=1e-3)
    assert [p["part_index"] for p in territory.parts if p["region_id"] == "jkpg1"] == [0, 1]


def test_regions_link_at_50_km_between_boxes():
    deg_per_km = 1 / 111.32
    box = (57.0, 14.0, 57.01, 14.01)
    inside = (57.01 + 49 * deg_per_km, 14.0, 57.02 + 49 * deg_per_km, 14.01)
    outside = (57.01 + 51 * deg_per_km, 14.0, 57.02 + 51 * deg_per_km, 14.01)
    assert group_regions([box, inside]) == [0, 0]
    assert group_regions([box, outside]) == [0, 1]


@pytest.mark.parametrize(
    ("a", "b", "geodesic_m"),
    [
        # Apart in latitude at 70 N: the facing corners, (70.0, 10.0) and (70.3, 11.0).
        ((69.9, 9.9, 70.0, 10.0), (70.3, 11.0, 70.4, 11.1), 50_570.65),
        # Latitudes overlapping from 59.8 to 60.0: the parallel at 60.0, not at 59.9.
        ((59.5, 14.0, 60.0, 14.1), (59.8, 15.0, 60.3, 15.1), 50_218.45),
        # The same south of the equator, where the poleward end of the overlap is its minimum.
        ((-60.0, 14.0, -59.5, 14.1), (-60.3, 15.0, -59.8, 15.1), 50_218.45),
    ],
)
def test_the_box_gap_is_the_geodesic_between_the_nearest_points(a, b, geodesic_m):
    """Against the WGS84 geodesic between the boxes' nearest points.

    The expected values are GeographicLib's, through pyproj 3.8, minimised
    over both boxes' boundaries on 2026-10-03. The ellipsoid is symmetric
    about its axis, so they hold for the same boxes moved along a parallel.
    Reading the parallel scale at the wrong latitude, the upper box's bottom
    edge or the middle of the overlap, is off by 0.3 to 0.4% in these three
    cases.
    """
    assert _box_gap_m(a, b) == pytest.approx(geodesic_m, rel=1e-4)
    assert _box_gap_m(b, a) == _box_gap_m(a, b)


def test_a_region_whose_runs_name_no_place_is_named_from_the_bundled_table():
    run = track_from_xy(*square(1000.0), centre=VAXJO, locality=None)
    run = Track(run.activity_id, run.start_time_utc, run.lat, run.lon, None, None)
    region = claim_territory([run]).regions[0]
    assert region["name"] == "Växjö" and region["country"] == "Sweden"


def test_the_display_outline_is_wound_and_placed_as_geojson_asks():
    run = track_from_xy(*square(1000.0))
    part = claim_territory([run]).parts[0]
    geo = json.loads(part["geometry_geojson"])
    assert geo["type"] == "Polygon"
    ring = np.array(geo["coordinates"][0])
    assert (ring[0] == ring[-1]).all()
    # Anticlockwise in [lon, lat]: a positive shoelace.
    assert float(np.sum(ring[:-1, 0] * ring[1:, 1] - ring[1:, 0] * ring[:-1, 1])) > 0
    lat, lon = ring[:, 1], ring[:, 0]
    assert lat.min() == pytest.approx(JONKOPING[0], abs=1e-4)
    assert lon.min() == pytest.approx(JONKOPING[1], abs=1e-4)
    shown = Polygon(np.column_stack(EqualArea(*JONKOPING).forward(lat, lon))).area
    assert shown == pytest.approx(part["area_m2"], rel=1e-3)
    assert part["vertex_count"] == sum(len(r) for r in geo["coordinates"])
    assert shape(geo).is_valid


# --- Holes and the served outline ---------------------------------------------


def test_a_hole_no_disc_of_the_sliver_radius_fits_in_is_filled():
    """A 2 by 100 m pocket inside a 500 m square is no more ground than a sliver."""
    pocket = [(100, 100), (200, 100), (200, 102), (100, 102)]
    filled = fill_thin_holes(Polygon(box(0, 0, 500, 500).exterior, [pocket]))
    assert isinstance(filled, Polygon) and not filled.interiors
    assert filled.area == pytest.approx(500 * 500)


def test_a_hole_a_disc_of_the_sliver_radius_fits_in_is_kept_as_drawn():
    pocket = [(100, 100), (140, 100), (140, 140), (100, 140)]
    kept = fill_thin_holes(Polygon(box(0, 0, 500, 500).exterior, [pocket]))
    assert len(kept.interiors) == 1
    assert kept.area == pytest.approx(500 * 500 - 40 * 40)


def test_filling_a_hole_merges_an_island_inside_it():
    ring = Polygon(box(0, 0, 500, 500).exterior, [[(100, 100), (400, 100), (400, 400), (100, 400)]])
    # A 300 m courtyard with a 296 m island in it: the moat is 2 m wide.
    union = unary_union([ring, box(102, 102, 398, 398)])
    assert union.geom_type == "MultiPolygon"
    filled = fill_thin_holes(union)
    assert isinstance(filled, Polygon) and not filled.interiors
    assert filled.area == pytest.approx(500 * 500)


def test_moats_are_filled_at_every_level_of_nested_islands_and_the_innermost_courtyard_kept():
    """Three rings, each 2 m inside the hole of the one round it.

    A 500 m square with a 300 m hole, a ring in it with a 150 m courtyard,
    and a ring in that with a 50 m courtyard. Each moat is 2 m wide and is
    filled though the hole it lies in is wide, because the islands' own
    courtyards are not part of it. The innermost courtyard is the only
    unclaimed ground a disc fits in, and the only hole left.
    """

    def ring(outer: float, inner: float) -> Polygon:
        a, b = 250 - outer / 2, 250 - inner / 2
        return Polygon(
            box(a, a, 500 - a, 500 - a).exterior, [box(b, b, 500 - b, 500 - b).exterior.coords]
        )

    union = unary_union([ring(500, 300), ring(296, 150), ring(146, 50)])
    assert len(polygons(union)) == 3
    filled = fill_thin_holes(union)
    assert isinstance(filled, Polygon) and len(filled.interiors) == 1
    assert Polygon(filled.interiors[0]).bounds == pytest.approx((225, 225, 275, 275))
    assert filled.area == pytest.approx(500 * 500 - 50 * 50)
    assert fill_thin_holes(filled).equals(filled)


def test_each_piece_of_a_pocket_an_island_cuts_apart_is_judged_on_its_own():
    """An island touching a 300 m hole at four points cuts its pocket into four triangles.

    Each triangle is unclaimed ground of its own. The two with a 20 m leg
    are narrower than 30 m everywhere, inradii 9.3 and 9.6 m, and are
    filled; the two wide ones, inradii 43.9 and 56.2 m, stay as holes.
    Judging the pocket whole would keep all four, because a disc fits in
    the wide ones.
    """
    frame = Polygon(box(0, 0, 500, 500).exterior, [box(100, 100, 400, 400).exterior.coords])
    island = Polygon([(120, 100), (400, 120), (250, 400), (100, 250)])
    union = unary_union([frame, island])
    assert len(polygons(union)) == 2
    filled = fill_thin_holes(union)
    thin = 280 * 20 / 2 + 20 * 150 / 2
    assert isinstance(filled, Polygon) and len(filled.interiors) == 2
    assert filled.area == pytest.approx(union.area + thin)
    assert sorted(Polygon(r).area for r in filled.interiors) == pytest.approx(
        [150 * 150 / 2, 280 * 150 / 2]
    )
    assert fill_thin_holes(filled).equals(filled)


def test_a_moat_round_an_island_with_a_wide_courtyard_is_filled_and_the_courtyard_kept():
    """Four loops frame a 300 m hole; four more, 2 m inside it, ring a 150 m courtyard.

    The moat between them is 2 m wide and is filled, so the island merges
    with the frame. The courtyard is the island's own hole and a disc fits
    in it, so it stays: the served part is the 500 m square less the
    courtyard, losing only the frame's four outer corners to the opening.
    The island's outer corners are rounded too, but the filled moat covers
    them. Every corner of the courtyard is where two loops' straight edges
    cross, which the opening does not round.
    """
    r, n = SLIVER_RADIUS_M, BUFFER_QUAD_SEGMENTS
    chorded_corner_m2 = r * r - n * r * r * math.sin(math.pi / (2 * n)) / 2
    loops = [
        rectangle(0, 0, 500, 100),
        rectangle(0, 400, 500, 500),
        rectangle(0, 0, 100, 500),
        rectangle(400, 0, 500, 500),
        rectangle(102, 102, 398, 175),
        rectangle(102, 325, 398, 398),
        rectangle(102, 102, 175, 398),
        rectangle(325, 102, 398, 398),
    ]
    tracks = [
        track_from_xy(*xy, activity_id=f"r{k}", start=T0 + pd.Timedelta(days=k))
        for k, xy in enumerate(loops)
    ]
    territory = claim_territory(tracks)
    assert len(territory.parts) == 1
    part = territory.parts[0]
    assert part["area_m2"] == pytest.approx(500 * 500 - 150 * 150 - 4 * chorded_corner_m2, rel=1e-9)
    geo = json.loads(part["geometry_geojson"])
    assert geo["type"] == "Polygon" and len(geo["coordinates"]) == 2
    assert_valid_outlines(json.loads(p["geometry_geojson"]) for p in territory.parts)
    hole = np.array(geo["coordinates"][1])
    assert shoelace(hole) < 0
    x, y = EqualArea(*JONKOPING).forward(hole[:, 1], hole[:, 0])
    courtyard = Polygon(np.column_stack([x, y]))
    assert courtyard.area == pytest.approx(150 * 150, rel=2.5e-3)
    assert courtyard.bounds == pytest.approx((175, 175, 325, 325), abs=0.1)
    # The run that closes the moat off claims it, so the new ground sums to the union.
    assert sum(c["new_m2"] for c in territory.claims) == pytest.approx(part["area_m2"], rel=1e-12)
    assert territory.claims[-1]["cumulative_m2"] == pytest.approx(part["area_m2"], rel=1e-12)
    assert territory.regions[0]["area_m2"] == pytest.approx(part["area_m2"], rel=1e-12)


def test_a_seam_between_two_claims_leaves_no_hole_and_a_valid_outline():
    """Two loops sharing an edge their tracks drew 2 cm apart in the middle.

    The second loop's west edge runs from x = 499 m at its ends to 500.02 m
    halfway, so it overlaps the first loop's east edge, x = 500 m, except for
    a 2 cm by 9.8 m triangle where it falls short. Unfilled, that triangle
    is a hole a few centimetres wide, which the outline's 6 decimal grid
    turns into a self-crossing ring.
    """
    first = track_from_xy(*square(500.0), activity_id="first")
    second = track_from_xy(
        *densify([(499, 0), (1000, 0), (1000, 500), (499, 500), (500.02, 250), (499, 0)], 3.0),
        activity_id="second",
        start=T0 + pd.Timedelta(days=1),
    )
    territory = claim_territory([first, second])
    assert len(territory.parts) == 1
    part = territory.parts[0]
    geo = json.loads(part["geometry_geojson"])
    assert geo["type"] == "Polygon" and len(geo["coordinates"]) == 1
    assert_valid_outlines(json.loads(p["geometry_geojson"]) for p in territory.parts)
    # The filled triangle is claimed by the run that closed it off, so the
    # accounting still sums to the union it serves.
    assert territory.claims[-1]["cumulative_m2"] == pytest.approx(part["area_m2"], rel=1e-12)
    assert territory.regions[0]["area_m2"] == pytest.approx(part["area_m2"], rel=1e-12)


def test_a_courtyard_four_loops_ring_is_a_hole_in_the_served_outline():
    """Four 100 m wide loops around a 100 m courtyard, which stays unclaimed.

    The outline is the 300 m square less the courtyard, with the opening's
    corner loss at each of its four outer corners only: every other convex
    corner of a loop is inside a neighbour. The buffer draws each rounded
    corner as ``BUFFER_QUAD_SEGMENTS`` chords inscribed in its arc, so a
    corner loses ``r^2 - n r^2 sin(pi / 2n) / 2`` rather than the true arc's
    ``(1 - pi / 4) r^2``, 0.28 m^2 more at 15 m.
    """
    r, n = SLIVER_RADIUS_M, BUFFER_QUAD_SEGMENTS
    chorded_corner_m2 = r * r - n * r * r * math.sin(math.pi / (2 * n)) / 2
    loops = [
        rectangle(0, 0, 300, 100),
        rectangle(200, 0, 300, 300),
        rectangle(0, 200, 300, 300),
        rectangle(0, 0, 100, 300),
    ]
    tracks = [
        track_from_xy(*xy, activity_id=f"r{k}", start=T0 + pd.Timedelta(days=k))
        for k, xy in enumerate(loops)
    ]
    territory = claim_territory(tracks)
    assert len(territory.parts) == 1
    part = territory.parts[0]
    assert part["area_m2"] == pytest.approx(300 * 300 - 100 * 100 - 4 * chorded_corner_m2, rel=1e-9)
    geo = json.loads(part["geometry_geojson"])
    assert geo["type"] == "Polygon" and len(geo["coordinates"]) == 2
    assert_valid_outlines(json.loads(p["geometry_geojson"]) for p in territory.parts)
    hole = np.array(geo["coordinates"][1])
    x, y = EqualArea(*JONKOPING).forward(hole[:, 1], hole[:, 0])
    # Snapped to the grid, as the neck test below says, to within 0.25%.
    assert Polygon(np.column_stack([x, y])).area == pytest.approx(100 * 100, rel=2.5e-3)


def test_a_neck_thinner_than_the_grid_splits_the_outline_into_a_valid_multipolygon():
    """Two 100 m squares joined by a 20 m long, 5 cm wide strip, under a 0.11 m grid step.

    Snapping moves each vertex by up to half a step, 0.056 m of latitude, so
    a 100 m square's area moves by up to its perimeter times that, 0.22%.
    """
    plane = EqualArea(*JONKOPING)
    dumbbell = unary_union(
        [box(0, 0, 100, 100), box(100, 49.975, 120, 50.025), box(120, 0, 220, 100)]
    )
    assert isinstance(dumbbell, Polygon)
    shown = display_outline(dumbbell, plane, 1.0)
    assert shown.geom_type == "MultiPolygon" and shown.is_valid
    for piece in shown.geoms:
        lon, lat = np.asarray(piece.exterior.coords).T
        assert Polygon(np.column_stack(plane.forward(lat, lon))).area == pytest.approx(
            1e4, rel=2.5e-3
        )
        assert shoelace(np.asarray(piece.exterior.coords)) > 0


def test_overlapping_jittered_loops_serve_only_valid_outlines():
    """The real store's shape: dozens of noisy laps of a few routes, seams everywhere.

    Each loop is one of three overlapping circuits, its vertices moved by
    up to 3 m, the scatter of a GPS track, so neighbouring claims meet along
    edges drawn a few centimetres to metres apart.
    """
    rng = np.random.default_rng(7)
    circuits = [
        [(0, 0), (800, 0), (800, 600), (0, 600), (0, 0)],
        [(780, 0), (1500, 0), (1500, 600), (780, 600), (780, 0)],
        [(0, 590), (1500, 590), (1500, 1200), (0, 1200), (0, 590)],
    ]
    tracks = []
    for k in range(36):
        x, y = densify(circuits[k % 3], 4.0)
        x = x + rng.uniform(-3, 3, x.size)
        y = y + rng.uniform(-3, 3, y.size)
        tracks.append(
            track_from_xy(x, y, activity_id=f"lap{k:02d}", start=T0 + pd.Timedelta(days=k))
        )
    territory = claim_territory(tracks)
    assert territory.parts
    assert_valid_outlines(json.loads(p["geometry_geojson"]) for p in territory.parts)
    claimed = territory.claims[-1]["cumulative_m2"]
    assert claimed == pytest.approx(sum(p["area_m2"] for p in territory.parts), rel=1e-12)


def test_the_quad_segments_keep_a_rounded_corner_close_to_its_arc():
    assert 1 - math.cos(math.pi / (4 * BUFFER_QUAD_SEGMENTS)) < 0.0013


def test_the_tables_take_the_schemas_even_when_nothing_was_claimed():
    claims, regions, parts = territory_tables(claim_territory([]))
    assert list(claims.columns) == TERRITORY_CLAIM_SCHEMA.names and claims.empty
    assert list(regions.columns) == TERRITORY_REGION_SCHEMA.names and regions.empty
    assert list(parts.columns) == TERRITORY_PART_SCHEMA.names and parts.empty


def test_the_tables_carry_the_claims_in_order():
    first = track_from_xy(*square(1000.0), activity_id="first", start=T0)
    claims, regions, parts = territory_tables(claim_territory([first]))
    assert claims["activity_id"].tolist() == ["first"]
    assert regions["region_id"].tolist() == ["first"]
    assert parts["region_id"].tolist() == ["first"]
