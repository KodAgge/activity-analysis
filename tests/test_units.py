import pytest

from activity_analysis.units import fit_cadence_to_spm, semicircles_to_degrees


def test_semicircles_to_degrees_matches_gpx_rendering():
    # First sample of the 2026-08-28 fixture. The GPX export of the same
    # activity renders these as 57.7708879 / 14.1830235.
    assert semicircles_to_degrees(689233540) == pytest.approx(57.7708879, abs=1e-7)
    assert semicircles_to_degrees(169210061) == pytest.approx(14.1830235, abs=1e-7)


def test_semicircles_to_degrees_passes_through_none():
    assert semicircles_to_degrees(None) is None


def test_fit_cadence_to_spm_doubles_single_foot_rpm():
    assert fit_cadence_to_spm(81, 0.0) == 162.0


def test_fit_cadence_to_spm_includes_fractional_part():
    assert fit_cadence_to_spm(81, 0.5) == 163.0


def test_fit_cadence_to_spm_treats_missing_fraction_as_zero():
    assert fit_cadence_to_spm(81, None) == 162.0
    assert fit_cadence_to_spm(81) == 162.0


def test_fit_cadence_to_spm_passes_through_none():
    assert fit_cadence_to_spm(None, 0.5) is None
