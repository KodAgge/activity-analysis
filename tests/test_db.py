import shutil
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from activity_analysis.analysis.pipeline import recompute
from activity_analysis.config import Paths
from activity_analysis.ingest.pipeline import ingest
from activity_analysis.store.db import connect, read_grid


def test_views_exist_and_are_empty_before_ingestion(tmp_path: Path):
    paths = Paths(root=tmp_path)
    paths.ensure()
    with connect(paths) as con:
        assert con.execute("SELECT count(*) FROM activities").fetchone()[0] == 0
        assert con.execute("SELECT count(*) FROM laps").fetchone()[0] == 0
        assert con.execute("SELECT count(*) FROM streams").fetchone()[0] == 0


def test_queries_ingested_data(tmp_path: Path, all_fit_fixtures: list[Path]):
    root = tmp_path / "dump"
    root.mkdir()
    for path in all_fit_fixtures:
        shutil.copy(path, root / path.name)
    paths = Paths(root=tmp_path / "store")
    ingest(paths, root)

    with connect(paths) as con:
        assert con.execute("SELECT count(*) FROM activities").fetchone()[0] == 5
        assert con.execute("SELECT count(*) FROM laps").fetchone()[0] == 45
        # 450 + 562 + 626 + 764 + 872
        assert con.execute("SELECT count(*) FROM streams").fetchone()[0] == 3274


def test_streams_join_to_activities(tmp_path: Path, reference_fit: Path):
    root = tmp_path / "dump"
    root.mkdir()
    shutil.copy(reference_fit, root / reference_fit.name)
    paths = Paths(root=tmp_path / "store")
    ingest(paths, root)

    with connect(paths) as con:
        total = con.execute(
            """
            SELECT count(*) FROM streams s
            JOIN activities a USING (activity_id)
            WHERE a.sport = 'running'
            """
        ).fetchone()[0]
    assert total == 626


def test_derived_views_exist_even_with_no_derived_data(tmp_path: Path):
    # Callers should be able to query unconditionally rather than branching on
    # whether recompute has ever run.
    with connect(Paths(root=tmp_path)) as con:
        for view in (
            "streams_1hz",
            "best_efforts",
            "zone_time",
            "activity_metrics",
            "athlete_profile",
        ):
            row = con.execute(f"SELECT count(*) FROM {view}").fetchone()
            assert row is not None and row[0] == 0


def test_derived_views_read_the_derived_layer(tmp_path: Path, all_fit_fixtures: list[Path]):
    paths = Paths(root=tmp_path)
    source = tmp_path / "fixtures"
    source.mkdir()
    for fixture in all_fit_fixtures:
        shutil.copy(fixture, source / fixture.name)
    ingest(paths, source, athlete_id="tester")
    recompute(paths)

    with connect(paths) as con:
        metrics = con.execute("SELECT count(*) FROM activity_metrics").fetchone()
        assert metrics is not None and metrics[0] == 5
        efforts = con.execute("SELECT count(*) FROM best_efforts").fetchone()
        assert efforts is not None and efforts[0] > 0

        # The join the overview screen will actually make.
        rows = con.execute(
            """
            SELECT z.zone_index, sum(z.seconds_s) AS seconds
            FROM zone_time z JOIN activities a USING (activity_id)
            WHERE a.sport = 'running'
            GROUP BY 1 ORDER BY 1
            """
        ).fetchall()
        assert len(rows) == 7


def test_a_stored_file_predating_a_column_reads_as_null(tmp_path: Path, reference_fit: Path):
    """A store written before a schema addition must degrade, not raise.

    Dropping the column and re-writing the file reproduces exactly what a
    canonical store ingested before ``utc_offset_s`` existed looks like on
    disk. A bare ``SELECT *`` view would fail every query naming the column
    with a binder error; projecting through the schema yields nulls until the
    next ingest rewrites the file.
    """
    source = tmp_path / "dump"
    source.mkdir()
    shutil.copy(reference_fit, source / reference_fit.name)
    paths = Paths(root=tmp_path / "store")
    ingest(paths, source)

    stored = pq.read_table(paths.activities_parquet)
    pq.write_table(stored.drop_columns(["utc_offset_s"]), paths.activities_parquet)

    with connect(paths) as con:
        rows = con.execute(
            "SELECT activity_id, utc_offset_s FROM activities ORDER BY activity_id"
        ).fetchall()
    assert len(rows) == 1
    assert rows[0][1] is None


