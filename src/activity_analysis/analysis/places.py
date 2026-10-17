"""Where an activity happened, from its first fixed position.

Fully offline. The bundled table (`activity_analysis/data/places.parquet`,
built by `scripts/build_places.py` from GeoNames) is searched with the
project's own haversine, so no coordinate ever leaves the machine and there
is no API key, no rate limit and no network dependency. That is the same
reasoning that keeps the route basemap self-hosted - see
`docs/reference/frontend.md` - applied to the same coordinates.

Maths: `docs/reference/math/places.md`.
"""

from __future__ import annotations

import functools
from dataclasses import dataclass
from importlib import resources

import numpy as np
import numpy.typing as npt
import pandas as pd

from activity_analysis.geo import haversine_to_many_m

#: How far away a more significant place may be and still be preferred to
#: the nearest one.
#:
#: The problem this solves: GeoNames' populated places include city
#: districts, so nearest-place alone labels the athlete's three clusters in
#: one city with the names of two of its districts. All true, all districts,
#: and none the answer a reader wants to "where was this run".
POPULOUS_PREFERENCE_RADIUS_M = 15_000.0

#: How many times more populous the alternative has to be before it wins.
#:
#: Preferring population *unconditionally* inside the radius above fixes
#: that city and breaks two other real starts: a small town and a coastal
#: city each become a neighbour inside the radius that is only 1.1x and 1.2x
#: as populous. Both are wrong for the same reason - the alternative is a
#: *different town*, not the place the nearest match is a district of - and
#: a bare population comparison cannot tell those two situations apart.
#:
#: A ratio can, because the case worth overriding is lopsided. Measured over
#: 14 real start locations on 2026-09-03: the three city-against-district
#: pairs stand at 23x, 26x and 63x, while the two neighbours stand at 1.1x
#: and 1.2x the towns they would replace. A 10x gate takes the first
#: group and leaves the second, and every one of those 14 then resolves to
#: the name a reader would give.
#:
#: 5x and 10x are indistinguishable on this history, so the more
#: conservative one is taken: the gate exists to catch a city against its own
#: district, and the cost of setting it too low is attaching a metropolis to
#: a town that is genuinely its own place.
POPULOUS_PREFERENCE_RATIO = 10

#: The population the alternative needs to override a nearest place whose
#: own population GeoNames does not know.
#:
#: GeoNames records 0 for a place whose population it does not know: 11 893
#: of the 170 911 bundled places, mostly administrative seats under 1 000
#: people. Lopsidedness cannot be judged against an unknown. The first
#: version clamped the unknown to 1, which made the ratio gate's threshold
#: ten people, so any place inside the radius won: measured on a sample of
#: 400 zero-population places, 208 were renamed when queried at their own
#: centroid, and standing at Tuburan (PH) was labelled Lunas, 12.6 km away.
#:
#: So when the nearest population is unknown the question changes from "how
#: many times larger is the alternative" to "is the alternative unambiguously
#: a city", and it wins only at or above this floor. 15 000 is the
#: `cities15000` threshold that docs/reference/math/places.md already
#: reasons about as the line between a city and a village, so it is a figure
#: that document can defend rather than a new one.
#:
#: Measured over all 221 placed runs on 2026-09-04: 0 labels change. The
#: unknown branch is reached on two real starts. One has nothing within the
#: radius, so no override was ever in question; the other is in a comuna of
#: a capital that clears the floor, so it still resolves to the capital.
#: Tuburan resolves to Tuburan. Applying the floor to a *known*
#: nearest as well was also measured, and rejected: it changes nothing on
#: this history but would stop a hamlet of 200 resolving to the town of
#: 5 000 beside it, where the town is the better answer.
POPULOUS_PREFERENCE_ABSOLUTE_FLOOR = 15_000


@dataclass(frozen=True)
class Place:
    """A named place, and how far the activity started from it."""

    locality: str
    country_code: str
    country: str | None
    #: Great-circle metres from the queried position to the named place.
    #:
    #: Stored rather than thrown away, because a match is not always close:
    #: the worst on this history is 27.9 km, a remote start with nothing
    #: closer in the table. Keeping the distance lets a
    #: consumer decide - name the place, name only the country, or say
    #: nothing - rather than having that decision made silently here. Same
    #: shape as `contains_jump` in the best-efforts table: flag it, and let
    #: the reader of the number choose.
    distance_m: float


