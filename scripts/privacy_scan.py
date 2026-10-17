"""Scan the repository for personal data before it reaches the remote.

    uv run python scripts/privacy_scan.py                 # tracked and untracked files
    uv run python scripts/privacy_scan.py --history       # plus every blob, author and message
    uv run python scripts/privacy_scan.py dist/*.whl docs # given files, directories or archives

Each hit prints as `path:line: [rule] excerpt`, and any hit exits 1.
`--history` reads every blob any ref reaches the way it reads a file, so a
binary a later commit replaced still gets its position checks, and names a
hit in one as `blob!path`, the blob and the path it was committed at.

The patterns live in a denylist that is never committed, `privacy-denylist.txt`
at the repository root by default, because the list itself is the personal
data it guards against. Without one the scan refuses to run rather than pass.
One rule per line, `#` starts a comment:

    Some Name               a literal, case-sensitive, matched as a whole word
    re:\\bSome\\s+Name\\b     a Python regular expression
    near:12.34,56.78,25     a place: latitude, longitude and a radius in km
    skip:*.woff2            a glob of paths not to scan, for third-party binaries

A `near:` rule is checked three ways, because a position can be written in
any of them.
In text, every pair of decimal numbers on one line is read as degrees in both
orders, which covers `lat, lon`, a box's corners and GeoJSON's `[lon, lat]`.
Every run of four decimals is read as a box, `west,south,east,north` or
`south,west,north,east`, and flagged when it holds a place's centre.
Every pair of 7 to 10 digit integers on one line is read the same way as FIT
semicircles and as PMTiles' degrees times 10^7.
In a FIT file, every pair of 4-byte fields in one message is read as
semicircles, the definitions telling where each field starts, so a message
the decoder has no name for is checked too.
In a PMTiles file, the header's bounds and centre are read as 10^7 degrees,
the bounds also as a box, and its metadata as text.
In a PNG or JPEG image only the metadata is read, as text, and an EXIF GPS
block is flagged: the pixels are compressed, and what they show is checked by
eye.
In any other binary file, every pair of adjacent little-endian int32s at any
byte offset is read as semicircles and as 10^7 degrees.

A file is binary when its first 8 KiB holds a NUL byte; its literal and
regex rules are matched against the bytes read as Latin-1 and as UTF-8, so
a name with an a-ring or an o-umlaut is found in either encoding, and a hit
there reports a byte offset in place of a line.
"""

from __future__ import annotations

import argparse
import fnmatch
import gzip
import io
import itertools
import math
import re
import struct
import subprocess
import sys
import tarfile
import zipfile
import zlib
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DENYLIST = ROOT / "privacy-denylist.txt"
EARTH_RADIUS_KM = 6371.0088
SEMICIRCLE_DEG = 180 / 2**31
E7_DEG = 1e-7
EXCERPT = 60

DECIMAL = re.compile(r"(?<![\d.])-?\d{1,3}\.\d+(?![\d.])")
INTEGER = re.compile(r"(?<![\d.])-?\d{7,10}(?![\d.])")
WORD = re.compile(r"\w+")
PAIR_REACH = 3
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
JPEG_MAGIC = b"\xff\xd8\xff"
BOX_SPAN = 5.0


@dataclass(frozen=True)
class Place:
    lat: float
    lon: float
    radius_km: float
    label: str


class PlaceIndex:
    """Places bucketed by the 0.1 degree cells they touch, so a check costs one lookup."""

    CELL = 10  # cells per degree

    def __init__(self, places: list[Place]) -> None:
        self.places = places
        self.cells: dict[int, list[Place]] = {}
        for place in places:
            dlat = place.radius_km / 111.0
            dlon = dlat / max(math.cos(math.radians(place.lat)), 1e-6)
            for i in range(_cell(place.lat - dlat), _cell(place.lat + dlat) + 1):
                for j in range(_cell(place.lon - dlon), _cell(place.lon + dlon) + 1):
                    self.cells.setdefault(_key(i, j), []).append(place)
        self.keys = np.array(sorted(self.cells), dtype=np.int64)

    def hits(self, lat: np.ndarray, lon: np.ndarray) -> Iterator[tuple[int, Place]]:
        """Each index whose (lat, lon) lies within a place, with the place."""
        if not self.places or not len(lat):
            return
        valid = (np.abs(lat) <= 90) & (np.abs(lon) <= 180)
        keys = _key(
            np.floor(np.where(valid, lat, 0) * self.CELL).astype(np.int64),
            np.floor(np.where(valid, lon, 0) * self.CELL).astype(np.int64),
        )
        for index in np.flatnonzero(valid & np.isin(keys, self.keys)):
            a, b = float(lat[index]), float(lon[index])
            for place in self.cells[int(keys[index])]:
                if _haversine_km(place.lat, place.lon, a, b) <= place.radius_km:
                    yield int(index), place
                    break

    def boxed(self, values: np.ndarray) -> Iterator[tuple[int, Place]]:
        """Each run of four numbers that, as a box, holds a place's centre.

        A box can surround a place with every corner outside its radius. Read
        as west, south, east, north and as south, west, north, east, and only
        when both sides are under BOX_SPAN degrees, so a few unrelated numbers
        are not read as a box around half the world.
        """
        for index in range(len(values) - 3):
            a, b, c, d = (float(v) for v in values[index : index + 4])
            for south, west, north, east in ((b, a, d, c), (a, b, c, d)):
                if not (0 < north - south < BOX_SPAN and 0 < east - west < BOX_SPAN):
                    continue
                inside = next(
                    (
                        place
                        for place in self.places
                        if south <= place.lat <= north and west <= place.lon <= east
                    ),
                    None,
                )
                if inside is not None:
                    yield index, inside
                    break


