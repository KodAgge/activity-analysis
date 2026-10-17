"""Build the frontend into the package, so an installed wheel needs no Node.

Hatchling loads this as the project's custom build hook. In a checkout it runs
``npm ci`` and ``npm run build`` in ``web/``. The sdist carries the result in
``web/dist`` and none of the frontend's sources, so a wheel built from the
sdist, which is how ``uv build`` builds one, uses that build instead of
needing Node a second time. The wheel puts it at ``activity_analysis/web``,
where ``api/frontend.py`` looks first.

An editable install, which is what ``uv sync`` makes of a checkout, is left
alone: it runs from the checkout, where ``serve`` finds ``web/dist`` itself.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Any

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class FrontendBuildHook(BuildHookInterface):
    PLUGIN_NAME = "custom"

    def initialize(self, version: str, build_data: dict[str, Any]) -> None:
        if self.target_name == "wheel" and version == "editable":
            return
        web = Path(self.root) / "web"
        dist = web / "dist"
        if (web / "package.json").is_file():
            npm = shutil.which("npm")
            if npm is None:
                raise RuntimeError(
                    "building the package builds the frontend, which needs npm on PATH"
                )
            self.app.display_info("building the frontend in web/")
            subprocess.run([npm, "ci"], cwd=web, check=True)
            subprocess.run([npm, "run", "build"], cwd=web, check=True)
        if not (dist / "index.html").is_file():
            raise RuntimeError(f"no frontend build at {dist}, and no web/package.json to make one")
        target = "activity_analysis/web" if self.target_name == "wheel" else "web/dist"
        build_data["force_include"][str(dist)] = target
