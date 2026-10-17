"""The records endpoint, and the eligibility rule it must not get wrong.

The rule is the analysis layer's, stated in docs/reference/derived-layer.md
under "Records exclude the efforts the best-efforts invariant above says they
must": a treadmill effort's distance comes from an uncalibrated footpod, and
an effort flagged ``contains_jump`` was credited metres nobody ran. Both are
excluded, and both must be *explicitly* false rather than merely not true,
because a null means "not known" and a record is the one consumer for which
an unverified effort is worse than no effort.

Most of this file tests `queries.records` against a hand-built connection
rather than through the API, for the reason CLAUDE.md gives for the whole
analysis layer: a synthetic fixture has a known analytic answer, and a query
run against real noisy data proves only that it ran.
"""

from __future__ import annotations

import duckdb
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from activity_analysis.analysis.tags import TagHistory
from activity_analysis.api import queries


@pytest.fixture
def store() -> duckdb.DuckDBPyConnection:
    """A connection carrying the three relations `records` reads.

    Built as tables with the same names `store/db.py` exposes as views, so
    the query under test is the same text that runs in production.
    """
    con = duckdb.connect()
    con.execute(
        """
        CREATE TABLE activities (
            activity_id VARCHAR,
            start_time_utc TIMESTAMPTZ,
            utc_offset_s INTEGER,
            name VARCHAR
        );
        CREATE TABLE activity_metrics (activity_id VARCHAR, is_indoor BOOLEAN);
        CREATE TABLE best_efforts (
            activity_id VARCHAR,
            distance_key VARCHAR,
            distance_m DOUBLE,
            elapsed_time_s DOUBLE,
            avg_hr_bpm DOUBLE,
            contains_jump BOOLEAN,
            speed_distance_m DOUBLE,
            distance_trusted BOOLEAN
        );
        CREATE TABLE activity_tags (
            activity_id VARCHAR, kind VARCHAR, tag VARCHAR, distance_key VARCHAR
        );
        """
    )
    return con


def _activity(
    con: duckdb.DuckDBPyConnection,
    activity_id: str,
    *,
    indoor: bool | None,
    started: str = "2026-01-01 10:00:00+00",
) -> None:
    con.execute(
        "INSERT INTO activities VALUES (?, ?::TIMESTAMPTZ, 3600, 'Run')",
        [activity_id, started],
    )
    con.execute("INSERT INTO activity_metrics VALUES (?, ?)", [activity_id, indoor])


def _effort(
    con: duckdb.DuckDBPyConnection,
    activity_id: str,
    key: str,
    seconds: float,
    *,
    jump: bool | None = False,
    metres: float = 5000.0,
    trusted: bool | None | str = "from jump",
) -> None:
    """``trusted`` defaults to what the flag alone says, the rule before the speed check."""
    if trusted == "from jump":
        trusted = None if jump is None else not jump
    con.execute(
        "INSERT INTO best_efforts VALUES (?, ?, ?, ?, 150.0, ?, NULL, ?)",
        [activity_id, key, metres, seconds, jump, trusted],
    )


def test_the_fastest_eligible_effort_is_the_record(store: duckdb.DuckDBPyConnection):
    _activity(store, "outdoor-a", indoor=False)
    _activity(store, "outdoor-b", indoor=False)
    _effort(store, "outdoor-a", "5k", 1500.0)
    _effort(store, "outdoor-b", "5k", 1400.0)

    (record,) = queries.records(store.cursor())
    assert record["distance_key"] == "5k"
    assert record["elapsed_time_s"] == 1400.0
    assert record["activity_id"] == "outdoor-b"
    assert record["effort_count"] == 2


