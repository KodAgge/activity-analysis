"""`scripts/privacy_scan.py`, run as its command line against a denylist written here.

The real denylist is never committed, so these use a stand-in: made-up names,
a pattern, and a place in the Arabian Sea at 12.34 N, 56.78 E.
"""

from __future__ import annotations

import gzip
import shutil
import struct
import subprocess
import sys
import zipfile
import zlib
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "privacy_scan.py"
SEMICIRCLES = 2**31 / 180

DENYLIST = """\
# a comment, then one rule of each kind
Quillfeather
re:\\bcase-[0-9]{3}\\b
near:12.34,56.78,5
skip:*.ignored
Quillfjäder
"""


def run(tmp_path: Path, *paths: Path) -> subprocess.CompletedProcess[str]:
    denylist = tmp_path / "denylist.txt"
    if not denylist.exists():
        denylist.write_text(DENYLIST, encoding="utf-8")
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--denylist", str(denylist), *map(str, paths)],
        capture_output=True,
        text=True,
        check=False,
    )


def write(tmp_path: Path, name: str, content: str | bytes) -> Path:
    path = tmp_path / name
    if isinstance(content, str):
        path.write_text(content, encoding="utf-8")
    else:
        path.write_bytes(content)
    return path


def fit_file(lat: float, lon: float) -> bytes:
    """A one-record FIT file: a definition for `record` fields 0 and 1, then the record."""
    definition = struct.pack("<BBBHB", 0x40, 0, 0, 20, 2) + bytes([0, 4, 0x85, 1, 4, 0x85])
    record = struct.pack("<Bii", 0x00, round(lat * SEMICIRCLES), round(lon * SEMICIRCLES))
    body = definition + record
    header = struct.pack("<BBHI4sH", 14, 0x10, 2132, len(body), b".FIT", 0)
    return header + body + b"\0\0"


def pmtiles_file(west: float, south: float, east: float, north: float) -> bytes:
    """A PMTiles v3 header with the given bounds and no metadata."""
    header = bytearray(127)
    header[:8] = b"PMTiles\x03"
    struct.pack_into("<2Q", header, 24, 127, 0)
    header[97] = 1
    bounds = (west, south, east, north)
    struct.pack_into("<4i", header, 102, *(round(v * 1e7) for v in bounds))
    struct.pack_into("<2i", header, 119, round((west + east) / 2e-7), round((south + north) / 2e-7))
    return bytes(header)


def test_a_clean_file_exits_zero(tmp_path: Path) -> None:
    clean = write(tmp_path, "clean.md", "Nothing here but 57.77, 14.18 and a quill.\n")
    result = run(tmp_path, clean)
    assert result.returncode == 0, result.stdout
    assert result.stdout == ""


def test_a_literal_is_reported_with_its_line_and_only_as_a_whole_word(tmp_path: Path) -> None:
    doc = write(tmp_path, "doc.md", "first\nRaised by Quillfeather.\nQuillfeathers are fine.\n")
    result = run(tmp_path, doc)
    assert result.returncode == 1
    assert result.stdout.splitlines() == [f"{doc}:2: [literal] Raised by Quillfeather."]


def test_a_regex_rule_matches(tmp_path: Path) -> None:
    doc = write(tmp_path, "doc.md", "see case-123, not case-12\n")
    result = run(tmp_path, doc)
    assert result.returncode == 1
    assert result.stdout.count("[rule 3]") == 1


@pytest.mark.parametrize(
    "line",
    [
        "start at 12.3401, 56.7799",  # lat, lon
        "bbox=56.70,12.33,56.85,12.40",  # a box's south-west corner
        '"coordinates": [56.781, 12.342]',  # GeoJSON lon, lat
        "position_lat == 147221250 and position_long == 677443200",  # semicircles
        "min_lat_e7 123400000 min_lon_e7 567800000",  # PMTiles 10^7 degrees
    ],
)
def test_a_position_near_a_place_is_found_however_it_is_written(tmp_path: Path, line: str) -> None:
    result = run(tmp_path, write(tmp_path, "data.ts", line + "\n"))
    assert result.returncode == 1
    assert "[rule 4]" in result.stdout


@pytest.mark.parametrize(
    "line",
    ["--bbox=56.0,12.0,57.5,12.7", "south 12.0 west 56.0 north 12.7 east 57.5"],
)
def test_a_box_around_a_place_is_found_with_every_corner_far_from_it(
    tmp_path: Path, line: str
) -> None:
    result = run(tmp_path, write(tmp_path, "data.ts", line + "\n"))
    assert result.returncode == 1
    assert "[rule 4]" in result.stdout


