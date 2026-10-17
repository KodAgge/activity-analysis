from itertools import pairwise

import pyarrow.parquet as pq
from fastapi.testclient import TestClient

from activity_analysis.config import Paths

CHANNELS = (
    "t_s",
    "distance_m",
    "speed_mps",
    "hr_bpm",
    "cadence_spm",
    "altitude_m",
    "lat_deg",
    "lon_deg",
    "paused",
    "outage",
)


def _first_activity_id(client: TestClient) -> str:
    return str(client.get("/api/activities").json()["items"][0]["activity_id"])


def _streams(client: TestClient) -> dict:
    return dict(client.get(f"/api/activities/{_first_activity_id(client)}/streams").json())


def test_streams_are_column_major_and_equal_length(api_client: TestClient):
    body = _streams(api_client)
    assert body["sample_count"] > 0
    for channel in CHANNELS:
        assert len(body[channel]) == body["sample_count"], channel


def test_the_grid_is_one_sample_per_second_and_starts_at_zero(api_client: TestClient):
    """The defining property of the derived layer, and what a raw records
    payload would not satisfy: uniform 1 Hz from zero."""
    t = _streams(api_client)["t_s"]
    assert t == [float(i) for i in range(len(t))]


def test_distance_never_goes_backwards(api_client: TestClient):
    """The grid interpolates distance across every gap, so the odometer is
    monotonic even where the sensors are null."""
    distance = _streams(api_client)["distance_m"]
    assert None not in distance
    assert all(b >= a for a, b in pairwise(distance))


def test_pauses_and_outages_travel_with_the_samples(api_client: TestClient):
    body = _streams(api_client)
    assert all(isinstance(v, bool) for v in body["paused"])
    assert all(isinstance(v, bool) for v in body["outage"])


def test_a_grid_missing_the_pause_flags_serves_unknown_rather_than_not_paused(
    ingested_store: Paths, api_client: TestClient
):
    """The flags degrade the way the measured channels do.

    A grid written before the flags existed knows nothing about pauses, and
    the honest answer is null. Coalescing to False would assert that the
    athlete kept running through every gap, which is the one claim the pause
    work exists to avoid making.
    """
    activity_id = _first_activity_id(api_client)
    path = ingested_store.derived_stream_path(activity_id)
    pq.write_table(pq.read_table(path).drop_columns(["paused", "outage"]), path)

    response = api_client.get(f"/api/activities/{activity_id}/streams")

    assert response.status_code == 200
    body = response.json()
    assert body["sample_count"] > 0
    assert body["paused"] == [None] * body["sample_count"]
    assert body["outage"] == [None] * body["sample_count"]


def test_a_grid_missing_a_channel_reads_as_nulls_rather_than_failing(
    ingested_store: Paths, api_client: TestClient
):
    """Recompute rewrites the grid one activity at a time.

    A partly rebuilt directory is the normal intermediate state of an
    ANALYSIS_VERSION bump, so a file written before a channel existed has to
    degrade to nulls in that channel, which is what the ``streams_1hz`` view
    does through ``union_by_name``. Reading the file directly must not answer
    differently from reading the view.
    """
    activity_id = _first_activity_id(api_client)
    path = ingested_store.derived_stream_path(activity_id)
    pq.write_table(pq.read_table(path).drop_columns(["cadence_spm"]), path)

    response = api_client.get(f"/api/activities/{activity_id}/streams")

    assert response.status_code == 200
    body = response.json()
    assert body["sample_count"] > 0
    assert body["cadence_spm"] == [None] * body["sample_count"]
    assert None not in body["distance_m"]


def test_streams_for_an_unknown_activity_say_so(api_client: TestClient):
    response = api_client.get("/api/activities/0123456789abcdef/streams")
    assert response.status_code == 404
    assert "no such activity" in response.json()["detail"]


def test_streams_for_a_known_activity_name_the_absence_they_actually_found(
    ingested_store: Paths, api_client: TestClient
):
    """An unknown id, a run the rebuild has not reached, and another sport are
    three different facts, and the body has to say which one it is.

    This activity is a run, so the body must name the rebuild rather than the
    sport, which is the same wording ``derived_absent_reason`` serves.
    """
    activity_id = _first_activity_id(api_client)
    ingested_store.derived_stream_path(activity_id).unlink()

    response = api_client.get(f"/api/activities/{activity_id}/streams")

    assert response.status_code == 404
    assert "recompute" in response.json()["detail"]
    assert "covers running only" not in response.json()["detail"]


def test_an_id_that_is_not_an_id_never_becomes_a_path(api_client: TestClient):
    response = api_client.get("/api/activities/..%2F..%2Fetc%2Fpasswd/streams")
    assert response.status_code in (404, 422)


def test_stream_payloads_are_compressed_on_the_wire(api_client: TestClient):
    """A grid is the one response large enough for this to matter.

    A full 1 Hz run is megabytes of JSON that gzip reduces to a fraction of
    that. Full resolution is only defensible at the compressed size, so the
    compression is part of the decision not to downsample rather than an
    afterthought. The measured payload sizes are in ``docs/reference/api.md``.
    """
    activity_id = _first_activity_id(api_client)
    response = api_client.get(
        f"/api/activities/{activity_id}/streams", headers={"Accept-Encoding": "gzip"}
    )
    assert response.headers["content-encoding"] == "gzip"


def test_small_responses_are_not_compressed(api_client: TestClient):
    """Compressing a 400 byte body costs CPU and saves nothing."""
    response = api_client.get("/api/health", headers={"Accept-Encoding": "gzip"})
    assert "content-encoding" not in response.headers