def test_the_record_is_the_activity_holding_the_most_recent_pr_tag(
    store: duckdb.DuckDBPyConnection,
):
    """Two independent paths to one fact must agree.

    `records` takes the minimum eligible time per distance out of the derived
    tables. `analysis.tags.TagHistory` walks the same efforts in time order
    and tags each improvement ``pr``, so the most recent ``pr`` tag at a
    distance names the same activity - if both apply the eligibility rule.
    The history here carries a faster jump-flagged 5k and a faster treadmill
    5k and 1k, none of which the tagger tags; a records query that dropped
    either half of the filter would name one of them and disagree.

    The 10k has exactly one eligible effort, beside a faster treadmill one.
    That was the documented exception until 2026-09-05, when the first
    eligible effort at a distance became a record so that the tags, this
    endpoint and the progression chart agree; a test that still exempted the
    sole-effort case would pass whether or not that change worked.

    The real tagger produces the tags rather than this test writing them by
    hand, so a drift in either path is what fails here, not a typo in a
    fixture.
    """
    runs = [
        ("jan", "2026-01-01 10:00:00+00", False),
        ("feb", "2026-02-01 10:00:00+00", False),
        ("mar", "2026-03-01 10:00:00+00", False),
        ("apr-jump", "2026-04-01 10:00:00+00", False),
        ("may-treadmill", "2026-05-01 10:00:00+00", True),
    ]
    efforts = [
        ("jan", "5k", 5000.0, 1500.0, False),
        ("feb", "5k", 5000.0, 1400.0, False),
        ("mar", "5k", 5000.0, 1450.0, False),
        ("apr-jump", "5k", 5000.0, 1200.0, True),
        ("may-treadmill", "5k", 5000.0, 1100.0, False),
        ("jan", "1k", 1000.0, 240.0, False),
        ("mar", "1k", 1000.0, 230.0, False),
        ("may-treadmill", "1k", 1000.0, 200.0, False),
        ("mar", "10k", 10000.0, 3100.0, False),
        ("may-treadmill", "10k", 10000.0, 2900.0, False),
    ]
    for activity_id, started, indoor in runs:
        _activity(store, activity_id, indoor=indoor, started=started)
    for activity_id, key, metres, seconds, jump in efforts:
        _effort(store, activity_id, key, seconds, jump=jump, metres=metres)

    history = TagHistory(
        pd.DataFrame(
            {
                "activity_id": [activity_id for activity_id, _, _ in runs],
                "start_time_utc": pd.to_datetime([started for _, started, _ in runs], utc=True),
                "distance_m": [10_000.0] * len(runs),
            }
        ),
        pd.DataFrame(
            {
                "activity_id": [effort[0] for effort in efforts],
                "distance_key": [effort[1] for effort in efforts],
                "elapsed_time_s": [effort[3] for effort in efforts],
                "contains_jump": [effort[4] for effort in efforts],
                "distance_trusted": [
                    None if effort[4] is None else not effort[4] for effort in efforts
                ],
            }
        ),
        excluded_activity_ids=[
            activity_id for activity_id, _, indoor in runs if indoor is not False
        ],
    )
    for activity_id, _, _ in runs:
        for flag in history.flags(activity_id):
            store.execute(
                "INSERT INTO activity_tags VALUES (?, 'flag', ?, ?)",
                [activity_id, flag.tag, flag.distance_key],
            )

    most_recent_pr = dict(
        store.execute(
            """
            SELECT t.distance_key, arg_max(t.activity_id, a.start_time_utc)
            FROM activity_tags t
            JOIN activities a ON a.activity_id = t.activity_id
            WHERE t.tag = 'pr'
            GROUP BY 1
            """
        ).fetchall()
    )
    # The known answer first, so two empty sides cannot agree vacuously.
    assert most_recent_pr == {"5k": "feb", "1k": "mar", "10k": "mar"}

    records = {row["distance_key"]: row["activity_id"] for row in queries.records(store.cursor())}
    assert records == most_recent_pr


def test_a_jump_flagged_effort_cannot_be_the_record(store: duckdb.DuckDBPyConnection):
    """The fault this rule exists for, at the scale it happens on real data.

    Measured on the real store: the five fastest 400 m efforts all carry
    ``contains_jump``, the quickest implying 13.45 m/s - faster than the peak
    of the 100 m world record. Ignoring the flag would print that as the
    athlete's record.
    """
    _activity(store, "outdoor", indoor=False)
    _effort(store, "outdoor", "400m", 95.0, metres=400.0)
    _effort(store, "outdoor", "400m", 29.7, metres=400.0, jump=True)

    (record,) = queries.records(store.cursor())
    assert record["elapsed_time_s"] == 95.0
    # And the ineligible effort is not counted among the attempts either: it
    # was never comparable, so "the best of N" must not include it.
    assert record["effort_count"] == 1


