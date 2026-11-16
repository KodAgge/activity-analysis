"""Options every command shares, in a leaf module so command groups can import them."""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

import typer

from activity_analysis.config import Paths, default_paths

RootOption = Annotated[
    Path | None,
    typer.Option(
        "--root",
        help=(
            "Directory holding the data directory. Defaults to $ACTIVITY_ANALYSIS_HOME, "
            "then the platform's user data directory."
        ),
        show_default=False,
    ),
]


def paths_from(root: Path | None) -> Paths:
    return Paths(root=root) if root is not None else default_paths()
