import pyarrow.parquet as pq
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from activity_analysis.api.deps import CursorDep
from activity_analysis.api.main import create_app
from activity_analysis.cli import app as cli_app
from activity_analysis.config import ANALYSIS_VERSION, INGEST_VERSION, Paths


def _section(output: str, heading: str) -> list[tuple[str, str]]:
    """The indented `name: value` pairs `info` prints under one heading."""
    lines = output.splitlines()
    start = lines.index(heading) + 1
    pairs: list[tuple[str, str]] = []
    for line in lines[start:]:
        if not line.startswith("  "):
            break
        name, value = line.strip().split(": ", 1)
        pairs.append((name, value))
    return pairs


def test_health_reports_the_rows_the_store_holds(api_client: TestClient):
    body = api_client.get("/api/health").json()
    assert body["counts"]["activities"] == 5
    assert body["counts"]["streams_1hz"] > 0


def test_health_counts_every_table_the_info_command_counts(
    api_client: TestClient, ingested_store: Paths
):
    """``cli.py``'s ``info`` and ``queries.COUNTED_TABLES`` are two lists of the same tables.

    Nothing compared them before this test: ``activity_tags`` was added to one
    and not the other, and the counts object still had eight keys where
    ``info`` printed nine. So the expected set is read out of what ``info``
    actually prints for the same store, rather than from a literal here, which
    would be a third list of the same names to keep in step and would leave a
    table added to one of the other two uncaught.

    The counts themselves are compared, not only the names: both surfaces run
    ``count(*)`` over the same store, so a name that resolves to a different
    view on one side is a difference in the numbers.
    """
    result = CliRunner().invoke(cli_app, ["info", "--root", str(ingested_store.root)])
    assert result.exit_code == 0, result.stdout
    # `info` prints its row counts indented under a `store rows:` heading, and
    # its one non-store figure under another heading. Reading the section
    # rather than every `label: number` line in the output is what lets this
    # test keep deriving its expectation from `info` instead of from a literal
    # list: a table added there is still caught, while a reference figure
    # added there is correctly not mistaken for a store table.
    counted = {name: int(value) for name, value in _section(result.stdout, "store rows:")}
    assert counted, result.stdout

    body = api_client.get("/api/health").json()
    assert body["counts"] == counted


def test_health_reports_an_empty_store_without_failing(empty_api_client: TestClient):
    response = empty_api_client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["counts"]["activities"] == 0


def test_health_compares_stored_versions_against_the_running_code(api_client: TestClient):
    body = api_client.get("/api/health").json()
    assert body["expected_ingest_version"] == INGEST_VERSION
    assert body["expected_analysis_version"] == ANALYSIS_VERSION
    assert body["stored_ingest_versions"] == [INGEST_VERSION]
    assert body["stored_analysis_versions"] == [ANALYSIS_VERSION]
    assert body["stale"] is False


def test_a_duckdb_error_becomes_a_503_naming_the_remedy(ingested_store: Paths):
    """A canonical stream file written before a column existed.

    The store raises on the query rather than on connect, precisely so that
    health and the activity list keep working while the operator sorts it out.
    What the API adds is turning that error into a status code and a message
    instead of a stack trace.

    No production endpoint reads the canonical ``streams`` view, which is the
    one that raises, so the test mounts its own route on the application under
    test rather than adding a debug route that exists only to be tested.
    """
    current = next(iter(ingested_store.streams_dir.glob("*.parquet")))
    stale = pq.read_table(current).drop_columns(["hr_bpm"])
    # Sorts before any hex activity id, so the scan binds to the stale file.
    pq.write_table(stale, ingested_store.streams_dir / "0000_stale.parquet")

    app = create_app(ingested_store)

    @app.get("/api/test-only/raise")
    def _raise(cur: CursorDep) -> None:
        cur.execute("SELECT hr_bpm FROM streams LIMIT 1").fetchall()

    with TestClient(app, raise_server_exceptions=False) as client:
        assert client.get("/api/health").status_code == 200
        assert client.get("/api/activities").status_code == 200

        response = client.get("/api/test-only/raise")

    assert response.status_code == 503
    assert "hr_bpm" in response.json()["detail"]
    assert "--force" in response.json()["detail"]


