"""DuckDB views over the canonical and derived Parquet layers.

Views are always created, even when no data has been ingested, so callers can
query unconditionally instead of branching on whether files exist.

Tolerance for a file written before a column was added is deliberately not
uniform, because a null does not mean the same thing in each case.

A single-file view reads the absent column as null: with one file, absent
really is absent for every row, so the null is the truth. The derived
``streams_1hz`` glob reads it as null too, through ``union_by_name``, which
unions the per-file schemas so the null lands only on the files that lack the
column. The canonical ``streams`` glob does neither, because a plain glob binds
to one file's schema and a null there would be indistinguishable from a value
quietly discarded from every other file. It projects an error in that column's
place instead, so the failure lands on the query that reads the column rather
than on ``connect``: counting rows, listing activities and inspecting the store
all keep working while the operator sorts the staleness out. See ``connect``
for why the two globs differ.
"""

from __future__ import annotations

import re
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

from activity_analysis.config import Paths
from activity_analysis.models import (
    ACTIVITY_EFFICIENCY_SCHEMA,
    ACTIVITY_METRICS_SCHEMA,
    ACTIVITY_SCHEMA,
    ACTIVITY_TAG_SCHEMA,
    ATHLETE_FIT_SCHEMA,
    ATHLETE_PROFILE_SCHEMA,
    BEST_EFFORT_SCHEMA,
    DEVICE_VO2MAX_SCHEMA,
    FITNESS_SERIES_SCHEMA,
    GRID_SCHEMA,
    LAP_SCHEMA,
    ROUTE_RUN_SCHEMA,
    ROUTE_SCHEMA,
    SPORT_RECLASSIFICATION_SCHEMA,
    STREAM_SCHEMA,
    TERRITORY_CLAIM_SCHEMA,
    TERRITORY_PART_SCHEMA,
    TERRITORY_REGION_SCHEMA,
    ZONE_TIME_SCHEMA,
)

#: An activity id is a hex digest produced by ``identity``. Anything else
#: reaching a lookup came from a URL, not from the store.
_ACTIVITY_ID = re.compile(r"\A[0-9a-f]{1,64}\Z")


def read_grid(paths: Paths, activity_id: str) -> pa.Table | None:
    """One activity's 1 Hz grid, read from its own file.

    Filtering the ``streams_1hz`` view by ``activity_id`` is several times
    slower against the real store, because the column lives inside the files
    and the glob reads every file's footer to answer it. This is a lookup by
    primary key, and the primary key is the filename. See the stream endpoint
    in ``docs/reference/api.md`` for the measurements.

    ``None`` when the activity has no grid, which is every sport but running:
    the derived layer covers running only.

    Projected through ``GRID_SCHEMA`` so that reading one file keeps the
    tolerance the ``streams_1hz`` view gets from ``union_by_name``: a grid
    written before a channel existed reads as nulls in that channel rather
    than raising. A partly rebuilt grid directory is the normal intermediate
    state of an ANALYSIS_VERSION bump, and it must not turn the fast path into
    a different answer from the slow one.
    """
    if not _ACTIVITY_ID.match(activity_id):
        raise ValueError(f"not an activity id: {activity_id!r}")
    path = paths.derived_stream_path(activity_id)
    if not path.exists():
        return None
    return _project(pq.read_table(path), GRID_SCHEMA)


def _project(table: pa.Table, schema: pa.Schema) -> pa.Table:
    """``table`` under ``schema``, with a typed null column for what it lacks.

    The single-file counterpart of ``_parquet_view``'s NULL substitution, and
    honest for the same reason: with one file, a column absent from it is
    absent from every row it can return.
    """
    if table.schema.names == list(schema.names):
        return table
    present = set(table.column_names)
    columns = [
        table.column(field.name).cast(field.type)
        if field.name in present
        else pa.nulls(table.num_rows, field.type)
        for field in schema
    ]
    return pa.Table.from_arrays(columns, schema=schema)


def _stale_store_message(view: str, location: Path, missing: list[str]) -> str:
    """What a query naming a column the stored files do not have gets told."""
    return (
        f"{view}: {location} holds Parquet written before the current schema, "
        f"missing {', '.join(missing)}. Reading across the directory cannot tell "
        f"that from a column absent everywhere, so it could return null where "
        f"other files hold real values. Run "
        f"'activity-analysis ingest <export> --force' to rewrite every stored "
        f"file under the current schema."
    )