def test_a_jump_the_measured_speed_confirms_can_be_the_record(
    store: duckdb.DuckDBPyConnection,
):
    """A real half marathon's shape: the faster effort carries a 15 m blip the
    speed channel never saw, the slower one is clean. ``distance_trusted`` is
    the rule, not ``contains_jump``."""
    _activity(store, "clean", indoor=False)
    _activity(store, "blip", indoor=False, started="2025-11-01 09:00:00+00")
    _effort(store, "clean", "half", 7500.0, metres=21097.5)
    _effort(store, "blip", "half", 7200.0, metres=21097.5, jump=True, trusted=True)

    (record,) = queries.records(store.cursor())
    assert record["activity_id"] == "blip"
    assert record["effort_count"] == 2


def test_an_unknown_jump_flag_is_excluded_like_a_known_one(store: duckdb.DuckDBPyConnection):
    """Null means not known, and an unverified effort cannot be a record.

    The rows written before the flag existed carry null, and treating null as
    clean would let exactly the efforts nobody has checked set the records.
    """
    _activity(store, "outdoor", indoor=False)
    _effort(store, "outdoor", "5k", 1500.0)
    _effort(store, "outdoor", "5k", 900.0, jump=None)

    (record,) = queries.records(store.cursor())
    assert record["elapsed_time_s"] == 1500.0


def test_a_treadmill_effort_cannot_be_the_record(store: duckdb.DuckDBPyConnection):
    """Its distance comes from an uncalibrated footpod."""
    _activity(store, "outdoor", indoor=False)
    _activity(store, "treadmill", indoor=True)
    _effort(store, "outdoor", "5k", 1500.0)
    _effort(store, "treadmill", "5k", 1200.0)

    (record,) = queries.records(store.cursor())
    assert record["activity_id"] == "outdoor"
    assert record["elapsed_time_s"] == 1500.0


def test_a_treadmill_effort_cannot_be_the_baseline_either(store: duckdb.DuckDBPyConnection):
    """The worse half of the same fault, and the reason the rule is two-sided.

    Excluding an uncalibrated effort only from the *candidate* side would let
    it stand as the time to beat, silently suppressing a genuine record for
    as long as nobody beat a number that was never real. Here the treadmill
    effort is the fastest; the record must still name the outdoor one rather
    than reporting no record at all.
    """
    _activity(store, "treadmill", indoor=True)
    _activity(store, "outdoor", indoor=False)
    _effort(store, "treadmill", "5k", 1000.0)
    _effort(store, "outdoor", "5k", 1500.0)

    (record,) = queries.records(store.cursor())
    assert record["activity_id"] == "outdoor"
    assert record["effort_count"] == 1


def test_an_activity_with_no_metrics_row_is_excluded(store: duckdb.DuckDBPyConnection):
    """`is_indoor` unknown is excluded on the same side as a treadmill.

    An effort whose activity the derived layer never covered has no
    ``is_indoor`` to read, so nothing says it was run outdoors. The join is
    inner for exactly this reason.
    """
    _activity(store, "outdoor", indoor=False)
    _effort(store, "outdoor", "5k", 1500.0)
    # No `_activity` call, so no metrics row - only the effort.
    store.execute("INSERT INTO activities VALUES ('orphan', '2026-01-01 10:00:00+00', 3600, 'Run')")
    _effort(store, "orphan", "5k", 800.0)

    (record,) = queries.records(store.cursor())
    assert record["activity_id"] == "outdoor"


