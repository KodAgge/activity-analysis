"""The efficiency pass inside recompute.

Built on the five committed fixtures rather than on synthetic grids, because
what is under test here is the wiring: which activities reach the fit, that
the tables are written, and that a failure is contained. The arithmetic is
tested against synthetic data in tests/test_efficiency.py.
"""

from __future__ import annotations

import pandas as pd
import pytest

from activity_analysis.analysis.pipeline import recompute
from activity_analysis.config import Paths
from activity_analysis.store.writer import (
    read_activities,
    read_activity_efficiency,
    read_athlete_fit,
    upsert_activities,
)


@pytest.fixture
def store_with_a_treadmill_run(ingested_store: Paths) -> tuple[Paths, str]:
    """The five fixtures are all outdoor, so one is relabelled a treadmill run.

    ``is_indoor`` is derived from ``sub_sport == "treadmill"`` at recompute,
    so rewriting the canonical row is enough; nothing is re-ingested.
    """
    activities = read_activities(ingested_store)
    treadmill = str(activities["activity_id"].iloc[0])
    activities.loc[activities["activity_id"] == treadmill, "sub_sport"] = "treadmill"
    activities.to_parquet(ingested_store.activities_parquet, index=False)
    return ingested_store, treadmill


def test_recompute_writes_the_smoothed_columns(ingested_store: Paths) -> None:
    """The efficiency table carries its smoothed columns after a recompute.

    ``smooth_efficiency`` is a separate function from ``efficiency_rows``, so
    a pipeline that never called it would leave every smoothed column null
    while every test in tests/test_efficiency.py still passed.
    """
    recompute(ingested_store)
    rows = read_activity_efficiency(ingested_store)

    for column in (
        "hr_at_slow_smoothed_bpm",
        "hr_at_median_smoothed_bpm",
        "hr_at_fast_smoothed_bpm",
        "cadence_at_slow_smoothed_spm",
        "cadence_at_median_smoothed_spm",
        "cadence_at_fast_smoothed_spm",
        "is_aerobic_long_run",
        "decoupling_smoothed_pct",
    ):
        assert column in rows.columns
    assert rows["cadence_at_median_smoothed_spm"].notna().any()


#: The 2026-08-28 reference run, steady and 2932 fitted seconds, so inside
#: the population. Its halves were measured on 2026-10-03, independently of
#: this module, from the grid's moving seconds with speed above 1 m/s and
#: finite heart rate: 2.5574 and 2.4451 m/s, 148.41 and 163.24 bpm.
REFERENCE_RUN = "854fd775d479ca9f"


def test_recompute_writes_the_halves_decoupling_compares(ingested_store: Paths) -> None:
    recompute(ingested_store)
    rows = read_activity_efficiency(ingested_store).set_index("activity_id")
    row = rows.loc[REFERENCE_RUN]
    assert row["decoupling_pct"] == pytest.approx(13.0762, abs=1e-4)
    assert row["decoupling_first_speed_mps"] == pytest.approx(2.5574, abs=1e-4)
    assert row["decoupling_second_speed_mps"] == pytest.approx(2.4451, abs=1e-4)
    assert row["decoupling_first_hr_bpm"] == pytest.approx(148.41, abs=0.01)
    assert row["decoupling_second_hr_bpm"] == pytest.approx(163.24, abs=0.01)
    first = row["decoupling_first_speed_mps"] / row["decoupling_first_hr_bpm"]
    second = row["decoupling_second_speed_mps"] / row["decoupling_second_hr_bpm"]
    assert row["decoupling_pct"] == pytest.approx(100.0 * (first - second) / first, rel=1e-9)


def test_the_smoothed_columns_are_computed_in_time_order(ingested_store: Paths) -> None:
    """The first run in time order can only ever see itself.

    ``efficiency_rows`` returns rows in sample order, which is the order the
    derived grids were walked in rather than the order they were run in, so
    the pass has to establish both the order and the instants before a
    trailing window means anything.
    """
    recompute(ingested_store)
    rows = read_activity_efficiency(ingested_store)
    activities = read_activities(ingested_store)

    when = activities.set_index("activity_id")["start_time_utc"]
    ordered = rows.assign(start=rows["activity_id"].map(when)).sort_values("start")
    first = ordered.iloc[0]

    assert first["cadence_at_median_smoothed_spm"] == pytest.approx(first["cadence_at_median_spm"])