def test_the_schema_describes_every_endpoint_the_frontend_needs(api_client: TestClient):
    """The OpenAPI document is a shipped artefact, not a proxy for behaviour.

    Phase 3b generates its TypeScript client from it, so a route missing here
    is a compile error over there.
    """
    paths = api_client.get("/openapi.json").json()["paths"]
    assert set(paths) >= {
        "/api/health",
        "/api/sports",
        "/api/activities",
        "/api/activities/{activity_id}",
        "/api/activities/{activity_id}/streams",
        "/api/overview",
    }


def test_the_schema_keeps_si_units_in_the_field_names(api_client: TestClient):
    schemas = api_client.get("/openapi.json").json()["components"]["schemas"]
    summary = schemas["ActivitySummary"]["properties"]
    assert "distance_m" in summary
    assert "utc_offset_s" in summary
    assert "start_time_local" not in summary
    assert not any(name.startswith("pace") for name in summary)


def test_the_schema_names_moving_time_only_after_the_derived_one(api_client: TestClient):
    """Phase 3b generates a client from this document.

    ``ActivitySummary`` now carries ``moving_time_s`` too - the browser needs
    it to avoid showing elapsed time, inflated by tens of minutes on the real
    history, as though it were moving time. ``test_api_activities.py`` has
    the behavioural half of this, proving it against a real fixture activity
    where the two disagree.

    Carrying it here is safe only because both fields are sourced from the
    same place, ``activity_metrics.moving_time_s``, never from the canonical
    ``activities.moving_time_s`` column - a byte-identical duplicate of
    ``timer_time_s`` (see docs/reference/api.md). Two fields sharing a name but
    disagreeing in value would be the actual danger a generated client can't
    see; two fields sharing a name and a source are redundant, not wrong.
    ``timer_time_s`` stays alongside it so a reader can still tell moving
    time from the device's raw timer.
    """
    schemas = api_client.get("/openapi.json").json()["components"]["schemas"]
    assert "timer_time_s" in schemas["ActivitySummary"]["properties"]
    assert "moving_time_s" in schemas["ActivitySummary"]["properties"]
    assert "moving_time_s" in schemas["ActivityMetrics"]["properties"]


def test_the_schema_carries_the_date_filter_semantics(api_client: TestClient):
    """A bound nobody can see is a bound the client gets wrong.

    ``to`` is exclusive and both are compared against the local calendar date
    rather than the UTC instant, neither of which a client author can infer
    from a bare ``string($date)``. The behaviour itself is pinned by
    ``test_the_date_filter_uses_the_local_calendar_date``; what this pins is
    that it reaches the document phase 3b generates from.
    """
    parameters = api_client.get("/openapi.json").json()["paths"]["/api/activities"]["get"][
        "parameters"
    ]
    described = {p["name"]: p.get("description", "") for p in parameters}
    assert described["from"]
    assert described["to"]
    assert described["sport"]


def test_the_schema_types_the_sort_parameter_as_a_union(api_client: TestClient):
    """So the generated client cannot send a column the API would refuse."""
    parameters = api_client.get("/openapi.json").json()["paths"]["/api/activities"]["get"][
        "parameters"
    ]
    sort = next(p for p in parameters if p["name"] == "sort")
    assert set(sort["schema"]["enum"]) == {
        "start_time_utc",
        "distance_m",
        "elapsed_time_s",
        "moving_time_s",
        # Pace and heart rate joined the set on 2026-09-03, so every column
        # the browser renders can now be sorted by. `avg_speed_mps` rather
        # than a virtual "pace": pace is never stored (CLAUDE.md), so a pace
        # sort is a sort on the speed it is the reciprocal of, and the client
        # inverts the direction.
        "avg_speed_mps",
        "avg_hr_bpm",
    }


def test_the_schema_closes_the_source_filter_to_the_sources_that_exist(api_client: TestClient):
    """Three sources exist, so a generated client should not offer a free string."""
    parameters = api_client.get("/openapi.json").json()["paths"]["/api/activities"]["get"][
        "parameters"
    ]
    source = next(p for p in parameters if p["name"] == "source")
    enum = next(option["enum"] for option in source["schema"]["anyOf"] if "enum" in option)
    assert set(enum) == {"garmin_fit", "strava_fit", "gpx"}
