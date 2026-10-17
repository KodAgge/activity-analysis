from datetime import UTC, date, datetime, timedelta

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from activity_analysis.api.main import create_app
from activity_analysis.api.routers import overview as overview_router
from activity_analysis.config import Paths
from activity_analysis.store.writer import read_activities, upsert_activities


def test_the_overview_buckets_runs_into_weeks_and_months(api_client: TestClient):
    body = api_client.get("/api/overview").json()
    assert sum(w["runs"] for w in body["weeks"]) == 5
    assert sum(m["runs"] for m in body["months"]) == 5


def test_the_fixtures_fall_in_the_two_weeks_they_were_run_in(api_client: TestClient):
    """Bucketed on local date, not on the UTC instant.

    Only the weeks holding a run are compared. The series is dense, so it also
    carries a zero bucket for every week between the fixtures and whichever
    week the test happens to run in, which is not what this test is about.
    """
    weeks = {
        w["period_start"]: w["runs"]
        for w in api_client.get("/api/overview").json()["weeks"]
        if w["runs"]
    }
    assert weeks == {"2026-08-17": 2, "2026-08-24": 3}


def test_the_overview_and_the_detail_view_agree_on_moving_time(api_client: TestClient):
    """One field name, one definition.

    The canonical ``moving_time_s`` column holds the device's timer time,
    which counts the device's own auto-pause rather than this project's pause
    rule, so summing it here would answer a different question from the one
    ``derived.metrics.moving_time_s`` answers for the same runs.
    """
    items = api_client.get("/api/activities", params={"limit": 200}).json()["items"]
    per_activity = sum(
        api_client.get(f"/api/activities/{item['activity_id']}").json()["derived"]["metrics"][
            "moving_time_s"
        ]
        for item in items
    )
    assert per_activity > 0

    body = api_client.get("/api/overview").json()
    assert sum(week["moving_time_s"] for week in body["weeks"]) == pytest.approx(per_activity)
    assert sum(month["moving_time_s"] for month in body["months"]) == pytest.approx(per_activity)


def test_a_run_stamped_in_the_future_is_absent_from_every_field(ingested_store: Paths):
    """One window for the whole response.

    ``streak`` and ``consistency`` already drop weeks after the current one,
    because a device clock can be wrong. If the buckets and the date range did
    not, one payload would describe two stretches of history: a distance in a
    week nobody has run, next to a streak that ignores it.
    """
    stored = read_activities(ingested_store)
    ahead = str(stored.iloc[0]["activity_id"])
    stored.loc[stored["activity_id"] == ahead, "start_time_utc"] = pd.Timestamp(
        datetime.now(tz=UTC) + timedelta(weeks=6)
    )
    upsert_activities(ingested_store, stored)

    with TestClient(create_app(ingested_store)) as client:
        body = client.get("/api/overview").json()
        listed = [item["activity_id"] for item in client.get("/api/activities").json()["items"]]
        zone_seconds = {
            activity_id: sum(
                zone["seconds_s"]
                for zone in client.get(f"/api/activities/{activity_id}").json()["derived"]["zones"]
            )
            for activity_id in listed
        }

    horizon = (date.today() + timedelta(weeks=1)).isoformat()
    assert sum(week["runs"] for week in body["weeks"]) == 4
    assert all(week["period_start"] < horizon for week in body["weeks"])
    assert all(month["period_start"] < horizon for month in body["months"])
    assert body["last_run_local_date"] < horizon

    # zone_time carries no date of its own, so this is the field most easily
    # left outside the window. The activity has to hold zone time for the
    # assertion below to mean anything.
    assert zone_seconds[ahead] > 0
    in_window = sum(seconds for key, seconds in zone_seconds.items() if key != ahead)
    assert sum(zone["seconds_s"] for zone in body["zones"]) == pytest.approx(in_window)


def test_the_overview_totals_zone_seconds_without_inventing_boundaries(
    api_client: TestClient,
):
    body = api_client.get("/api/overview").json()
    assert body["zones"]
    assert all(zone["seconds_s"] >= 0 for zone in body["zones"])
    assert all(set(zone) == {"zone_index", "seconds_s"} for zone in body["zones"])
    assert isinstance(body["zone_boundaries_bpm"], list)


