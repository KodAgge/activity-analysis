"""Unpack an export, and tell a Strava export from a Garmin Connect one.

The kind decides the source each FIT file is labelled with, and through that
which copy of a run survives deduplication. Getting it wrong is silent: a
Garmin export labelled Strava ranks equal to the Strava copies already stored,
so not one of its files displaces them.
"""

from __future__ import annotations

import zipfile
import zlib
from pathlib import Path, PurePosixPath

from activity_analysis.progress import SILENT, Progress

STRAVA = "strava"
GARMIN = "garmin"

#: Where a Garmin Connect export keeps the original activity files, in zips
#: that the export's own zip does not unpack. Garmin's export FAQ names both
#: directories, read 2026-10-16; an account's export may hold either.
GARMIN_UPLOADS = (
    Path("DI_CONNECT") / "DI-Connect-Uploaded-Files",
    Path("DI_CONNECT") / "DI-Connect-Fitness-Uploaded-Files",
)


class UnsafeArchiveError(ValueError):
    """A zip member whose path would be written outside the directory it is unpacked into."""


#: What unpacking a zip raises for an archive or a disk it cannot cope with:
#: not a zip, a member that would escape, a full disk or an unwritable
#: directory, a corrupt member, an unsupported method such as Deflate64, and
#: an encrypted member.
UNPACK_ERRORS: tuple[type[Exception], ...] = (
    zipfile.BadZipFile,
    UnsafeArchiveError,
    OSError,
    zlib.error,
    EOFError,
    NotImplementedError,
    RuntimeError,
)


def _extract(archive: zipfile.ZipFile, into: Path, progress: Progress, label: str) -> None:
    """Unpack ``archive`` into ``into``, refusing it whole if any member would escape.

    Every member is checked before anything is written, so a refused archive
    leaves nothing behind. ``zipfile`` already drops ``..`` and leading slashes
    as it extracts, but silently, writing the file somewhere it was not named;
    an archive that tries this is not an export, so it is refused instead.
    """
    base = into.resolve()
    for name in archive.namelist():
        if not (base / name).resolve().is_relative_to(base):
            raise UnsafeArchiveError(f"{name} would be unpacked outside {into}")
    into.mkdir(parents=True, exist_ok=True)
    for member in progress.track(archive.infolist(), label):
        archive.extract(member, into)


def extract_export(zipped: Path, into: Path, progress: Progress = SILENT) -> Path:
    """Unpack an export's zip into ``into`` and return the directory the export is in.

    That is ``into`` itself for the zips Strava and Garmin send, which keep
    their layout at the top. A zip holding a single folder, which is what
    zipping an unpacked export again produces, has its export one level down.
    Unpacking again over an earlier unpack overwrites it with the same files,
    and the ingest ledger's content hashes make those a no-op.
    """
    with zipfile.ZipFile(zipped) as archive:
        _extract(archive, into, progress, "unpacking the export")
    if detect_archive_kind(into) is None:
        entries = [entry for entry in into.iterdir() if entry.name != "__MACOSX"]
        if len(entries) == 1 and entries[0].is_dir():
            return entries[0]
    return into


def detect_archive_kind(root: Path) -> str | None:
    """``strava`` or ``garmin`` from the export's layout, or None if it is neither.

    A Strava export has its activity index, ``activities.csv``, at the top.
    A Garmin export has ``DI_CONNECT``, the Garmin Connect half of the dump.
    """
    if (root / "activities.csv").is_file():
        return STRAVA
    if (root / "DI_CONNECT").is_dir():
        return GARMIN
    return None


def packed_garmin_uploads(root: Path) -> list[Path]:
    """The upload zips of a Garmin export that hold activities not yet unpacked.

    Unpacking the export leaves these zipped, so ingesting it then misses every
    activity inside them. A zip counts as unpacked once each FIT file it lists
    sits somewhere under its uploads directory, matched by file name, however
    it was unpacked. A zip that cannot be read is reported too, since its
    activities were not read either.
    """
    packed = []
    for directory in GARMIN_UPLOADS:
        if (root / directory).is_dir():
            packed.extend(_packed_in(root / directory))
    return packed


def _packed_in(uploads: Path) -> list[Path]:
    unpacked = {
        path.name for path in uploads.rglob("*") if path.is_file() and path.suffix.lower() == ".fit"
    }
    packed = []
    for zipped in sorted(uploads.glob("*.zip")):
        try:
            with zipfile.ZipFile(zipped) as archive:
                members = archive.namelist()
        except zipfile.BadZipFile:
            packed.append(zipped)
            continue
        fit_names = {
            PurePosixPath(member).name
            for member in members
            if PurePosixPath(member).suffix.lower() == ".fit"
        }
        if not fit_names <= unpacked:
            packed.append(zipped)
    return packed


def unpack_garmin_uploads(
    root: Path, progress: Progress = SILENT
) -> tuple[list[Path], list[tuple[Path, str]]]:
    """Unpack each upload zip :func:`packed_garmin_uploads` finds, beside itself.

    ``UploadedFiles_0-_Part1.zip`` is unpacked into ``UploadedFiles_0-_Part1/``,
    which is where unpacking it by hand puts it, so a zip unpacked either way
    is found unpacked next time and never unpacked twice. Returns the zips
    unpacked, and the ones that could not be read with the reason.
    """
    unpacked: list[Path] = []
    errors: list[tuple[Path, str]] = []
    for zipped in packed_garmin_uploads(root):
        try:
            with zipfile.ZipFile(zipped) as archive:
                _extract(archive, zipped.with_suffix(""), progress, f"unpacking {zipped.name}")
        except UNPACK_ERRORS as exc:
            errors.append((zipped, str(exc)))
            continue
        unpacked.append(zipped)
    return unpacked, errors