def _cell(degrees: float) -> int:
    return math.floor(degrees * PlaceIndex.CELL)


def _key(i: Any, j: Any) -> Any:
    return (i + 1000) * 10_000 + (j + 2000)


@dataclass
class Denylist:
    patterns: list[tuple[str, re.Pattern[str]]] = field(default_factory=list)
    words: set[str] = field(default_factory=set)
    places: PlaceIndex = field(default_factory=lambda: PlaceIndex([]))
    skips: list[str] = field(default_factory=list)

    def skipped(self, name: str) -> bool:
        member = name.rsplit("!", 1)[-1]
        return any(fnmatch.fnmatch(name, g) or fnmatch.fnmatch(member, g) for g in self.skips)

    @classmethod
    def read(cls, path: Path) -> Denylist:
        rules = cls()
        phrases: list[str] = []
        places: list[Place] = []
        for number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            label = f"rule {number}"
            if line.startswith("re:"):
                rules.patterns.append((label, re.compile(line[3:])))
            elif line.startswith("skip:"):
                rules.skips.append(line[5:])
            elif line.startswith("near:"):
                lat, lon, radius = (float(part) for part in line[5:].split(","))
                places.append(Place(lat, lon, radius, label))
            elif WORD.fullmatch(line):
                # Single words, a few thousand IDs among them, go in a set: an
                # alternation that long costs a regex pass per alternative.
                rules.words.add(line)
            else:
                phrases.append(line)
        if phrases:
            alternation = "|".join(_whole_word(p) for p in sorted(phrases, key=len, reverse=True))
            rules.patterns.append(("literal", re.compile(alternation)))
        rules.places = PlaceIndex(places)
        return rules

    def text_hits(self, text: str) -> Iterator[tuple[int, str, str]]:
        for number, line in enumerate(text.splitlines(), 1):
            for start, end, label in self._line_hits(line):
                yield number, label, _excerpt(line, start, end)

    def _rule_hits(self, text: str) -> Iterator[tuple[int, int, str]]:
        if self.words:
            for match in WORD.finditer(text):
                if match.group() in self.words:
                    yield match.start(), match.end(), "literal"
        for label, pattern in self.patterns:
            for match in pattern.finditer(text):
                yield match.start(), match.end(), label

    def _line_hits(self, line: str) -> Iterator[tuple[int, int, str]]:
        yield from self._rule_hits(line)
        for regex, scales in ((DECIMAL, (1.0,)), (INTEGER, (SEMICIRCLE_DEG, E7_DEG))):
            found = list(regex.finditer(line))
            if len(found) < 2:
                continue
            values = np.array([float(m.group()) for m in found])
            # Each number against the next few: lat and lon sit close together
            # whether written as a pair, a box or a GeoJSON coordinate.
            for gap in range(1, PAIR_REACH + 1):
                first, second = values[:-gap], values[gap:]
                for scale in scales:
                    for lat, lon in ((first, second), (second, first)):
                        for index, place in self.places.hits(lat * scale, lon * scale):
                            yield found[index].start(), found[index + gap].end(), place.label
            for scale in scales:
                for index, place in self.places.boxed(values * scale):
                    yield found[index].start(), found[index + 3].end(), place.label

    def binary_hits(self, data: bytes) -> Iterator[tuple[int, str, str]]:
        if data[:8] == PNG_MAGIC or data[:3] == JPEG_MAGIC:
            yield from self._image_hits(data)
            return
        # An ASCII name matches in both readings, so each byte offset reports once.
        seen: set[tuple[int, str]] = set()
        for codec in ("latin-1", "utf-8"):
            text = data.decode(codec, errors="surrogateescape")
            for start, end, label in self._rule_hits(text):
                offset = len(text[:start].encode(codec, errors="surrogateescape"))
                if (offset, label) not in seen:
                    seen.add((offset, label))
                    yield offset, label, repr(text[start:end])
        if len(data) < 8:
            return
        if data[:7] == b"PMTiles" and len(data) >= 127:
            yield from self._pmtiles_places(data)
            return
        if data[8:12] == b".FIT":
            try:
                yield from self._fit_places(data)
                return
            except (IndexError, KeyError, struct.error):
                pass  # Not a FIT file after all, or a damaged one: read it as bytes.
        for shift in range(4):
            usable = (len(data) - shift) // 4 * 4
            words = np.frombuffer(data[shift : shift + usable], dtype="<i4").astype(np.float64)
            first, second = words[:-1], words[1:]
            for scale in (SEMICIRCLE_DEG, E7_DEG):
                for lat, lon in ((first, second), (second, first)):
                    for index, place in self.places.hits(lat * scale, lon * scale):
                        what = f"{lat[index] * scale:.5f}, {lon[index] * scale:.5f}"
                        yield shift + 4 * index, place.label, what

    def _image_hits(self, data: bytes) -> Iterator[tuple[int, str, str]]:
        """An image's metadata, read as text, and any GPS block in its EXIF.

        Its pixels are compressed, so every rule would match them by chance,
        and what they show is checked by eye; the metadata is where a
        position or a name hides.
        """
        for offset, kind, payload in _image_metadata(data):
            if kind == "exif" and _exif_has_gps(payload):
                yield offset, "exif", "EXIF carries a GPS block"
            text = payload.decode("utf-8", errors="replace")
            for line, label, what in self.text_hits(text):
                yield offset, label, f"{kind} line {line}: {what}"

    def _fit_places(self, data: bytes) -> Iterator[tuple[int, str, str]]:
        for offset, values in _fit_messages(data):
            if len(values) < 2:
                continue
            first, second = np.meshgrid(values, values, indexing="ij")
            pairs = first != second
            lat, lon = first[pairs] * SEMICIRCLE_DEG, second[pairs] * SEMICIRCLE_DEG
            for index, place in self.places.hits(lat, lon):
                yield offset, place.label, f"{lat[index]:.5f}, {lon[index]:.5f}"

    def _pmtiles_places(self, data: bytes) -> Iterator[tuple[int, str, str]]:
        """The header's bounds and centre, and the metadata JSON, which is text.

        The tiles themselves hold tile-local integers, not positions.
        """
        min_lon, min_lat, max_lon, max_lat = struct.unpack_from("<4i", data, 102)
        center_lon, center_lat = struct.unpack_from("<2i", data, 119)
        corners = [(min_lat, min_lon), (max_lat, max_lon), (min_lat, max_lon), (max_lat, min_lon)]
        for lat_e7, lon_e7 in [*corners, (center_lat, center_lon)]:
            lat, lon = np.array([lat_e7 * E7_DEG]), np.array([lon_e7 * E7_DEG])
            for _, place in self.places.hits(lat, lon):
                yield 102, place.label, f"{lat[0]:.5f}, {lon[0]:.5f}"
        bounds = np.array([min_lon, min_lat, max_lon, max_lat]) * E7_DEG
        for _, place in self.places.boxed(bounds):
            yield 102, place.label, "bounds " + ", ".join(f"{v:.5f}" for v in bounds)
        offset, length = struct.unpack_from("<2Q", data, 24)
        metadata = data[offset : offset + length]
        if data[97] == 2:
            metadata = gzip.decompress(metadata)
        for line, label, what in self.text_hits(metadata.decode("utf-8", errors="replace")):
            yield offset, label, f"metadata line {line}: {what}"