def test_the_overview_reports_streak_and_consistency(api_client: TestClient):
    body = api_client.get("/api/overview").json()
    assert body["streak"]["current_weeks"] >= 0
    assert body["streak"]["longest_weeks"] >= 2
    assert body["consistency"]["weeks_considered"] == 52
    assert 0 <= body["consistency"]["weeks_with_a_run"] <= 52


def test_the_overview_reports_the_span_of_the_history(api_client: TestClient):
    body = api_client.get("/api/overview").json()
    assert body["first_run_local_date"] == "2026-08-21"
    assert body["last_run_local_date"] == "2026-08-28"


def test_the_last_activity_date_counts_every_sport(ingested_store: Paths):
    """Where the store's history ends, whatever the athlete did last.

    The last run's date cannot say this: an athlete who stops running and
    keeps cycling has a history that continues past it. The latest fixture
    run is recast as a ride, so the two dates part.
    """
    stored = read_activities(ingested_store)
    latest = stored["start_time_utc"].idxmax()
    stored.loc[latest, "sport"] = "cycling"
    upsert_activities(ingested_store, stored)

    with TestClient(create_app(ingested_store)) as client:
        body = client.get("/api/overview").json()

    assert body["last_activity_local_date"] == "2026-08-28"
    assert body["last_run_local_date"] < body["last_activity_local_date"]


def test_the_last_activity_date_is_inside_the_window(ingested_store: Paths):
    """A device clock can be wrong, so this date obeys the same bound as the rest."""
    stored = read_activities(ingested_store)
    stored.loc[stored["start_time_utc"].idxmax(), "start_time_utc"] = pd.Timestamp(
        datetime.now(tz=UTC) + timedelta(weeks=6)
    )
    upsert_activities(ingested_store, stored)

    with TestClient(create_app(ingested_store)) as client:
        body = client.get("/api/overview").json()

    horizon = (date.today() + timedelta(weeks=1)).isoformat()
    assert body["last_activity_local_date"] < horizon


def test_an_empty_store_has_an_overview_of_zeroes(empty_api_client: TestClient):
    body = empty_api_client.get("/api/overview").json()
    assert body["weeks"] == []
    assert body["months"] == []
    assert body["zones"] == []
    assert body["streak"]["current_weeks"] == 0
    assert body["consistency"]["weeks_with_a_run"] == 0
    assert body["first_run_local_date"] is None
    assert body["last_run_local_date"] is None
    assert body["last_activity_local_date"] is None


def _period_starts(client: TestClient, key: str) -> list[date]:
    body = client.get("/api/overview").json()[key]
    return [date.fromisoformat(bucket["period_start"]) for bucket in body]


def test_weekly_series_is_contiguous_by_iso_week(api_client: TestClient) -> None:
    """Consecutive entries are exactly seven days apart, so position indexes time."""
    weeks = _period_starts(api_client, "weeks")
    gaps = {(b - a).days for a, b in zip(weeks, weeks[1:], strict=False)}
    assert gaps <= {7}, f"non-weekly step in the series: {gaps}"


def test_weekly_series_starts_on_monday(api_client: TestClient) -> None:
    """ISO weeks, Monday to Sunday, matching analysis.consistency.week_start."""
    weeks = _period_starts(api_client, "weeks")
    assert all(w.weekday() == 0 for w in weeks)


def test_weekly_series_is_contiguous_across_a_manufactured_gap(ingested_store: Paths) -> None:
    """The shipped fixtures alone cannot exercise this fix.

    All five fixture activities fall in two adjacent ISO weeks
    (2026-08-17 and 2026-08-24), so there is no real gap between them: the
    dense and the sparse query return the same rows, and every test above
    passes whether or not the series is densified. Move one activity's start
    time six weeks earlier to open a real gap, then check the two properties
    the sparse implementation got wrong across it: the step stays seven days,
    and the weeks in between report zero runs and zero totals rather than
    vanishing.
    """
    stored = read_activities(ingested_store)
    moved = str(stored.iloc[0]["activity_id"])
    stored.loc[stored["activity_id"] == moved, "start_time_utc"] -= pd.Timedelta(weeks=6)
    upsert_activities(ingested_store, stored)

    with TestClient(create_app(ingested_store)) as client:
        weeks = client.get("/api/overview").json()["weeks"]

    starts = [date.fromisoformat(w["period_start"]) for w in weeks]
    gaps = {(b - a).days for a, b in zip(starts, starts[1:], strict=False)}
    assert gaps == {7}, f"non-weekly step across the manufactured gap: {gaps}"

    empty = [w for w in weeks if w["runs"] == 0]
    assert len(empty) >= 3, f"expected at least three empty weeks, got {len(empty)}"
    assert all(w["distance_m"] == 0.0 and w["moving_time_s"] == 0.0 for w in empty)


