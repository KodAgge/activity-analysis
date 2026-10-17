"""The reader-agnostic intermediate between a source file and the canonical model."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class ParsedActivity:
    """Raw content of one activity file.

    Field names and units are whatever the source format used. Conversion to
    the canonical SI model happens in ``normalize``, exactly once.
    """

    source_format: str
    session: dict[str, Any] = field(default_factory=dict)
    #: FIT's ``activity`` message. Named for the message rather than for
    #: the dataclass, because it is the only place ``local_timestamp`` lives.
    activity_message: dict[str, Any] = field(default_factory=dict)
    records: list[dict[str, Any]] = field(default_factory=list)
    laps: list[dict[str, Any]] = field(default_factory=list)
    device: dict[str, Any] = field(default_factory=dict)
    profile: dict[str, Any] | None = None
    zones: dict[str, Any] | None = None
    name: str | None = None
