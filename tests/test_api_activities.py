import math
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from fastapi.testclient import TestClient

from activity_analysis.analysis.best_efforts import STANDARD_DISTANCES_M
from activity_analysis.analysis.pipeline import recompute
from activity_analysis.api.main import create_app
from activity_analysis.api.models import ActivitySummary
from activity_analysis.api.routers.activities import (
    DECOUPLING_INDOORS,
    DECOUPLING_INTERVALS,
    DECOUPLING_NO_HEART_RATE,
    DECOUPLING_NOT_RECOMPUTED,
    DECOUPLING_TOO_FEW_SECONDS,
    DECOUPLING_TOO_SHORT,
    DECOUPLING_WALK,
    OUTSIDE_ALL_OUT,
    OUTSIDE_NOT_EASY_OR_STEADY,
    OUTSIDE_SHORT,
    OUTSIDE_UNKNOWN,
    OUTSIDE_UNTAGGED,
    decoupling_absent_reason,
    outside_population_reason,
)
from activity_analysis.config import Paths
from activity_analysis.ingest.pipeline import ingest
from activity_analysis.store.writer import (
    read_activities,
    read_activity_metrics,
    read_activity_tags,
    read_laps,
    upsert_activities,
    upsert_laps,
    write_activity_metrics,
    write_activity_tags,
)


def test_the_list_defaults_to_running(api_client: TestClient):
    body = api_client.get("/api/activities").json()
    assert body["items"]
    assert {item["sport"] for item in body["items"]} == {"running"}


def test_the_list_can_show_every_sport(api_client: TestClient):
    everything = api_client.get("/api/activities", params={"sport": "all"}).json()
    running = api_client.get("/api/activities").json()
    assert everything["total"] >= running["total"]


def test_the_list_reports_the_total_beyond_the_page(api_client: TestClient):
    body = api_client.get("/api/activities", params={"limit": 1}).json()
    assert len(body["items"]) == 1
    assert body["total"] == 5
    assert body["limit"] == 1
    assert body["offset"] == 0


def test_the_list_is_ordered_by_instant_descending(api_client: TestClient):
    starts = [
        datetime.fromisoformat(i["start_time_utc"])
        for i in api_client.get("/api/activities").json()["items"]
    ]
    assert starts == sorted(starts, reverse=True)


def test_paging_does_not_repeat_or_drop_an_activity(api_client: TestClient):
    """Two runs starting in the same second must not swap between pages."""
    whole = [i["activity_id"] for i in api_client.get("/api/activities").json()["items"]]
    paged: list[str] = []
    for offset in range(0, 5, 2):
        page = api_client.get("/api/activities", params={"limit": 2, "offset": offset})
        paged.extend(i["activity_id"] for i in page.json()["items"])
    assert paged == whole


def test_the_list_carries_the_offset_rather_than_a_local_string(api_client: TestClient):
    item = api_client.get("/api/activities").json()["items"][0]
    assert item["utc_offset_s"] == 7200
    assert "start_time_local" not in item


def test_an_empty_store_lists_nothing_without_failing(empty_api_client: TestClient):
    response = empty_api_client.get("/api/activities")
    assert response.status_code == 200
    assert response.json() == {"total": 0, "limit": 50, "offset": 0, "items": []}


def test_the_limit_is_capped(api_client: TestClient):
    assert api_client.get("/api/activities", params={"limit": 5000}).status_code == 422


def test_a_source_that_does_not_exist_is_refused_rather_than_answered_emptily(
    api_client: TestClient,
):
    """An empty page is what "no matching data" looks like.

    A misspelt source has to be distinguishable from a filter that genuinely
    matched nothing, and the valid set has to reach the generated client.
    """
    assert api_client.get("/api/activities", params={"source": "fit"}).status_code == 422
    assert api_client.get("/api/activities", params={"source": "gpx"}).status_code == 200


def test_an_unsortable_column_is_refused_before_it_reaches_sql(api_client: TestClient):
    response = api_client.get("/api/activities", params={"sort": "1; DROP TABLE activities"})
    assert response.status_code == 422


def test_moving_time_is_sortable_and_orders_by_the_served_field_not_the_canonical_duplicate(
    ingested_store: Paths,
):
    """``moving_time_s`` is sortable, and it sorts by the value the response
    actually shows - ``activity_metrics.moving_time_s`` via the summary's
    LEFT JOIN - never by ``activities.moving_time_s``, which is a
    byte-identical duplicate of the device's own ``timer_time_s`` (see
    docs/reference/api.md).

    Both columns share the exact name ``moving_time_s``, so a naive
    ``ORDER BY a.{sort}`` - the pattern the other three sortable columns
    correctly use, and the one an incomplete extension of it would copy
    here too - would not error; it would run and silently sort by the
    canonical duplicate instead, disagreeing with what the response body
    shows. Two activities are given swapped derived values here so the two
    orderings genuinely disagree; a fixture where they merely happen to
    coincide would not catch the mistake (measured against the real store:
    on the five example activities alone, the two orderings happen to
    coincide, which is exactly why this constructs a case where they cannot).
    """
    metrics = read_activity_metrics(ingested_store)
    stored = read_activities(ingested_store)[["activity_id", "moving_time_s"]].rename(
        columns={"moving_time_s": "canonical_moving_time_s"}
    )
    merged = metrics.merge(stored, on="activity_id").sort_values("canonical_moving_time_s")
    smallest_canonical = str(merged.iloc[0]["activity_id"])
    largest_canonical = str(merged.iloc[-1]["activity_id"])
    assert smallest_canonical != largest_canonical

    # Give the row with the smallest canonical value the largest derived
    # one, and vice versa, so a descending sort must reverse their order to
    # be reading the derived column at all.
    metrics.loc[metrics["activity_id"] == smallest_canonical, "moving_time_s"] = 999_999.0
    metrics.loc[metrics["activity_id"] == largest_canonical, "moving_time_s"] = 1.0
    write_activity_metrics(ingested_store, metrics)

    with TestClient(create_app(ingested_store)) as client:
        body = client.get(
            "/api/activities",
            params={"sport": "all", "sort": "moving_time_s", "order": "desc", "limit": 200},
        ).json()

    ids = [item["activity_id"] for item in body["items"]]
    assert ids[0] == smallest_canonical
    assert ids[-1] == largest_canonical


