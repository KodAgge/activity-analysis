"""Find ingestible files in an unpacked export archive."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

#: Suffix to format, checked after stripping a trailing ".gz".
SUPPORTED_SUFFIXES = {".fit": "fit", ".gpx": "gpx"}

#: Activity formats that exports contain but no reader handles yet. A real
#: Strava export holds a couple of TCX runs, and a silent skip would lose
#: them, so they are counted and reported instead.
UNSUPPORTED_SUFFIXES = {".tcx"}

_CHUNK = 1024 * 1024


@dataclass(frozen=True)
class SourceFile:
    path: Path
    fmt: str


def sha256_file(path: Path) -> str:
    """SHA-256 of a file's bytes, read in chunks."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(_CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def _activity_suffix(path: Path) -> str | None:
    """The format suffix of an activity file, ignoring any ``.gz`` wrapper."""
    name = path.name
    # WSL writes Windows alternate data streams as sibling files.
    if ":Zone.Identifier" in name or name.startswith("."):
        return None
    stem = Path(name[:-3]) if name.lower().endswith(".gz") else Path(name)
    return stem.suffix.lower()


def _classify(path: Path) -> str | None:
    suffix = _activity_suffix(path)
    if suffix is None:
        return None
    return SUPPORTED_SUFFIXES.get(suffix)


def _files_under(root: Path) -> list[Path]:
    if not root.is_dir():
        return []
    return [path for path in sorted(root.rglob("*")) if path.is_file()]


def discover(root: Path) -> list[SourceFile]:
    """Every ingestible file under ``root``, sorted by path.

    Not hashed here: ingest hashes each file as it reaches it, so that the
    progress it reports covers the hashing. A Garmin export holds tens of
    thousands of FIT files, and on a re-run hashing them is all the work.
    """
    found: list[SourceFile] = []
    for path in _files_under(root):
        fmt = _classify(path)
        if fmt is not None:
            found.append(SourceFile(path=path, fmt=fmt))
    return found


def find_unsupported(root: Path) -> list[Path]:
    """Activity files under ``root`` in a format no reader handles yet."""
    return [path for path in _files_under(root) if _activity_suffix(path) in UNSUPPORTED_SUFFIXES]
