"""Request-scoped access to the store."""

from __future__ import annotations

from collections.abc import Iterator
from typing import Annotated

import duckdb
from fastapi import Depends, Request

from activity_analysis.config import Paths


def get_cursor(request: Request) -> Iterator[duckdb.DuckDBPyConnection]:
    """A cursor over the one connection the application opened at startup.

    Cursors from a single connection share its catalog and run concurrently,
    which is what FastAPI's threadpool needs for synchronous endpoints.
    Reconnecting per request would instead rebuild every view over files that
    did not change, which costs far more than the queries behind these
    endpoints do, so most of every request would go on work whose answer had
    not changed. See "Connection model" in ``docs/reference/api.md`` for the
    measurements, and for the consequence: the store is held as it was at
    startup, so a recompute needs a restart.
    """
    cur = request.app.state.con.cursor()
    try:
        yield cur
    finally:
        cur.close()


def get_paths(request: Request) -> Paths:
    return request.app.state.paths  # type: ignore[no-any-return]


CursorDep = Annotated[duckdb.DuckDBPyConnection, Depends(get_cursor)]
PathsDep = Annotated[Paths, Depends(get_paths)]