@pytest.fixture
def store_with_a_walk(ingested_store: Paths) -> tuple[Paths, str]:
    """The five fixtures are all runs, so one is slowed to a walk.

    Its canonical ``distance_m`` is divided by four and its stream is left
    alone, so every second it recorded still looks like running and only the
    whole-activity moving speed gives it away. That is the shape the
    exclusion exists for, and the shape neither the per-second speed filter
    nor the effort classifier can see.

    The canonical column rather than the stream, because that is the one
    ``activity_metrics.avg_speed_mps`` divides and therefore the one the rule
    reads.
    """
    activities = read_activities(ingested_store)
    walker = str(activities["activity_id"].iloc[0])
    activities.loc[activities["activity_id"] == walker, "distance_m"] /= 4.0
    upsert_activities(ingested_store, activities)
    return ingested_store, walker


def test_a_walk_gets_no_efficiency_row(store_with_a_walk: tuple[Paths, str]) -> None:
    """The walk rule has to survive the wiring, not only the unit test.

    ``ActivitySample.moving_speed_mps`` defaults to None, so a pipeline that
    forgot to pass it would leave the rule silently dead on the real store
    while every test in tests/test_efficiency.py still passed.
    """
    paths, walker = store_with_a_walk
    recompute(paths)
    rows = read_activity_efficiency(paths)
    assert walker not in set(rows["activity_id"])
    assert len(rows) > 0


def test_recompute_writes_one_athlete_fit_row(ingested_store: Paths) -> None:
    """Whole-history quantities are one row, rewritten each rebuild, not
    appended. A second row would mean two different fits were in force at
    once and no efficiency row could say which it used."""
    recompute(ingested_store)
    recompute(ingested_store)
    fit = read_athlete_fit(ingested_store)
    assert len(fit) == 1
    assert fit.loc[0, "ref_slow_mps"] <= fit.loc[0, "ref_median_mps"] <= fit.loc[0, "ref_fast_mps"]


def test_recompute_writes_efficiency_rows_for_eligible_runs(ingested_store: Paths) -> None:
    result = recompute(ingested_store)
    rows = read_activity_efficiency(ingested_store)
    assert result.efficiency_rows == len(rows)
    assert len(rows) > 0
    assert rows["hr_at_median_bpm"].notna().all()
    assert (rows["fit_seconds"] > 0).all()


def test_an_intervals_session_gets_no_efficiency_row(ingested_store: Paths) -> None:
    """One fixture is a real interval session. Heart rate lags speed sharply
    through repetitions, so the relation being fitted does not hold in it."""
    recompute(ingested_store)
    rows = read_activity_efficiency(ingested_store)
    assert "intervals" not in set(rows["effort_tag"])
    assert len(rows) == 4


def test_a_treadmill_run_gets_no_efficiency_row(
    store_with_a_treadmill_run: tuple[Paths, str],
) -> None:
    """Its distance comes from an uncalibrated footpod, so its speed channel
    is not comparable with an outdoor run's and must not enter a fit whose
    whole purpose is comparing across runs."""
    paths, treadmill = store_with_a_treadmill_run
    recompute(paths)
    rows = read_activity_efficiency(paths)
    assert not rows.empty
    assert treadmill not in set(rows["activity_id"])


def test_an_efficiency_failure_does_not_lose_the_other_derived_tables(
    ingested_store: Paths, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The efficiency pass runs after every grid is on disk, so an exception
    escaping it would leave fresh grids against tables that were never
    rewritten. It must be contained the same way the tag history is."""
    import activity_analysis.analysis.pipeline as pipeline

    def boom(*args: object, **kwargs: object) -> object:
        raise RuntimeError("efficiency exploded")

    monkeypatch.setattr(pipeline, "efficiency_rows", boom)
    result = recompute(ingested_store)
    assert any(label == "efficiency" for label, _ in result.errors)
    assert result.activities == 5
    assert result.efficiency_rows == 0
    assert read_activity_efficiency(ingested_store).empty
    assert read_athlete_fit(ingested_store).empty
    assert isinstance(pd.read_parquet(ingested_store.activity_metrics_parquet), pd.DataFrame)
