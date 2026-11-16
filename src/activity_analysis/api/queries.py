"""Every SQL statement the API issues.

Kept out of the routers so that the queries can be read together, and so that
a router is small enough to see at a glance that it does no arithmetic of its
own. Each function returns plain Python containers: nothing lazy escapes the
request that opened the cursor.

``fetchall()`` on a ``TIMESTAMPTZ`` column makes DuckDB import ``pytz``, which
is not a dependency of this project, and the failure is an unrelated-looking
``ModuleNotFoundError``. Read results with ``to_arrow_table()`` instead.
"""

from __future__ import annotations

from datetime import date
from typing import Any

import duckdb

from activity_analysis.analysis.best_efforts import (
    JUMP_UNCHECKABLE,
    JUMP_UNCONFIRMED,
    JUMP_UNKNOWN,
    STANDARD_DISTANCES_M,
    VDOT_DISTANCES_M,
)
from activity_analysis.analysis.pipeline import RUNNING_SPORT


def _sql_text(value: str) -> str:
    """``value`` as a SQL string literal. Only ever given this module's constants."""
    return "'" + value.replace("'", "''") + "'"


#: Whether a best effort ``be`` may be a record, given its activity's metrics
#: ``m``: the one statement of the rule every records-shaped query applies.
#: ``docs/reference/derived-layer.md`` states it under "Records exclude the
#: efforts the best-efforts invariant above says they must". A treadmill's
#: distance comes from an uncalibrated footpod, and an effort whose
#: ``distance_trusted`` is not true holds a jump in the recorded distance
#: that the measured speed did not confirm. Each must be explicitly false or
#: true: a null means "not known", and a record is the one consumer for which
#: an unverified effort is worse than no effort. The analysis layer applies
#: the same rule through ``best_efforts.distance_trusted``.
_EFFORT_ELIGIBLE_SQL = "(m.is_indoor IS FALSE AND be.distance_trusted IS TRUE)"

#: Why ``_EFFORT_ELIGIBLE_SQL`` fails, or null when it holds. The ``is_indoor``
#: cases come first because they are the whole activity, and each flag names
#: the case it knows apart from the case nobody looked at, so a chart can say
#: why a faster point did not count without claiming more than was measured.
#: The jump strings are ``analysis.best_efforts``' own, the ones
#: ``analysis.routes`` stores for the same causes.
_EFFORT_INELIGIBLE_REASON_SQL = f"""CASE
    WHEN m.is_indoor IS TRUE THEN 'treadmill'
    WHEN m.is_indoor IS NULL THEN 'not known to be outdoors'
    WHEN be.distance_trusted IS NULL THEN {_sql_text(JUMP_UNKNOWN)}
    WHEN be.distance_trusted IS FALSE AND be.speed_distance_m IS NULL
        THEN {_sql_text(JUMP_UNCHECKABLE)}
    WHEN be.distance_trusted IS FALSE THEN {_sql_text(JUMP_UNCONFIRMED)}
END"""

COUNTED_TABLES = (
    "activities",
    "laps",
    "streams",
    "streams_1hz",
    "best_efforts",
    "zone_time",
    "activity_metrics",
    "activity_tags",
    "athlete_profile",
    "activity_efficiency",
    "athlete_fit",
    "fitness_series",
    "sport_reclassifications",
)


def store_counts(cur: duckdb.DuckDBPyConnection) -> dict[str, int]:
    counts: dict[str, int] = {}
    for table in COUNTED_TABLES:
        row = cur.execute(f"SELECT count(*) FROM {table}").fetchone()
        counts[table] = int(row[0]) if row else 0
    return counts


def stored_versions(cur: duckdb.DuckDBPyConnection) -> tuple[list[int], list[int]]:
    """The distinct schema versions present in the stored files."""
    ingest = (
        cur.execute("SELECT DISTINCT ingest_version FROM activities ORDER BY 1")
        .to_arrow_table()
        .column(0)
        .to_pylist()
    )
    analysis = (
        cur.execute("SELECT DISTINCT analysis_version FROM activity_metrics ORDER BY 1")
        .to_arrow_table()
        .column(0)
        .to_pylist()
    )
    return [int(v) for v in ingest], [int(v) for v in analysis]


SUMMARY_COLUMNS = (
    "activity_id",
    "start_time_utc",
    "utc_offset_s",
    "sport",
    "recorded_sport",
    "sub_sport",
    "name",
    "distance_m",
    "elapsed_time_s",
    "timer_time_s",
    "ascent_m",
    "descent_m",
    "max_speed_mps",
    "avg_hr_bpm",
    "max_hr_bpm",
    "avg_cadence_spm",
    "calories",
    "source",
)

#: Every ``SUMMARY_COLUMNS`` entry qualified onto ``activities`` (aliased
#: ``a``), plus ``moving_time_s`` and ``avg_speed_mps`` from the derived layer.
#:
#: ``elapsed_time_s`` and ``distance_m`` exist on both sides of the join
#: below, so leaving any of ``SUMMARY_COLUMNS`` unqualified would be an
#: ambiguous-column error the moment the join is added rather than silently
#: picking the wrong side. ``moving_time_s`` comes from ``m`` (
#: ``activity_metrics``) rather than from ``a`` on purpose: the canonical
#: ``activities.moving_time_s`` is a byte-identical duplicate of
#: ``timer_time_s`` (see docs/reference/api.md, "``moving_time_s`` is always
#: the derived layer's"), so selecting it under this name would
#: silently show the device's auto-paused timer as this project's own
#: elapsed-minus-paused definition - the exact mistake already found and
#: fixed once in ``volume_by_period``, which this mirrors.
#:
#: ``avg_speed_mps`` comes from ``m`` for the reason ``moving_time_s`` does,
#: and it is the stored column read unchanged: ``analysis/metrics.py`` owns
#: the division, which is the activity's canonical distance over this
#: project's moving time, so the Distance, Moving time and Pace the browser
#: renders side by side all come from one distance and one clock.
#:
#: The canonical tail is a fallback, not a second opinion. This list renders
#: a Pace column for every sport and the derived layer covers running only,
#: so a ride or a walk has no ``activity_metrics`` row at all and would show
#: an empty column. Measured on the real store the fallback carries 286
#: non-running rows, all from 2026-01-23 onward, mostly walks, and they carry
#: the device's own definition, which is the honest answer for a sport
#: nothing here analyses. It also catches the degenerate running rows the
#: derived column is null on, a zero distance or a zero moving time, where a
#: served zero would render as an infinite pace.
#:
#: ``a.avg_speed_mps`` stays out of ``SUMMARY_COLUMNS`` so the qualified list
#: above remains unambiguous; it appears only inside this expression, and
#: ``SORTABLE_COLUMNS`` names the identical expression so the browser cannot
#: sort by one number while showing another.
SUMMARY_SELECT = (
    ", ".join(f"a.{column}" for column in SUMMARY_COLUMNS)
    + ", m.moving_time_s"
    + ", coalesce(m.avg_speed_mps, a.avg_speed_mps) AS avg_speed_mps"
    # `coalesce(..., [])` rather than a bare list: `list()` over no rows is
    # NULL, and "this run set no records" is an empty list rather than an
    # unknown. A null here would make the client guess.
    + ", coalesce(pr.pr_distance_keys, []) AS pr_distance_keys"
    + ", coalesce(et.effort_tags, []) AS effort_tags"
)

#: Which distances each activity holds a personal record at, ordered by the
#: distance itself rather than by the key's spelling - `'10k'` sorts before
#: `'1k'` alphabetically and after it in metres, and the badge reads wrong
#: either way round if the order is a coincidence.
#:
#: Read from ``activity_tags``, which is where the analysis layer already
#: decided what a record is: the first eligible effort at a distance is one,
#: a treadmill effort cannot be one, and an effort whose ``distance_trusted``
#: is not true cannot be one either, on both sides of the comparison. See "Records exclude the
#: efforts the best-efforts invariant above says they must" in
#: docs/reference/derived-layer.md, and ``analysis/tags.py``'s ``TagHistory``
#: for the implementation. Re-deriving any of that here would be exactly the
#: compute-on-read shortcut CLAUDE.md's Architecture section rules out, and
#: it would drift: measured on the real store, the five fastest 400 m efforts
#: all carry ``contains_jump``, the fastest of them implying 13.45 m/s,
#: so a records list that skipped this rule would lead with a number no
#: human has run.
#:
#: The join to ``best_efforts`` is 1:1 - that table holds one row per
#: (activity, distance) - so it supplies the distance without duplicating a
#: tag.
PR_DISTANCE_KEYS_FROM = """(
    SELECT t.activity_id,
           list(t.distance_key ORDER BY be.distance_m) AS pr_distance_keys
    FROM activity_tags t
    JOIN best_efforts be
      ON be.activity_id = t.activity_id AND be.distance_key = t.distance_key
    WHERE t.tag = 'pr'
    GROUP BY 1
)"""

#: Each activity's tag names from ``activity_tags``, each once, the effort
#: classification first and the flags after it by name, as ``recent_runs``
#: orders them: ``['steady', 'long_run']``. ``pr`` is left out because
#: ``pr_distance_keys`` already carries it with its distances. Read from the
#: classifier's own table and never re-derived, for the reason
#: ``PR_DISTANCE_KEYS_FROM`` gives; the training plan's lead-in colours each
#: run by it from the list it already fetches, rather than one detail
#: request per run.
EFFORT_TAGS_FROM = """(
    SELECT activity_id,
           list(tag ORDER BY effort DESC, tag) AS effort_tags
    FROM (SELECT DISTINCT activity_id, tag, kind = 'effort' AS effort
          FROM activity_tags
          WHERE tag <> 'pr')
    GROUP BY 1
)"""

