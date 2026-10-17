"""Where an activity happened, resolved offline against the bundled table.

The place table is real bundled data rather than a synthetic fixture, so
these tests name real coordinates and real answers. That is deliberate and
is the same exception `tests/test_zones.py` takes: the lookup's ground truth
is the geography itself, and a synthetic table of invented towns would only
test that `argmin` works.

Every coordinate below is a public landmark or a town centroid, not one of
the athlete's own start positions.

The one exception to real data is `TestPopulationGateBranches`, which runs
the rule over a three-row table of invented places. The gate has two branches
and the difference between them is arithmetic on populations, which is the
kind of thing CLAUDE.md says to test against a synthetic fixture with a known
answer rather than against whatever the real table happens to contain.
"""

from __future__ import annotations

import numpy as np
import pytest

from activity_analysis.analysis import places
from activity_analysis.analysis.places import (
    POPULOUS_PREFERENCE_ABSOLUTE_FLOOR,
    POPULOUS_PREFERENCE_RADIUS_M,
    POPULOUS_PREFERENCE_RATIO,
    first_fixed_position,
    nearest_place,
    place_count,
)
from activity_analysis.geo import haversine_to_many_m


def test_the_bundled_table_is_the_cities1000_extract():
    """A shape check on the bundled file, so a truncated one is loud.

    Measured when it was built on 2026-09-03: 170 911 places. Asserted as a
    floor rather than an equality, because a rebuild against a newer GeoNames
    dump legitimately moves the count.
    """
    assert place_count() > 150_000


def test_a_city_centre_resolves_to_that_city():
    # Jönköping Central station.
    place = nearest_place(57.7845, 14.1619)
    assert place is not None
    assert place.locality == "Jönköping"
    assert place.country_code == "SE"
    assert place.country == "Sweden"
    assert place.distance_m < 5_000


def test_a_city_district_resolves_to_the_city_rather_than_the_district():
    """The reason the population preference exists.

    GeoNames' populated places include city districts, and several are
    closer to a given point than the city's own centroid. Nearest-place
    alone answers "Neubau" for a run through central Vienna - true, and not
    what anybody means by where the run was.
    """
    # Wien Westbahnhof, about 0.9 km from the Neubau centroid and 2.9 km from
    # Vienna's.
    place = nearest_place(48.1967, 16.3378)
    assert place is not None
    assert place.locality == "Vienna"
    assert place.country_code == "AT"


def test_a_town_next_to_a_slightly_larger_town_keeps_its_own_name():
    """The regression an unconditional population preference caused.

    Skillingaryd has a marginally larger neighbour, Vaggeryd, 8.2 km away -
    5 122 against 3 965, a ratio of 1.3. Preferring population without a
    ratio gate renames every Skillingaryd run to Vaggeryd, which is a
    different town rather than the place Skillingaryd is a district of.
    """
    # The GeoNames centroid of Skillingaryd.
    place = nearest_place(57.4304, 14.0938)
    assert place is not None
    assert place.locality == "Skillingaryd"
    assert place.country_code == "SE"


def test_the_ratio_gate_is_what_separates_those_two_cases():
    """Stated as the measured property rather than as two magic numbers.

    The override only fires when the alternative is overwhelmingly larger,
    which is the signature of a city against its own district. This asserts
    that relationship holds for the two real cases above, so lowering the
    constant to where it breaks Skillingaryd fails here rather than silently
    renaming a town.
    """
    vienna = nearest_place(48.1967, 16.3378)
    skillingaryd = nearest_place(57.4304, 14.0938)
    assert vienna is not None and skillingaryd is not None

    # The overridden case: the city won even though a district was nearer.
    assert vienna.locality == "Vienna"
    # The preserved case: nothing within the radius was 10x larger.
    assert skillingaryd.locality == "Skillingaryd"
    assert POPULOUS_PREFERENCE_RATIO >= 5
    assert POPULOUS_PREFERENCE_RADIUS_M >= 10_000


def test_a_place_with_unknown_population_is_not_overridden_by_a_mere_town():
    """The ratio gate has nothing to divide by when GeoNames records 0.

    The first version clamped the unknown to 1, so the threshold became ten
    people and every place inside the radius won. Standing at Tuburan in the
    Philippines, population unknown, was labelled Lunas, 5 789 people and
    12.6 km away. Lunas is a town, not a city, so it does not clear the
    absolute floor the unknown branch asks for instead.
    """
    # The GeoNames centroid of Tuburan, Cebu.
    place = nearest_place(10.7273, 123.8257)
    assert place is not None
    assert place.locality == "Tuburan"
    assert place.country_code == "PH"
    assert place.distance_m < 100


