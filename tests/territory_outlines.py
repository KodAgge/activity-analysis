"""The checks every served territory outline must pass, shared by the territory tests."""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

import numpy as np
from shapely.geometry import shape


def shoelace(ring: np.ndarray) -> float:
    """Twice the signed area of a closed ring: positive when anticlockwise."""
    return float(np.sum(ring[:-1, 0] * ring[1:, 1] - ring[1:, 0] * ring[:-1, 1]))


def assert_valid_outlines(geometries: Iterable[dict[str, Any]]) -> None:
    """Every GeoJSON geometry is a valid, closed, correctly wound ``[lon, lat]`` shape.

    Valid as GEOS reads the served coordinates, so on the 6 decimal grid and
    not on the plane they were computed on.
    """
    for geo in geometries:
        assert geo["type"] in {"Polygon", "MultiPolygon"}
        assert shape(geo).is_valid, geo
        polys = [geo["coordinates"]] if geo["type"] == "Polygon" else geo["coordinates"]
        for poly in polys:
            for k, coords in enumerate(poly):
                ring = np.array(coords)
                assert len(ring) >= 4 and (ring[0] == ring[-1]).all()
                # The exterior anticlockwise, every hole clockwise.
                assert (shoelace(ring) > 0) == (k == 0)
                # On the served grid: no coordinate carries a seventh decimal.
                assert np.allclose(ring, np.round(ring, 6), rtol=0, atol=1e-12)