def _first_activity_id(client: TestClient) -> str:
    return str(client.get("/api/activities").json()["items"][0]["activity_id"])


def test_filters_narrow_the_list(api_client: TestClient):
    assert api_client.get("/api/activities", params={"has_hr": True}).json()["total"] <= 5
    assert api_client.get("/api/activities", params={"source": "gpx"}).json()["total"] == 0
    dated = api_client.get("/api/activities", params={"from": "2026-08-28"}).json()
    assert dated["total"] >= 1


def test_the_date_filter_uses_the_local_calendar_date(ingested_store: Paths):
    """A run belongs to the day the athlete ran it, not to the day in UTC.

    Two stored runs are put on opposite sides of the 2026-08-29 boundary, and
    each is put there by its offset rather than by its instant:

    * ``east`` starts at 2026-08-28T18:19:14Z at UTC+6, so it is 00:19 on the
      29th locally while the instant is still on the 28th.
    * ``west`` starts at 2026-08-29T02:00:00Z at UTC-6, so it is 20:00 on the
      28th locally while the instant is already on the 29th.

    Bracketing the boundary in both directions is what makes the assertion
    independent of the machine timezone, which one offset alone cannot do.
    Comparing the bound date against the instant resolves the boundary in the
    session timezone, so it admits ``east`` only at UTC+5:41 or further east
    and excludes ``west`` only at UTC-2 or further west. No timezone satisfies
    both, so the broken predicate fails this test wherever it runs, and
    nothing here depends on ``TZ``, which DuckDB reads once per process.
    """
    stored = read_activities(ingested_store).sort_values("start_time_utc").reset_index(drop=True)
    east, west = stored.index[-1], stored.index[0]
    stored.loc[east, "utc_offset_s"] = 6 * 3600
    stored.loc[west, "start_time_utc"] = pd.Timestamp("2026-08-29T02:00:00Z")
    stored.loc[west, "utc_offset_s"] = -6 * 3600
    upsert_activities(ingested_store, stored)
    east_id, west_id = stored.loc[east, "activity_id"], stored.loc[west, "activity_id"]

    with TestClient(create_app(ingested_store)) as client:
        on_or_after = client.get("/api/activities", params={"from": "2026-08-29"}).json()
        before = client.get("/api/activities", params={"to": "2026-08-29"}).json()

    on_the_29th = {item["activity_id"] for item in on_or_after["items"]}
    up_to_the_29th = {item["activity_id"] for item in before["items"]}
    assert east_id in on_the_29th
    assert west_id not in on_the_29th
    assert east_id not in up_to_the_29th
    assert west_id in up_to_the_29th


def test_sports_are_reported_with_counts(api_client: TestClient):
    body = api_client.get("/api/sports").json()
    running = next(s for s in body if s["sport"] == "running")
    assert running["count"] == 5


def test_the_reference_activity_matches_its_recorded_golden_distance(api_client: TestClient):
    item = api_client.get("/api/activities").json()["items"][0]
    assert item["distance_m"] == pytest.approx(7456.06, abs=0.01)


def test_the_browser_reports_the_derived_moving_time_not_the_canonical_duplicate(
    api_client: TestClient,
):
    """``activities.moving_time_s`` is a byte-identical duplicate of
    ``timer_time_s`` (see docs/reference/api.md, "``moving_time_s`` is
    always the derived layer's"): a projection from it would
    silently show the device's auto-paused timer under this project's own
    label. Fixture activity 6116b2e90f551a6c is the one committed run where
    the two genuinely disagree - 3334.583 s (timer, and the canonical
    duplicate) against 3318.0 s (elapsed minus paused, the derived layer's
    own definition) - which is what lets this assertion actually fail
    against the wrong column instead of passing either way.
    """
    activity_id = "6116b2e90f551a6c"
    row = next(
        item
        for item in api_client.get("/api/activities").json()["items"]
        if item["activity_id"] == activity_id
    )
    assert row["timer_time_s"] == pytest.approx(3334.583)
    assert row["moving_time_s"] == pytest.approx(3318.0)
    assert row["moving_time_s"] != row["timer_time_s"]

    detail = api_client.get(f"/api/activities/{activity_id}").json()
    assert detail["derived"] is not None
    assert row["moving_time_s"] == pytest.approx(detail["derived"]["metrics"]["moving_time_s"])


def test_the_browsers_moving_time_is_null_without_a_derived_layer(ingested_store: Paths):
    """Mirrors ``test_a_run_without_a_derived_layer_is_not_told_it_is_not_a_run``.

    Dropping a run's metrics row is one of the three real paths to no derived
    layer at all, and the browser's own ``moving_time_s`` - a LEFT JOIN onto
    ``activity_metrics`` - has to go null along with it rather than quietly
    falling back to the canonical duplicate.
    """
    metrics = read_activity_metrics(ingested_store)
    orphaned = str(metrics.iloc[0]["activity_id"])
    write_activity_metrics(ingested_store, metrics.iloc[1:])

    with TestClient(create_app(ingested_store)) as client:
        row = next(
            item
            for item in client.get("/api/activities").json()["items"]
            if item["activity_id"] == orphaned
        )

    assert row["moving_time_s"] is None
    assert row["timer_time_s"] is not None


def test_detail_carries_summary_laps_and_derived(api_client: TestClient):
    body = api_client.get(f"/api/activities/{_first_activity_id(api_client)}").json()
    assert body["summary"]["distance_m"] == pytest.approx(7456.06, abs=0.01)
    assert body["laps"]
    assert body["laps"] == sorted(body["laps"], key=lambda lap: lap["lap_index"])
    assert body["derived"]["metrics"]["distance_m"] > 0
    assert body["derived"]["zones"]
    assert body["derived"]["best_efforts"]
    assert body["derived_absent_reason"] is None
    # The fixture store's five runs are five distinct routes with nobody
    # having repeated one, so nothing here groups: `route` is null rather
    # than absent, the same explicit-null guarantee `derived` carries.
    assert body["route"] is None