#: LEFT, not INNER: a running activity ingested but not yet recomputed - or
#: any non-running activity, which the derived layer never covers at all -
#: still has to appear in the list, with ``moving_time_s`` null rather than
#: the row vanishing. Same shape as ``volume_by_period``'s join.
SUMMARY_FROM = (
    "activities a "
    "LEFT JOIN activity_metrics m ON m.activity_id = a.activity_id "
    f"LEFT JOIN {PR_DISTANCE_KEYS_FROM} pr ON pr.activity_id = a.activity_id "
    f"LEFT JOIN {EFFORT_TAGS_FROM} et ON et.activity_id = a.activity_id"
)

#: Only these six, because they are the only orderings the list's columns ask for.
#: The column name goes into the SQL text unparameterised, so an open sort
#: parameter would be an injection surface for no gain. The route's Literal
#: rejects anything else first; this is the second lock on the same door.
#:
#: Each maps to the table it is actually read from: ``moving_time_s`` only
#: ever lives on ``activity_metrics`` (aliased ``m``), the other five on
#: ``activities`` (aliased ``a``) - both are ambiguous unqualified once the
#: join in ``SUMMARY_FROM`` is in scope, and sorting is always by the list's
#: own canonical value. An earlier version of the "Moving time" browser
#: column rendered ``moving_time_s`` but sorted by ``elapsed_time_s``,
#: because this set did not carry the column at all yet: measured on the
#: real store, 197 of 307 running rows changed position between an
#: elapsed-descending and a moving-descending sort, with 30 adjacent
#: inversions.
SORTABLE_COLUMNS = {
    "start_time_utc": "a.start_time_utc",
    "distance_m": "a.distance_m",
    "elapsed_time_s": "a.elapsed_time_s",
    "moving_time_s": "m.moving_time_s",
    # Pace is not stored and never will be (CLAUDE.md: "Never store pace"),
    # so a pace sort is a sort on the speed it is the reciprocal of. That
    # inverts the direction, and the inversion is the client's to apply: this
    # set names stored SI columns and orders them, and inventing a virtual
    # "pace" key here would put a unit conversion in the query layer for the
    # one column that has one.
    #
    # The identical expression ``SUMMARY_SELECT`` renders. Sorting on one
    # column while showing another is the same defect the moving-time comment
    # above records: taking ``m`` alone here would put every non-running row
    # in one null block, ordered by nothing, beside a Pace column that shows
    # them a number.
    "avg_speed_mps": "coalesce(m.avg_speed_mps, a.avg_speed_mps)",
    "avg_hr_bpm": "a.avg_hr_bpm",
}
SORTABLE = frozenset(SORTABLE_COLUMNS)

#: An activity's local calendar date, from the instant and the offset it was
#: recorded under. ``AT TIME ZONE 'UTC'`` is what makes this independent of
#: the reader: DuckDB renders a TIMESTAMPTZ in the session timezone
#: otherwise, so the expression would be right only on a machine set to UTC.
LOCAL_DATE_SQL = "(start_time_utc AT TIME ZONE 'UTC' + to_seconds(coalesce(utc_offset_s, 0)))::DATE"


def sport_counts(cur: duckdb.DuckDBPyConnection) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = (
        cur.execute("SELECT sport, count(*) AS count FROM activities GROUP BY 1 ORDER BY 2 DESC")
        .to_arrow_table()
        .to_pylist()
    )
    return rows


#: Sentinel values the ``sport`` filter accepts that are not sports.
#: ``ALL_SPORTS`` turns the filter off, because a missing parameter cannot
#: mean everything when the default is running. ``UNKNOWN_SPORT`` selects the
#: rows whose sport is null, which is what GPX ingestion writes and what
#: ``sport_counts`` reports as a null bucket: without it the frontend renders
#: a chip from that bucket that no request can select.
ALL_SPORTS = "all"
UNKNOWN_SPORT = "unknown"


def _filters(
    sport: str | None,
    start: date | None,
    end: date | None,
    source: str | None,
    has_hr: bool | None,
    q: str | None,
    min_distance_m: float | None,
    max_distance_m: float | None,
    min_moving_time_s: float | None,
    max_moving_time_s: float | None,
    has_pr: bool | None,
) -> tuple[str, list[Any]]:
    """The WHERE clause shared by the page and its own total.

    Every column reference is qualified. It did not have to be while the
    only relation in scope was ``activities``, and it does now: ``SUMMARY_FROM``
    joins ``activity_metrics``, which carries its own ``distance_m``,
    ``elapsed_time_s`` and ``activity_id``, so a bare name that reads fine
    today would become an ambiguity error the moment a filter touched one of
    those three.
    """
    clauses: list[str] = []
    params: list[Any] = []
    if sport == UNKNOWN_SPORT:
        clauses.append("a.sport IS NULL")
    elif sport is not None:
        clauses.append("a.sport = ?")
        params.append(sport)
    if start is not None:
        clauses.append(f"{LOCAL_DATE_SQL} >= ?")
        params.append(start)
    if end is not None:
        clauses.append(f"{LOCAL_DATE_SQL} < ?")
        params.append(end)
    if source is not None:
        clauses.append("a.source = ?")
        params.append(source)
    if has_hr is not None:
        clauses.append("a.avg_hr_bpm IS NOT NULL" if has_hr else "a.avg_hr_bpm IS NULL")
    if q:
        clauses.append("a.name ILIKE ?")
        params.append(f"%{q}%")
    if min_distance_m is not None:
        clauses.append("a.distance_m >= ?")
        params.append(min_distance_m)
    if max_distance_m is not None:
        clauses.append("a.distance_m <= ?")
        params.append(max_distance_m)
    # Against the derived column, not the canonical one of the same name -
    # for exactly the reason `SUMMARY_SELECT` projects `m.moving_time_s`. A
    # row with no derived layer has no moving time to compare, so it falls
    # out of a moving-time filter rather than being coerced into passing or
    # failing it; that is 1637 of 1944 rows in the real store, every one of
    # them a non-running activity or one not yet recomputed.
    if min_moving_time_s is not None:
        clauses.append("m.moving_time_s >= ?")
        params.append(min_moving_time_s)
    if max_moving_time_s is not None:
        clauses.append("m.moving_time_s <= ?")
        params.append(max_moving_time_s)
    if has_pr is not None:
        clauses.append(
            "pr.pr_distance_keys IS NOT NULL" if has_pr else "pr.pr_distance_keys IS NULL"
        )
    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    return where, params


def activity_page(
    cur: duckdb.DuckDBPyConnection,
    *,
    sport: str | None,
    start: date | None,
    end: date | None,
    source: str | None,
    has_hr: bool | None,
    q: str | None,
    min_distance_m: float | None = None,
    max_distance_m: float | None = None,
    min_moving_time_s: float | None = None,
    max_moving_time_s: float | None = None,
    has_pr: bool | None = None,
    sort: str,
    descending: bool,
    limit: int,
    offset: int,
) -> tuple[int, list[dict[str, Any]]]:
    if sort not in SORTABLE:
        raise ValueError(f"not a sortable column: {sort!r}")
    where, params = _filters(
        sport,
        start,
        end,
        source,
        has_hr,
        q,
        min_distance_m,
        max_distance_m,
        min_moving_time_s,
        max_moving_time_s,
        has_pr,
    )

    # Counted over the same FROM as the page below, not over `activities`
    # alone. The moving-time and personal-record filters live on the joined
    # tables, so a total taken from the canonical table would count rows the
    # page then filtered out - a pager reporting more results than the list
    # can reach.
    total_row = cur.execute(f"SELECT count(*) FROM {SUMMARY_FROM}{where}", params).fetchone()
    total = int(total_row[0]) if total_row else 0

    direction = "DESC" if descending else "ASC"
    order_column = SORTABLE_COLUMNS[sort]
    # activity_id breaks ties so that two runs starting in the same second do
    # not swap places between two requests for adjacent pages, which would
    # make one of them appear twice while another vanished. NULLS LAST
    # matters for moving_time_s specifically: it is null for every activity
    # the derived layer does not cover, which is 1637 of 1944 rows in the
    # real store, and those belong at the bottom of a "longest run" sort
    # rather than scattered through it by DuckDB's own default placement.
    rows = cur.execute(
        f"SELECT {SUMMARY_SELECT} FROM {SUMMARY_FROM}{where} "
        f"ORDER BY {order_column} {direction} NULLS LAST, a.activity_id LIMIT ? OFFSET ?",
        [*params, limit, offset],
    ).to_arrow_table()
    return total, rows.to_pylist()


def activity_summary(cur: duckdb.DuckDBPyConnection, activity_id: str) -> dict[str, Any] | None:
    rows: list[dict[str, Any]] = (
        cur.execute(
            f"SELECT {SUMMARY_SELECT} FROM {SUMMARY_FROM} WHERE a.activity_id = ?",
            [activity_id],
        )
        .to_arrow_table()
        .to_pylist()
    )
    return rows[0] if rows else None


