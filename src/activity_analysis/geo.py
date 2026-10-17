"""Great-circle distance.

Only the GPX path needs this. FIT files carry a device-measured cumulative
distance that is more accurate than anything derivable from coordinates.

Maths: ``docs/reference/math/geodesy.md`` derives the haversine formula, shows
why the spherical law of cosines is unusable at these segment lengths, and
bounds the error left by modelling the Earth as a sphere.
"""

from __future__ import annotations

import numpy as np
import numpy.typing as npt

EARTH_RADIUS_M = 6371000.0


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance between two points in metres."""
    phi1, phi2 = np.radians(lat1), np.radians(lat2)
    dphi = phi2 - phi1
    dlambda = np.radians(lon2 - lon1)
    a = np.sin(dphi / 2) ** 2 + np.cos(phi1) * np.cos(phi2) * np.sin(dlambda / 2) ** 2
    return float(2 * EARTH_RADIUS_M * np.arcsin(np.sqrt(a)))


def haversine_to_many_m(
    lat: float, lon: float, lats: npt.NDArray[np.float64], lons: npt.NDArray[np.float64]
) -> npt.NDArray[np.float64]:
    """Great-circle distance from one point to many, in metres.

    Vectorised because the one caller compares a start position against every
    populated place on Earth over 1000 people - 170 911 of them - and does it
    once per activity. A Python loop over that is seconds per run; this is
    about a millisecond.
    """
    phi1 = np.radians(lat)
    phi2 = np.radians(lats)
    dphi = phi2 - phi1
    dlambda = np.radians(lons - lon)
    a = np.sin(dphi / 2) ** 2 + np.cos(phi1) * np.cos(phi2) * np.sin(dlambda / 2) ** 2
    return np.asarray(2 * EARTH_RADIUS_M * np.arcsin(np.sqrt(a)), dtype=np.float64)


def cumulative_distance_m(
    lat: npt.NDArray[np.float64], lon: npt.NDArray[np.float64]
) -> npt.NDArray[np.float64]:
    """Cumulative great-circle distance along a track, starting at zero."""
    if len(lat) == 0:
        return np.zeros(0, dtype=np.float64)
    phi = np.radians(lat)
    lam = np.radians(lon)
    dphi = np.diff(phi)
    dlam = np.diff(lam)
    a = np.sin(dphi / 2) ** 2 + np.cos(phi[:-1]) * np.cos(phi[1:]) * np.sin(dlam / 2) ** 2
    segments = 2 * EARTH_RADIUS_M * np.arcsin(np.sqrt(a))
    return np.concatenate([[0.0], np.cumsum(segments)]).astype(np.float64)
