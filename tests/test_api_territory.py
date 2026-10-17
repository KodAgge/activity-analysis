"""The territory API: it serves the stored tables, and an empty store as zeros.

The geometry is tested on synthetic loops in `tests/test_territory.py`. This
file builds the store the way a user does, ingest then recompute over the
committed fixtures, so it proves the endpoint projects what `recompute` wrote
rather than that the ground is right.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from activity_analysis.analysis.territory import CLOSURE_MAX_M, SLIVER_RADIUS_M
from activity_analysis.config import Paths
from activity_analysis.store.writer import (
    read_activities,
    read_territory_claims,
    read_territory_parts,
    read_territory_regions,
    write_territory_parts,
)
from tests.territory_outlines import assert_valid_outlines


def test_territory_serves_the_stored_union_regions_and_growth(
    api_client: TestClient, ingested_store: Paths
) -> None:
    body = api_client.get("/api/territory").json()
    claims = read_territory_claims(ingested_store)
    regions = read_territory_regions(ingested_store)
    parts = read_territory_parts(ingested_store)

    assert body["total_area_m2"] == pytest.approx(regions["area_m2"].sum())
    assert body["closure_max_m"] == CLOSURE_MAX_M
    assert body["sliver_radius_m"] == SLIVER_RADIUS_M
    assert body["counts"] == {
        "outdoor_runs": len(claims),
        "loop_runs": int(claims["closes_loop"].sum()),
        "claiming_runs": int(claims["region_id"].notna().sum()),
        "regions": len(regions),
        "parts": len(parts),
    }

    served = body["regions"][0]
    stored = regions.sort_values("area_m2", ascending=False).iloc[0]
    assert served["region_id"] == stored["region_id"]
    assert served["name"] == stored["name"]
    assert (served["west"], served["south"], served["east"], served["north"]) == (
        stored["min_lon"],
        stored["min_lat"],
        stored["max_lon"],
        stored["max_lat"],
    )
    assert served["first_claim_utc"].endswith("Z")

    collection = body["territory"]
    assert collection["type"] == "FeatureCollection"
    assert len(collection["features"]) == len(parts)
    feature = collection["features"][0]
    assert feature["type"] == "Feature" and feature["geometry"]["type"] == "Polygon"
    assert feature["properties"]["area_m2"] == pytest.approx(parts["area_m2"].max())
    lon, lat = feature["geometry"]["coordinates"][0][0]
    assert served["west"] <= lon <= served["east"]
    assert served["south"] <= lat <= served["north"]
    assert_valid_outlines(f["geometry"] for f in collection["features"])


def test_a_part_split_at_a_neck_is_served_as_a_multipolygon(
    api_client: TestClient, ingested_store: Paths
) -> None:
    """An outline snapping split in two is stored as a MultiPolygon and served as one."""
    parts = read_territory_parts(ingested_store)
    west = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0], [0.0, 0.0]]
    east = [[2.0, 0.0], [3.0, 0.0], [3.0, 1.0], [2.0, 1.0], [2.0, 0.0]]
    split = {"type": "MultiPolygon", "coordinates": [[west], [east]]}
    parts.loc[0, "geometry_geojson"] = json.dumps(split)
    write_territory_parts(ingested_store, parts)

    features = api_client.get("/api/territory").json()["territory"]["features"]
    assert features[0]["geometry"] == split


def test_growth_is_one_point_per_claiming_run_oldest_first(
    api_client: TestClient, ingested_store: Paths
) -> None:
    growth = api_client.get("/api/territory").json()["growth"]
    claims = read_territory_claims(ingested_store)
    claiming = claims[claims["region_id"].notna()].sort_values("start_time_utc")
    assert [p["activity_id"] for p in growth] == claiming["activity_id"].tolist()
    assert [p["new_m2"] for p in growth] == pytest.approx(claiming["new_m2"].tolist())
    cumulative = [p["cumulative_m2"] for p in growth]
    assert cumulative == sorted(cumulative)
    assert cumulative[-1] == pytest.approx(api_client.get("/api/territory").json()["total_area_m2"])
    names = read_activities(ingested_store).set_index("activity_id")["name"]
    assert growth[0]["name"] == names[growth[0]["activity_id"]]
    assert all(p["start_time_utc"].endswith("Z") for p in growth)


def test_an_empty_store_has_no_territory(empty_api_client: TestClient) -> None:
    response = empty_api_client.get("/api/territory")
    assert response.status_code == 200
    body = response.json()
    assert body["total_area_m2"] == 0
    assert body["regions"] == [] and body["growth"] == []
    assert body["territory"] == {"type": "FeatureCollection", "features": []}
    assert body["counts"] == {
        "outdoor_runs": 0,
        "loop_runs": 0,
        "claiming_runs": 0,
        "regions": 0,
        "parts": 0,
    }


def test_the_schema_names_the_territory_endpoint_in_si(api_client: TestClient) -> None:
    schema = api_client.get("/openapi.json").json()
    assert "/api/territory" in schema["paths"]
    point = schema["components"]["schemas"]["TerritoryGrowthPoint"]["properties"]
    assert {"new_m2", "cumulative_m2", "utc_offset_s"} <= set(point)
    assert not any("km" in name for name in point)