def test_laps_are_served_in_lap_index_order_even_when_stored_out_of_order(
    ingested_store: Paths,
) -> None:
    """``queries.laps`` sorts with ``ORDER BY lap_index`` so a consumer never
    has to, and docs/reference/api.md documents that as a guarantee rather
    than a coincidence. What consumes it is the analysis layer's per-lap
    ``rep_pattern``: one character per lap, matched positionally, so a
    consumer reading it against a differently ordered ``laps`` array would
    confidently label the wrong laps. The frontend's own
    ``web/src/components/splitsMath.ts`` deliberately does not take the
    guarantee on trust - ``rolesFromPattern`` sorts a defensive copy by
    ``lap_index`` first - which is precisely why the guarantee needs a test
    of its own here: nothing downstream would fail loudly if the query
    quietly stopped honouring it.

    A test built on the fixture store alone cannot tell a real guarantee
    from an accident: the reference activity's laps already sit on disk in
    ``lap_index`` order, because that is the order a FIT file's laps arrive
    in, so a version of this test run against the untouched fixture store
    still passes with ``ORDER BY lap_index`` deleted from the query -
    confirmed while writing this test. Storing one activity's laps
    reversed on disk first is what makes the assertion below actually
    depend on the query's own ordering rather than on the fixture data
    happening to agree with it.
    """
    laps = read_laps(ingested_store)
    counts = laps["activity_id"].value_counts()
    multi_lap_activities = counts[counts >= 3].index
    assert len(multi_lap_activities) > 0, "need a fixture activity with at least 3 laps"
    activity_id = str(multi_lap_activities[0])

    subset = laps[laps["activity_id"] == activity_id]
    reversed_subset = subset.iloc[::-1].reset_index(drop=True)
    assert reversed_subset["lap_index"].tolist() != subset["lap_index"].tolist(), (
        "the reversal must actually change on-disk order or this test proves nothing"
    )
    upsert_laps(ingested_store, reversed_subset)

    with TestClient(create_app(ingested_store)) as client:
        body = client.get(f"/api/activities/{activity_id}").json()

    served_indices = [lap["lap_index"] for lap in body["laps"]]
    assert served_indices == sorted(served_indices)


def test_best_efforts_carry_the_flags_that_qualify_them(api_client: TestClient):
    """A best effort spanning a pause, an outage or a jump in the recorded
    distance is still a best effort, but the consumer has to be able to see
    that it is one."""
    efforts = api_client.get(f"/api/activities/{_first_activity_id(api_client)}").json()["derived"][
        "best_efforts"
    ]
    for effort in efforts:
        assert set(effort) >= {
            "contains_pause",
            "contains_outage",
            "contains_jump",
            "speed_distance_m",
            "distance_trusted",
            "is_eligible",
            "ineligible_reason",
        }
        # The same identity the progression chart serves.
        assert effort["is_eligible"] == (effort["ineligible_reason"] is None)


def test_a_run_without_a_derived_layer_is_not_told_it_is_not_a_run(ingested_store: Paths):
    """Three states leave a running activity with no metrics row.

    ``recompute`` skips a run whose canonical stream is empty and records a
    per-activity failure without aborting, and a run ingested but not yet
    recomputed reaches the same place. Answering any of them with "the derived
    layer covers running only" tells the athlete their run is not a run.
    """
    metrics = read_activity_metrics(ingested_store)
    orphaned = str(metrics.iloc[0]["activity_id"])
    write_activity_metrics(ingested_store, metrics.iloc[1:])
    ingested_store.derived_stream_path(orphaned).unlink()

    with TestClient(create_app(ingested_store)) as client:
        body = client.get(f"/api/activities/{orphaned}").json()
        streams = client.get(f"/api/activities/{orphaned}/streams")

    assert body["summary"]["sport"] == "running"
    assert body["derived"] is None
    assert "recompute" in body["derived_absent_reason"]
    assert "covers running only" not in body["derived_absent_reason"]

    assert streams.status_code == 404
    assert "recompute" in streams.json()["detail"]


def test_an_activity_that_is_not_a_run_is_told_the_derived_layer_covers_running(
    ingested_store: Paths,
):
    """The mirror of the test above, and the statistically normal case.

    The derived layer covers running only, so most of the store reaches this
    branch; see ``docs/reference/api.md`` for how much of it does. Rewriting
    one fixture's sport and rebuilding is what makes a non-running activity out
    of five committed runs; ``recompute`` then writes no metrics row for it and
    clears the grid it had.
    """
    stored = read_activities(ingested_store)
    walked = str(stored.iloc[0]["activity_id"])
    stored.loc[stored["activity_id"] == walked, "sport"] = "walking"
    upsert_activities(ingested_store, stored)
    recompute(ingested_store)

    with TestClient(create_app(ingested_store)) as client:
        body = client.get(f"/api/activities/{walked}").json()
        streams = client.get(f"/api/activities/{walked}/streams")

    assert body["summary"]["sport"] == "walking"
    assert body["derived"] is None
    assert "covers running only" in body["derived_absent_reason"]
    assert "recompute" not in body["derived_absent_reason"]

    assert streams.status_code == 404
    assert "covers running only" in streams.json()["detail"]
    assert "recompute" not in streams.json()["detail"]


def test_an_activity_with_no_recorded_sport_is_still_selectable(
    tmp_path: Path, reference_gpx: Path
):
    """GPX records no sport, so the canonical row holds null.

    ``/api/sports`` reports that as a null bucket and the frontend renders a
    chip from it, so there has to be a value the filter round-trips. Without
    one the chip returns an empty page beside a non-zero count.
    """
    dump = tmp_path / "dump"
    dump.mkdir()
    shutil.copy(reference_gpx, dump / reference_gpx.name)
    paths = Paths(root=tmp_path / "store")
    ingest(paths, dump)

    with TestClient(create_app(paths)) as client:
        counts = {row["sport"]: row["count"] for row in client.get("/api/sports").json()}
        unknown = client.get("/api/activities", params={"sport": "unknown"}).json()
        running = client.get("/api/activities", params={"sport": "running"}).json()

    assert counts[None] == 1
    assert unknown["total"] == counts[None]
    assert [item["sport"] for item in unknown["items"]] == [None]
    assert running["total"] == 0


