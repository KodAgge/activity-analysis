"""The fitness pass inside recompute."""

from __future__ import annotations

import pytest

from activity_analysis.analysis.pipeline import recompute
from activity_analysis.config import Paths
from activity_analysis.store.writer import read_fitness_series


def test_recompute_writes_a_fitness_row_per_contributing_activity(ingested_store: Paths) -> None:
    result = recompute(ingested_store)
    rows = read_fitness_series(ingested_store)
    assert result.fitness_rows == len(rows)
    assert rows["activity_id"].is_unique
    # The five fixture runs are outdoors with clean kilometre efforts, so at
    # least the VDOT side contributes and the table is not written empty.
    assert result.fitness_rows > 0
    assert (rows["analysis_version"] > 0).all()


def test_every_row_carries_at_least_one_estimate(ingested_store: Paths) -> None:
    """A row with neither estimate would be an activity saying nothing."""
    recompute(ingested_store)
    rows = read_fitness_series(ingested_store)
    assert (rows["hr_vo2max"].notna() | rows["vdot"].notna()).all()


def test_a_fitness_failure_does_not_lose_the_other_derived_tables(
    ingested_store: Paths, monkeypatch: pytest.MonkeyPatch
) -> None:
    import activity_analysis.analysis.pipeline as pipeline

    def boom(*args: object, **kwargs: object) -> object:
        raise RuntimeError("fitness exploded")

    monkeypatch.setattr(pipeline, "fitness_rows", boom)
    result = recompute(ingested_store)
    assert any(label == "fitness" for label, _ in result.errors)
    assert result.activities > 0
    assert result.fitness_rows == 0
    # The table is still written, empty, so every consumer reads a table
    # with no rows rather than a stale one from the previous rebuild.
    assert read_fitness_series(ingested_store).empty
