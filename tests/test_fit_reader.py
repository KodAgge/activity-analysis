import gzip
from pathlib import Path
from types import SimpleNamespace

import pytest

from activity_analysis.ingest.fit_reader import field_values, read_fit


def test_reads_the_reference_activity(reference_fit: Path):
    parsed = read_fit(reference_fit)
    assert parsed.source_format == "fit"
    assert len(parsed.records) == 626
    assert len(parsed.laps) == 8


def test_session_carries_golden_values(reference_fit: Path):
    session = read_fit(reference_fit).session
    assert session["sport"] == "running"
    assert session["sub_sport"] == "generic"
    assert session["total_distance"] == pytest.approx(7456.06)
    assert session["total_elapsed_time"] == pytest.approx(2931.205)
    assert session["enhanced_avg_speed"] == pytest.approx(2.544)
    assert session["enhanced_max_speed"] == pytest.approx(2.855)
    assert session["avg_heart_rate"] == 156
    assert session["max_heart_rate"] == 172
    assert session["avg_running_cadence"] == 81
    assert session["total_ascent"] == 56
    assert session["total_descent"] == 52
    assert session["total_calories"] == 660


def test_records_keep_raw_fit_field_names_and_units(reference_fit: Path):
    first = read_fit(reference_fit).records[0]
    # Semicircles, not degrees. Conversion belongs to normalize.
    assert first["position_lat"] == 689233540
    assert first["heart_rate"] == 84
    assert first["cadence"] == 50


def test_device_is_identified(reference_fit: Path):
    device = read_fit(reference_fit).device
    assert device["manufacturer"] == "garmin"
    assert device["garmin_product"] == "venu2_plus"


def test_profile_is_captured(reference_fit: Path):
    profile = read_fit(reference_fit).profile
    assert profile is not None
    assert profile["weight"] == pytest.approx(70.0)
    assert profile["resting_heart_rate"] == 67


def test_reads_gzipped_fit(reference_fit: Path, tmp_path: Path):
    gzipped = tmp_path / "activity.fit.gz"
    gzipped.write_bytes(gzip.compress(reference_fit.read_bytes()))
    assert len(read_fit(gzipped).records) == 626


def test_every_fixture_parses(all_fit_fixtures: list[Path]):
    counts = {p.name: len(read_fit(p).records) for p in all_fit_fixtures}
    assert sorted(counts.values()) == [450, 562, 626, 764, 872]


def test_reader_captures_the_device_zone_settings(reference_fit: Path):
    # Verified against the file on 2026-08-29. These are device settings, not
    # measurements, which is exactly why the profile has to be time-versioned.
    parsed = read_fit(reference_fit)
    assert parsed.zones is not None
    assert parsed.zones["max_heart_rate"] == 207
    assert parsed.zones["hr_calc_type"] == "percent_max_hr"
    assert parsed.zones["hr_zone_high_boundary"] == [104.0, 124.0, 145.0, 166.0, 186.0, 207.0]


def test_reader_captures_the_user_profile(reference_fit: Path):
    parsed = read_fit(reference_fit)
    assert parsed.profile is not None
    assert parsed.profile["weight"] == pytest.approx(70.0)
    assert parsed.profile["resting_heart_rate"] == 67


def test_reading_stops_at_the_header_of_a_file_that_is_not_an_activity(
    garmin_monitoring_fit: Path, tmp_path: Path
):
    # A Garmin export holds some 31,700 monitoring and sleep files next to
    # its 2,900 activities. Decoding each in full is most of a 15 minute
    # ingest, so the reader stops once file_id has said what the file is.
    # Cutting the file short proves it: a full decode would hit the end.
    truncated = tmp_path / "monitoring.fit"
    truncated.write_bytes(garmin_monitoring_fit.read_bytes()[:200])
    parsed = read_fit(truncated)
    assert parsed.device["type"] == "monitoring_b"
    assert parsed.records == []


def test_a_duplicated_field_keeps_its_value_when_a_later_copy_is_empty(
    garmin_breathing_fit: Path,
) -> None:
    # A Garmin-original FIT carries some fields twice in one lap or session:
    # the field itself, then a copy fitdecode expands from a legacy field the
    # device left invalid, with no field definition of its own and no value.
    # Read last-wins, the empty copy erased the value, which on running
    # activities emptied every lap's and session's speed.
    parsed = read_fit(garmin_breathing_fit)
    assert parsed.laps
    assert all(lap["enhanced_avg_respiration_rate"] is not None for lap in parsed.laps)
    assert parsed.session is not None
    assert parsed.session["enhanced_avg_respiration_rate"] is not None


def test_the_first_value_of_a_duplicated_field_wins_and_an_empty_copy_never_replaces_one() -> None:
    def field(name: str, value: object) -> SimpleNamespace:
        return SimpleNamespace(name=name, value=value)

    # The measured Garmin pattern: the field, then an empty expanded copy.
    assert field_values(
        [field("enhanced_avg_speed", 3.324), field("enhanced_avg_speed", None)]
    ) == {"enhanced_avg_speed": 3.324}
    # An empty field followed by a copy that carries the value.
    assert field_values([field("enhanced_avg_speed", None), field("enhanced_avg_speed", 3.3)]) == {
        "enhanced_avg_speed": 3.3
    }
    # Two values: the field read first stands.
    assert field_values([field("x", 1.0), field("x", 2.0)]) == {"x": 1.0}
    # Every copy empty is still an empty field rather than a missing one.
    assert field_values([field("x", None), field("x", None)]) == {"x": None}
