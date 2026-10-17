import numpy as np
import pytest

from activity_analysis.geo import cumulative_distance_m, haversine_m


def test_haversine_zero_for_identical_points():
    assert haversine_m(57.7709, 14.1830, 57.7709, 14.1830) == pytest.approx(0.0, abs=1e-9)


def test_haversine_one_degree_of_latitude_is_about_111_km():
    # One degree of latitude is ~111.19 km on a sphere of radius 6371 km.
    assert haversine_m(0.0, 0.0, 1.0, 0.0) == pytest.approx(111194.9, rel=1e-4)


def test_haversine_is_symmetric():
    a = haversine_m(57.7709, 14.1830, 57.7723, 14.1816)
    b = haversine_m(57.7723, 14.1816, 57.7709, 14.1830)
    assert a == pytest.approx(b, rel=1e-12)


def test_cumulative_distance_starts_at_zero_and_accumulates():
    lat = np.array([0.0, 1.0, 2.0])
    lon = np.array([0.0, 0.0, 0.0])
    result = cumulative_distance_m(lat, lon)
    assert len(result) == 3
    assert result[0] == 0.0
    assert result[1] == pytest.approx(111194.9, rel=1e-4)
    assert result[2] == pytest.approx(2 * 111194.9, rel=1e-4)


def test_cumulative_distance_handles_single_point():
    result = cumulative_distance_m(np.array([57.7]), np.array([14.1]))
    assert list(result) == [0.0]