@dataclass(frozen=True)
class _PlaceTable:
    """The bundled table, in the layout the search wants."""

    lat: npt.NDArray[np.float64]
    lon: npt.NDArray[np.float64]
    population: npt.NDArray[np.int64]
    name: npt.NDArray[np.object_]
    country_code: npt.NDArray[np.object_]
    country: npt.NDArray[np.object_]


@functools.lru_cache(maxsize=1)
def _table() -> _PlaceTable:
    """The bundled place table, read once per process.

    Read through `importlib.resources` rather than a path relative to this
    file, so it resolves the same whether the package is a source checkout, an
    installed wheel or a zip import.
    """
    source = resources.files("activity_analysis.data").joinpath("places.parquet")
    with resources.as_file(source) as path:
        frame = pd.read_parquet(path)
    return _PlaceTable(
        lat=frame["lat"].to_numpy(dtype=np.float64),
        lon=frame["lon"].to_numpy(dtype=np.float64),
        population=frame["population"].to_numpy(dtype=np.int64),
        name=frame["name"].to_numpy(dtype=object),
        country_code=frame["country_code"].to_numpy(dtype=object),
        country=frame["country"].to_numpy(dtype=object),
    )


def place_count() -> int:
    """How many places the bundled table holds.

    `places.parquet` is the one input this application depends on that
    arrives as bundled data rather than through ingestion, so the `info`
    command prints this alongside the store's row counts, labelled as
    reference data: a missing or truncated table is then visible to whoever
    asks what the installation has, not only to the test suite.
    """
    return int(len(_table().lat))


def nearest_place(lat: float, lon: float) -> Place | None:
    """The place to name for a position, or `None` if the position is unusable.

    The nearest place wins, unless something within
    `POPULOUS_PREFERENCE_RADIUS_M` is at least `POPULOUS_PREFERENCE_RATIO`
    times more populous - which is what turns a city district into its city
    without turning a small town into the slightly larger town next to it.
    When the nearest place's population is unknown there is nothing to take a
    ratio against, and the alternative wins only if it is a city
    outright, at or above `POPULOUS_PREFERENCE_ABSOLUTE_FLOOR`. See the three
    constants for the measurements behind them.

    A non-finite or out-of-range coordinate returns `None` rather than
    raising or picking something: the derived layer's rule throughout is that
    an absence is stated, not guessed.
    """
    if not (np.isfinite(lat) and np.isfinite(lon)):
        return None
    if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
        return None

    table = _table()
    distances = haversine_to_many_m(lat, lon, table.lat, table.lon)
    if distances.size == 0:
        return None

    index = int(np.argmin(distances))
    within = np.flatnonzero(distances <= POPULOUS_PREFERENCE_RADIUS_M)
    if within.size > 0:
        # `argmax` over population, tie-broken by whichever comes first in
        # the table, which is stable for a given bundled file.
        candidate = int(within[np.argmax(table.population[within])])
        nearest_population = int(table.population[index])
        candidate_population = int(table.population[candidate])
        # A population of 0 is GeoNames for "not known", never a real count.
        if nearest_population > 0:
            overrides = candidate_population >= POPULOUS_PREFERENCE_RATIO * nearest_population
        else:
            overrides = candidate_population >= POPULOUS_PREFERENCE_ABSOLUTE_FLOOR
        if overrides:
            index = candidate

    country = table.country[index]
    return Place(
        locality=str(table.name[index]),
        country_code=str(table.country_code[index]),
        country=None if country is None or pd.isna(country) else str(country),
        distance_m=float(distances[index]),
    )


def first_fixed_position(
    lat: npt.NDArray[np.float64], lon: npt.NDArray[np.float64]
) -> tuple[float, float] | None:
    """The first sample where both coordinates are present and finite.

    The *first*, not the mean: a mean over a route is a point the athlete may
    never have been, and on a there-and-back it lands in the middle of the
    trace rather than where the run began. "Where was this run" is answered
    by where it started.

    Null across the whole array for an activity with no position at all -
    86 of the 307 real runs, every treadmill run among them.
    """
    if lat.size == 0 or lon.size == 0:
        return None
    usable = np.flatnonzero(np.isfinite(lat) & np.isfinite(lon))
    if usable.size == 0:
        return None
    first = int(usable[0])
    return float(lat[first]), float(lon[first])