def test_monthly_series_is_contiguous_by_calendar_month(api_client: TestClient) -> None:
    """Months densify through the same code path as weeks, so this is the real check.

    The brief's original monthly test asserted ``... or True``, which can
    never fail regardless of what the series holds. Contiguity is the
    property that actually matters: consecutive months are exactly one
    calendar month apart, with no skipped month even if the real store never
    happens to show a gap.
    """
    months = _period_starts(api_client, "months")
    for earlier, later in zip(months, months[1:], strict=False):
        assert later.year * 12 + later.month == earlier.year * 12 + earlier.month + 1


def test_empty_store_returns_an_empty_weekly_series(empty_api_client: TestClient) -> None:
    """An empty store is not an error, and generate_series over a NULL bound yields nothing."""
    body = empty_api_client.get("/api/overview").json()
    assert body["weeks"] == []
    assert body["months"] == []


#: A Monday whose ISO week runs into the next calendar month: the week
#: containing 2026-08-31 ends on Sunday 2026-09-06. Every date-dependent
#: assertion below pins this rather than reading the clock.
_MONTH_END_MONDAY = date(2026, 8, 31)


@pytest.fixture
def as_of_month_end(monkeypatch: pytest.MonkeyPatch) -> None:
    """Freeze the endpoint's notion of today on `_MONTH_END_MONDAY`."""
    monkeypatch.setattr(overview_router, "_today", lambda: _MONTH_END_MONDAY)


def test_the_monthly_series_stops_at_the_current_month(
    api_client: TestClient, as_of_month_end: None
) -> None:
    """The window's end is not the series' end.

    The row filter runs through the current week's Sunday, which here is
    2026-09-06, and truncating that to a month emitted a 2026-09 bucket with
    zero runs and zero totals while it was still August. A bar chart draws
    that as "no training in September", and a client reading the last element
    as "this month" reads 0. It recurs for up to six days at the end of most
    months.
    """
    months = _period_starts(api_client, "months")
    assert months[-1] == date(2026, 8, 1)
    assert date(2026, 9, 1) not in months


def test_the_weekly_series_still_runs_through_the_current_week(
    api_client: TestClient, as_of_month_end: None
) -> None:
    """Bounding the series on today rather than on Sunday must not shorten it.

    ``date_trunc('week', week_end(today))`` and ``date_trunc('week', today)``
    are the same Monday, so the weekly series is unchanged by the month fix.
    """
    weeks = _period_starts(api_client, "weeks")
    assert weeks[-1] == _MONTH_END_MONDAY


def test_a_run_in_the_next_month_inside_the_window_keeps_its_bucket(
    ingested_store: Paths, as_of_month_end: None
) -> None:
    """Densifying may add empty periods; it must never drop a run.

    A device clock can be wrong, so a run can be stamped later in the current
    week than today is. Here one fixture run moves to 2026-09-02, which is
    inside the window that ends on Sunday 2026-09-06 but past the month the
    series would otherwise stop at. Joining the runs onto a period list that
    stopped in August would silently discard it: five runs would be counted
    as four.
    """
    stored = read_activities(ingested_store)
    moved = str(stored.iloc[0]["activity_id"])
    stored.loc[stored["activity_id"] == moved, "start_time_utc"] = pd.Timestamp(
        "2026-09-02T09:00:00Z"
    )
    upsert_activities(ingested_store, stored)

    with TestClient(create_app(ingested_store)) as client:
        months = client.get("/api/overview").json()["months"]

    assert sum(m["runs"] for m in months) == 5
    september = [m for m in months if m["period_start"] == "2026-09-01"]
    assert len(september) == 1
    assert september[0]["runs"] == 1
