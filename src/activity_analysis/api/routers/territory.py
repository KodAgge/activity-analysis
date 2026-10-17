"""Territory: the ground every outdoor loop run has claimed, and how it grew.

`analysis.territory` decides what a loop is, what ground it encloses and
how the union is accumulated, derived in `docs/reference/math/territory.md`.
This router computes none of it. The areas are stored columns, the total
and the counts are aggregates DuckDB evaluates over the stored tables, and
each part's outline is the GeoJSON text `recompute` wrote, parsed and served
as it is.
"""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import TypeAdapter

from activity_analysis.analysis.territory import CLOSURE_MAX_M, SLIVER_RADIUS_M
from activity_analysis.api import queries
from activity_analysis.api.deps import CursorDep
from activity_analysis.api.models import (
    Territory,
    TerritoryCounts,
    TerritoryFeature,
    TerritoryFeatureCollection,
    TerritoryGeometry,
    TerritoryGrowthPoint,
    TerritoryPartProperties,
    TerritoryRegion,
)

router = APIRouter(tags=["territory"])

#: Parses a stored outline into whichever GeoJSON geometry its ``type`` names.
_GEOMETRY: TypeAdapter[TerritoryGeometry] = TypeAdapter(TerritoryGeometry)


@router.get("/api/territory")
def territory(cur: CursorDep) -> Territory:
    """The claimed ground as GeoJSON, its regions, its total and its growth series."""
    total, counts = queries.territory_summary(cur)
    features = [
        TerritoryFeature(
            type="Feature",
            properties=TerritoryPartProperties(
                region_id=row["region_id"],
                part_index=row["part_index"],
                area_m2=row["area_m2"],
            ),
            geometry=_GEOMETRY.validate_json(row["geometry_geojson"]),
        )
        for row in queries.territory_parts(cur)
    ]
    return Territory(
        total_area_m2=total,
        closure_max_m=CLOSURE_MAX_M,
        sliver_radius_m=SLIVER_RADIUS_M,
        counts=TerritoryCounts(**counts),
        regions=[TerritoryRegion(**row) for row in queries.territory_regions(cur)],
        territory=TerritoryFeatureCollection(type="FeatureCollection", features=features),
        growth=[TerritoryGrowthPoint(**row) for row in queries.territory_growth(cur)],
    )