def _sql_string(value: str | Path) -> str:
    """A single-quoted SQL literal.

    DuckDB rejects prepared parameters inside CREATE VIEW, so paths have to be
    inlined and therefore quoted properly.
    """
    return "'" + str(value).replace("'", "''") + "'"


def _register_schema(
    con: duckdb.DuckDBPyConnection, name: str, schema: pa.Schema
) -> dict[str, str]:
    """Register an empty table for ``schema`` and return DuckDB's column types.

    Asking DuckDB to describe its own conversion of the Arrow schema avoids
    maintaining a second Arrow-to-DuckDB type table that could drift from it.

    Unregistered again immediately. The relation exists only for the DESCRIBE,
    and a registered relation is exactly the thing a cursor cannot see, so
    leaving it in the catalog would leave a shape for a later view to bind to
    and reintroduce the bug ``_empty_view`` documents.
    """
    registered = f"_empty_{name}"
    con.register(registered, schema.empty_table())
    try:
        described = con.execute(f"DESCRIBE SELECT * FROM {registered}").fetchall()
    finally:
        con.unregister(registered)
    return {column: column_type for column, column_type, *_ in described}


def _empty_view(con: duckdb.DuckDBPyConnection, name: str, types: dict[str, str]) -> None:
    """A correctly typed view over no rows.

    Built from typed NULL literals rather than from the registered Arrow table
    that ``_register_schema`` describes. A relation registered with
    ``con.register`` lives in the registering connection's own temporary
    catalog, and ``con.cursor()`` does not inherit it, so a view referring to
    one binds but raises ``Table with name _empty_activities does not exist``
    when a cursor reads it. The API takes a cursor per request, and an empty
    store is the state a new user is in.
    """
    projection = ", ".join(
        f'CAST(NULL AS {column_type}) AS "{column}"' for column, column_type in types.items()
    )
    con.execute(f"CREATE OR REPLACE VIEW {name} AS SELECT {projection} WHERE false")


def _parquet_view(
    con: duckdb.DuckDBPyConnection,
    name: str,
    source: str,
    types: dict[str, str],
    location: Path,
    *,
    absent_is_null: bool,
) -> None:
    """A view over stored Parquet, projected through the current schema.

    A file written before a column was added does not contain it, and a bare
    ``SELECT *`` would then fail every query that names it with a binder error
    rather than a null. Selecting the schema's columns explicitly, substituting
    a correctly typed NULL for any the file lacks, lets a stale store degrade to
    nulls until the next ingest or recompute rewrites it.

    That substitution is only honest when a column absent from what the scan
    binds is absent from every row it will return, which is what
    ``absent_is_null`` asserts. It holds for a single file, and for a glob read
    with ``union_by_name``, which unions the per-file schemas before binding.
    It does not hold for a plain glob: DuckDB binds to whichever file the
    pattern happens to expand to first, so a column missing from that one file
    would be projected as NULL across the whole directory, discarding the values
    the remaining files really do carry, with no error.

    Where the substitution would be a lie, the column is projected as
    ``error(...)`` rather than as NULL. The view still binds, so opening a
    connection never fails and every query that does not name the column - row
    counts, the activity listing, any other view - keeps working. Only a query
    that actually reads the column fails, and it fails with the remedy.
    """
    present = {row[0] for row in con.execute(f"DESCRIBE SELECT * FROM {source}").fetchall()}
    missing = [column for column in types if column not in present]
    if missing and not absent_is_null:
        stale = _sql_string(_stale_store_message(name, location, missing))
        absent = f"error({stale})"
    else:
        absent = "NULL"
    projection = ", ".join(
        f'"{column}"' if column in present else f'CAST({absent} AS {column_type}) AS "{column}"'
        for column, column_type in types.items()
    )
    con.execute(f"CREATE OR REPLACE VIEW {name} AS SELECT {projection} FROM {source}")


