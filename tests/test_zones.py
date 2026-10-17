"""Zone arithmetic against synthetic input, then against the device's own answer."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from activity_analysis.analysis.resample import resample_to_1hz
from activity_analysis.analysis.zones import zone_time
from activity_analysis.ingest.fit_reader import read_fit
from activity_analysis.ingest.normalize import normalize
from activity_analysis.models import SOURCE_STRAVA_FIT

BOUNDARIES = [104.0, 124.0, 145.0, 166.0, 186.0, 207.0]


def _grid(hr: list[float], paused: list[bool] | None = None) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "t_s": np.arange(float(len(hr))),
            "hr_bpm": hr,
            "paused": paused if paused is not None else [False] * len(hr),
        }
    )


def test_six_boundaries_make_seven_zones() -> None:
    frame = zone_time(_grid([150.0]), BOUNDARIES)
    assert frame["zone_index"].tolist() == [0, 1, 2, 3, 4, 5, 6]


def test_each_second_on_the_grid_counts_once() -> None:
    frame = zone_time(_grid([150.0] * 60), BOUNDARIES)
    assert frame["seconds_s"].sum() == pytest.approx(60.0)
    assert frame.loc[frame["zone_index"] == 3, "seconds_s"].iloc[0] == pytest.approx(60.0)


def test_a_boundary_value_belongs_to_the_zone_it_opens() -> None:
    # 104 is the low edge of zone 1, not the top of zone 0.
    frame = zone_time(_grid([104.0]), BOUNDARIES)
    assert frame.loc[frame["zone_index"] == 1, "seconds_s"].iloc[0] == pytest.approx(1.0)
    assert frame.loc[frame["zone_index"] == 0, "seconds_s"].iloc[0] == pytest.approx(0.0)


def test_below_the_first_boundary_is_zone_zero() -> None:
    frame = zone_time(_grid([90.0, 103.0]), BOUNDARIES)
    assert frame.loc[frame["zone_index"] == 0, "seconds_s"].iloc[0] == pytest.approx(2.0)


def test_above_the_last_boundary_is_the_top_zone() -> None:
    frame = zone_time(_grid([210.0]), BOUNDARIES)
    assert frame.loc[frame["zone_index"] == 6, "seconds_s"].iloc[0] == pytest.approx(1.0)


def test_paused_seconds_are_not_counted() -> None:
    # The athlete was standing still. Those seconds are not training in zone 1.
    frame = zone_time(_grid([150.0] * 10, paused=[False] * 5 + [True] * 5), BOUNDARIES)
    assert frame["seconds_s"].sum() == pytest.approx(5.0)


def test_seconds_without_a_heart_rate_are_not_counted() -> None:
    frame = zone_time(_grid([150.0, np.nan, 150.0]), BOUNDARIES)
    assert frame["seconds_s"].sum() == pytest.approx(2.0)


def test_the_zone_edges_are_reported_alongside_the_time() -> None:
    frame = zone_time(_grid([150.0]), BOUNDARIES)
    assert np.isnan(frame.loc[frame["zone_index"] == 0, "low_bpm"].iloc[0])
    assert frame.loc[frame["zone_index"] == 0, "high_bpm"].iloc[0] == pytest.approx(104.0)
    assert frame.loc[frame["zone_index"] == 3, "low_bpm"].iloc[0] == pytest.approx(145.0)
    assert frame.loc[frame["zone_index"] == 3, "high_bpm"].iloc[0] == pytest.approx(166.0)
    assert np.isnan(frame.loc[frame["zone_index"] == 6, "high_bpm"].iloc[0])


def test_no_boundaries_means_no_zones() -> None:
    # The 84 oldest runs have neither zone settings nor heart rate.
    assert zone_time(_grid([150.0]), []).empty


def test_agrees_with_the_device_on_the_reference_activity(reference_fit: Path) -> None:
    """The device wrote its own zone totals into the file, so this is a real oracle.

    It does not agree exactly and should not be expected to: the device works
    from its internal one-second sampling while this works from the smart
    recorded samples the file actually contains, so interpolation moves some
    seconds across a boundary. Verified 2026-08-29: totals agree to within
    2 s and the largest per-zone difference is 46 s out of 2931.
    """
    normalized = normalize(
        read_fit(reference_fit),
        source=SOURCE_STRAVA_FIT,
        source_file=reference_fit.name,
        source_file_sha256="deadbeef",
        athlete_id="tester",
        ingested_at=datetime(2026, 8, 29, tzinfo=UTC),
    )
    grid = resample_to_1hz(normalized.streams)
    computed = zone_time(grid, BOUNDARIES)["seconds_s"].to_numpy()

    device = np.array([24.457, 46.0, 331.0, 1997.533, 531.88, 0.0, 0.0])

    assert computed.sum() == pytest.approx(device.sum(), abs=5.0)
    assert np.abs(computed - device).max() < 60.0
    assert int(np.argmax(computed)) == int(np.argmax(device))