def test_records_are_ordered_by_distance_not_by_time(store: duckdb.DuckDBPyConnection):
    """So the list reads as a ladder, which is how paces get compared.

    The two orderings are made to *disagree* here, which is the only way this
    assertion can fail: with a plausible ladder (400 m fastest, 10 k slowest)
    distance order and time order are the same sequence, and ordering by
    either passes. Verified by mutation - `ORDER BY r.elapsed_time_s` in
    place of `ORDER BY r.distance_m` left the plausible version green.

    A 400 m effort slower than a 5 k is not a contrived shape, either. Best
    efforts are elapsed time and span their pauses (CLAUDE.md, "Best efforts
    are elapsed time and span pauses"), so a 400 m window containing a long
    stop genuinely reports a large number.
    """
    _activity(store, "outdoor", indoor=False)
    _effort(store, "outdoor", "5k", 1400.0, metres=5000.0)
    _effort(store, "outdoor", "400m", 2000.0, metres=400.0)
    _effort(store, "outdoor", "10k", 3000.0, metres=10000.0)

    rows = queries.records(store.cursor())
    keys = [row["distance_key"] for row in rows]
    assert keys == ["400m", "5k", "10k"]
    # And that is genuinely not the order the times are in.
    assert [row["elapsed_time_s"] for row in rows] != sorted(row["elapsed_time_s"] for row in rows)


def test_a_distance_with_no_eligible_effort_is_absent_not_null(
    store: duckdb.DuckDBPyConnection,
):
    """There is nothing to say about it, so it says nothing."""
    _activity(store, "treadmill", indoor=True)
    _effort(store, "treadmill", "5k", 1200.0)

    assert queries.records(store.cursor()) == []


def test_an_effort_with_no_elapsed_time_is_not_a_record(store: duckdb.DuckDBPyConnection):
    _activity(store, "outdoor", indoor=False)
    _effort(store, "outdoor", "5k", 1500.0)
    store.execute(
        "INSERT INTO best_efforts VALUES ('outdoor', '5k', 5000.0, NULL, 150.0, false, NULL, true)"
    )

    (record,) = queries.records(store.cursor())
    assert record["elapsed_time_s"] == 1500.0
    assert record["effort_count"] == 1


def test_a_tie_resolves_to_one_record_deterministically(store: duckdb.DuckDBPyConnection):
    """Two identical times must not produce two rows for one distance.

    A `min()` would collapse the time and leave the holder ambiguous; the
    window function picks one, and the tie-break on activity_id is what makes
    it the same one on every request.
    """
    _activity(store, "a-first", indoor=False)
    _activity(store, "b-second", indoor=False)
    _effort(store, "a-first", "5k", 1400.0)
    _effort(store, "b-second", "5k", 1400.0)

    rows = queries.records(store.cursor())
    assert len(rows) == 1
    assert rows[0]["activity_id"] == "a-first"
    assert rows[0]["effort_count"] == 2


def test_the_endpoint_serves_the_records_of_the_ingested_store(api_client: TestClient):
    body = api_client.get("/api/records").json()
    assert "items" in body

    for record in body["items"]:
        # Every field the frontend reads, present and of the right shape.
        assert isinstance(record["distance_key"], str)
        assert record["distance_m"] > 0
        assert record["elapsed_time_s"] > 0
        assert record["effort_count"] >= 1
        assert record["start_time_utc"].endswith("Z")

    # Ordered by distance, shortest first.
    distances = [record["distance_m"] for record in body["items"]]
    assert distances == sorted(distances)


def test_no_eligible_effort_beats_its_own_record(api_client: TestClient):
    """The endpoint's answer against the store's own best-effort rows.

    An independent path to the same fact: rather than trusting the query's
    window function, this reads every eligible effort out of the API's own
    activity list and checks that none of them is faster than the record
    claimed for its distance. A record that excluded too much, or ordered by
    the wrong column, fails here.
    """
    records = {
        record["distance_key"]: record for record in api_client.get("/api/records").json()["items"]
    }
    if not records:
        pytest.skip("the ingested fixture store holds no eligible best efforts")

    page = api_client.get("/api/activities", params={"sport": "all", "limit": 200}).json()
    for activity in page["items"]:
        detail = api_client.get(f"/api/activities/{activity['activity_id']}").json()
        derived = detail.get("derived")
        if derived is None or derived["metrics"].get("is_indoor") is not False:
            continue
        for effort in derived["best_efforts"]:
            if effort.get("distance_trusted") is not True:
                continue
            record = records.get(effort["distance_key"])
            assert record is not None, (
                f"{effort['distance_key']} has an eligible effort but no record"
            )
            assert effort["elapsed_time_s"] >= record["elapsed_time_s"]