def connect(paths: Paths) -> duckdb.DuckDBPyConnection:
    """An in-memory DuckDB connection with a view over every stored table."""
    con = duckdb.connect()

    for name, path, schema in (
        ("canonical_activities", paths.activities_parquet, ACTIVITY_SCHEMA),
        ("laps", paths.laps_parquet, LAP_SCHEMA),
        ("device_vo2max", paths.device_vo2max_parquet, DEVICE_VO2MAX_SCHEMA),
        ("best_efforts", paths.best_efforts_parquet, BEST_EFFORT_SCHEMA),
        ("zone_time", paths.zone_time_parquet, ZONE_TIME_SCHEMA),
        ("activity_metrics", paths.activity_metrics_parquet, ACTIVITY_METRICS_SCHEMA),
        ("athlete_profile", paths.athlete_profile_parquet, ATHLETE_PROFILE_SCHEMA),
        ("activity_tags", paths.activity_tags_parquet, ACTIVITY_TAG_SCHEMA),
        ("activity_efficiency", paths.activity_efficiency_parquet, ACTIVITY_EFFICIENCY_SCHEMA),
        ("athlete_fit", paths.athlete_fit_parquet, ATHLETE_FIT_SCHEMA),
        ("fitness_series", paths.fitness_series_parquet, FITNESS_SERIES_SCHEMA),
        ("routes", paths.routes_parquet, ROUTE_SCHEMA),
        ("route_runs", paths.route_runs_parquet, ROUTE_RUN_SCHEMA),
        ("territory_claims", paths.territory_claims_parquet, TERRITORY_CLAIM_SCHEMA),
        ("territory_regions", paths.territory_regions_parquet, TERRITORY_REGION_SCHEMA),
        ("territory_parts", paths.territory_parts_parquet, TERRITORY_PART_SCHEMA),
        (
            "sport_reclassifications",
            paths.sport_reclassifications_parquet,
            SPORT_RECLASSIFICATION_SCHEMA,
        ),
    ):
        types = _register_schema(con, name, schema)
        if path.exists():
            _parquet_view(
                con,
                name,
                f"read_parquet({_sql_string(path)})",
                types,
                path,
                absent_is_null=True,
            )
        else:
            _empty_view(con, name, types)

    # Every consumer reads the sport an activity is counted as, so that a walk
    # recorded on the running profile drops out of each running query, the
    # sport filter and /api/sports without any of them knowing the rule.
    # `recorded_sport` keeps what the device wrote. `canonical_activities` is
    # the stored table unadjusted; nothing in the code reads it, and it is
    # there for ad hoc queries such as the reproduction SQL in
    # docs/reference/math/reclassification.md.
    con.execute(
        "CREATE OR REPLACE VIEW activities AS "
        "SELECT a.* REPLACE (coalesce(r.sport, a.sport) AS sport), "
        "a.sport AS recorded_sport "
        "FROM canonical_activities a "
        "LEFT JOIN sport_reclassifications r USING (activity_id)"
    )

    # One Parquet file per activity, so the view is a glob rather than a list.
    # A full export is thousands of files and listing them all would make the
    # view definition grow without bound.
    #
    # union_by_name lets a glob read a column that only some files carry, but
    # it has to open every file's footer to do it, and the view binds when the
    # connection opens rather than at first query. Measured over the real store
    # as the DESCRIBE that binds the view:
    #
    #   canonical streams, 1944 files:    6.8 ms plain, 137.2 ms unioned
    #   derived streams_1hz, 307 files:   1.5 ms plain,   9.0 ms unioned
    #
    # The cost is linear in file count, so it grows with the athlete's history.
    # Only the derived grid pays it. That is where a schema addition actually
    # bites: recompute rewrites the grid one activity at a time, so a partly
    # rebuilt directory is the normal intermediate state, and every
    # ANALYSIS_VERSION bump puts it there. The canonical stream schema changes
    # far more rarely, so paying 137 ms on every connection to anticipate it is
    # the wrong trade. The API opens one connection at startup and takes a
    # cursor per request, so this cost is paid once per server rather than once
    # per request, but it is still the cost of anticipating a change that the
    # canonical layer rarely makes.
    #
    # The canonical glob therefore cannot tell an absent column from a
    # discarded one, and says so rather than guessing. It says so at the point
    # the column is read, not when the connection opens, so a stale stream
    # directory never makes the rest of the store unreachable. A partial
    # re-ingest is not enough to recover; only --force rewrites every file.
    for name, directory, schema, union in (
        ("streams", paths.streams_dir, STREAM_SCHEMA, False),
        ("streams_1hz", paths.derived_streams_dir, GRID_SCHEMA, True),
    ):
        types = _register_schema(con, name, schema)
        if any(directory.glob("*.parquet")):
            pattern = _sql_string(directory / "*.parquet")
            options = ", union_by_name=true" if union else ""
            _parquet_view(
                con,
                name,
                f"read_parquet({pattern}{options})",
                types,
                directory,
                absent_is_null=union,
            )
        else:
            _empty_view(con, name, types)

    return con
