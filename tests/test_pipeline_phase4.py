"""Recompute writes the phase 4 tables even before anything fills them.

An absent Parquet file and an empty one are different states downstream: the
first makes every consumer branch on existence, the second lets them all read
a table with no rows. Writing them empty from the start is what keeps plans
008 and 009 from each having to add the same guard.
"""

from __future__ import annotations

from activity_analysis.analysis.pipeline import recompute
from activity_analysis.config import Paths
from activity_analysis.store.writer import read_fitness_series


def test_recompute_creates_all_three_tables(ingested_store: Paths) -> None:
    recompute(ingested_store)
    assert ingested_store.activity_efficiency_parquet.exists()
    assert ingested_store.athlete_fit_parquet.exists()
    assert ingested_store.fitness_series_parquet.exists()
    # Filled by the fitness pass; tests/test_pipeline_fitness.py owns its shape.
    assert not read_fitness_series(ingested_store).empty
