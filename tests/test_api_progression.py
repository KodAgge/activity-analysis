"""The progression endpoint, and the record staircase it must not get wrong.

Eligibility is the analysis layer's rule, restated in SQL exactly as
`queries.records` restates it: `is_indoor` and `contains_jump` must each be
explicitly false, on both sides. The staircase is computed in the query as a
running minimum over eligible efforts in time order rather than by joining to
the `pr` tags, so that the chart and the tags remain two independent paths to
one fact, the way `records` already is.
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
    con = duckdb.connect()
    con.execute(
        """
        CREATE TABLE activities (
            activity_id VARCHAR,
            start_time_utc TIMESTAMPTZ,
            utc_offset_s INTEGER,
            name VARCHAR
        );
        CREATE TABLE activity_metrics (activity_id VARCHAR, is_indoor BOOLEAN, locality VARCHAR);
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
        """
    )
    return con


def _activity(
    con: duckdb.DuckDBPyConnection,
    activity_id: str,
    started: str,
    *,
    indoor: bool | None = False,
    metrics: bool = True,
) -> None:
    con.execute(
        "INSERT INTO activities VALUES (?, ?::TIMESTAMPTZ, 3600, ?)",
        [activity_id, started, f"Run {activity_id}"],
    )
    if metrics:
        con.execute(
            "INSERT INTO activity_metrics VALUES (?, ?, 'Jönköping')", [activity_id, indoor]
        )


def _effort(
    con: duckdb.DuckDBPyConnection,
    activity_id: str,
    seconds: float,
    *,
    key: str = "5k",
    jump: bool | None = False,
    speed_m: float | None = None,
    trusted: bool | None | str = "from jump",
) -> None:
    """``trusted`` defaults to what the flag alone says, the rule before the speed check."""
    if trusted == "from jump":
        trusted = None if jump is None else not jump
    con.execute(
        "INSERT INTO best_efforts VALUES (?, ?, 5000.0, ?, 150.0, ?, ?, ?)",
        [activity_id, key, seconds, jump, speed_m, trusted],
    )


def _staircase(con: duckdb.DuckDBPyConnection, key: str = "5k") -> list[tuple[str, bool, bool]]:
    return [
        (row["activity_id"], row["is_eligible"], row["is_record"])
        for row in queries.progression(con.cursor(), key)
    ]


def test_efforts_are_served_oldest_first(store: duckdb.DuckDBPyConnection) -> None:
    _activity(store, "feb", "2026-02-01 10:00:00+00")
    _activity(store, "jan", "2026-01-01 10:00:00+00")
    _effort(store, "feb", 1400.0)
    _effort(store, "jan", 1500.0)
    assert [row["activity_id"] for row in queries.progression(store.cursor(), "5k")] == [
        "jan",
        "feb",
    ]


def test_the_first_eligible_effort_is_a_record(store: duckdb.DuckDBPyConnection) -> None:
    """The rule decided 2026-09-05, which the tags implement too."""
    _activity(store, "jan", "2026-01-01 10:00:00+00")
    _effort(store, "jan", 1500.0)
    assert _staircase(store) == [("jan", True, True)]


def test_a_record_must_strictly_beat_the_running_minimum(store: duckdb.DuckDBPyConnection) -> None:
    _activity(store, "jan", "2026-01-01 10:00:00+00")
    _activity(store, "feb", "2026-02-01 10:00:00+00")
    _activity(store, "mar", "2026-03-01 10:00:00+00")
    _activity(store, "apr", "2026-04-01 10:00:00+00")
    _effort(store, "jan", 1500.0)
    _effort(store, "feb", 1400.0)
    _effort(store, "mar", 1400.0)
    _effort(store, "apr", 1450.0)
    assert _staircase(store) == [
        ("jan", True, True),
        ("feb", True, True),
        ("mar", True, False),
        ("apr", True, False),
    ]


def test_an_ineligible_faster_effort_neither_sets_a_record_nor_becomes_the_baseline(
    store: duckdb.DuckDBPyConnection,
) -> None:
    """The two-sided rule: a
    treadmill effort faster than the standing best is drawn, is not a record,
    and the next eligible effort is measured against the last eligible one."""
    _activity(store, "jan", "2026-01-01 10:00:00+00")
    _activity(store, "feb-treadmill", "2026-02-01 10:00:00+00", indoor=True)
    _activity(store, "mar-jump", "2026-03-01 10:00:00+00")
    _activity(store, "apr", "2026-04-01 10:00:00+00")
    _effort(store, "jan", 1500.0)
    _effort(store, "feb-treadmill", 1100.0)
    _effort(store, "mar-jump", 1000.0, jump=True)
    _effort(store, "apr", 1450.0)
    rows = queries.progression(store.cursor(), "5k")
    assert [(r["activity_id"], r["is_eligible"], r["is_record"]) for r in rows] == [
        ("jan", True, True),
        ("feb-treadmill", False, False),
        ("mar-jump", False, False),
        ("apr", True, True),
    ]
    assert [r["ineligible_reason"] for r in rows] == [
        None,
        "treadmill",
        "a jump in the recorded distance, with no measured speed to check it against",
        None,
    ]


def test_a_jump_names_whether_the_measured_speed_disagreed_or_was_confirmed(
    store: duckdb.DuckDBPyConnection,
) -> None:
    """A jump the measured speed confirms is eligible and can be the record; one
    it does not confirm is not, and says the measured speed is what disagreed."""
    _activity(store, "jan", "2026-01-01 10:00:00+00")
    _activity(store, "feb-unconfirmed", "2026-02-01 10:00:00+00")
    _activity(store, "mar-confirmed", "2026-03-01 10:00:00+00")
    _effort(store, "jan", 1500.0)
    _effort(store, "feb-unconfirmed", 1000.0, jump=True, speed_m=4000.0, trusted=False)
    _effort(store, "mar-confirmed", 1400.0, jump=True, speed_m=4990.0, trusted=True)
    rows = queries.progression(store.cursor(), "5k")
    assert [
        (r["activity_id"], r["is_eligible"], r["is_record"], r["ineligible_reason"]) for r in rows
    ] == [
        ("jan", True, True, None),
        (
            "feb-unconfirmed",
            False,
            False,
            "a jump in the recorded distance that the measured speed does not confirm",
        ),
        ("mar-confirmed", True, True, None),
    ]


def test_an_unknown_flag_is_ineligible_like_a_known_one(store: duckdb.DuckDBPyConnection) -> None:
    """Null means not known. An activity with no metrics row has no
    `is_indoor` to read and is excluded on the same side as a treadmill, as
    `records` does, but the reason says so rather than calling it one."""
    _activity(store, "jan", "2026-01-01 10:00:00+00", indoor=None)
    _activity(store, "feb", "2026-02-01 10:00:00+00", metrics=False)
    _activity(store, "mar", "2026-03-01 10:00:00+00")
    _effort(store, "jan", 1000.0)
    _effort(store, "feb", 1000.0)
    _effort(store, "mar", 1500.0, jump=None)
    _effort(store, "mar", 1600.0, key="1k")
    rows = queries.progression(store.cursor(), "5k")
    assert [(r["activity_id"], r["is_eligible"], r["ineligible_reason"]) for r in rows] == [
        ("jan", False, "not known to be outdoors"),
        ("feb", False, "not known to be outdoors"),
        ("mar", False, "not known to be free of distance jumps"),
    ]
    assert not any(r["is_record"] for r in rows)


def test_the_staircase_agrees_with_the_tagger(store: duckdb.DuckDBPyConnection) -> None:
    """Two independent paths to one fact. The query computes the staircase
    with a window function; `TagHistory` walks the same efforts in Python. A
    drift in either is what fails here."""
    runs = [
        ("jan", "2026-01-01 10:00:00+00", False),
        ("feb", "2026-02-01 10:00:00+00", False),
        ("mar-treadmill", "2026-03-01 10:00:00+00", True),
        ("apr", "2026-04-01 10:00:00+00", False),
        ("may", "2026-05-01 10:00:00+00", False),
    ]
    efforts = [
        ("jan", 1500.0, False),
        ("feb", 1550.0, False),
        ("mar-treadmill", 1100.0, False),
        ("apr", 1200.0, True),
        ("may", 1450.0, False),
    ]
    for activity_id, started, indoor in runs:
        _activity(store, activity_id, started, indoor=indoor)
    for activity_id, seconds, jump in efforts:
        _effort(store, activity_id, seconds, jump=jump)

    history = TagHistory(
        pd.DataFrame(
            {
                "activity_id": [r[0] for r in runs],
                "start_time_utc": pd.to_datetime([r[1] for r in runs], utc=True),
                "distance_m": [10_000.0] * len(runs),
            }
        ),
        pd.DataFrame(
            {
                "activity_id": [e[0] for e in efforts],
                "distance_key": ["5k"] * len(efforts),
                "elapsed_time_s": [e[1] for e in efforts],
                "contains_jump": [e[2] for e in efforts],
                "distance_trusted": [None if e[2] is None else not e[2] for e in efforts],
            }
        ),
        excluded_activity_ids=[r[0] for r in runs if r[2] is not False],
    )
    tagged = {r[0] for r in runs if any(f.tag == "pr" for f in history.flags(r[0]))}
    assert tagged == {"jan", "may"}
    assert {
        r["activity_id"] for r in queries.progression(store.cursor(), "5k") if r["is_record"]
    } == tagged


def test_only_the_asked_distance_is_served(store: duckdb.DuckDBPyConnection) -> None:
    _activity(store, "jan", "2026-01-01 10:00:00+00")
    _effort(store, "jan", 1500.0)
    _effort(store, "jan", 250.0, key="1k")
    assert [r["activity_id"] for r in queries.progression(store.cursor(), "1k")] == ["jan"]
    assert queries.progression(store.cursor(), "10k") == []


def test_the_endpoint_counts_and_404s(api_client: TestClient) -> None:
    body = api_client.get("/api/progression/1k").json()
    assert body["distance_key"] == "1k"
    assert body["effort_count"] == len(body["items"]) > 0
    assert body["eligible_count"] == sum(item["is_eligible"] for item in body["items"])
    assert body["record_count"] == sum(item["is_record"] for item in body["items"])
    # The first eligible effort is a record, so a distance with any eligible
    # effort has at least one.
    if body["eligible_count"]:
        assert body["record_count"] >= 1
    for item in body["items"]:
        assert item["start_time_utc"].endswith("Z")
        assert item["is_eligible"] == (item["ineligible_reason"] is None)
    assert api_client.get("/api/progression/marathon").status_code == 404
    assert api_client.get("/api/progression/42k").status_code == 404