def _image_metadata(data: bytes) -> Iterator[tuple[int, str, bytes]]:
    """Each metadata block of a PNG or JPEG: its offset, kind and bytes.

    PNG text chunks (`tEXt`, and `zTXt` and `iTXt` decompressed where they
    are compressed) and `eXIf`; JPEG APP segments (EXIF, XMP and the rest)
    and comments.
    """
    if data[:8] == PNG_MAGIC:
        pos = 8
        while pos + 8 <= len(data):
            (length,) = struct.unpack_from(">I", data, pos)
            kind = data[pos + 4 : pos + 8].decode("latin-1")
            body = data[pos + 8 : pos + 8 + length]
            if kind == "zTXt":
                keyword, _, rest = body.partition(b"\0")
                body = keyword + b"\0" + zlib.decompress(rest[1:])
            elif kind == "iTXt":
                keyword, _, rest = body.partition(b"\0")
                compressed = rest[:1] == b"\1"
                language, _, rest = rest[2:].partition(b"\0")
                translated, _, text = rest.partition(b"\0")
                if compressed:
                    body = b"\0".join([keyword, language, translated, zlib.decompress(text)])
            if kind in {"tEXt", "zTXt", "iTXt"}:
                yield pos, kind, body
            elif kind == "eXIf":
                yield pos, "exif", body
            pos += 12 + length
        return
    pos = 2
    while pos + 4 <= len(data) and data[pos] == 0xFF:
        marker = data[pos + 1]
        if marker == 0xDA:  # start of scan: compressed pixels follow
            return
        (length,) = struct.unpack_from(">H", data, pos + 2)
        body = data[pos + 4 : pos + 2 + length]
        if 0xE0 <= marker <= 0xEF or marker == 0xFE:
            yield pos, "exif" if body.startswith(b"Exif\0\0") else f"app{marker - 0xE0}", body
        pos += 2 + length