def test_derived_flags_missing_from_the_store_serve_unknown_rather_than_false(
    ingested_store: Paths,
):
    """The single-file derived tables degrade the way the grid does.

    An ANALYSIS_VERSION bump that adds a flag leaves every stored file without
    it until recompute rewrites them, and ``store/db.py`` projects that as a
    null on purpose. Rejecting the null would turn the documented 503-with-a
    -remedy into a 500 on every run; coalescing it to False would claim the
    effort was clean when nobody looked.
    """
    for path, column in (
        (ingested_store.activity_metrics_parquet, "is_indoor"),
        (ingested_store.best_efforts_parquet, "contains_jump"),
        (ingested_store.best_efforts_parquet, "distance_trusted"),
    ):
        pq.write_table(pq.read_table(path).drop_columns([column]), path)

    with TestClient(create_app(ingested_store)) as client:
        response = client.get(f"/api/activities/{_first_activity_id(client)}")

    assert response.status_code == 200
    derived = response.json()["derived"]
    assert derived["metrics"]["is_indoor"] is None
    assert derived["metrics"]["has_hr"] is not None
    assert derived["best_efforts"]
    assert all(effort["contains_jump"] is None for effort in derived["best_efforts"])
    assert all(effort["contains_pause"] is not None for effort in derived["best_efforts"])
    # Not known is not eligible, and says so rather than naming a cause.
    assert all(effort["is_eligible"] is False for effort in derived["best_efforts"])
    assert {effort["ineligible_reason"] for effort in derived["best_efforts"]} == {
        "not known to be outdoors"
    }


def test_detail_of_an_unknown_activity_is_a_404(api_client: TestClient):
    response = api_client.get("/api/activities/deadbeefdeadbeef")
    assert response.status_code == 404
    assert "deadbeefdeadbeef" in response.json()["detail"]


def test_the_instant_is_serialised_as_utc_whatever_the_server_timezone_is():
    """``start_time_utc`` must not render in the server's local timezone.

    DuckDB returns a TIMESTAMPTZ converted to the session timezone, so on a
    machine set to Europe/Stockholm the raw value carries +02:00. Serialising
    that verbatim would be an instant the field name denies, and the frontend
    computes local wall clock as ``start_time_utc + utc_offset_s``: adding the
    offset to an already-offset timestamp lands two hours late.

    Constructed directly rather than through the API so the assertion holds on
    any machine, including a CI runner set to UTC where the bug is invisible.
    """
    stockholm = timezone(timedelta(hours=2))
    summary = ActivitySummary(
        activity_id="0123456789abcdef",
        start_time_utc=datetime(2026, 8, 28, 20, 19, 14, tzinfo=stockholm),
        utc_offset_s=7200,
        sport="running",
        recorded_sport="running",
        sub_sport=None,
        name=None,
        distance_m=None,
        elapsed_time_s=None,
        timer_time_s=None,
        moving_time_s=None,
        ascent_m=None,
        descent_m=None,
        avg_speed_mps=None,
        max_speed_mps=None,
        avg_hr_bpm=None,
        max_hr_bpm=None,
        avg_cadence_spm=None,
        calories=None,
        source="garmin_fit",
        pr_distance_keys=[],
    )
    assert summary.start_time_utc.utcoffset() == timedelta(0)
    assert summary.model_dump(mode="json")["start_time_utc"] == "2026-08-28T18:19:14Z"


def test_the_served_instant_is_utc(api_client: TestClient):
    item = api_client.get("/api/activities").json()["items"][0]
    assert item["start_time_utc"] == "2026-08-28T18:19:14Z"


def test_detail_carries_tags_with_their_reasoning(api_client: TestClient) -> None:
    body = api_client.get(f"/api/activities/{_first_activity_id(api_client)}").json()
    tags = body["derived"]["tags"]
    assert isinstance(tags, list)
    for tag in tags:
        assert tag["kind"] in {"effort", "flag"}
        assert tag["reason"]
        if tag["kind"] == "effort":
            assert tag["distance_key"] is None, "an effort tag is not about one distance"


def test_records_are_told_apart_by_distance_and_ordered_by_it(api_client: TestClient) -> None:
    """A run records at several distances at once, and each one is its own row.

    A breakthrough 5k records at 400m, 1k, 1mi, 3k and 5k in the same run, so
    ``tag`` alone renders as the same chip five times over and the only thing
    telling them apart used to be ``reason``, which is prose and explicitly
    not a parsing surface. ``distance_key`` is the machine-readable half.

    The order is by distance, not by text: sorting the keys as strings puts
    "400m" after "3k", which is why the endpoint sorts on position in the
    analysis module's ascending list instead. The second assertion below is
    what fails if that becomes a plain alphabetical sort.
    """
    for item in api_client.get("/api/activities", params={"limit": 200}).json()["items"]:
        tags = api_client.get(f"/api/activities/{item['activity_id']}").json()["derived"]["tags"]
        records = [tag["distance_key"] for tag in tags if tag["tag"] == "pr"]
        if len(records) > 1:
            break
    else:
        pytest.fail("no fixture activity records at more than one distance")

    assert len(set(records)) == len(records)
    ascending = list(STANDARD_DISTANCES_M)
    assert records == sorted(records, key=ascending.index)
    assert records != sorted(records), "alphabetical order is not distance order"