class TestPopulationGateBranches:
    """The two branches of the override, on a table small enough to reason about.

    Three places on one line of longitude: the start is on the first, the
    other two are 10 km and 100 km north, so exactly one alternative is
    inside the 15 km radius and it is never the nearest.
    """

    @staticmethod
    def _table(nearest_population: int, neighbour_population: int) -> places._PlaceTable:
        return places._PlaceTable(
            lat=np.array([0.0, 0.09, 0.9]),
            lon=np.array([0.0, 0.0, 0.0]),
            population=np.array([nearest_population, neighbour_population, 10_000_000]),
            name=np.array(["Nearest", "Neighbour", "Far metropolis"], dtype=object),
            country_code=np.array(["XX", "XX", "XX"], dtype=object),
            country=np.array(["Nowhere", "Nowhere", "Nowhere"], dtype=object),
        )

    def _resolve(
        self, monkeypatch: pytest.MonkeyPatch, nearest_population: int, neighbour_population: int
    ) -> str:
        table = self._table(nearest_population, neighbour_population)
        monkeypatch.setattr(places, "_table", lambda: table)
        place = nearest_place(0.0, 0.0)
        assert place is not None
        return place.locality

    def test_an_unknown_nearest_keeps_its_name_beside_a_mid_size_town(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        assert self._resolve(monkeypatch, 0, POPULOUS_PREFERENCE_ABSOLUTE_FLOOR - 1) == "Nearest"

    def test_an_unknown_nearest_yields_to_a_genuine_city(self, monkeypatch: pytest.MonkeyPatch):
        assert self._resolve(monkeypatch, 0, POPULOUS_PREFERENCE_ABSOLUTE_FLOOR) == "Neighbour"

    def test_a_known_small_nearest_still_yields_to_a_ten_times_larger_town(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """The floor belongs to the unknown branch alone.

        A hamlet of 200 beside a town of 5 000 resolves to the town, which is
        the better answer and is what the documented ratio rule has always
        said. Applying the floor here too would silently break that.
        """
        assert POPULOUS_PREFERENCE_RATIO * 200 <= 5_000 < POPULOUS_PREFERENCE_ABSOLUTE_FLOOR
        assert self._resolve(monkeypatch, 200, 5_000) == "Neighbour"

    def test_a_known_nearest_keeps_its_name_beside_a_merely_larger_town(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        assert self._resolve(monkeypatch, 4_000, 5_000) == "Nearest"


def test_a_remote_start_reports_the_settlement_that_is_actually_nearest():
    """And reports honestly how far away it is.

    Not every match is close, and pretending otherwise is what a
    distance-free answer would do. The worst on the real history is a remote
    start 27.9 km from the nearest place in the table.
    """
    # A rounded coordinate in the interior of the Taklamakan, well away from
    # any town, which resolves 111 km out.
    place = nearest_place(39.0, 83.0)
    assert place is not None
    assert place.country_code == "CN"
    assert place.distance_m > 20_000


def test_the_distance_is_the_great_circle_distance_to_the_named_place():
    """Not a bounding-box or degree distance, which diverges with latitude.

    At Jönköping's latitude a degree of longitude is 59 km rather than 111,
    so a naive planar distance overstates east-west separation by nearly 2x.
    """
    place = nearest_place(57.7845, 14.1619)
    assert place is not None
    # Recomputed independently through the same haversine the search uses,
    # against the coordinates of the place it named.
    from activity_analysis.analysis.places import _table

    table = _table()
    matches = np.flatnonzero(table.name == place.locality)
    distances = haversine_to_many_m(57.7845, 14.1619, table.lat[matches], table.lon[matches])
    assert place.distance_m == pytest.approx(float(distances.min()), rel=1e-9)


@pytest.mark.parametrize(
    ("lat", "lon"),
    [
        (float("nan"), 14.2),
        (57.8, float("nan")),
        (float("inf"), 14.2),
        (91.0, 14.2),
        (-91.0, 14.2),
        (57.8, 181.0),
        (57.8, -181.0),
    ],
)
def test_an_unusable_coordinate_states_the_absence_rather_than_guessing(lat: float, lon: float):
    assert nearest_place(lat, lon) is None


def test_the_first_fixed_position_is_the_first_one_not_the_mean():
    """A mean over a route is a point the athlete may never have been.

    On a there-and-back it lands in the middle of the trace rather than
    where the run began, and "where was this run" is answered by where it
    started.
    """
    lat = np.array([57.76, 57.78, 57.80, 57.78, 57.76])
    lon = np.array([14.14, 14.16, 14.18, 14.16, 14.14])
    assert first_fixed_position(lat, lon) == (57.76, 14.14)


def test_the_first_fixed_position_skips_leading_nulls():
    """A GPS fix takes a few seconds, so the grid opens with nulls."""
    lat = np.array([np.nan, np.nan, 57.78, 57.79])
    lon = np.array([np.nan, np.nan, 14.16, 14.17])
    assert first_fixed_position(lat, lon) == (57.78, 14.16)


def test_the_first_fixed_position_needs_both_coordinates():
    """One coordinate alone is not a position."""
    lat = np.array([57.78, 57.79])
    lon = np.array([np.nan, 14.17])
    assert first_fixed_position(lat, lon) == (57.79, 14.17)


def test_a_track_with_no_position_at_all_has_none():
    """The shape of every treadmill run - 86 of the 307 real ones."""
    nulls = np.full(10, np.nan)
    assert first_fixed_position(nulls, nulls) is None
    assert first_fixed_position(np.zeros(0), np.zeros(0)) is None
