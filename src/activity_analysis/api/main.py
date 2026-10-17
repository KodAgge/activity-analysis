"""The FastAPI application.

Read-only, bound to localhost, one athlete. The API is a projection of the
store rather than a second analysis engine: every number it returns is read
from a Parquet column or produced by an aggregate DuckDB evaluates in the
query, so a metric fix is a ``recompute`` and never an API change.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import duckdb
from fastapi import FastAPI, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse

from activity_analysis.api.frontend import SinglePageApp
from activity_analysis.api.routers import (
    activities,
    basemap,
    distributions,
    fitness,
    health,
    overview,
    predictions,
    progression,
    records,
    routes,
    territory,
    trends,
)
from activity_analysis.config import Paths, default_paths
from activity_analysis.store.db import connect


def create_app(paths: Paths | None = None, frontend: Path | None = None) -> FastAPI:
    """An application serving the store at ``paths``, and the built frontend at ``frontend``.

    The connection is opened once, in the lifespan, and every request takes a
    cursor from it. The consequence is that the server holds the store as it
    was at startup, so a ``recompute`` while it runs is not picked up.

    The frontend is mounted last, at ``/``, so every API route and the docs
    match before it does.
    """
    resolved = paths if paths is not None else default_paths()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.paths = resolved
        app.state.con = connect(resolved)
        try:
            yield
        finally:
            app.state.con.close()

    app = FastAPI(
        title="activity-analysis",
        summary="Read-only access to the canonical and derived training store.",
        lifespan=lifespan,
    )
    # A grid is the one response large enough for this to matter: a full 1 Hz
    # run is megabytes of JSON that gzip reduces to a fraction of that, and
    # serving it at full resolution is only defensible at the compressed size,
    # so this is part of the decision not to downsample. The threshold keeps
    # the CPU off the small responses, where compression saves nothing.
    # Measured payload sizes are in docs/reference/api.md.
    app.add_middleware(GZipMiddleware, minimum_size=4096)

    app.include_router(health.router)
    app.include_router(activities.router)
    app.include_router(overview.router)
    app.include_router(records.router)
    app.include_router(trends.router)
    app.include_router(distributions.router)
    app.include_router(fitness.router)
    app.include_router(predictions.router)
    app.include_router(progression.router)
    app.include_router(routes.router)
    app.include_router(territory.router)
    app.include_router(basemap.router)

    @app.exception_handler(duckdb.Error)
    async def stale_store(request: Request, exc: Exception) -> JSONResponse:
        """A store the running code cannot read is a 503, not a 500.

        The API inherits the store's staleness policy rather than inventing
        one. ``store/db.py`` already decides, per view, whether a column
        missing from the stored Parquet reads as null or raises, and its
        message already names the ``ingest --force`` or ``recompute`` that
        fixes it. All this adds is a status code saying the server is fine and
        its data is not.
        """
        return JSONResponse(status_code=503, content={"detail": str(exc)})

    if frontend is not None:
        app.mount("/", SinglePageApp(directory=frontend, html=True), name="frontend")

    return app
