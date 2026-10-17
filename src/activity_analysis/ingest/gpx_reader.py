"""Read GPX and gzipped GPX files into a ParsedActivity.

This is the degraded ingestion path. GPX carries no distance, no speed, no
laps and no athlete profile, so activities read this way are flagged and can
be excluded from trend analysis.
"""

from __future__ import annotations

import gzip
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path
from typing import Any

from activity_analysis.ingest.parsed import ParsedActivity

GPX_NS = "http://www.topografix.com/GPX/1/1"
TPX_NS = "http://www.garmin.com/xmlschemas/TrackPointExtension/v1"
_NS = {"g": GPX_NS, "tpx": TPX_NS}


def _read_bytes(path: Path) -> bytes:
    if path.suffix.lower() == ".gz":
        with gzip.open(path, "rb") as handle:
            return handle.read()
    return path.read_bytes()


def _parse_time(text: str) -> datetime:
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


def _extension_value(point: ET.Element, tag: str) -> int | None:
    node = point.find(f"g:extensions/tpx:TrackPointExtension/tpx:{tag}", _NS)
    if node is None or node.text is None:
        return None
    return int(node.text)


def _float_or_none(point: ET.Element, tag: str) -> float | None:
    node = point.find(f"g:{tag}", _NS)
    if node is None or node.text is None:
        return None
    return float(node.text)


def read_gpx(path: Path) -> ParsedActivity:
    """Parse one GPX file into the reader-agnostic intermediate."""
    root = ET.fromstring(_read_bytes(path))
    parsed = ParsedActivity(source_format="gpx")

    name_node = root.find("g:trk/g:name", _NS)
    if name_node is not None:
        parsed.name = name_node.text

    for point in root.iterfind(".//g:trkpt", _NS):
        time_node = point.find("g:time", _NS)
        if time_node is None or time_node.text is None:
            continue
        record: dict[str, Any] = {
            "timestamp": _parse_time(time_node.text),
            "lat_deg": float(point.attrib["lat"]),
            "lon_deg": float(point.attrib["lon"]),
            "altitude_m": _float_or_none(point, "ele"),
            "heart_rate": _extension_value(point, "hr"),
            # Garmin GPX records cadence in single-foot rpm, as FIT does.
            "cadence": _extension_value(point, "cad"),
        }
        parsed.records.append(record)

    return parsed