def records(cur: duckdb.DuckDBPyConnection) -> list[dict[str, Any]]:
    """The athlete's best eligible effort at each distance, fastest key first.

    **Eligibility is the analysis layer's rule, restated here rather than
    invented.** ``docs/reference/derived-layer.md`` states it under "Records
    exclude the efforts the best-efforts invariant above says they must": a
    treadmill activity's distance comes from an uncalibrated footpod, and an
    effort whose ``distance_trusted`` is not true was credited metres the
    measured speed does not account for. Both are excluded on *both* sides of
    the comparison, so an ineligible effort neither sets a record nor becomes
    a baseline. ``_EFFORT_ELIGIBLE_SQL`` holds the rule, and a null in either
    flag means "not known", which a record is the one consumer to treat as
    worse than no effort at all.

    That rule is not decoration. Measured on the real store, the five fastest
    400 m efforts all carry ``contains_jump``, the quickest of them 29.7 s -
    13.45 m/s, faster than the 100 m world record's peak - and their recorded
    distance runs 56% to 447% ahead of the measured speed, so none is
    trusted. A records list that ignored the flag would lead with the jump.

    The result agrees with the ``pr`` tags at every distance: the activity
    holding the minimum eligible time is the activity carrying the most
    recent ``pr`` tag for that distance. These are two independent paths to
    one fact - this query against the derived tables, ``analysis.tags``'s
    ``TagHistory`` against the efforts in time order - and a disagreement
    would mean one of them is wrong.
    ``tests/test_api_records.py::test_the_record_is_the_activity_holding_the_most_recent_pr_tag``
    asserts the identity on a synthetic store, running the real tagger over
    efforts that include a faster jump and a faster treadmill time carrying
    no tag, so a records query that dropped its eligibility filter would
    disagree with the tags and fail.

    That includes a distance with exactly one eligible effort. Until
    2026-09-05 it was the documented exception: a ``pr`` tag meant "beat a
    previous best" while this list meant "your best", and the two coincide
    only when there is a previous best. The first eligible effort at a
    distance is now a record on both sides, so a sole effort is served here
    with ``effort_count`` 1 and its activity carries the tag, the badge and
    the ``has_pr`` match. The identity test covers that case with a distance
    that has one eligible effort beside a faster treadmill one.

    ``effort_count`` counts the eligible efforts only, so it answers "out of
    how many comparable attempts" rather than "how many times the extractor
    found this distance".

    ``local_date`` rides along for the training plan's context, which files
    each record under its day; ``Record`` ignores it, so the endpoint does not
    serve it.
    """
    rows: list[dict[str, Any]] = (
        cur.execute(
            f"""
            WITH eligible AS (
                SELECT be.distance_key,
                       be.distance_m,
                       be.elapsed_time_s,
                       be.activity_id,
                       be.avg_hr_bpm
                FROM best_efforts be
                JOIN activity_metrics m ON m.activity_id = be.activity_id
                WHERE {_EFFORT_ELIGIBLE_SQL}
                  AND be.elapsed_time_s IS NOT NULL
            ),
            ranked AS (
                SELECT e.*,
                       row_number() OVER (
                           PARTITION BY e.distance_key
                           ORDER BY e.elapsed_time_s, e.activity_id
                       ) AS rn,
                       count(*) OVER (PARTITION BY e.distance_key) AS effort_count
                FROM eligible e
            )
            SELECT r.distance_key,
                   r.distance_m,
                   r.elapsed_time_s,
                   r.avg_hr_bpm,
                   r.effort_count,
                   r.activity_id,
                   a.start_time_utc,
                   a.utc_offset_s,
                   a.name,
                   {LOCAL_DATE_SQL} AS local_date
            FROM ranked r
            JOIN activities a ON a.activity_id = r.activity_id
            WHERE r.rn = 1
            ORDER BY r.distance_m
            """
        )
        .to_arrow_table()
        .to_pylist()
    )
    return rows


def stored_sport(
    cur: duckdb.DuckDBPyConnection, activity_id: str
) -> tuple[bool, str | None, str | None]:
    """Whether the store knows the id, the sport it counts as and the one recorded.

    The presence is separate because ``sport`` is itself nullable, so a null
    cannot stand in for an absent row. Both sports, because a run counted as a
    walk has no derived layer for a reason neither one says alone. Separate
    from ``activity_summary`` because the stream route needs these and none of
    the other columns.
    """
    rows: list[dict[str, Any]] = (
        cur.execute(
            "SELECT sport, recorded_sport FROM activities WHERE activity_id = ?", [activity_id]
        )
        .to_arrow_table()
        .to_pylist()
    )
    if not rows:
        return False, None, None
    return True, rows[0]["sport"], rows[0]["recorded_sport"]


def reclassification(cur: duckdb.DuckDBPyConnection, activity_id: str) -> dict[str, Any] | None:
    """Why an activity recorded as a run is counted as something else, or None.

    Read from ``sport_reclassifications``, where ``recompute`` recorded the
    decision with the pace it was judged on, rather than re-judged here.
    """
    rows: list[dict[str, Any]] = (
        cur.execute(
            "SELECT recorded_sport, sport, avg_speed_mps, threshold_mps "
            "FROM sport_reclassifications WHERE activity_id = ?",
            [activity_id],
        )
        .to_arrow_table()
        .to_pylist()
    )
    return rows[0] if rows else None