def test_an_intervals_tag_carries_its_rep_count(api_client: TestClient) -> None:
    """The rep count is a field, not something read out of ``reason``'s prose.

    One of the fixture activities is a real interval session of five reps,
    so this is exercised against a genuine ``intervals`` tag rather than a
    contrived one.
    """
    for item in api_client.get("/api/activities", params={"limit": 200}).json()["items"]:
        tags = api_client.get(f"/api/activities/{item['activity_id']}").json()["derived"]["tags"]
        intervals = [tag for tag in tags if tag["tag"] == "intervals"]
        if intervals:
            break
    else:
        pytest.fail("no fixture activity classifies as intervals")

    assert intervals[0]["rep_count"] == 5
    for tag in tags:
        if tag["tag"] != "intervals":
            assert tag["rep_count"] is None, "only an intervals tag carries a rep count"


def test_an_intervals_tag_carries_its_rep_pattern(api_client: TestClient) -> None:
    """The per-lap pattern, not only the count, is a field a client can read.

    A frontend that wants to know which individual recorded laps were reps
    must not recompute the analysis layer's own classification to get it.
    """
    for item in api_client.get("/api/activities", params={"limit": 200}).json()["items"]:
        tags = api_client.get(f"/api/activities/{item['activity_id']}").json()["derived"]["tags"]
        intervals = [tag for tag in tags if tag["tag"] == "intervals"]
        if intervals:
            break
    else:
        pytest.fail("no fixture activity classifies as intervals")

    pattern = intervals[0]["rep_pattern"]
    assert pattern is not None and pattern != ""
    assert set(pattern) <= {"R", "W", "-"}
    laps = api_client.get(f"/api/activities/{item['activity_id']}").json()["laps"]
    assert len(pattern) == len(laps)
    for tag in tags:
        if tag["tag"] != "intervals":
            assert tag["rep_pattern"] is None, "only an intervals tag carries a rep pattern"


def test_a_run_with_no_stored_tags_serves_an_empty_list_not_null(
    ingested_store: Paths,
) -> None:
    """Empty and null mean different things here.

    An empty ``tags`` list is a run the store recorded no tags for.
    Null is reserved for the whole ``derived`` block being absent, which
    carries its own ``derived_absent_reason``.
    Every one of the five fixture activities carries at least one tag row,
    so one activity's rows are stripped from the store here to exercise the
    genuinely empty case, following the same pattern
    ``test_derived_flags_missing_from_the_store_serve_unknown_rather_than_false``
    uses: rewrite a derived Parquet file, then build a fresh client over it.
    The rest of the derived block is asserted populated too, so the empty
    list is shown to be the tag field's own state rather than a symptom of
    the whole block collapsing.
    """
    tags = read_activity_tags(ingested_store)
    untagged = str(tags.iloc[0]["activity_id"])
    write_activity_tags(ingested_store, tags[tags["activity_id"] != untagged])

    with TestClient(create_app(ingested_store)) as client:
        body = client.get(f"/api/activities/{untagged}").json()

    derived = body["derived"]
    assert derived["tags"] == []
    assert derived["metrics"]["distance_m"] > 0
    assert derived["best_efforts"]


def test_the_distance_filter_bounds_both_ends(api_client: TestClient):
    """Inclusive on both sides, in metres, against the canonical distance."""
    everything = api_client.get("/api/activities", params={"sport": "all", "limit": 200}).json()
    distances = sorted(
        item["distance_m"] for item in everything["items"] if item["distance_m"] is not None
    )
    if len(distances) < 3:
        pytest.skip("needs at least three activities with a distance")
    floor = distances[1]

    narrowed = api_client.get(
        "/api/activities", params={"sport": "all", "min_distance_m": floor, "limit": 200}
    ).json()
    assert narrowed["total"] < everything["total"]
    assert all(item["distance_m"] >= floor for item in narrowed["items"])
    # Inclusive: the activity sitting exactly on the bound is in.
    assert any(item["distance_m"] == floor for item in narrowed["items"])

    capped = api_client.get(
        "/api/activities", params={"sport": "all", "max_distance_m": floor, "limit": 200}
    ).json()
    assert all(item["distance_m"] <= floor for item in capped["items"])
    assert any(item["distance_m"] == floor for item in capped["items"])


def test_the_moving_time_filter_reads_the_derived_column_not_the_device_timer(
    api_client: TestClient,
):
    """The same column the list renders, which is not `timer_time_s`.

    The canonical ``activities.moving_time_s`` is a byte-identical duplicate
    of the device's auto-paused timer (see docs/reference/api.md), so filtering on
    it would narrow by a different quantity from the one the reader sees in
    the column - the exact mistake already found and fixed twice in this
    codebase, in ``volume_by_period`` and in the browser's own sort.
    """
    everything = api_client.get("/api/activities", params={"sport": "all", "limit": 200}).json()
    moving = sorted(
        item["moving_time_s"] for item in everything["items"] if item["moving_time_s"] is not None
    )
    if len(moving) < 2:
        pytest.skip("needs at least two activities with a derived moving time")
    floor = moving[1]

    narrowed = api_client.get(
        "/api/activities", params={"sport": "all", "min_moving_time_s": floor, "limit": 200}
    ).json()
    assert all(item["moving_time_s"] >= floor for item in narrowed["items"])
    # A row with no derived moving time falls out rather than being coerced
    # into passing. Every non-running activity is in that position.
    assert all(item["moving_time_s"] is not None for item in narrowed["items"])


def test_the_total_counts_the_same_rows_the_page_returns(api_client: TestClient):
    """A filter on a joined table must narrow the total too.

    The count used to run against `activities` alone while the page ran
    against the join, so a filter living on `activity_metrics` or on the
    personal-record subquery would have left the pager promising more results
    than the list could reach.
    """
    for params in (
        {"sport": "all", "min_moving_time_s": 1},
        {"sport": "all", "has_pr": "true"},
        {"sport": "all", "has_pr": "false"},
    ):
        body = api_client.get("/api/activities", params={**params, "limit": 200}).json()
        assert body["total"] == len(body["items"]), params


