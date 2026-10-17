"""Store plumbing for the phase 4 tables."""

from __future__ import annotations

from pathlib import Path

from activity_analysis.config import Paths
from activity_analysis.models import (
    ACTIVITY_EFFICIENCY_SCHEMA,
    ATHLETE_FIT_SCHEMA,
    FITNESS_SERIES_SCHEMA,
    empty_frame,
)
from activity_analysis.store.db import connect
from activity_analysis.store.writer import (
    read_activity_efficiency,
    read_athlete_fit,
    read_fitness_series,
    write_activity_efficiency,
    write_athlete_fit,
    write_fitness_series,
)


def test_each_table_round_trips_empty(tmp_path: Path) -> None:
    paths = Paths(root=tmp_path)
    paths.ensure()
    write_activity_efficiency(paths, empty_frame(ACTIVITY_EFFICIENCY_SCHEMA))
    write_athlete_fit(paths, empty_frame(ATHLETE_FIT_SCHEMA))
    write_fitness_series(paths, empty_frame(FITNESS_SERIES_SCHEMA))
    assert read_activity_efficiency(paths).empty
    assert read_athlete_fit(paths).empty
    assert read_fitness_series(paths).empty


def test_each_table_is_queryable_before_it_has_ever_been_written(tmp_path: Path) -> None:
    """``connect`` binds every view when the connection opens, so a store that
    has never been recomputed must still be queryable rather than raising.
    That is the property ``_empty_view`` exists for, and it has to hold for the
    new tables too or the API will not start against a fresh store."""
    paths = Paths(root=tmp_path)
    paths.ensure()
    con = connect(paths)
    for view in ("activity_efficiency", "athlete_fit", "fitness_series"):
        assert con.execute(f"select count(*) from {view}").fetchone()[0] == 0
    con.close()