def test_a_derived_stream_file_predating_a_column_reads_as_null(
    tmp_path: Path, reference_fit: Path
):
    """The derived grid is one file per activity, so staleness is per file.

    A column added to GRID_SCHEMA leaves every file written before it without
    that column, and recompute rewrites them one activity at a time. The view
    has to read the rewritten and the stale file together, so it must union the
    per-file schemas by name rather than bind to whichever file it reads first.
    The stale file is named to sort first, which is the arrangement that makes
    the canonical glob refuse to build: here the rebuilt file keeps its real
    values, and that difference is the whole reason the two globs are read
    differently.
    """
    source = tmp_path / "dump"
    source.mkdir()
    shutil.copy(reference_fit, source / reference_fit.name)
    paths = Paths(root=tmp_path / "store")
    ingest(paths, source)
    recompute(paths)

    rebuilt = next(iter(paths.derived_streams_dir.glob("*.parquet")))
    grid = pq.read_table(rebuilt).drop_columns(["hr_bpm"])
    stale = grid.set_column(
        grid.schema.get_field_index("activity_id"),
        "activity_id",
        pa.array(["0000_stale"] * grid.num_rows, pa.string()),
    )
    pq.write_table(stale, paths.derived_stream_path("0000_stale"))

    with connect(paths) as con:
        rows = con.execute(
            """
            SELECT activity_id, count(*), count(hr_bpm)
            FROM streams_1hz GROUP BY 1 ORDER BY 1
            """
        ).fetchall()

    assert len(rows) == 2
    stale_row = next(row for row in rows if row[0] == "0000_stale")
    rebuilt_row = next(row for row in rows if row[0] != "0000_stale")
    assert stale_row[1] == grid.num_rows and stale_row[2] == 0
    assert rebuilt_row[2] > 0


def test_a_stale_canonical_stream_file_fails_only_when_the_column_is_read(
    tmp_path: Path, reference_fit: Path
):
    """A plain glob cannot tell an absent column from a discarded one.

    Canonical streams are one file per activity and ingest skips files already
    in the ledger, so a column added to STREAM_SCHEMA leaves old files beside
    new ones. DuckDB binds the glob to whichever file expands first; when that
    file lacks the column, every row would read null and the values the other
    files do carry would be dropped without an error.

    Projecting an error in that column's place puts the failure on the query
    that reads it. Opening the store, counting its rows and reading every other
    column stay available, which is what makes the store diagnosable while it
    is stale.
    """
    source = tmp_path / "dump"
    source.mkdir()
    shutil.copy(reference_fit, source / reference_fit.name)
    paths = Paths(root=tmp_path / "store")
    ingest(paths, source)

    current = next(iter(paths.streams_dir.glob("*.parquet")))
    stale = pq.read_table(current).drop_columns(["hr_bpm"])
    # Sorts before any hex activity id, so the scan binds to the stale file.
    pq.write_table(stale, paths.streams_dir / "0000_stale.parquet")

    with connect(paths) as con:
        assert con.execute("SELECT count(*) FROM streams").fetchone()[0] == 2 * stale.num_rows
        assert con.execute("SELECT count(DISTINCT activity_id) FROM streams").fetchone()[0] == 1
        assert con.execute("SELECT count(*) FROM activities").fetchone()[0] == 1

        with pytest.raises(duckdb.Error) as raised:
            con.execute("SELECT hr_bpm FROM streams").fetchall()

    assert "hr_bpm" in str(raised.value)
    assert "--force" in str(raised.value)


def test_a_cursor_can_read_the_views_of_an_empty_store(tmp_path: Path):
    """Views must survive being read from a cursor rather than the connection.

    The API takes a ``cursor()`` per request from one connection opened at
    startup. A view built over a relation registered with ``con.register``
    breaks there, because a registered Python object lives in the registering
    connection's own temporary catalog and a cursor does not inherit it: the
    view binds, and reading it raises ``Table with name _empty_activities does
    not exist``. It fails only on an empty store, which is the state a new
    user is in.
    """
    con = connect(Paths(root=tmp_path))
    cur = con.cursor()
    for table in ("activities", "laps", "streams", "streams_1hz", "best_efforts"):
        assert cur.execute(f"SELECT count(*) FROM {table}").fetchone()[0] == 0


def test_read_grid_returns_the_activitys_own_rows(ingested_store: Paths):
    with connect(ingested_store) as con:
        activity_id = con.execute("SELECT activity_id FROM streams_1hz LIMIT 1").fetchone()[0]
    table = read_grid(ingested_store, activity_id)
    assert table is not None
    assert table.num_rows > 0
    assert set(table.column("activity_id").to_pylist()) == {activity_id}


def test_read_grid_is_none_for_an_activity_with_no_grid(ingested_store: Paths):
    assert read_grid(ingested_store, "0123456789abcdef") is None


def test_read_grid_rejects_an_id_that_is_not_an_id(ingested_store: Paths):
    """The id reaches this function from a URL and becomes a filename.

    Anything that is not a bare hex digest has to be refused before it is
    joined to a path, or the caller names the file that gets read.
    """
    for hostile in ("../../etc/passwd", "..", "a/b", "0123456789abcdef.parquet"):
        with pytest.raises(ValueError):
            read_grid(ingested_store, hostile)