def _exif_has_gps(block: bytes) -> bool:
    """Whether an EXIF block's first IFD points at a GPS IFD, tag 0x8825."""
    tiff = block[6:] if block.startswith(b"Exif\0\0") else block
    if len(tiff) < 8 or tiff[:2] not in (b"II", b"MM"):
        return False
    endian = "<" if tiff[:2] == b"II" else ">"
    (first,) = struct.unpack_from(endian + "I", tiff, 4)
    if first + 2 > len(tiff):
        return False
    (count,) = struct.unpack_from(endian + "H", tiff, first)
    for index in range(count):
        entry = first + 2 + 12 * index
        if entry + 2 <= len(tiff) and struct.unpack_from(endian + "H", tiff, entry)[0] == 0x8825:
            return True
    return False


def _fit_messages(data: bytes) -> Iterator[tuple[int, np.ndarray]]:
    """Each data message's offset and its 4-byte fields read as signed int32.

    Walks the record headers the way a decoder does, including compressed
    timestamp headers, developer fields and files chained one after another.
    """
    start = 0
    while start + 12 <= len(data) and data[start + 8 : start + 12] == b".FIT":
        header_size = data[start]
        (body_size,) = struct.unpack_from("<I", data, start + 4)
        pos, end = start + header_size, start + header_size + body_size
        layouts: dict[int, tuple[str, list[tuple[int, int]], int]] = {}
        while pos < end:
            header = data[pos]
            if header & 0x80:
                local, pos = (header >> 5) & 0x03, pos + 1
            elif header & 0x40:
                endian = ">" if data[pos + 2] else "<"
                count = data[pos + 5]
                fields = [(data[pos + 7 + 3 * i], 0) for i in range(count)]
                pos += 6 + 3 * count
                developer = 0
                if header & 0x20:
                    dev_count = data[pos]
                    developer = sum(data[pos + 2 + 3 * i] for i in range(dev_count))
                    pos += 1 + 3 * dev_count
                layouts[header & 0x0F] = (endian, fields, developer)
                continue
            else:
                local, pos = header & 0x0F, pos + 1
            endian, fields, developer = layouts[local]
            offset, values = pos, []
            for size, _ in fields:
                if size == 4:
                    values.append(struct.unpack_from(endian + "i", data, pos)[0])
                pos += size
            pos += developer
            yield offset, np.array(values, dtype=np.float64)
        start = end + 2


def _whole_word(word: str) -> str:
    escaped = re.escape(word)
    if word[:1].isalnum() or word[:1] == "_":
        escaped = r"(?<![\w])" + escaped
    if word[-1:].isalnum() or word[-1:] == "_":
        escaped += r"(?![\w])"
    return escaped


