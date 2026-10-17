"""Read FIT and gzipped FIT files into a ParsedActivity."""

from __future__ import annotations

import gzip
import io
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import fitdecode

from activity_analysis.ingest.parsed import ParsedActivity


@contextmanager
def _open_maybe_gzipped(path: Path) -> Iterator[io.BufferedIOBase]:
    """Yield a binary stream, transparently decompressing ``.gz``.

    fitdecode cannot open a gzipped path itself; handed one it raises
    FitHeaderError("not a FIT file @ 0"). It accepts a file object, so the
    decompression happens here.
    """
    if path.suffix.lower() == ".gz":
        with gzip.open(path, "rb") as handle:
            yield handle
    else:
        with path.open("rb") as handle:
            yield handle


def field_values(fields: Iterable[Any]) -> dict[str, Any]:
    """One message's fields by name, where a duplicated name keeps its value.

    A Garmin-original FIT carries some fields twice in one message: the field
    itself, then a copy fitdecode expands from the legacy field that names it
    as a component. Garmin leaves the legacy ``avg_speed`` and ``max_speed``
    invalid, so the expanded ``enhanced_avg_speed`` and ``enhanced_max_speed``
    copies come second, carry no field definition and hold None. Read
    last-wins, that None erased the value: measured on 2026-10-16, every lap
    and session of all 60 sampled Garmin running files lost both speeds, and
    the 2026-10-04 export's runs stored 2734 laps with no speed at all.

    So a later copy fills a name only while it is still empty, and an empty
    copy never replaces a value. Two copies that both hold a value keep the
    first, the field read before its expansion.
    """
    values: dict[str, Any] = {}
    for f in fields:
        if values.get(f.name) is None:
            values[f.name] = f.value
    return values


def read_fit(path: Path) -> ParsedActivity:
    """Parse one FIT file. Field names and units are left as the format had them."""
    parsed = ParsedActivity(source_format="fit")
    with _open_maybe_gzipped(path) as handle, fitdecode.FitReader(handle) as reader:
        for frame in reader:
            if not isinstance(frame, fitdecode.FitDataMessage):
                continue
            data = field_values(frame.fields)
            if frame.name == "record":
                parsed.records.append(data)
            elif frame.name == "lap":
                parsed.laps.append(data)
            elif frame.name == "session":
                parsed.session = data
            elif frame.name == "activity":
                parsed.activity_message = data
            elif frame.name == "file_id":
                parsed.device.update(data)
                # file_id comes first and names what the file is. A Garmin
                # export holds over ten monitoring and sleep files for every
                # activity, and decoding them in full was most of the run.
                # A file with no file_id at all is still read.
                if data.get("type") != "activity":
                    break
            elif frame.name == "sport" and parsed.name is None:
                parsed.name = data.get("name")
            elif frame.name == "user_profile" and parsed.profile is None:
                parsed.profile = data
            elif frame.name == "zones_target":
                parsed.zones = {**(parsed.zones or {}), **data}
            elif frame.name == "time_in_zone":
                # A file holds one of these per lap, one per split and one per
                # session. The lap and session copies carry the boundaries; the
                # split copy carries a tuple of nulls, which is not a setting.
                raw = data.get("hr_zone_high_boundary") or ()
                if raw and all(v is not None for v in raw):
                    parsed.zones = {
                        **(parsed.zones or {}),
                        "hr_zone_high_boundary": [float(v) for v in raw],
                    }
    return parsed
