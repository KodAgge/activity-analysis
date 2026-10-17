"""Store state, so that an empty screen can be diagnosed from the frontend."""

from __future__ import annotations

from fastapi import APIRouter

from activity_analysis.api import queries
from activity_analysis.api.deps import CursorDep, PathsDep
from activity_analysis.api.models import Health
from activity_analysis.config import ANALYSIS_VERSION, INGEST_VERSION

router = APIRouter(tags=["health"])


@router.get("/api/health")
def health(cur: CursorDep, paths: PathsDep) -> Health:
    """The ``info`` command's answer over HTTP.

    Reporting the stored versions beside the constants the running code was
    built with makes a store one version behind visible as a version
    mismatch, which is what it is, rather than as a metric that quietly
    stopped moving.
    """
    counts = queries.store_counts(cur)
    stored_ingest, stored_analysis = queries.stored_versions(cur)
    stale = any(v != INGEST_VERSION for v in stored_ingest) or any(
        v != ANALYSIS_VERSION for v in stored_analysis
    )
    return Health(
        root=str(paths.root),
        canonical=str(paths.canonical),
        derived=str(paths.derived),
        counts=counts,
        expected_ingest_version=INGEST_VERSION,
        expected_analysis_version=ANALYSIS_VERSION,
        stored_ingest_versions=stored_ingest,
        stored_analysis_versions=stored_analysis,
        stale=stale,
    )