def _excerpt(line: str, start: int, end: int) -> str:
    lo = max(0, start - EXCERPT // 2)
    hi = min(len(line), end + EXCERPT // 2)
    return ("..." if lo else "") + line[lo:hi].strip() + ("..." if hi < len(line) else "")


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = (
        math.sin((p2 - p1) / 2) ** 2
        + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    )
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(a))


def _is_binary(data: bytes) -> bool:
    return b"\0" in data[:8192]


def scan_bytes(name: str, data: bytes, rules: Denylist) -> list[str]:
    if data[:2] == b"\x1f\x8b":
        # A gzipped file hides everything inside it, so scan what it holds.
        data = gzip.decompress(data)
    if _is_binary(data):
        hits = rules.binary_hits(data)
        return [f"{name}@{offset}: [{label}] {what}" for offset, label, what in hits]
    return scan_text(name, data.decode("utf-8", errors="replace"), rules)


def scan_text(name: str, text: str, rules: Denylist) -> list[str]:
    return [f"{name}:{line}: [{label}] {what}" for line, label, what in rules.text_hits(text)]


def _members(name: str, data: bytes) -> Iterator[tuple[str, bytes]]:
    """The file, or each member of an archive, since compression hides what one holds."""
    archive_suffix = Path(name).suffix in {".whl", ".zip", ".gz", ".tgz", ".tar"}
    if archive_suffix and zipfile.is_zipfile(io.BytesIO(data)):
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            for info in archive.infolist():
                if not info.is_dir():
                    yield f"{name}!{info.filename}", archive.read(info)
    elif archive_suffix and tarfile.is_tarfile(io.BytesIO(data)):
        with tarfile.open(fileobj=io.BytesIO(data)) as archive:
            for member in archive.getmembers():
                extracted = archive.extractfile(member) if member.isfile() else None
                if extracted is not None:
                    yield f"{name}!{member.name}", extracted.read()
    else:
        yield name, data


def _given(paths: Iterable[Path]) -> Iterator[tuple[str, bytes]]:
    for path in paths:
        files = sorted(p for p in path.rglob("*") if p.is_file()) if path.is_dir() else [path]
        for file in files:
            # Named relative to the repository when inside it, so `skip:` globs
            # anchored on a repository path hold however the path was given.
            resolved = file.resolve()
            name = resolved.relative_to(ROOT) if resolved.is_relative_to(ROOT) else file
            yield from _members(str(name), file.read_bytes())


def _git(*args: str, stdin: bytes = b"") -> bytes:
    command = ["git", "-C", str(ROOT), *args]
    return subprocess.run(command, input=stdin, check=True, capture_output=True).stdout


def _work_tree() -> Iterator[tuple[str, bytes]]:
    listed = _git("ls-files", "-z", "--cached", "--others", "--exclude-standard")
    for name in sorted(set(listed.decode().split("\0")) - {""}):
        path = ROOT / name
        if path.is_file():
            yield from _members(name, path.read_bytes())


def _history_blobs() -> Iterator[tuple[str, bytes]]:
    """Every blob reachable from any ref, once, under the first path it was seen at."""
    listed = _git("rev-list", "--all", "--objects", "--filter=object:type=blob")
    blobs = [line.split(" ", 1) for line in listed.decode().splitlines() if " " in line]
    batch = _git("cat-file", "--batch", stdin="".join(f"{sha}\n" for sha, _ in blobs).encode())
    pos = 0
    for sha, path in blobs:
        header_end = batch.index(b"\n", pos)
        size = int(batch[pos:header_end].rsplit(b" ", 1)[1])
        pos = header_end + 1 + size + 1
        yield from _members(f"{sha[:12]}!{path}", batch[header_end + 1 : pos - 1])


def _history_log() -> Iterator[tuple[str, bytes]]:
    people = _git("log", "--all", "--format=%H %an <%ae> %cn <%ce>")
    yield "git log (authors)", people
    yield "git log (messages)", _git("log", "--all", "--format=commit %H%n%B")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("paths", nargs="*", type=Path, help="files, directories or archives")
    parser.add_argument("--denylist", type=Path, default=DEFAULT_DENYLIST)
    parser.add_argument("--history", action="store_true", help="also scan every commit's blobs")
    args = parser.parse_args(argv)

    if not args.denylist.is_file():
        print(f"no denylist at {args.denylist}; refusing to report a clean scan", file=sys.stderr)
        return 2
    rules = Denylist.read(args.denylist)

    sources: Iterable[tuple[str, bytes]] = _given(args.paths) if args.paths else _work_tree()
    if args.history:
        sources = itertools.chain(sources, _history_blobs())
    hits: list[str] = []
    scanned = 0
    for name, data in sources:
        if rules.skipped(name):
            continue
        scanned += 1
        hits.extend(scan_bytes(name, data, rules))
    if args.history:
        for name, data in _history_log():
            hits.extend(scan_text(name, data.decode("utf-8", errors="replace"), rules))

    for hit in hits:
        print(hit)
    print(f"{len(hits)} hits in {scanned} files", file=sys.stderr)
    return 1 if hits else 0


if __name__ == "__main__":
    sys.exit(main())