def test_the_personal_record_filter_partitions_the_list(api_client: TestClient):
    """`has_pr` true and false must add back up to the unfiltered total."""
    base = api_client.get("/api/activities", params={"sport": "all", "limit": 1}).json()
    with_pr = api_client.get(
        "/api/activities", params={"sport": "all", "has_pr": "true", "limit": 200}
    ).json()
    without = api_client.get(
        "/api/activities", params={"sport": "all", "has_pr": "false", "limit": 1}
    ).json()

    assert with_pr["total"] + without["total"] == base["total"]
    # And the flag agrees with the field: every row on the true side names at
    # least one distance, every row on the false side names none.
    assert all(item["pr_distance_keys"] for item in with_pr["items"])
    without_items = api_client.get(
        "/api/activities", params={"sport": "all", "has_pr": "false", "limit": 200}
    ).json()["items"]
    assert all(item["pr_distance_keys"] == [] for item in without_items)


def test_a_row_that_set_no_record_carries_an_empty_list_not_null(api_client: TestClient):
    """An empty list is a fact; null would make the client guess."""
    body = api_client.get("/api/activities", params={"sport": "all", "limit": 200}).json()
    assert body["items"], "expected the fixture store to hold activities"
    for item in body["items"]:
        assert isinstance(item["pr_distance_keys"], list)


def test_the_pace_sort_orders_by_speed_so_descending_is_fastest_first(api_client: TestClient):
    """Pace is never stored, so a pace sort is a speed sort.

    Descending speed is ascending pace, which is why the browser asks for
    `desc` when the reader clicks "Pace" expecting the fastest run first.
    """
    body = api_client.get(
        "/api/activities",
        params={"sport": "all", "sort": "avg_speed_mps", "order": "desc", "limit": 200},
    ).json()
    speeds = [item["avg_speed_mps"] for item in body["items"] if item["avg_speed_mps"] is not None]
    assert speeds == sorted(speeds, reverse=True)
    if len(speeds) > 1:
        assert speeds[0] > speeds[-1], "a constant-speed store cannot prove an ordering"


def test_a_non_running_activity_keeps_the_device_s_average_speed(ingested_store: Paths):
    """The Pace column is rendered for every sport, and nothing derives a ride.

    ``activity_metrics`` covers running only, so a ride and a walk have no
    moving time for the served division to use. The expression falls back to
    the device's own session average there rather than leaving Pace empty.
    Rewriting one fixture's sport and rebuilding is what makes a non-running
    activity out of five committed runs; the canonical value is planted so
    the served number can be told apart from any division of the row.
    """
    stored = read_activities(ingested_store)
    walked = str(stored.iloc[0]["activity_id"])
    stored.loc[stored["activity_id"] == walked, "sport"] = "walking"
    stored.loc[stored["activity_id"] == walked, "avg_speed_mps"] = 1.25
    upsert_activities(ingested_store, stored)
    recompute(ingested_store)

    assert walked not in set(read_activity_metrics(ingested_store)["activity_id"].astype(str)), (
        "the derived layer must not cover the walk, or this proves nothing"
    )

    with TestClient(create_app(ingested_store)) as client:
        items = client.get("/api/activities", params={"sport": "all", "limit": 200}).json()["items"]
    (walk,) = [item for item in items if item["activity_id"] == walked]

    assert walk["moving_time_s"] is None
    assert walk["avg_speed_mps"] == pytest.approx(1.25)


def test_every_row_s_pace_multiplies_out_against_its_own_distance(api_client: TestClient):
    """Distance, Moving time and Pace are rendered side by side.

    The browser puts the three in one row, so the speed has to be the
    quotient of the other two rather than a third measurement of the same
    run. Asserted across the whole list because the property is the contract,
    not a case.
    """
    items = api_client.get("/api/activities", params={"sport": "all", "limit": 200}).json()["items"]
    checked = 0
    for item in items:
        distance, moving = item["distance_m"], item["moving_time_s"]
        if not distance or not moving:
            continue
        assert item["avg_speed_mps"] == pytest.approx(distance / moving)
        checked += 1
    assert checked, "the fixture store proved nothing"


def test_a_treadmill_pace_comes_from_the_distance_shown_beside_it(ingested_store: Paths):
    """On a treadmill the grid's odometer is a footpod estimate that drifts.

    There is no satellite fix indoors, so the session total is the
    trustworthy distance and the stream is the approximation; on the real
    store the two differ by a median of 7.78%. Serving the grid's own
    ``activity_metrics.avg_speed_mps`` would therefore render a pace beside a
    distance it was not computed from, on 82 of the 307 real runs.

    Rewriting one fixture's canonical distance and marking it a treadmill
    reproduces that divergence: the grid is untouched, so the grid's own
    speed and the stored one must now differ, and the stored one must be the
    canonical distance over the derived moving time.
    """
    stored = read_activities(ingested_store)
    indoor = str(stored.iloc[0]["activity_id"])
    stored.loc[stored["activity_id"] == indoor, "sub_sport"] = "treadmill"
    stored.loc[stored["activity_id"] == indoor, "avg_speed_mps"] = 1.25
    upsert_activities(ingested_store, stored)
    recompute(ingested_store)

    grid_distance = float(
        read_activity_metrics(ingested_store).set_index("activity_id").loc[indoor, "distance_m"]
    )
    session_distance = grid_distance * 1.1
    stored = read_activities(ingested_store)
    stored.loc[stored["activity_id"] == indoor, "distance_m"] = session_distance
    upsert_activities(ingested_store, stored)
    recompute(ingested_store)

    row = read_activity_metrics(ingested_store).set_index("activity_id").loc[indoor]
    moving = float(row["moving_time_s"])
    assert float(row["distance_m"]) == pytest.approx(grid_distance), (
        "the grid must be untouched, or the two distances cannot differ"
    )

    with TestClient(create_app(ingested_store)) as client:
        (item,) = [
            i
            for i in client.get("/api/activities", params={"sport": "all", "limit": 200}).json()[
                "items"
            ]
            if i["activity_id"] == indoor
        ]

    assert item["distance_m"] == pytest.approx(session_distance)
    assert item["avg_speed_mps"] == pytest.approx(session_distance / moving)
    assert item["avg_speed_mps"] != pytest.approx(grid_distance / moving), (
        "the two distances must differ, or this proves nothing"
    )
    assert item["avg_speed_mps"] != pytest.approx(1.25), (
        "the device's own average must not win where the derived value exists"
    )


