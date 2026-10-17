"""Unit conversions applied once, at the ingestion boundary.

Everything downstream of ingestion is SI: metres, seconds, m/s, bpm, spm.

Maths: ``docs/reference/math/units.md`` explains the semicircle encoding and the
resolution it delivers, why running cadence is doubled, and what
``fractional_cadence`` actually contributes at record versus lap level.
"""

from __future__ import annotations

SEMICIRCLES_TO_DEGREES = 180.0 / (2**31)


def semicircles_to_degrees(value: int | None) -> float | None:
    """Convert a FIT semicircle coordinate to decimal degrees."""
    if value is None:
        return None
    return value * SEMICIRCLES_TO_DEGREES


def fit_cadence_to_spm(
    cadence: float | None, fractional_cadence: float | None = None
) -> float | None:
    """Convert single-foot rpm to steps per minute.

    FIT and Garmin GPX both record running cadence as revolutions per minute
    for one foot, so a runner turning over at 81 rpm is taking 162 steps per
    minute. ``fractional_cadence`` carries sub-rpm resolution on a 1/128 rpm
    grid; records use only 0.0 and 0.5 of it, lap and session averages use all
    of it.
    """
    if cadence is None:
        return None
    return (cadence + (fractional_cadence or 0.0)) * 2.0