def test_four_numbers_spanning_more_than_a_region_are_not_a_box(tmp_path: Path) -> None:
    result = run(tmp_path, write(tmp_path, "data.ts", "0.0, 10.0, 20.0, 70.0\n"))
    assert result.returncode == 0, result.stdout


def test_a_position_outside_the_radius_is_not_reported(tmp_path: Path) -> None:
    # 0.1 degrees of latitude is 11 km, past the rule's 5 km.
    result = run(tmp_path, write(tmp_path, "data.ts", "12.44, 56.78\n"))
    assert result.returncode == 0, result.stdout


def test_a_fit_file_is_read_message_by_message(tmp_path: Path) -> None:
    near = run(tmp_path, write(tmp_path, "near.fit", fit_file(12.341, 56.779)))
    far = run(tmp_path, write(tmp_path, "far.fit", fit_file(57.77, 14.18)))
    assert near.returncode == 1
    assert "near.fit@" in near.stdout
    assert far.returncode == 0, far.stdout


def test_a_pmtiles_header_is_checked_for_its_bounds(tmp_path: Path) -> None:
    near = run(tmp_path, write(tmp_path, "near.pmtiles", pmtiles_file(56.7, 12.3, 56.9, 12.4)))
    far = run(tmp_path, write(tmp_path, "far.pmtiles", pmtiles_file(14.0, 57.7, 14.3, 57.85)))
    assert near.returncode == 1
    assert far.returncode == 0, far.stdout


def test_pmtiles_bounds_around_a_place_are_found_with_every_corner_far_from_it(
    tmp_path: Path,
) -> None:
    # The centre, 12.325 N 56.95 E, and every corner are over 10 km from the place.
    archive = write(tmp_path, "area.pmtiles", pmtiles_file(56.7, 12.2, 57.2, 12.45))
    result = run(tmp_path, archive)
    assert result.returncode == 1
    assert f"{archive}@102: [rule 4] bounds" in result.stdout


def test_a_binary_file_is_searched_as_latin_1_and_as_utf_8_once_per_offset(
    tmp_path: Path,
) -> None:
    name = "Quillfjäder".encode()
    data = b"\0\0Quillfeather\0" + name + b"\0\xff\xfe" + name + b"\0"
    binary = write(tmp_path, "names.bin", data)
    result = run(tmp_path, binary)
    assert result.returncode == 1
    offsets = [line.split(": ", 1)[0] for line in result.stdout.splitlines()]
    assert offsets == [f"{binary}@2", f"{binary}@15", f"{binary}@30"]


def test_gzipped_files_and_archive_members_are_scanned(tmp_path: Path) -> None:
    gzipped = write(tmp_path, "notes.txt.gz", gzip.compress(b"by Quillfeather\n"))
    archive = tmp_path / "bundle.whl"
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr("pkg/notes.txt", "Quillfeather again\n")
    result = run(tmp_path, gzipped, archive)
    assert result.returncode == 1
    assert f"{gzipped}:1:" in result.stdout
    assert f"{archive}!pkg/notes.txt:1:" in result.stdout


def test_an_archive_found_in_a_directory_is_opened(tmp_path: Path) -> None:
    dist = tmp_path / "dist"
    dist.mkdir()
    wheel = dist / "pkg-1.0-py3-none-any.whl"
    with zipfile.ZipFile(wheel, "w", zipfile.ZIP_DEFLATED) as bundle:
        bundle.writestr("pkg/notes.txt", "Quillfeather inside a wheel\n")
    result = run(tmp_path, dist)
    assert result.returncode == 1
    assert result.stdout.startswith(f"{wheel}!pkg/notes.txt:1: [literal]")


def test_history_scans_a_binary_blob_a_later_commit_replaced(tmp_path: Path) -> None:
    # The scan reads the repository it sits in, so a copy of it sits in a
    # throwaway one, ignored so its own docstring is not scanned.
    repo = tmp_path / "repo"
    (repo / "scripts").mkdir(parents=True)
    shutil.copy(SCRIPT, repo / "scripts" / "privacy_scan.py")
    (repo / ".gitignore").write_text("scripts/\n", encoding="utf-8")

    def git(*args: str) -> None:
        identity = ["-c", "user.name=Tester", "-c", "user.email=tester@example.com"]
        command = ["git", "-C", str(repo), *identity, "-c", "commit.gpgsign=false", *args]
        subprocess.run(command, check=True, capture_output=True)

    git("init", "-q")
    (repo / "track.fit").write_bytes(fit_file(12.341, 56.779))
    git("add", ".")
    git("commit", "-q", "-m", "add a track")
    (repo / "track.fit").write_bytes(fit_file(57.77, 14.18))
    git("commit", "-q", "-am", "move the track")

    denylist = tmp_path / "denylist.txt"
    denylist.write_text(DENYLIST, encoding="utf-8")
    script = repo / "scripts" / "privacy_scan.py"
    command = [sys.executable, str(script), "--denylist", str(denylist)]
    tree = subprocess.run(command, capture_output=True, text=True, check=False)
    history = subprocess.run([*command, "--history"], capture_output=True, text=True, check=False)
    assert tree.returncode == 0, tree.stdout
    assert history.returncode == 1
    assert [line.split("!", 1)[1].split(":", 1)[0] for line in history.stdout.splitlines()] == [
        "track.fit@27"
    ]


