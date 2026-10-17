"""How a long pass reports how far it has got.

Unpacking, ingesting and recomputing take a ``Progress`` and route their
loops through it, so they never print. The CLI hands them one that draws a
bar on the terminal; every other caller, the tests among them, gets
``SILENT``.
"""

from __future__ import annotations

from collections.abc import Iterator, Sequence


class Progress:
    """Reports nothing. Subclassed by the CLI to draw a bar."""

    def track[T](self, items: Sequence[T], label: str) -> Iterator[T]:
        """Yield ``items`` in order, reporting each one as it is taken."""
        yield from items

    def stage(self, label: str) -> None:
        """Report the start of a step that has no items to count."""


SILENT = Progress()