def test_the_pace_sort_agrees_with_the_pace_shown(ingested_store: Paths):
    """Sorting by one number while showing another is the defect this guards.

    The list mixes rows whose speed comes from the derived layer with rows
    whose speed comes from the device, so the ordering has to evaluate the
    same coalesce the projection does. Planting a canonical value that would
    sort the walk first if the derived column alone were ordered by - where a
    null sorts into its own block - is what makes the two visible apart.
    """
    stored = read_activities(ingested_store)
    walked = str(stored.iloc[0]["activity_id"])
    stored.loc[stored["activity_id"] == walked, "sport"] = "walking"
    stored.loc[stored["activity_id"] == walked, "avg_speed_mps"] = 99.0
    upsert_activities(ingested_store, stored)
    recompute(ingested_store)

    with TestClient(create_app(ingested_store)) as client:
        items = client.get(
            "/api/activities",
            params={"sport": "all", "sort": "avg_speed_mps", "order": "desc", "limit": 200},
        ).json()["items"]

    speeds = [item["avg_speed_mps"] for item in items if item["avg_speed_mps"] is not None]
    assert speeds == sorted(speeds, reverse=True)
    assert items[0]["activity_id"] == walked, "the fastest served speed must sort first"


def test_the_heart_rate_sort_orders_by_heart_rate(api_client: TestClient):
    body = api_client.get(
        "/api/activities",
        params={"sport": "all", "sort": "avg_hr_bpm", "order": "desc", "limit": 200},
    ).json()
    rates = [item["avg_hr_bpm"] for item in body["items"] if item["avg_hr_bpm"] is not None]
    assert rates == sorted(rates, reverse=True)


def test_a_column_outside_the_whitelist_is_refused(api_client: TestClient):
    """The column name goes into the SQL text unparameterised."""
    assert api_client.get("/api/activities", params={"sort": "name; DROP TABLE"}).status_code == 422
    assert api_client.get("/api/activities", params={"sort": "calories"}).status_code == 422


def test_every_fixture_run_carries_no_route(api_client: TestClient) -> None:
    """The five fixture runs form no route among themselves - see
    `tests/test_api_routes.py` for a member run's own field carried here,
    written straight into a copy of this same store."""
    items = api_client.get("/api/activities", params={"limit": 200}).json()["items"]
    for item in items:
        body = api_client.get(f"/api/activities/{item['activity_id']}").json()
        assert body["route"] is None


#: The fixture store's three decoupling cases, measured on 2026-10-03.
#: 854fd775d479ca9f is the 2026-08-28 reference run, steady with 2932 fitted
#: seconds, so inside the population; 174c6a0e5af5c4b4 is easy with 1719, so
#: outside it; 6116b2e90f551a6c is an intervals session, which the efficiency
#: fit leaves out.
POPULATION_RUN = "854fd775d479ca9f"
SHORT_EASY_RUN = "174c6a0e5af5c4b4"
INTERVALS_RUN = "6116b2e90f551a6c"


def test_a_population_run_serves_its_decoupling_and_both_halves(api_client: TestClient):
    derived = api_client.get(f"/api/activities/{POPULATION_RUN}").json()["derived"]
    block = derived["decoupling"]
    assert derived["decoupling_absent_reason"] is None
    assert block["decoupling_pct"] == pytest.approx(13.0762, abs=1e-4)
    assert block["first_half_speed_mps"] == pytest.approx(2.5574, abs=1e-4)
    assert block["second_half_speed_mps"] == pytest.approx(2.4451, abs=1e-4)
    assert block["first_half_hr_bpm"] == pytest.approx(148.41, abs=0.01)
    assert block["second_half_hr_bpm"] == pytest.approx(163.24, abs=0.01)
    assert block["is_aerobic_long_run"] is True
    assert block["outside_population_reason"] is None


def test_a_run_outside_the_population_says_why_in_the_response(api_client: TestClient):
    block = api_client.get(f"/api/activities/{SHORT_EASY_RUN}").json()["derived"]["decoupling"]
    assert block["decoupling_pct"] == pytest.approx(4.6814, abs=1e-4)
    assert block["is_aerobic_long_run"] is False
    assert block["outside_population_reason"] == OUTSIDE_SHORT


def test_a_run_with_no_value_serves_why_instead(api_client: TestClient):
    derived = api_client.get(f"/api/activities/{INTERVALS_RUN}").json()["derived"]
    assert derived["decoupling"] is None
    assert derived["decoupling_absent_reason"] == DECOUPLING_INTERVALS


def _facts(**overrides: object) -> dict[str, object]:
    facts: dict[str, object] = {
        "is_indoor": False,
        "has_hr": True,
        "moving_time_s": 3000.0,
        "avg_speed_mps": 2.8,
        "effort_tag": "steady",
        "fit_seconds": 2900,
        "is_aerobic_long_run": True,
        "decoupling_pct": None,
        "decoupling_first_speed_mps": None,
        "decoupling_second_speed_mps": None,
        "decoupling_first_hr_bpm": None,
        "decoupling_second_hr_bpm": None,
    }
    facts.update(overrides)
    return facts


@pytest.mark.parametrize(
    ("overrides", "reason"),
    [
        # Tested in this order, so the first fact that applies names the run.
        ({"is_indoor": True, "effort_tag": "intervals", "has_hr": False}, DECOUPLING_INDOORS),
        ({"effort_tag": "intervals", "has_hr": False}, DECOUPLING_INTERVALS),
        ({"has_hr": False, "moving_time_s": 200.0}, DECOUPLING_NO_HEART_RATE),
        # The shape of one real run: too short and under walking pace.
        ({"moving_time_s": 210.0, "avg_speed_mps": 1.8}, DECOUPLING_TOO_SHORT),
        ({"avg_speed_mps": 1.5}, DECOUPLING_WALK),
        ({}, DECOUPLING_TOO_FEW_SECONDS),
        # A percentage with no halves is a store written before version 12.
        ({"decoupling_pct": 13.08}, DECOUPLING_NOT_RECOMPUTED),
        # A null flag is not known, never false: it does not name a reason.
        ({"is_indoor": None, "has_hr": None}, DECOUPLING_TOO_FEW_SECONDS),
    ],
)
def test_the_absent_reason_is_the_first_fact_that_applies(
    overrides: dict[str, object], reason: str
) -> None:
    assert decoupling_absent_reason(_facts(**overrides)) == reason


