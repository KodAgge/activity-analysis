"""`scripts/build_demo_store.py`, built small: four weeks, twice, into temporary roots.

Structural checks only. The demo store's numbers are scripted, so asserting on
them would test the script's constants rather than anything the project does.
"""

from __future__ import annotations

import importlib.util
import sys
from collections.abc import Iterator
from datetime import date
from pathlib import Path
from types import ModuleType
from typing import Any

import pandas as pd
import pytest

from activity_analysis.config import Paths
from activity_analysis.identity import compute_activity_id
from activity_analysis.store.writer import (
    read_activities,
    read_activity_metrics,
    read_best_efforts,
    read_device_vo2max,
    read_laps,
    read_route_runs,
    read_routes,
    read_sport_reclassifications,
    read_streams,
)

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "build_demo_store.py"
END = date(2026, 10, 4)
WEEKS = 4


def _load_script() -> ModuleType:
    spec = importlib.util.spec_from_file_location("build_demo_store", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # dataclasses resolves the module's annotations through sys.modules.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def script() -> Iterator[ModuleType]:
    module = _load_script()
    yield module
    sys.modules.pop("build_demo_store", None)


@pytest.fixture(scope="module")
def two_builds(
    script: ModuleType, tmp_path_factory: pytest.TempPathFactory
) -> tuple[Paths, Paths, Any]:
    first = tmp_path_factory.mktemp("demo-a")
    second = tmp_path_factory.mktemp("demo-b")
    summary = script.build(first, end=END, weeks=WEEKS)
    script.build(second, end=END, weeks=WEEKS)
    return Paths(root=first), Paths(root=second), summary


def test_activity_count_and_identity(
    script: ModuleType, two_builds: tuple[Paths, Paths, Any]
) -> None:
    paths, _, _ = two_builds
    activities = read_activities(paths)

    # Five fixtures plus three to five runs in each of four weeks.
    assert 5 + 3 * WEEKS <= len(activities) <= 5 + 5 * WEEKS + 1
    assert activities["activity_id"].is_unique
    assert set(activities["sport"]) == {"running"}
    fixtures = activities[activities["source_file"].str.startswith("run-2026-08-")]
    assert len(fixtures) == 5

    # Every id is the provisional identity of its own start time under the
    # demo athlete, so reconciliation against a later ingest behaves as for a
    # real file and no id can equal one from a real store.
    assert set(activities["athlete_id"]) == {script.DEMO_ATHLETE_ID}
    for activity_id, start in zip(
        activities["activity_id"], activities["start_time_utc"], strict=True
    ):
        assert activity_id == compute_activity_id(script.DEMO_ATHLETE_ID, start.to_pydatetime())
    synthetic = activities[activities["source_file"].str.startswith("demo-")]
    local = synthetic["start_time_utc"] + pd.to_timedelta(synthetic["utc_offset_s"], unit="s")
    assert local.dt.date.max() <= END
    assert local.dt.date.nunique() == len(synthetic), "one synthetic run a day"


def test_streams_and_laps_are_well_formed(two_builds: tuple[Paths, Paths, Any]) -> None:
    paths, _, _ = two_builds
    activities = read_activities(paths)
    laps = read_laps(paths)
    for activity_id, distance_m in zip(
        activities["activity_id"], activities["distance_m"], strict=True
    ):
        stream = read_streams(paths, str(activity_id))
        assert not stream.empty
        assert stream["t_s"].is_monotonic_increasing
        assert (stream["distance_m"].diff().dropna() >= -0.05).all()
        assert stream["distance_m"].iloc[-1] == pytest.approx(distance_m, abs=5.0)
        own = laps[laps["activity_id"] == activity_id]
        assert not own.empty
        assert own["distance_m"].sum() == pytest.approx(distance_m, rel=0.01)


def test_recompute_produced_the_derived_layer(two_builds: tuple[Paths, Paths, Any]) -> None:
    paths, _, summary = two_builds
    rc = summary.recompute
    assert rc.errors == []
    activities = read_activities(paths)
    metrics = read_activity_metrics(paths)
    assert set(metrics["activity_id"]) == set(activities["activity_id"])
    assert read_sport_reclassifications(paths).empty

    # The 2026-08-21 fixture holds a jump in its distance channel that its
    # speed does not confirm, so the runs re-timed from it carry untrusted
    # short efforts, as it does. Every other effort is trusted.
    efforts = read_best_efforts(paths)
    trusted = efforts[efforts["distance_trusted"]]
    assert {"5k", "10k"} <= set(trusted["distance_key"])
    assert len(trusted) > 0.8 * len(efforts)

    routes = read_routes(paths)
    assert len(routes) >= 1
    assert (routes["run_count"] >= 3).all()
    assert not read_route_runs(paths).empty
    assert not read_device_vo2max(paths).empty


def test_two_builds_are_identical(two_builds: tuple[Paths, Paths, Any]) -> None:
    first, second, _ = two_builds

    def canonical(paths: Paths) -> pd.DataFrame:
        # ingest stamps the five fixtures with the clock.
        frame = read_activities(paths).drop(columns="ingested_at")
        return frame.sort_values("activity_id").reset_index(drop=True)

    pd.testing.assert_frame_equal(canonical(first), canonical(second))
    pd.testing.assert_frame_equal(
        read_laps(first).sort_values(["activity_id", "lap_index"]).reset_index(drop=True),
        read_laps(second).sort_values(["activity_id", "lap_index"]).reset_index(drop=True),
    )
    for activity_id in canonical(first)["activity_id"]:
        pd.testing.assert_frame_equal(
            read_streams(first, activity_id), read_streams(second, activity_id)
        )
    pd.testing.assert_frame_equal(read_best_efforts(first), read_best_efforts(second))
    pd.testing.assert_frame_equal(read_device_vo2max(first), read_device_vo2max(second))


def test_refuses_a_root_that_already_holds_a_store(script: ModuleType, tmp_path: Path) -> None:
    (tmp_path / "data").mkdir()
    with pytest.raises(FileExistsError):
        script.build(tmp_path, end=END, weeks=WEEKS)
    assert script.main([str(tmp_path), "--end", END.isoformat(), "--weeks", str(WEEKS)]) == 2


def test_refuses_an_end_before_the_fixtures(script: ModuleType, tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="--end"):
        script.build(tmp_path, end=date(2026, 8, 1), weeks=WEEKS)
    assert not (tmp_path / "data").exists()
