"""Per-activity summary metrics against fabricated grids."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from activity_analysis.analysis.metrics import activity_metrics


def _grid(
    seconds: int,
    *,
    paused_from: int | None = None,
    hr: bool = True,
    gps: bool = True,
    distance: bool = True,
) -> pd.DataFrame:
    t_s = np.arange(float(seconds))
    paused = np.zeros(seconds, dtype=bool)
    if paused_from is not None:
        paused[paused_from:] = True
    advance = t_s * 3.0 if distance else np.zeros(seconds)
    distance_m = np.where(paused, float(paused_from or 0) * 3.0, advance)
    return pd.DataFrame(
        {
            "t_s": t_s,
            "distance_m": distance_m,
            "hr_bpm": np.full(seconds, 150.0) if hr else np.full(seconds, np.nan),
            "cadence_spm": np.full(seconds, 165.0),
            "lat_deg": np.full(seconds, 57.78) if gps else np.full(seconds, np.nan),
            "lon_deg": np.full(seconds, 14.16) if gps else np.full(seconds, np.nan),
            "paused": paused,
        }
    )


def _activity(**overrides: object) -> pd.Series:
    row: dict[str, object] = {
        "activity_id": "abc",
        "sub_sport": "generic",
        "source": "strava_fit",
        "ascent_m": 50.0,
        # The session total, which `avg_speed_mps` divides rather than the
        # grid's odometer. Equal to the grid here, as it is on every outdoor
        # run; the two diverge only on a treadmill.
        "distance_m": 300.0,
    }
    row.update(overrides)
    return pd.Series(row)


def test_moving_time_excludes_paused_seconds() -> None:
    metrics = activity_metrics(_grid(101, paused_from=61), _activity())
    assert metrics["elapsed_time_s"] == pytest.approx(100.0)
    assert metrics["moving_time_s"] == pytest.approx(60.0)
    assert metrics["paused_time_s"] == pytest.approx(40.0)


def test_elapsed_time_is_the_span_the_grid_covers_not_its_row_count() -> None:
    # A grid spanning t=0 to t=3600 is an hour, not an hour and a second.
    # Counting rows disagrees with canonical activities.elapsed_time_s by one.
    metrics = activity_metrics(_grid(3601), _activity())
    assert metrics["elapsed_time_s"] == pytest.approx(3600.0)


def test_distance_is_the_last_value_on_the_grid() -> None:
    metrics = activity_metrics(_grid(101), _activity())
    assert metrics["distance_m"] == pytest.approx(300.0)


def test_average_speed_is_derived_from_distance_and_moving_time() -> None:
    # 300 m over 100 moving seconds is 3 m/s, which is 5:33/km.
    metrics = activity_metrics(_grid(101), _activity())
    assert metrics["avg_speed_mps"] == pytest.approx(3.0)


def test_average_speed_divides_the_session_distance_not_the_grid_s() -> None:
    """On a treadmill the two are different numbers, and the session wins.

    There is no satellite fix indoors, so the stream's distance is a footpod
    estimate that drifts while the session total is the corrected one. The
    browser renders the session total beside this speed, so a pace taken
    from the odometer would print a row that does not multiply out.
    """
    metrics = activity_metrics(_grid(101), _activity(distance_m=600.0))
    assert metrics["distance_m"] == pytest.approx(300.0), "the grid column stays the odometer"
    assert metrics["avg_speed_mps"] == pytest.approx(6.0)


def test_average_speed_is_null_without_a_session_distance() -> None:
    # A run whose canonical row carries no distance has no pace to render,
    # and the API falls back to the device's own average there.
    metrics = activity_metrics(_grid(101), _activity(distance_m=None))
    assert metrics["avg_speed_mps"] is None


def test_average_speed_excludes_paused_seconds_like_moving_time_does() -> None:
    # 183 m covered before the pause, over 60 moving seconds. Dividing by
    # elapsed time instead would report 1.83 m/s for a run held near 3, which
    # is the one rule under which standing still makes an athlete slower.
    metrics = activity_metrics(_grid(101, paused_from=61), _activity(distance_m=183.0))
    assert metrics["moving_time_s"] == pytest.approx(60.0)
    assert metrics["avg_speed_mps"] == pytest.approx(183.0 / 60.0)


def test_average_speed_is_null_rather_than_zero_without_moving_time() -> None:
    # A missing number is not a zero, and a zero here would render as an
    # infinite pace in the browser's Pace column.
    metrics = activity_metrics(_grid(101, paused_from=1), _activity())
    assert metrics["moving_time_s"] == pytest.approx(0.0)
    assert metrics["avg_speed_mps"] is None


def test_average_speed_is_null_rather_than_zero_without_distance() -> None:
    metrics = activity_metrics(_grid(101, distance=False), _activity(distance_m=0.0))
    assert metrics["distance_m"] == pytest.approx(0.0)
    assert metrics["avg_speed_mps"] is None


def test_ascent_per_kilometre_uses_the_device_total() -> None:
    # The device's barometric ascent is better than summing noisy per-second
    # altitude differences, which inflates the total badly.
    metrics = activity_metrics(_grid(1001), _activity(ascent_m=60.0))
    assert metrics["ascent_per_km_m"] == pytest.approx(20.0)


def test_a_run_with_no_distance_has_no_ascent_rate() -> None:
    grid = _grid(10)
    grid["distance_m"] = 0.0
    metrics = activity_metrics(grid, _activity())
    assert np.isnan(metrics["ascent_per_km_m"])


def test_a_run_with_no_recorded_ascent_has_no_ascent_rate() -> None:
    metrics = activity_metrics(_grid(101), _activity(ascent_m=None))
    assert np.isnan(metrics["ascent_per_km_m"])


def test_treadmill_runs_are_flagged_indoor() -> None:
    assert activity_metrics(_grid(10), _activity(sub_sport="treadmill"))["is_indoor"] is True
    assert activity_metrics(_grid(10), _activity(sub_sport="generic"))["is_indoor"] is False


def test_missing_channels_are_reported_rather_than_hidden() -> None:
    metrics = activity_metrics(_grid(10, hr=False, gps=False), _activity())
    assert metrics["has_hr"] is False
    assert metrics["has_gps"] is False


def test_a_positioned_grid_is_placed_through_the_bundled_table() -> None:
    # 57.78 N, 14.16 E is central Jönköping. The name itself is the bundled
    # table's business (tests/test_places.py); this proves the grid reaches it.
    metrics = activity_metrics(_grid(10), _activity())
    assert isinstance(metrics["locality"], str) and metrics["locality"]
    assert metrics["country_code"] == "SE"
    assert isinstance(metrics["country"], str) and metrics["country"]
    assert np.isfinite(metrics["locality_distance_m"])


def test_a_grid_with_no_position_is_placed_nowhere() -> None:
    metrics = activity_metrics(_grid(10, gps=False), _activity())
    assert metrics["locality"] is None
    assert metrics["country_code"] is None
    assert metrics["country"] is None
    assert np.isnan(metrics["locality_distance_m"])


def test_a_gpx_sourced_activity_is_flagged() -> None:
    # GPX carries 10.2 times the sample-to-sample speed noise of FIT, so trend
    # analyses need to be able to exclude it.
    assert activity_metrics(_grid(10), _activity(source="gpx"))["is_gpx_sourced"] is True


def test_an_empty_grid_summarises_to_zeroes_rather_than_raising() -> None:
    empty = pd.DataFrame(columns=["t_s", "distance_m", "hr_bpm", "lat_deg", "lon_deg", "paused"])
    metrics = activity_metrics(empty, _activity())
    assert metrics["elapsed_time_s"] == 0.0
    assert metrics["distance_m"] == 0.0
    assert metrics["has_hr"] is False
