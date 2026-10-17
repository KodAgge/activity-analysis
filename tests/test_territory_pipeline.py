"""Territory end to end over the committed fixtures: which runs recompute considers.

The geometry and the accounting are tested on synthetic loops in
`tests/test_territory.py`; this file only proves that `recompute` feeds the
pass the right runs and writes the three tables, the same split
`tests/test_routes.py` and `tests/test_analysis_pipeline.py` keep.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pandas as pd
import pytest

from activity_analysis.analysis.pipeline import recompute
from activity_analysis.config import ANALYSIS_VERSION, Paths
from activity_analysis.ingest.pipeline import ingest
from activity_analysis.store import db
from activity_analysis.store.writer import (
    read_activities,
    read_territory_claims,
    read_territory_parts,
    read_territory_regions,
    upsert_activities,
)
from tests.territory_outlines import assert_valid_outlines


@pytest.fixture
def ingested(tmp_path: Path, all_fit_fixtures: list[Path]) -> Paths:
    paths = Paths(root=tmp_path)
    source = tmp_path / "dump"
    source.mkdir()
    for fixture in all_fit_fixtures:
        shutil.copy(fixture, source / fixture.name)
    ingest(paths, source, athlete_id="tester")
    return paths


def test_recompute_writes_one_claim_row_per_outdoor_run(ingested: Paths) -> None:
    result = recompute(ingested)
    assert not result.errors
    claims = read_territory_claims(ingested)
    assert sorted(claims["activity_id"]) == sorted(read_activities(ingested)["activity_id"])
    assert claims["start_time_utc"].is_monotonic_increasing
    assert (claims["analysis_version"] == ANALYSIS_VERSION).all()
    claiming = claims[claims["region_id"].notna()]
    assert result.territory_claims == len(claiming)
    # The cumulative column ends at the union's area, which the regions hold.
    regions = read_territory_regions(ingested)
    assert claiming["cumulative_m2"].iloc[-1] == pytest.approx(regions["area_m2"].sum())
    assert result.territory_area_m2 == pytest.approx(regions["area_m2"].sum())
    parts = read_territory_parts(ingested)
    assert set(parts["region_id"]) == set(regions["region_id"])
    # Real tracks leave several parts: every outline is valid on the served grid.
    assert len(parts) > 1
    assert_valid_outlines(json.loads(g) for g in parts["geometry_geojson"])


def test_a_treadmill_run_claims_no_ground(ingested: Paths) -> None:
    recompute(ingested)
    claims = read_territory_claims(ingested)
    treadmill = str(claims.loc[claims["region_id"].notna(), "activity_id"].iloc[0])

    activities = read_activities(ingested)
    row = activities[activities["activity_id"] == treadmill].copy()
    row["sub_sport"] = "treadmill"
    upsert_activities(ingested, row)
    recompute(ingested)

    assert treadmill not in set(read_territory_claims(ingested)["activity_id"])


def test_the_views_read_the_territory_tables(ingested: Paths) -> None:
    recompute(ingested)
    con = db.connect(ingested)
    n = len(read_territory_claims(ingested))
    assert con.sql("select count(*) from territory_claims").fetchone() == (n,)
    regions = con.sql("select count(*) from territory_regions").fetchone()
    assert regions is not None and regions[0] >= 1
    parts = con.sql("select count(*) from territory_parts").fetchone()
    assert parts is not None and parts[0] >= 1


def test_the_views_exist_on_a_store_never_recomputed(tmp_path: Path) -> None:
    con = db.connect(Paths(root=tmp_path))
    for view in ("territory_claims", "territory_regions", "territory_parts"):
        assert con.sql(f"select count(*) from {view}").fetchone() == (0,)


def test_a_failing_territory_pass_still_writes_its_tables_empty(
    ingested: Paths, monkeypatch: pytest.MonkeyPatch
) -> None:
    recompute(ingested)
    assert not read_territory_claims(ingested).empty

    def broken(*_: object, **__: object) -> None:
        raise RuntimeError("boom")

    monkeypatch.setattr("activity_analysis.analysis.pipeline.claim_territory", broken)
    result = recompute(ingested)
    assert ("territory", "RuntimeError: boom") in result.errors
    for table in (
        read_territory_claims(ingested),
        read_territory_regions(ingested),
        read_territory_parts(ingested),
    ):
        assert isinstance(table, pd.DataFrame) and table.empty