class TestPersonalRecordKeyOrdering:
    """`pr_distance_keys` is ordered by distance, never by the key's spelling.

    Two documented places state this - `docs/reference/api.md` and
    `ActivitySummary.pr_distance_keys` - and until this class nothing
    asserted it, which is why `queries.PR_DISTANCE_KEYS_FROM` joins
    `best_efforts` for the metres rather than calling a bare `list()`.

    It is not a hypothetical. Measured on the real store on 2026-09-03: 12
    activities hold more than one record, and on **5 of them** the two
    orderings differ. One of them holds a 1k and a 10k, so it reads
    `1k, 10k` by distance and `10k, 1k` alphabetically - the exact inversion
    the documentation cites.
    """

    @staticmethod
    def _store() -> duckdb.DuckDBPyConnection:
        """The four relations `SUMMARY_FROM` reads, with the real column shapes."""
        con = duckdb.connect()
        con.execute(
            """
            CREATE TABLE activities (
                activity_id VARCHAR, start_time_utc TIMESTAMPTZ, utc_offset_s INTEGER,
                sport VARCHAR, recorded_sport VARCHAR, sub_sport VARCHAR, name VARCHAR,
                distance_m DOUBLE,
                elapsed_time_s DOUBLE, timer_time_s DOUBLE, ascent_m DOUBLE,
                descent_m DOUBLE, avg_speed_mps DOUBLE, max_speed_mps DOUBLE,
                avg_hr_bpm DOUBLE, max_hr_bpm DOUBLE, avg_cadence_spm DOUBLE,
                calories DOUBLE, source VARCHAR
            );
            CREATE TABLE activity_metrics (
                activity_id VARCHAR, moving_time_s DOUBLE, avg_speed_mps DOUBLE
            );
            CREATE TABLE activity_tags (activity_id VARCHAR, tag VARCHAR, distance_key VARCHAR);
            CREATE TABLE best_efforts (
                activity_id VARCHAR, distance_key VARCHAR, distance_m DOUBLE
            );
            INSERT INTO activities VALUES
                ('run-1', '2026-01-01 10:00:00+00', 3600, 'running', 'running', NULL, 'Run',
                 10000.0, 3600.0, 3600.0, 50.0, 50.0, 2.8, 3.5, 150.0, 180.0, 160.0,
                 500.0, 'garmin_fit');
            INSERT INTO activity_metrics VALUES ('run-1', 3500.0, 2.857);
            """
        )
        return con

    def _keys(self, con: duckdb.DuckDBPyConnection) -> list[str]:
        rows = (
            con.cursor()
            .execute(f"SELECT {queries.SUMMARY_SELECT} FROM {queries.SUMMARY_FROM}")
            .to_arrow_table()
            .to_pylist()
        )
        assert len(rows) == 1
        keys: list[str] = list(rows[0]["pr_distance_keys"])
        return keys

    def test_the_keys_are_ordered_by_metres_not_by_spelling(self):
        """The shape of that real run: a 1k and a 10k on one run."""
        con = self._store()
        for key, metres in [("1k", 1000.0), ("10k", 10000.0)]:
            con.execute("INSERT INTO activity_tags VALUES ('run-1', 'pr', ?)", [key])
            con.execute("INSERT INTO best_efforts VALUES ('run-1', ?, ?)", [key, metres])

        # Alphabetically this is ['10k', '1k']; by distance it is ['1k', '10k'].
        # A bare `list()` would give whichever order the rows happen to arrive
        # in, which on this store is insertion order and so passes by luck -
        # hence the explicit inversion below rather than only the equality.
        assert self._keys(con) == ["1k", "10k"]
        assert self._keys(con) != sorted(["1k", "10k"])

    def test_a_four_record_run_orders_every_one_of_them(self):
        """The shape of a real four-record run, whose orderings also differ."""
        con = self._store()
        for key, metres in [
            ("3k", 3000.0),
            ("400m", 400.0),
            ("1mi", 1609.344),
            ("1k", 1000.0),
        ]:
            con.execute("INSERT INTO activity_tags VALUES ('run-1', 'pr', ?)", [key])
            con.execute("INSERT INTO best_efforts VALUES ('run-1', ?, ?)", [key, metres])

        assert self._keys(con) == ["400m", "1k", "1mi", "3k"]

    def test_a_run_with_no_records_gets_an_empty_list_not_null(self):
        """`list()` over no rows is NULL, and a null would make the client guess."""
        assert self._keys(self._store()) == []

    def test_a_non_pr_tag_never_reaches_the_list(self):
        """The projection filters on `tag = 'pr'`, not on the presence of a key.

        `long_run` is a flag with no distance and `intervals` an effort
        classification; neither is a record, and an activity carrying one
        must still report no records.
        """
        con = self._store()
        con.execute("INSERT INTO activity_tags VALUES ('run-1', 'long_run', NULL)")
        con.execute("INSERT INTO activity_tags VALUES ('run-1', 'intervals', NULL)")
        assert self._keys(con) == []

    def test_a_distance_keyed_tag_that_is_not_a_record_is_still_excluded(self):
        """The `tag = 'pr'` filter is load-bearing, not redundant with the join.

        Found by mutation: deleting that filter left every other test in this
        class green. The reason is that no tag in the store *today* carries a
        `distance_key` except `pr` - measured on the real store, `distance_key`
        is non-null only on `pr` rows - so the inner join to `best_efforts` on
        `(activity_id, distance_key)` already drops the others by itself, and
        nothing could tell the two mechanisms apart.

        It stops being redundant the moment the analysis layer adds a second
        distance-keyed tag, which is exactly the kind of addition
        `docs/reference/derived-layer.md` leaves room for. A tag that is about
        one distance but is not a record would otherwise appear on the browser's
        PR badge, claiming an achievement the athlete never made. So the case
        is constructed here rather than waited for.
        """
        con = self._store()
        # A real record, and a hypothetical future distance-keyed tag that is
        # not one - both with a matching effort row, so the join keeps both
        # and only the filter can separate them.
        con.execute("INSERT INTO activity_tags VALUES ('run-1', 'pr', '5k')")
        con.execute("INSERT INTO activity_tags VALUES ('run-1', 'course_best', '1k')")
        con.execute("INSERT INTO best_efforts VALUES ('run-1', '5k', 5000.0)")
        con.execute("INSERT INTO best_efforts VALUES ('run-1', '1k', 1000.0)")

        assert self._keys(con) == ["5k"]

    def test_a_pr_tag_with_no_matching_effort_row_is_dropped_rather_than_nulled(self):
        """The join is inner, so a tag with no effort cannot contribute a null.

        This should not happen - the analysis layer writes both together -
        but a null inside the list would reach the badge as the string
        "null", which is worse than the key being absent.
        """
        con = self._store()
        con.execute("INSERT INTO activity_tags VALUES ('run-1', 'pr', '5k')")
        con.execute("INSERT INTO activity_tags VALUES ('run-1', 'pr', '1k')")
        con.execute("INSERT INTO best_efforts VALUES ('run-1', '1k', 1000.0)")
        assert self._keys(con) == ["1k"]

    def test_the_join_cannot_duplicate_a_key(self):
        """The projection depends on `best_efforts` holding one row per pair.

        Measured on the real store on 2026-09-03, all three counts zero:
        duplicate `(activity_id, distance_key)` rows in `best_efforts`,
        `pr` tags whose join would fan out, and duplicate `(activity_id,
        distance_key)` among `pr` tags. So it holds today and was not
        asserted anywhere. `list_distinct` is deliberately *not* the fix -
        DuckDB's does not preserve order, and the ordering above is the
        whole point of the join.
        """
        con = self._store()
        con.execute("INSERT INTO activity_tags VALUES ('run-1', 'pr', '5k')")
        con.execute("INSERT INTO best_efforts VALUES ('run-1', '5k', 5000.0)")
        # Nothing in the schema forbids a second row, so the guarantee is
        # asserted where it is relied on rather than assumed.
        duplicates = (
            con.cursor()
            .execute(
                "SELECT count(*) FROM (SELECT activity_id, distance_key, count(*) n "
                "FROM best_efforts GROUP BY 1, 2 HAVING n > 1)"
            )
            .fetchone()
        )
        assert duplicates is not None and duplicates[0] == 0
        assert self._keys(con) == ["5k"]