def test_a_skipped_path_is_not_scanned(tmp_path: Path) -> None:
    result = run(tmp_path, write(tmp_path, "vendor.ignored", "Quillfeather\n"))
    assert result.returncode == 0, result.stdout


def test_a_skip_anchored_on_a_repo_path_holds_however_the_directory_is_given(
    tmp_path: Path,
) -> None:
    # The scan names files in its own repository relative to it, so a copy of
    # it sits in a throwaway repository holding a skipped vendored file.
    repo = tmp_path / "repo"
    (repo / "scripts").mkdir(parents=True)
    shutil.copy(SCRIPT, repo / "scripts" / "privacy_scan.py")
    vendor = repo / "vendor" / "data"
    vendor.mkdir(parents=True)
    (vendor / "places.bin").write_text("Quillfeather\n", encoding="utf-8")
    denylist = write(tmp_path, "denylist.txt", DENYLIST + "skip:vendor/data/places.bin\n")
    script = repo / "scripts" / "privacy_scan.py"
    ways = ((vendor, tmp_path), (Path("vendor/data"), repo), (Path("data"), vendor.parent))
    for given, cwd in ways:
        result = subprocess.run(
            [sys.executable, str(script), "--denylist", str(denylist), str(given)],
            capture_output=True,
            text=True,
            check=False,
            cwd=cwd,
        )
        assert result.returncode == 0, (given, result.stdout)


def test_without_a_denylist_the_scan_refuses_rather_than_passes(tmp_path: Path) -> None:
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--denylist", str(tmp_path / "missing.txt"), str(SCRIPT)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 2
    assert "no denylist" in result.stderr


def png_file(*chunks: tuple[bytes, bytes]) -> bytes:
    """A PNG signature and the given chunks; the CRCs are not checked by the scan."""
    body = b"".join(
        struct.pack(">I", len(data)) + kind + data + b"\0\0\0\0" for kind, data in chunks
    )
    return b"\x89PNG\r\n\x1a\n" + body


def test_an_image_is_read_for_its_metadata_not_its_pixels(tmp_path: Path) -> None:
    # Pixel bytes that, read as int32 pairs, would sit on the synthetic place.
    pixels = struct.pack("<ii", round(12.341 * 1e7), round(56.779 * 1e7)) * 8
    clean = run(tmp_path, write(tmp_path, "pixels.png", png_file((b"IDAT", pixels))))
    named = run(
        tmp_path,
        write(tmp_path, "named.png", png_file((b"tEXt", b"Author\0Quillfeather"), (b"IDAT", b""))),
    )
    assert clean.returncode == 0, clean.stdout
    assert named.returncode == 1
    assert "tEXt" in named.stdout


@pytest.mark.parametrize("compressed", [False, True])
def test_international_png_text_is_read_whether_or_not_it_is_compressed(
    tmp_path: Path, compressed: bool
) -> None:
    text = "<x:xmpmeta>Quillfjäder</x:xmpmeta>".encode()
    flag = b"\1\0" if compressed else b"\0\0"
    body = b"XML:com.adobe.xmp\0" + flag + b"sv\0Upphovsman\0"
    body += zlib.compress(text) if compressed else text
    result = run(tmp_path, write(tmp_path, "xmp.png", png_file((b"iTXt", body), (b"IDAT", b""))))
    assert result.returncode == 1
    assert "iTXt" in result.stdout
    assert "Quillfjäder" in result.stdout


def test_a_jpeg_with_a_gps_block_in_its_exif_is_flagged(tmp_path: Path) -> None:
    # A little-endian TIFF whose first IFD holds one entry: the GPS IFD pointer.
    tiff = b"II*\0" + struct.pack("<I", 8) + struct.pack("<H", 1)
    tiff += struct.pack("<HHII", 0x8825, 4, 1, 26) + struct.pack("<I", 0)
    exif = b"Exif\0\0" + tiff
    app1 = b"\xff\xe1" + struct.pack(">H", len(exif) + 2) + exif
    jpeg = b"\xff\xd8" + app1 + b"\xff\xda\0\x02" + b"\x12\x34" * 32
    result = run(tmp_path, write(tmp_path, "photo.jpg", jpeg))
    assert result.returncode == 1
    assert "GPS" in result.stdout
