"""Serving the built frontend from the API process.

With the build mounted, ``serve`` is the whole application on one port, which
is what an installed package needs: no Node and no second server. Vite's dev
server is still how the frontend is developed; it proxies ``/api`` to this
process and never reaches the mount.
"""

from __future__ import annotations

from pathlib import Path, PurePath

from starlette.exceptions import HTTPException
from starlette.responses import FileResponse, Response
from starlette.staticfiles import StaticFiles
from starlette.types import Scope

#: Where the wheel's build hook puts ``web/dist``; see ``hatch_build.py``.
PACKAGED_BUILD = Path(__file__).resolve().parents[1] / "web"

#: ``web/dist`` in a source checkout, which an editable install runs from.
CHECKOUT_BUILD = Path(__file__).resolve().parents[3] / "web" / "dist"


def find_build() -> Path | None:
    """The built frontend this installation can serve, or None if there is none.

    The packaged build comes first, because in a wheel install the checkout
    path points somewhere arbitrary in the virtual environment's parents.
    """
    for candidate in (PACKAGED_BUILD, CHECKOUT_BUILD):
        if (candidate / "index.html").is_file():
            return candidate
    return None


#: Vite names every file under ``assets/`` by a hash of its content.
IMMUTABLE = "public, max-age=31536000, immutable"


class SinglePageApp(StaticFiles):
    """Static files, with ``index.html`` for any path that names a client route.

    TanStack Router resolves ``/activities/<id>`` and the other views in the
    browser, so a reload or a pasted link asks the server for a path no file
    has. A path with a suffix is a file and keeps its 404: a stale hashed asset
    answered with HTML would surface as a script parse error instead. So does
    anything under ``/api``, whose misses must stay JSON for the client; that
    is read from the request path, because ``path`` here has the platform's
    separators, ``api\\nope`` on Windows.

    ``index.html`` is sent ``no-cache``, so the browser revalidates it on every
    load. Without a directive it would be cached heuristically, from its
    modification time, and after an upgrade an old index names hashed assets
    the new build no longer has, which renders a blank page.
    """

    async def get_response(self, path: str, scope: Scope) -> Response:
        try:
            response = await super().get_response(path, scope)
        except HTTPException as exc:
            under_api = scope["path"].lstrip("/").split("/", 1)[0] == "api"
            if exc.status_code != 404 or PurePath(path).suffix or under_api:
                raise
            response = await super().get_response("index.html", scope)
        if isinstance(response, FileResponse):
            served = PurePath(str(response.path))
            if served.name == "index.html":
                response.headers["Cache-Control"] = "no-cache"
            elif served.parent.name == "assets":
                response.headers["Cache-Control"] = IMMUTABLE
        return response