def laps(cur: duckdb.DuckDBPyConnection, activity_id: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = (
        cur.execute(
            "SELECT lap_index, start_time_utc, trigger, elapsed_time_s, distance_m, "
            "avg_speed_mps, avg_hr_bpm, max_hr_bpm, avg_cadence_spm, ascent_m, "
            "descent_m, calories FROM laps WHERE activity_id = ? ORDER BY lap_index",
            [activity_id],
        )
        .to_arrow_table()
        .to_pylist()
    )
    return rows


def derived_blocks(
    cur: duckdb.DuckDBPyConnection, activity_id: str
) -> tuple[dict[str, Any] | None, list[dict[str, Any]], list[dict[str, Any]]]:
    """The derived layer's three per-activity tables, or nothing.

    The metrics row is what says whether the activity has a derived layer at
    all: ``recompute`` writes one per run and nothing for any other sport.
    """
    metrics_rows: list[dict[str, Any]] = (
        cur.execute(
            "SELECT elapsed_time_s, moving_time_s, paused_time_s, distance_m, "
            "ascent_per_km_m, is_indoor, has_hr, has_gps, is_gpx_sourced, "
            "locality, country_code, country, locality_distance_m "
            "FROM activity_metrics WHERE activity_id = ?",
            [activity_id],
        )
        .to_arrow_table()
        .to_pylist()
    )
    zones: list[dict[str, Any]] = (
        cur.execute(
            "SELECT zone_index, low_bpm, high_bpm, seconds_s FROM zone_time "
            "WHERE activity_id = ? ORDER BY zone_index",
            [activity_id],
        )
        .to_arrow_table()
        .to_pylist()
    )
    # `is_eligible` and `ineligible_reason` are the progression chart's own
    # two columns, from the same fragments, so an activity and the chart say
    # the same thing about one effort.
    efforts: list[dict[str, Any]] = (
        cur.execute(
            "SELECT be.distance_key, be.distance_m, be.elapsed_time_s, be.start_t_s, "
            "be.end_t_s, be.avg_hr_bpm, be.contains_pause, be.contains_outage, "
            "be.contains_jump, be.speed_distance_m, be.distance_trusted, "
            f"{_EFFORT_ELIGIBLE_SQL} AS is_eligible, "
            f"{_EFFORT_INELIGIBLE_REASON_SQL} AS ineligible_reason "
            "FROM best_efforts be "
            "LEFT JOIN activity_metrics m ON m.activity_id = be.activity_id "
            "WHERE be.activity_id = ? ORDER BY be.distance_m",
            [activity_id],
        )
        .to_arrow_table()
        .to_pylist()
    )
    return (metrics_rows[0] if metrics_rows else None), zones, efforts


def decoupling_facts(cur: duckdb.DuckDBPyConnection, activity_id: str) -> dict[str, Any] | None:
    """What the activity view needs to show a run's decoupling, or say why not.

    The efficiency columns are null when the efficiency pass wrote no row,
    and the metrics and the effort tag are the stored facts the absent reason
    is chosen from. None only when the run has no metrics row, which is the
    whole derived block being absent and has its own reason.

    The effort tag is read from ``activity_tags``, the classifier's own table,
    rather than the copy on ``activity_efficiency``, because a run the
    efficiency pass left out has no copy.
    """
    rows: list[dict[str, Any]] = (
        cur.execute(
            "SELECT m.is_indoor, m.has_hr, m.moving_time_s, m.avg_speed_mps, "
            "t.tag AS effort_tag, e.fit_seconds, e.is_aerobic_long_run, e.decoupling_pct, "
            "e.decoupling_first_speed_mps, e.decoupling_second_speed_mps, "
            "e.decoupling_first_hr_bpm, e.decoupling_second_hr_bpm "
            "FROM activity_metrics m "
            "LEFT JOIN activity_efficiency e ON e.activity_id = m.activity_id "
            "LEFT JOIN activity_tags t ON t.activity_id = m.activity_id AND t.kind = 'effort' "
            "WHERE m.activity_id = ?",
            [activity_id],
        )
        .to_arrow_table()
        .to_pylist()
    )
    return rows[0] if rows else None


#: The order the standard distances are served in, as a SQL list literal. Two
#: ``pr`` rows differ only by ``distance_key``, so without a third sort key
#: their order is whatever the Parquet file happens to hold. Sorting on the
#: text would put "400m" after "3k", so the key is position in the analysis
#: module's own ascending list, which cannot drift from the values it produced.
_DISTANCE_ORDER_SQL = "[" + ", ".join(f"'{key}'" for key in STANDARD_DISTANCES_M) + "]"

#: The nine keys the race models may read, as a SQL tuple literal. Built from
#: the constant rather than spelled out, so the query cannot drift from
#: ``analysis/best_efforts.py``. Interpolated rather than parameterised
#: because the list is a compile-time constant of this module, never input.
_VDOT_DISTANCE_KEYS_SQL = "(" + ", ".join(f"'{key}'" for key in VDOT_DISTANCES_M) + ")"


def activity_tags(cur: duckdb.DuckDBPyConnection, activity_id: str) -> list[dict[str, Any]]:
    """One activity's tags, effort first so a reader sees the classification first."""
    rows: list[dict[str, Any]] = (
        cur.execute(
            "SELECT kind, tag, distance_key, rep_count, rep_pattern, reason FROM activity_tags "
            "WHERE activity_id = ? "
            f"ORDER BY kind = 'effort' DESC, tag, list_position({_DISTANCE_ORDER_SQL}, "
            "distance_key)",
            [activity_id],
        )
        .to_arrow_table()
        .to_pylist()
    )
    return rows


#: The overview is about running. The derived layer covers nothing else, and
#: the sport it means is the one ``recompute`` filters on, not a second
#: literal that could drift away from it.
RUNNING = f"sport = '{RUNNING_SPORT}'"

#: The overview's upper bound, and the reason every query below takes a
#: ``through`` date. A device clock can be wrong, so a store can hold an
#: activity stamped in the future; ``streak`` and ``consistency`` already drop
#: those weeks, and a response where the buckets and the date range did not
#: would describe two different windows under one roof. The bound is passed
#: in rather than computed here so that it is the same notion of the current
#: week ``analysis.consistency`` uses.
THROUGH = f"{LOCAL_DATE_SQL} <= ?"


def run_local_dates(cur: duckdb.DuckDBPyConnection, *, through: date) -> list[date]:
    dates: list[date] = (
        cur.execute(
            f"SELECT {LOCAL_DATE_SQL} AS d FROM activities "
            f"WHERE {RUNNING} AND {THROUGH} ORDER BY d",
            [through],
        )
        .to_arrow_table()
        .column("d")
        .to_pylist()
    )
    return dates


def resting_hr_measured_through(cur: duckdb.DuckDBPyConnection, *, through: date) -> date | None:
    """The newest day with a measured resting heart rate, on or before ``through``.

    Only a full Garmin export carries the resting series, so this is where it
    ends, and every run more than 28 days past it rests on an older rest or
    on the device setting.
    """
    row = cur.execute(
        "SELECT max(calendar_date) FROM resting_hr "
        "WHERE resting_hr_bpm IS NOT NULL AND calendar_date <= ?",
        [through],
    ).fetchone()
    return None if row is None else row[0]


def last_activity_local_date(cur: duckdb.DuckDBPyConnection, *, through: date) -> date | None:
    """The local date of the latest activity of any sport, inside the window.

    Every sport, unlike ``run_local_dates``: this is where the store's history
    ends, and an athlete who stops running and keeps cycling has a history
    that goes on past their last run. A week after this date is not a week
    off, it is a week the store knows nothing about, because the export it
    was built from ends there.
    """
    row = cur.execute(
        f"SELECT max({LOCAL_DATE_SQL}) FROM activities WHERE {THROUGH}", [through]
    ).fetchone()
    return None if row is None else row[0]


def volume_by_period(
    cur: duckdb.DuckDBPyConnection, period: str, *, through: date, today: date
) -> list[dict[str, Any]]:
    """Runs, distance and moving time per calendar period, as a dense series.

    One row per period between the first run's period and the period holding
    ``today``, zeros included. A period with no run is a real period with no
    training, and a client drawing the array index by index would otherwise
    close the gap and show an unbroken history. Measured before this was
    fixed: 132 week rows across a 147-week span, so 15 weeks vanished in 14
    separate gaps. Densifying is a property of the series rather than a
    computed metric, so it stays inside the rule that the API is a projection
    of the store.

    ``through`` still bounds which rows are counted, and ``today`` bounds how
    far the series runs. They are not the same date: ``through`` is the
    current week's Sunday, which for up to six days at the end of most months
    falls in the next calendar month, and truncating it would emit a monthly
    bucket for a month that has not started. A bar chart draws that as "no
    training in September" during August.

    The series bound is nevertheless the later of that period and the last
    period a counted run falls in, because a device clock can be wrong: a run
    stamped inside the current week but in the next month is inside
    ``through`` and must keep its bucket rather than be dropped by the join.
    Densifying may add empty periods; it must never remove a run.

    ``date_trunc`` truncates to Monday in DuckDB, which agrees with
    ``analysis.consistency.week_start``. ``test_weekly_series_starts_on_monday``
    is what catches it if that ever changes.

    Moving time comes from ``activity_metrics``, not from the canonical column
    of the same name, which holds the device's timer time; see
    docs/reference/api.md, "``moving_time_s`` is always the derived layer's".

    The join onto activities is a LEFT JOIN because a run that has been
    ingested but not yet recomputed should contribute its distance and its
    count rather than vanishing from the chart.

    An empty store yields no rows: ``min(period_start)`` is NULL and
    ``generate_series`` over a NULL bound produces nothing, which is the
    empty series an empty store should have.
    """
    if period not in {"week", "month"}:
        raise ValueError(f"not a period: {period!r}")
    step = "1 WEEK" if period == "week" else "1 MONTH"
    rows: list[dict[str, Any]] = (
        cur.execute(
            f"WITH runs AS ("
            f"  SELECT date_trunc('{period}', {LOCAL_DATE_SQL})::DATE AS period_start,"
            f"         a.activity_id, a.distance_m, m.moving_time_s"
            f"  FROM activities a LEFT JOIN activity_metrics m USING (activity_id)"
            f"  WHERE {RUNNING} AND {THROUGH}"
            f"), span AS ("
            f"  SELECT min(period_start) AS lo,"
            f"         greatest(max(period_start),"
            f"                  date_trunc('{period}', ?::DATE)::DATE) AS hi FROM runs"
            f"), periods AS ("
            f"  SELECT unnest(generate_series(lo, hi, INTERVAL {step}))::DATE AS period_start"
            f"  FROM span"
            f") "
            f"SELECT p.period_start, "
            f"count(r.activity_id) AS runs, "
            f"coalesce(sum(r.distance_m), 0.0) AS distance_m, "
            f"coalesce(sum(r.moving_time_s), 0.0) AS moving_time_s "
            f"FROM periods p LEFT JOIN runs r USING (period_start) "
            f"GROUP BY 1 ORDER BY 1",
            [through, today],
        )
        .to_arrow_table()
        .to_pylist()
    )
    return rows


def zone_totals(cur: duckdb.DuckDBPyConnection, *, through: date) -> list[dict[str, Any]]:
    """Seconds per zone index, over the same window as everything else here.

    ``zone_time`` carries no date of its own, so the bound arrives through the
    activity the rows belong to. Without the join this would be the one field
    of the overview that still counted a run stamped in the future.
    """
    rows: list[dict[str, Any]] = (
        cur.execute(
            f"SELECT zone_index, sum(seconds_s) AS seconds_s "
            f"FROM zone_time z JOIN activities a USING (activity_id) "
            f"WHERE {RUNNING} AND {THROUGH} GROUP BY 1 ORDER BY 1",
            [through],
        )
        .to_arrow_table()
        .to_pylist()
    )
    return rows


def current_zone_boundaries(cur: duckdb.DuckDBPyConnection) -> list[float]:
    """The boundaries from the profile in force now, or the latest one stored."""
    rows: list[dict[str, Any]] = (
        cur.execute(
            "SELECT hr_zone_boundaries FROM athlete_profile ORDER BY effective_from DESC LIMIT 1"
        )
        .to_arrow_table()
        .to_pylist()
    )
    if not rows or rows[0]["hr_zone_boundaries"] is None:
        return []
    return [float(value) for value in rows[0]["hr_zone_boundaries"]]


def current_max_hr_bpm(cur: duckdb.DuckDBPyConnection) -> float | None:
    """The maximum heart rate from the profile ``current_zone_boundaries`` reads."""
    row = cur.execute(
        "SELECT max_hr_bpm FROM athlete_profile ORDER BY effective_from DESC LIMIT 1"
    ).fetchone()
    return None if row is None or row[0] is None else float(row[0])


def fitness(cur: duckdb.DuckDBPyConnection) -> list[dict[str, Any]]:
    """Both VO2max estimates per contributing activity, oldest first.

    A plain projection of ``fitness_series``: every number here, the smoothed
    columns included, was computed by ``analysis.fitness`` at recompute time.
    The table is one row per activity that produced at least one estimate, so
    a null in either column is a run that did not qualify for that method,
    never a zero.
    """
    rows: list[dict[str, Any]] = (
        cur.execute(
            "SELECT activity_id, start_time_utc, hr_vo2max, hr_vo2max_smoothed, vdot, "
            "vdot_distance_key, vdot_smoothed, qualifying_segments "
            "FROM fitness_series ORDER BY start_time_utc, activity_id"
        )
        .to_arrow_table()
        .to_pylist()
    )
    return rows


def device_vo2max(cur: duckdb.DuckDBPyConnection) -> list[dict[str, Any]]:
    """Garmin's own running VO2max by calendar day, oldest first.

    A plain projection of the canonical ``device_vo2max`` table, which
    ingestion writes from a Garmin export's MaxMet files.
    """
    rows: list[dict[str, Any]] = (
        cur.execute(
            "SELECT calendar_date, vo2max, vo2max_reported "
            "FROM device_vo2max ORDER BY calendar_date"
        )
        .to_arrow_table()
        .to_pylist()
    )
    return rows


def progression(cur: duckdb.DuckDBPyConnection, distance_key: str) -> list[dict[str, Any]]:
    """Every effort at one distance, oldest first, with eligibility and record status.

    **Eligibility is the analysis layer's rule, restated exactly as
    ``records`` restates it**, through the one ``_EFFORT_ELIGIBLE_SQL``:
    ``is_indoor`` explicitly false and ``distance_trusted`` explicitly true,
    with a missing metrics row a null ``is_indoor`` and therefore not known.
    ``ineligible_reason`` is ``_EFFORT_INELIGIBLE_REASON_SQL``, which names
    which flag failed and says whether the measured speed disagreed or there
    was none to check against.

    The jump strings name the distance channel rather than the GPS on
    purpose. The flag compares the odometer's implied speed against
    ``IMPLAUSIBLE_SPEED_MPS``, which is a statement about the recorded
    distance and not about position. The long form rather than a terse
    ``distance jump`` is deliberate too, because the string renders as
    ``Not eligible: {reason}`` and a terse one still reads as a jump in
    position. On one real half marathon the distance channel alone gains 4.9
    times the speed channel's reading in one second, and that effort is
    eligible: over its window the recorded distance runs only
    0.20% ahead of the measured speed.

    **``is_record`` is the staircase, computed here as a running minimum over
    eligible efforts in time order, not read from the ``pr`` tags.** The tags
    and this query are two independent paths to one fact, the same
    arrangement ``records`` has, so a drift in either one fails
    ``tests/test_api_progression.py::test_the_staircase_agrees_with_the_tagger``
    rather than propagating silently. An effort is a record when it is
    eligible and strictly below the minimum of every earlier eligible effort,
    or when there is no earlier eligible effort at all: the first eligible
    effort at a distance is a record, the rule ``analysis.tags`` adopted on
    2026-09-05. Ineligible efforts sit outside the minimum on both sides, so
    a faster treadmill effort neither sets a record nor becomes the baseline.

    Ordered by instant and then by activity id, and the window frames by that
    same order with ``ROWS`` rather than ``RANGE`` so two efforts sharing an
    instant are compared in a fixed order instead of both seeing the other.
    """
    rows: list[dict[str, Any]] = (
        cur.execute(
            f"""
            WITH efforts AS (
                SELECT be.activity_id,
                       a.start_time_utc,
                       a.utc_offset_s,
                       a.name,
                       be.elapsed_time_s,
                       be.avg_hr_bpm,
                       m.locality,
                       {_EFFORT_ELIGIBLE_SQL} AS is_eligible,
                       {_EFFORT_INELIGIBLE_REASON_SQL} AS ineligible_reason,
                       be.contains_jump
                FROM best_efforts be
                JOIN activities a ON a.activity_id = be.activity_id
                LEFT JOIN activity_metrics m ON m.activity_id = be.activity_id
                WHERE be.distance_key = ?
                  AND be.elapsed_time_s IS NOT NULL
            ),
            laddered AS (
                SELECT e.*,
                       min(CASE WHEN e.is_eligible THEN e.elapsed_time_s END) OVER (
                           ORDER BY e.start_time_utc, e.activity_id
                           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                       ) AS best_before
                FROM efforts e
            )
            SELECT activity_id,
                   start_time_utc,
                   utc_offset_s,
                   name,
                   elapsed_time_s,
                   avg_hr_bpm,
                   locality,
                   is_eligible,
                   is_eligible AND (best_before IS NULL OR elapsed_time_s < best_before)
                       AS is_record,
                   ineligible_reason,
                   contains_jump
            FROM laddered
            ORDER BY start_time_utc, activity_id
            """,
            [distance_key],
        )
        .to_arrow_table()
        .to_pylist()
    )
    return rows


def trends(
    cur: duckdb.DuckDBPyConnection, *, since: date | None = None, through: date | None = None
) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    """The shared fit and one efficiency point per fitted activity, oldest first.

    Both tables are written by the efficiency pass in ``analysis.efficiency``
    and read here as they are. The join to ``activities`` supplies the instant
    and the offset, which the derived row deliberately does not repeat; it is
    inner, because a derived row whose activity has left the store has no
    instant to be plotted at.

    ``athlete_fit`` holds one row per recompute. The highest analysis version
    is taken should a store ever hold more than one, and ``None`` is returned
    on a store where the pass has not run, which the router serves as null
    references rather than as an error.

    ``since`` and ``through`` keep the points whose local date lies between
    them, inclusive, for the training plan's context; the endpoint serves
    every point.
    """
    fit_rows: list[dict[str, Any]] = (
        cur.execute(
            "SELECT ref_slow_mps, ref_median_mps, ref_fast_mps, hr_slope_shared_bpm_per_mps, "
            "cadence_slope_shared_spm_per_mps FROM athlete_fit "
            "ORDER BY analysis_version DESC LIMIT 1"
        )
        .to_arrow_table()
        .to_pylist()
    )
    items: list[dict[str, Any]] = (
        cur.execute(
            "SELECT e.activity_id, a.start_time_utc, a.utc_offset_s, e.effort_tag, "
            "e.hr_at_slow_bpm, e.hr_at_median_bpm, e.hr_at_fast_bpm, "
            "e.cadence_at_slow_spm, e.cadence_at_median_spm, e.cadence_at_fast_spm, "
            "e.hr_at_slow_smoothed_bpm, e.hr_at_median_smoothed_bpm, "
            "e.hr_at_fast_smoothed_bpm, e.cadence_at_slow_smoothed_spm, "
            "e.cadence_at_median_smoothed_spm, e.cadence_at_fast_smoothed_spm, "
            "e.hr_slope_shrunk_bpm_per_mps, e.hr_slope_weight, "
            "e.cadence_slope_shrunk_spm_per_mps, e.cadence_slope_weight, "
            "e.decoupling_pct, e.is_aerobic_long_run, e.decoupling_smoothed_pct, "
            "e.fit_seconds "
            "FROM activity_efficiency e JOIN activities a ON a.activity_id = e.activity_id "
            f"WHERE (?::DATE IS NULL OR {LOCAL_DATE_SQL} >= ?::DATE) "
            f"AND (?::DATE IS NULL OR {LOCAL_DATE_SQL} <= ?::DATE) "
            "ORDER BY a.start_time_utc, e.activity_id",
            [since, since, through, through],
        )
        .to_arrow_table()
        .to_pylist()
    )
    return (fit_rows[0] if fit_rows else None), items


def distributions(
    cur: duckdb.DuckDBPyConnection,
) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    """Every run's distribution values, oldest first, and the reference speed
    the frontend buckets pace against.

    The view fixes its axis over every run at once, switches variables
    without a round trip, and lists a bucket's runs, so unlike every other
    endpoint here the whole table is the response - no parameters, no
    aggregation. 151 KB of JSON on 324 runs, 26 KB gzipped (2026-09-28).

    The join is ``activity_metrics`` to ``activities``, inner: a run with no
    derived layer - every non-running activity, and a running one not yet
    recomputed - has none of the metrics this view buckets, so it is not a
    run to distribute. ``activity_efficiency`` is left, because a run the
    efficiency pass has not fitted still has every other field and must not
    vanish from every distribution but the two efficiency ones.

    ``distance_m`` is read from ``activities``, the canonical session total,
    never ``activity_metrics.distance_m``, the 1 Hz grid's odometer: the two
    disagree on a treadmill run, where the grid's figure is an uncalibrated
    footpod estimate and the session total is authoritative indoors (the
    maintainer's ruling of 2026-09-12; see docs/reference/math/units.md).

    ``athlete_fit`` holds one row per recompute; the highest analysis version
    is taken should a store ever hold more than one, and ``None`` on a store
    where the efficiency pass has not run, which the router serves as a null
    reference rather than an error - the pace-at-reference variables then
    show their own absence state.
    """
    fit_rows: list[dict[str, Any]] = (
        cur.execute("SELECT ref_median_mps FROM athlete_fit ORDER BY analysis_version DESC LIMIT 1")
        .to_arrow_table()
        .to_pylist()
    )
    items: list[dict[str, Any]] = (
        cur.execute(
            "SELECT a.activity_id, a.start_time_utc, a.utc_offset_s, m.is_indoor, "
            "a.distance_m, m.moving_time_s, m.elapsed_time_s, m.avg_speed_mps, "
            "a.avg_hr_bpm, a.max_hr_bpm, a.avg_cadence_spm, m.ascent_per_km_m, "
            "e.hr_at_median_bpm, e.cadence_at_median_spm, e.decoupling_pct, "
            "e.is_aerobic_long_run, m.days_since_previous_run "
            "FROM activity_metrics m "
            "JOIN activities a ON a.activity_id = m.activity_id "
            "LEFT JOIN activity_efficiency e ON e.activity_id = m.activity_id "
            "ORDER BY a.start_time_utc, a.activity_id"
        )
        .to_arrow_table()
        .to_pylist()
    )
    return (fit_rows[0] if fit_rows else None), items


#: The prediction window's end: the most recent run in the store, not today.
#: See ``analysis.fitness.PREDICTION_WINDOW_DAYS`` for why.
_LATEST_RUN_SQL = f"(SELECT max(start_time_utc) FROM activities WHERE {RUNNING})"


def recent_eligible_efforts(
    cur: duckdb.DuckDBPyConnection, *, window_days: int
) -> list[dict[str, Any]]:
    """The best eligible effort per distance in the trailing window, shortest first.

    The plan context's ``recent_best_efforts``, which the training plan's
    race estimate reads. Eligibility is ``records``'s rule, through the same
    ``_EFFORT_ELIGIBLE_SQL``, with a missing metrics row excluded like a
    treadmill. The window is ``window_days`` ending at the most recent run in
    the store, so the answer is a function of the store alone.

    Only ``VDOT_DISTANCES_M`` are considered, the prediction series' candidate
    set, not every extracted distance. See ``analysis/best_efforts.py``.
    """
    rows: list[dict[str, Any]] = (
        cur.execute(
            f"""
            SELECT be.distance_key,
                   be.distance_m,
                   min(be.elapsed_time_s) AS elapsed_time_s
            FROM best_efforts be
            JOIN activities a ON a.activity_id = be.activity_id
            JOIN activity_metrics m ON m.activity_id = be.activity_id
            WHERE {_EFFORT_ELIGIBLE_SQL}
              AND be.elapsed_time_s IS NOT NULL
              AND be.distance_key IN {_VDOT_DISTANCE_KEYS_SQL}
              AND a.start_time_utc >= {_LATEST_RUN_SQL} - to_days(?)
            GROUP BY 1, 2
            ORDER BY be.distance_m
            """,
            [window_days],
        )
        .to_arrow_table()
        .to_pylist()
    )
    return rows


def latest_prediction_vdots(
    cur: duckdb.DuckDBPyConnection,
) -> tuple[float | None, float | None]:
    """The two prediction VDOTs on the newest ``fitness_series`` row that has either.

    ``(best_efforts_vdot, ordinary_runs_vdot)``, each ``None`` where that
    row has no value. Both are smoothed and the ordinary-run one is already
    calibrated, so ``race_predictions`` only inverts them. ``(None, None)``
    when no row has either, which is a stated absence rather than a fallback
    to an older value.
    """
    row = cur.execute(
        """
        SELECT best_efforts_vdot, ordinary_runs_vdot
        FROM fitness_series
        WHERE best_efforts_vdot IS NOT NULL OR ordinary_runs_vdot IS NOT NULL
        ORDER BY start_time_utc DESC, activity_id DESC
        LIMIT 1
        """
    ).fetchone()
    if row is None:
        return None, None
    return (None if row[0] is None else float(row[0]), None if row[1] is None else float(row[1]))


def prediction_vdot_history(cur: duckdb.DuckDBPyConnection) -> list[dict[str, Any]]:
    """Every ``fitness_series`` row with either prediction VDOT, oldest first.

    The same rows ``latest_prediction_vdots`` picks its newest from, in the
    same order, so the last element here is what ``/api/predictions`` inverts.
    Each row carries its run's ``utc_offset_s`` from ``activities``, as
    ``fitness_on`` joins it, so a view dates the point by its own offset.
    """
    rows: list[dict[str, Any]] = (
        cur.execute(
            """
            SELECT f.activity_id, f.start_time_utc, a.utc_offset_s,
                   f.best_efforts_vdot, f.ordinary_runs_vdot
            FROM fitness_series f JOIN activities a ON a.activity_id = f.activity_id
            WHERE f.best_efforts_vdot IS NOT NULL OR f.ordinary_runs_vdot IS NOT NULL
            ORDER BY f.start_time_utc, f.activity_id
            """
        )
        .to_arrow_table()
        .to_pylist()
    )
    return rows


def effort_source(
    cur: duckdb.DuckDBPyConnection, *, distance_key: str, elapsed_time_s: float
) -> dict[str, Any] | None:
    """The run an eligible effort of this time at this distance came from, or None.

    ``recent_eligible_efforts`` aggregates to one time per distance and so
    drops the activity; this finds it again, so the training plan's context
    can say which run a best-effort prediction was converted from. The time
    is the stored value read back unchanged, so the match is exact. Should
    two runs hold the same time, the later one is taken, which is the one
    inside the prediction window whenever only one of them is.
    """
    rows: list[dict[str, Any]] = (
        cur.execute(
            f"""
            SELECT be.activity_id, a.start_time_utc, a.utc_offset_s,
                   {LOCAL_DATE_SQL} AS local_date
            FROM best_efforts be
            JOIN activities a ON a.activity_id = be.activity_id
            JOIN activity_metrics m ON m.activity_id = be.activity_id
            WHERE {_EFFORT_ELIGIBLE_SQL}
              AND be.distance_key = ?
              AND be.elapsed_time_s = ?
            ORDER BY a.start_time_utc DESC, be.activity_id
            LIMIT 1
            """,
            [distance_key, elapsed_time_s],
        )
        .to_arrow_table()
        .to_pylist()
    )
    return rows[0] if rows else None


def fitness_on(cur: duckdb.DuckDBPyConnection, *, on: date) -> dict[str, Any]:
    """The fitness estimates in force on a local date, each None when none is.

    ``hr_vo2max_smoothed``, ``best_efforts_vdot`` and ``vdot`` are the latest
    ``fitness_series`` row's on or before ``on``, read as stored: the smoothed
    estimate is the number the app reports, ``best_efforts_vdot`` is the
    prediction series' smoothed value a plan's ``expected_vdot`` starts from,
    and ``vdot`` is that run's own, null when the run held no eligible
    effort. ``garmin_vo2max`` is Garmin's value on the latest
    day on or before ``on``, unrounded (``maxMet`` x 3.5), since the plan's
    VO2max outlook works to a decimal; the watch shows it rounded.

    ``fitness_series`` carries the instant but not the offset, so the offset
    is joined from ``activities`` inside a subquery, where ``LOCAL_DATE_SQL``
    can name both columns unqualified.
    """
    estimate = cur.execute(
        f"""
        SELECT hr_vo2max_smoothed, best_efforts_vdot, vdot
        FROM (
            SELECT f.activity_id, f.start_time_utc, a.utc_offset_s,
                   f.hr_vo2max_smoothed, f.best_efforts_vdot, f.vdot
            FROM fitness_series f JOIN activities a ON a.activity_id = f.activity_id
        )
        WHERE {LOCAL_DATE_SQL} <= ?
        ORDER BY start_time_utc DESC, activity_id DESC
        LIMIT 1
        """,
        [on],
    ).fetchone()
    device = cur.execute(
        "SELECT vo2max FROM device_vo2max WHERE calendar_date <= ? "
        "ORDER BY calendar_date DESC, updated_at DESC LIMIT 1",
        [on],
    ).fetchone()
    return {
        "hr_vo2max_smoothed": None if estimate is None else estimate[0],
        "best_efforts_vdot": None if estimate is None else estimate[1],
        "vdot": None if estimate is None else estimate[2],
        "garmin_vo2max": None if device is None else device[0],
    }


def threshold_now(cur: duckdb.DuckDBPyConnection) -> dict[str, Any] | None:
    """The threshold heart rate in force at the newest run, with its readings.

    Read as ``fitness_on`` reads the newest row: the latest ``run_load`` row,
    stored as written. None when the store has no run or the newest run has
    no estimate yet, which is every run until three readings exist. The
    readings are the ``reading_ids`` that estimate was taken from, oldest first.
    """
    row = cur.execute(
        "SELECT lthr_bpm, reading_ids FROM run_load "
        "ORDER BY start_time_utc DESC, activity_id DESC LIMIT 1"
    ).fetchone()
    if row is None or row[0] is None:
        return None
    readings: list[dict[str, Any]] = (
        cur.execute(
            f"""
            SELECT activity_id, {LOCAL_DATE_SQL} AS local_date, distance_key,
                   elapsed_time_s, final_hr_bpm, vdot
            FROM (
                SELECT r.activity_id, r.start_time_utc, a.utc_offset_s,
                       r.distance_key, r.elapsed_time_s, r.final_hr_bpm, r.vdot
                FROM threshold_readings r
                JOIN activities a ON a.activity_id = r.activity_id
                WHERE list_contains(?::VARCHAR[], r.activity_id)
            )
            ORDER BY start_time_utc, activity_id
            """,
            [list(row[1] or [])],
        )
        .to_arrow_table()
        .to_pylist()
    )
    return {"lthr_bpm": row[0], "readings": readings}


def load_days(
    cur: duckdb.DuckDBPyConnection, *, since: date | None, through: date | None
) -> list[dict[str, Any]]:
    """The daily TRIMP series within inclusive local dates, oldest first.

    ``training_load.local_date`` is already a local calendar day, so it is
    compared directly.
    """
    rows: list[dict[str, Any]] = (
        cur.execute(
            "SELECT local_date, trimp, ctl, atl, form, distance_m, distance_7d_m "
            "FROM training_load "
            "WHERE (?::DATE IS NULL OR local_date >= ?::DATE) "
            "AND (?::DATE IS NULL OR local_date <= ?::DATE) "
            "ORDER BY local_date",
            [since, since, through, through],
        )
        .to_arrow_table()
        .to_pylist()
    )
    return rows


def load_weeks(
    cur: duckdb.DuckDBPyConnection, *, since: date | None, through: date | None
) -> list[dict[str, Any]]:
    """The weekly TRIMP series whose Monday is within inclusive dates, oldest first."""
    rows: list[dict[str, Any]] = (
        cur.execute(
            "SELECT week_start, days, trimp, ctl_mean, atl_mean, form_mean, distance_m "
            "FROM training_load_weekly "
            "WHERE (?::DATE IS NULL OR week_start >= ?::DATE) "
            "AND (?::DATE IS NULL OR week_start <= ?::DATE) "
            "ORDER BY week_start",
            [since, since, through, through],
        )
        .to_arrow_table()
        .to_pylist()
    )
    return rows


def trimp_per_minute_by_zone(
    cur: duckdb.DuckDBPyConnection, *, since: date, through: date
) -> list[float | None]:
    """TRIMP per minute in each estimated zone over runs within inclusive local dates.

    Five values, zone 1 first: each zone's summed stored ``trimp`` over the
    summed minutes of the rows that carry one, None for a zone with no such
    minutes. A run whose rest is at or above its max has zone seconds but no
    TRIMP, and counting its minutes would dilute the rate. A sum over stored
    rows.
    """
    rows = cur.execute(
        f"""
        SELECT zone_index, sum(trimp) AS trimp,
               sum(seconds_s) FILTER (WHERE trimp IS NOT NULL) / 60.0 AS minutes
        FROM (
            SELECT z.zone_index, z.trimp, z.seconds_s,
                   {LOCAL_DATE_SQL} AS local_date
            FROM zone_time_estimated z
            JOIN activities a ON a.activity_id = z.activity_id
        )
        WHERE local_date >= ?::DATE AND local_date <= ?::DATE
        GROUP BY zone_index
        """,
        [since, through],
    ).fetchall()
    out: list[float | None] = [None] * 5
    for zone_index, trimp, minutes in rows:
        if 0 <= zone_index < 5 and minutes and trimp is not None:
            out[zone_index] = trimp / minutes
    return out


def run_loads(
    cur: duckdb.DuckDBPyConnection, *, since: date | None, through: date | None
) -> list[dict[str, Any]]:
    """Every run's threshold, TRIMP, estimated zone seconds and heart rate histogram.

    ``zone_seconds`` is five values in zone order, empty for a run with no
    heart rate. The histogram is two parallel lists, whole bpm and seconds,
    ascending in bpm. Both are aggregated in subqueries before the join so
    neither multiplies the other's rows.
    """
    rows: list[dict[str, Any]] = (
        cur.execute(
            f"""
            SELECT activity_id, local_date, lthr_bpm, trimp,
                   rest_bpm, max_bpm, rest_from_setting, max_from_setting,
                   coalesce(zone_seconds, []::DOUBLE[]) AS zone_seconds,
                   coalesce(hr_bpm, []::INTEGER[]) AS hr_bpm,
                   coalesce(hr_seconds, []::DOUBLE[]) AS hr_seconds
            FROM (
                SELECT activity_id, start_time_utc, {LOCAL_DATE_SQL} AS local_date,
                       lthr_bpm, trimp, rest_bpm, max_bpm,
                       rest_from_setting, max_from_setting,
                       zone_seconds, hr_bpm, hr_seconds
                FROM (
                    SELECT l.activity_id, l.start_time_utc, a.utc_offset_s,
                           l.lthr_bpm, l.trimp, l.rest_bpm, l.max_bpm,
                           l.rest_from_setting, l.max_from_setting,
                           z.zone_seconds, h.hr_bpm, h.hr_seconds
                    FROM run_load l
                    JOIN activities a ON a.activity_id = l.activity_id
                    LEFT JOIN (
                        SELECT activity_id,
                               list(seconds_s ORDER BY zone_index) AS zone_seconds
                        FROM zone_time_estimated GROUP BY activity_id
                    ) z ON z.activity_id = l.activity_id
                    LEFT JOIN (
                        SELECT activity_id,
                               list(hr_bpm::INTEGER ORDER BY hr_bpm) AS hr_bpm,
                               list(seconds_s ORDER BY hr_bpm) AS hr_seconds
                        FROM hr_histogram GROUP BY activity_id
                    ) h ON h.activity_id = l.activity_id
                )
            )
            WHERE (?::DATE IS NULL OR local_date >= ?::DATE)
              AND (?::DATE IS NULL OR local_date <= ?::DATE)
            ORDER BY start_time_utc, activity_id
            """,
            [since, since, through, through],
        )
        .to_arrow_table()
        .to_pylist()
    )
    return rows


def weekly_load(
    cur: duckdb.DuckDBPyConnection, *, since: date, through: date
) -> list[dict[str, Any]]:
    """TRIMP and minutes in each estimated zone per local ISO week, oldest first.

    One row for every week that overlaps ``since`` through ``through``, keyed
    by the Monday that starts it. A week with no runs is a rest week, zero
    TRIMP and five zero minutes. A week with runs but none carrying a TRIMP,
    because none recorded heart rate, is unknown rather than zero: ``trimp``
    is None. So is ``zone_minutes`` for a week with runs but none with
    estimated zones, because none recorded heart rate or all came before the
    first threshold estimate, as the plan view's ``weeklyZoneMix`` has it. A
    week is whole: it sums every day in it that the store holds, not only the
    days inside the range. ``trimp`` sums the daily series and
    ``zone_minutes`` the estimated zone seconds of the runs dated in the week,
    five values, zone 1 first.
    """
    rows: list[dict[str, Any]] = (
        cur.execute(
            f"""
            WITH weeks AS (
                SELECT unnest(generate_series(
                    date_trunc('week', ?::DATE), date_trunc('week', ?::DATE),
                    INTERVAL 7 DAY))::DATE AS period_start
            ),
            loads AS (
                SELECT date_trunc('week', local_date)::DATE AS period_start,
                       sum(trimp) AS trimp
                FROM training_load GROUP BY 1
            ),
            runs AS (
                SELECT date_trunc('week', {LOCAL_DATE_SQL})::DATE AS period_start,
                       count(*) AS n_runs, count(trimp) AS n_loaded
                FROM (
                    SELECT l.start_time_utc, a.utc_offset_s, l.trimp
                    FROM run_load l
                    JOIN activities a ON a.activity_id = l.activity_id
                )
                GROUP BY 1
            ),
            zoned_runs AS (
                SELECT activity_id, zone_index, seconds_s,
                       date_trunc('week', {LOCAL_DATE_SQL})::DATE AS period_start
                FROM (
                    SELECT z.activity_id, z.zone_index, z.seconds_s,
                           a.start_time_utc, a.utc_offset_s
                    FROM zone_time_estimated z
                    JOIN activities a ON a.activity_id = z.activity_id
                )
            ),
            zoned AS (
                SELECT period_start, count(DISTINCT activity_id) AS n_zoned
                FROM zoned_runs GROUP BY 1
            ),
            zones AS (
                SELECT period_start, zone_index, sum(seconds_s) / 60.0 AS minutes
                FROM zoned_runs
                GROUP BY 1, 2
            )
            SELECT w.period_start,
                   CASE WHEN r.n_loaded = 0 THEN NULL
                        ELSE coalesce(l.trimp, 0.0) END AS trimp,
                   CASE WHEN r.n_runs > 0 AND coalesce(zd.n_zoned, 0) = 0 THEN NULL ELSE
                   [coalesce(sum(z.minutes) FILTER (WHERE z.zone_index = 0), 0.0),
                    coalesce(sum(z.minutes) FILTER (WHERE z.zone_index = 1), 0.0),
                    coalesce(sum(z.minutes) FILTER (WHERE z.zone_index = 2), 0.0),
                    coalesce(sum(z.minutes) FILTER (WHERE z.zone_index = 3), 0.0),
                    coalesce(sum(z.minutes) FILTER (WHERE z.zone_index = 4), 0.0)
                   ] END AS zone_minutes
            FROM weeks w
            LEFT JOIN loads l USING (period_start)
            LEFT JOIN runs r USING (period_start)
            LEFT JOIN zoned zd USING (period_start)
            LEFT JOIN zones z USING (period_start)
            GROUP BY w.period_start, l.trimp, r.n_loaded, r.n_runs, zd.n_zoned
            ORDER BY w.period_start
            """,
            [since, through],
        )
        .to_arrow_table()
        .to_pylist()
    )
    return rows


def recent_runs(
    cur: duckdb.DuckDBPyConnection, *, since: date, through: date
) -> list[dict[str, Any]]:
    """Every run from one local date through another, oldest first, as a plan judges it.

    Distance is the canonical session total and moving time and speed the
    derived layer's, the columns the activity browser shows, so a run reads
    the same in the training plan's context as in the app. The joins are
    LEFT for the reason ``volume_by_period``'s is: a run not yet recomputed
    still happened.

    ``tags`` is each tag name once, the effort classification first; a run
    that set records at several distances carries ``pr`` once, and
    ``records`` names the distances. ``zone_time_s`` is seconds per zone in
    zone order, empty for a run with no heart rate. ``trimp`` is the run's
    training load, null for a run with no heart rate, and
    ``estimated_zone_s`` its seconds in the five estimated zones, empty for a
    run with no heart rate or no threshold estimate yet. ``rest_from_setting``
    is true when the run's TRIMP was weighed against the device's resting
    heart rate setting because no measured rest was 90 days or less old,
    null for a run not yet recomputed.
    """
    rows: list[dict[str, Any]] = (
        cur.execute(
            f"""
            WITH tags AS (
                SELECT activity_id,
                       list(tag ORDER BY effort DESC, tag) AS tags
                FROM (SELECT DISTINCT activity_id, tag, kind = 'effort' AS effort
                      FROM activity_tags)
                GROUP BY 1
            ),
            zones AS (
                SELECT activity_id, list(seconds_s ORDER BY zone_index) AS zone_time_s
                FROM zone_time
                GROUP BY 1
            ),
            estimated AS (
                SELECT activity_id, list(seconds_s ORDER BY zone_index) AS estimated_zone_s
                FROM zone_time_estimated
                GROUP BY 1
            ),
            loads AS (
                SELECT activity_id, trimp, rest_from_setting FROM run_load
            )
            SELECT a.activity_id,
                   {LOCAL_DATE_SQL} AS local_date,
                   a.distance_m,
                   m.moving_time_s,
                   coalesce(m.avg_speed_mps, a.avg_speed_mps) AS avg_speed_mps,
                   a.avg_hr_bpm,
                   m.is_indoor AS indoor,
                   coalesce(t.tags, []) AS tags,
                   coalesce(z.zone_time_s, []) AS zone_time_s,
                   e.decoupling_pct,
                   l.trimp,
                   l.rest_from_setting,
                   coalesce(est.estimated_zone_s, []) AS estimated_zone_s
            FROM activities a
            LEFT JOIN activity_metrics m ON m.activity_id = a.activity_id
            LEFT JOIN activity_efficiency e ON e.activity_id = a.activity_id
            LEFT JOIN tags t ON t.activity_id = a.activity_id
            LEFT JOIN zones z ON z.activity_id = a.activity_id
            LEFT JOIN loads l ON l.activity_id = a.activity_id
            LEFT JOIN estimated est ON est.activity_id = a.activity_id
            WHERE a.{RUNNING} AND {LOCAL_DATE_SQL} BETWEEN ? AND ?
            ORDER BY a.start_time_utc, a.activity_id
            """,
            [since, through],
        )
        .to_arrow_table()
        .to_pylist()
    )
    return rows


#: A route's summary columns plus its current record, read from the
#: ``rank = 1`` row of ``route_runs`` rather than recomputed here: the API
#: computes nothing ``analysis.routes`` already decided. The join is a LEFT
#: JOIN because a route where every run is ineligible has no rank 1 row, and
#: a route with no record is a real state - the same one ``GET /api/records``
#: leaves a distance out of its ladder for, rather than inventing a record
#: from a run that was never comparable.
#:
#: The record's ``utc_offset_s`` comes from ``activities``, which
#: ``route_runs`` does not repeat - the split ``route_runs`` below keeps - and
#: through a second LEFT JOIN, so a route with no rank 1 row still has its
#: summary and a null offset rather than disappearing from an inner join.
_ROUTE_SUMMARY_SELECT = """
    r.route_id, r.name, r.locality, r.run_count, r.median_distance_m,
    r.first_run_utc, r.last_run_utc, r.reference_activity_id,
    rec.speed_mps AS record_speed_mps,
    rec.activity_id AS record_activity_id,
    rec.start_time_utc AS record_start_time_utc,
    rec_a.utc_offset_s AS record_utc_offset_s
"""
_ROUTE_SUMMARY_FROM = (
    "routes r LEFT JOIN route_runs rec ON rec.route_id = r.route_id AND rec.rank = 1 "
    "LEFT JOIN activities rec_a ON rec_a.activity_id = rec.activity_id"
)


def routes(cur: duckdb.DuckDBPyConnection) -> list[dict[str, Any]]:
    """Every route, most runs first and then by name.

    ``reference_activity_id`` rides along on every row here even though
    ``RouteSummary`` does not carry it, because ``route`` below reuses this
    exact select for the one row it serves and needs it for
    ``RouteDetail.reference_activity_id``; pydantic's default is to ignore an
    extra key, so the list endpoint's ``RouteSummary(**row)`` drops it rather
    than choking on it.
    """
    rows: list[dict[str, Any]] = (
        cur.execute(
            f"SELECT {_ROUTE_SUMMARY_SELECT} FROM {_ROUTE_SUMMARY_FROM} "
            "ORDER BY r.run_count DESC, r.name"
        )
        .to_arrow_table()
        .to_pylist()
    )
    return rows


def route(cur: duckdb.DuckDBPyConnection, route_id: str) -> dict[str, Any] | None:
    """One route's summary row, or None for an id the store does not know."""
    rows: list[dict[str, Any]] = (
        cur.execute(
            f"SELECT {_ROUTE_SUMMARY_SELECT} FROM {_ROUTE_SUMMARY_FROM} WHERE r.route_id = ?",
            [route_id],
        )
        .to_arrow_table()
        .to_pylist()
    )
    return rows[0] if rows else None


def route_runs(cur: duckdb.DuckDBPyConnection, route_id: str) -> list[dict[str, Any]]:
    """One route's runs, oldest first.

    Joined to ``activities`` for ``utc_offset_s`` and ``name``, which
    ``route_runs`` does not repeat: the same split ``progression`` keeps
    between the derived tables and the canonical one for the same two fields.
    """
    rows: list[dict[str, Any]] = (
        cur.execute(
            "SELECT rr.activity_id, rr.start_time_utc, a.utc_offset_s, a.name, "
            "rr.distance_m, rr.elapsed_time_s, rr.speed_mps, rr.direction, "
            "rr.eligible, rr.ineligible_reason, rr.rank, rr.is_record "
            "FROM route_runs rr JOIN activities a ON a.activity_id = rr.activity_id "
            "WHERE rr.route_id = ? ORDER BY rr.start_time_utc, rr.activity_id",
            [route_id],
        )
        .to_arrow_table()
        .to_pylist()
    )
    return rows


def activity_route(cur: duckdb.DuckDBPyConnection, activity_id: str) -> dict[str, Any] | None:
    """The route one activity belongs to, or None for a run in no route.

    Non-running activities and running ones ``analysis.routes`` never
    considered - indoor, GPX-only, or too short a history to form a route -
    have no row in ``route_runs`` at all, so this returns None for both
    without needing to ask the activity's own sport.
    """
    rows: list[dict[str, Any]] = (
        cur.execute(
            "SELECT r.route_id, r.name, r.run_count, rr.rank, rr.direction "
            "FROM route_runs rr JOIN routes r ON r.route_id = rr.route_id "
            "WHERE rr.activity_id = ?",
            [activity_id],
        )
        .to_arrow_table()
        .to_pylist()
    )
    return rows[0] if rows else None


def territory_regions(cur: duckdb.DuckDBPyConnection) -> list[dict[str, Any]]:
    """Every region of claimed ground, largest first."""
    rows: list[dict[str, Any]] = (
        cur.execute(
            "SELECT region_id, name, locality, country, area_m2, part_count, claim_count, "
            "first_claim_utc, last_claim_utc, min_lon AS west, min_lat AS south, "
            "max_lon AS east, max_lat AS north "
            "FROM territory_regions ORDER BY area_m2 DESC, region_id"
        )
        .to_arrow_table()
        .to_pylist()
    )
    return rows


def territory_parts(cur: duckdb.DuckDBPyConnection) -> list[dict[str, Any]]:
    """Every part of the claimed ground, its outline still the stored GeoJSON text."""
    rows: list[dict[str, Any]] = (
        cur.execute(
            "SELECT p.region_id, p.part_index, p.area_m2, p.geometry_geojson "
            "FROM territory_parts p JOIN territory_regions r USING (region_id) "
            "ORDER BY r.area_m2 DESC, p.region_id, p.part_index"
        )
        .to_arrow_table()
        .to_pylist()
    )
    return rows


def territory_growth(cur: duckdb.DuckDBPyConnection) -> list[dict[str, Any]]:
    """One row per claiming run, oldest first, with its canonical offset and name."""
    rows: list[dict[str, Any]] = (
        cur.execute(
            "SELECT c.activity_id, c.start_time_utc, a.utc_offset_s, a.name, c.region_id, "
            "c.enclosed_m2, c.new_m2, c.cumulative_m2 "
            "FROM territory_claims c JOIN activities a USING (activity_id) "
            "WHERE c.region_id IS NOT NULL "
            "ORDER BY c.start_time_utc, c.activity_id"
        )
        .to_arrow_table()
        .to_pylist()
    )
    return rows


def territory_summary(cur: duckdb.DuckDBPyConnection) -> tuple[float, dict[str, int]]:
    """The claimed area, the union's rather than a sum over runs, and what each rule kept."""
    row = cur.execute(
        "SELECT (SELECT coalesce(sum(area_m2), 0) FROM territory_regions), count(*), "
        "count(*) FILTER (WHERE closes_loop), count(*) FILTER (WHERE region_id IS NOT NULL), "
        "(SELECT count(*) FROM territory_regions), (SELECT count(*) FROM territory_parts) "
        "FROM territory_claims"
    ).fetchone()
    total, *counts = row if row else (0.0, 0, 0, 0, 0, 0)
    keys = ("outdoor_runs", "loop_runs", "claiming_runs", "regions", "parts")
    return float(total), dict(zip(keys, (int(c) for c in counts), strict=True))