@pytest.mark.parametrize(
    ("is_aerobic_long_run", "effort_tag", "reason"),
    [
        (True, "steady", None),
        (None, "steady", OUTSIDE_UNKNOWN),
        (False, None, OUTSIDE_UNTAGGED),
        (False, "easy", OUTSIDE_SHORT),
        (False, "steady", OUTSIDE_SHORT),
        (False, "all_out", OUTSIDE_ALL_OUT),
        (False, "some_future_tag", OUTSIDE_NOT_EASY_OR_STEADY),
    ],
)
def test_the_population_reason_follows_the_flag_and_the_tag(
    is_aerobic_long_run: bool | None, effort_tag: str | None, reason: str | None
) -> None:
    assert outside_population_reason(is_aerobic_long_run, effort_tag) == reason


def test_a_non_finite_stored_value_is_served_as_no_value(ingested_store: Paths) -> None:
    """A NaN would fail JSON serialisation, and a non-finite decoupling is not
    a value a reader can be shown. Written with ``from_pandas=False``, since
    pandas would otherwise store the NaN as a null and test nothing new."""
    path = ingested_store.activity_efficiency_parquet
    table = pq.read_table(path)
    values = [
        math.nan if activity_id == POPULATION_RUN else value
        for activity_id, value in zip(
            table.column("activity_id").to_pylist(),
            table.column("decoupling_pct").to_pylist(),
            strict=True,
        )
    ]
    index = table.schema.get_field_index("decoupling_pct")
    table = table.set_column(
        index, "decoupling_pct", pa.array(values, type=pa.float64(), from_pandas=False)
    )
    assert table.column("decoupling_pct").null_count == 0
    pq.write_table(table, path)
    with TestClient(create_app(ingested_store)) as client:
        derived = client.get(f"/api/activities/{POPULATION_RUN}").json()["derived"]
    assert derived["decoupling"] is None
    assert derived["decoupling_absent_reason"] == DECOUPLING_TOO_FEW_SECONDS


def test_a_store_written_before_the_halves_existed_serves_no_value(ingested_store: Paths) -> None:
    """A version 11 file has no half columns; db.py projects them as typed
    nulls, and the run reads as having no value rather than failing."""
    path = ingested_store.activity_efficiency_parquet
    table = pq.read_table(path).drop_columns(
        [
            "decoupling_first_speed_mps",
            "decoupling_second_speed_mps",
            "decoupling_first_hr_bpm",
            "decoupling_second_hr_bpm",
        ]
    )
    pq.write_table(table, path)
    with TestClient(create_app(ingested_store)) as client:
        response = client.get(f"/api/activities/{POPULATION_RUN}")
    assert response.status_code == 200
    derived = response.json()["derived"]
    assert derived["decoupling"] is None
    # The percentage is there and the halves are not: the store predates
    # them, which is the cause to name, not too few seconds.
    assert derived["decoupling_absent_reason"] == DECOUPLING_NOT_RECOMPUTED


def _count_as_a_walk(paths: Paths) -> str:
    """Make one fixture run a walk the way the real one is: a moving pace
    slower than 9:00/km, from a canonical distance chosen against the derived
    moving time."""
    stored = read_activities(paths)
    walk = str(stored.sort_values("start_time_utc").iloc[2]["activity_id"])
    moving = float(read_activity_metrics(paths).set_index("activity_id").loc[walk, "moving_time_s"])
    stored.loc[stored["activity_id"] == walk, "distance_m"] = moving * 1000.0 / 600.0
    upsert_activities(paths, stored)
    recompute(paths)
    return walk


def test_a_run_counted_as_a_walk_says_so_and_why(ingested_store: Paths):
    walk = _count_as_a_walk(ingested_store)

    with TestClient(create_app(ingested_store)) as client:
        body = client.get(f"/api/activities/{walk}").json()
        streams = client.get(f"/api/activities/{walk}/streams")

    assert body["summary"]["sport"] == "walking"
    assert body["summary"]["recorded_sport"] == "running"
    assert body["derived"] is None
    assert body["reclassification"] == {
        "recorded_sport": "running",
        "sport": "walking",
        "avg_speed_mps": pytest.approx(1000.0 / 600.0),
        "threshold_mps": pytest.approx(1000.0 / 540.0),
    }
    reason = body["derived_absent_reason"]
    assert "recorded as a run" in reason and "9:00/km" in reason
    assert "covers running only" not in reason and "recompute" not in reason

    assert streams.status_code == 404
    assert streams.json()["detail"].endswith(reason)


def test_a_run_counted_as_a_walk_leaves_the_running_list_for_the_walking_one(
    ingested_store: Paths,
):
    walk = _count_as_a_walk(ingested_store)

    with TestClient(create_app(ingested_store)) as client:
        running = client.get("/api/activities", params={"sport": "running"}).json()
        walking = client.get("/api/activities", params={"sport": "walking"}).json()
        sports = {row["sport"]: row["count"] for row in client.get("/api/sports").json()}

    assert walk not in {item["activity_id"] for item in running["items"]}
    assert [item["activity_id"] for item in walking["items"]] == [walk]
    assert sports == {"running": 4, "walking": 1}


def test_an_ordinary_activity_has_no_reclassification(api_client: TestClient):
    item = api_client.get("/api/activities").json()["items"][0]
    body = api_client.get(f"/api/activities/{item['activity_id']}").json()

    assert item["recorded_sport"] == item["sport"] == "running"
    assert body["reclassification"] is None
