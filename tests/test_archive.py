import zipfile
from pathlib import Path

import pytest

from activity_analysis.ingest.archive import (
    UnsafeArchiveError,
    detect_archive_kind,
    extract_export,
    packed_garmin_uploads,
    unpack_garmin_uploads,
)

UPLOADS = Path("DI_CONNECT") / "DI-Connect-Uploaded-Files"


def test_a_strava_export_is_recognised_by_its_activity_index(tmp_path: Path):
    (tmp_path / "activities.csv").write_text("Activity ID\n")
    assert detect_archive_kind(tmp_path) == "strava"


def test_a_garmin_export_is_recognised_by_its_connect_directory(tmp_path: Path):
    (tmp_path / "DI_CONNECT").mkdir()
    assert detect_archive_kind(tmp_path) == "garmin"


def test_a_directory_that_is_neither_is_not_guessed_at(tmp_path: Path):
    (tmp_path / "run.fit").write_bytes(b"x")
    assert detect_archive_kind(tmp_path) is None


def _zip(path: Path, *members: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as archive:
        for member in members:
            archive.writestr(member, b"x")
    return path


def _unpack(zipped: Path, into: Path) -> None:
    with zipfile.ZipFile(zipped) as archive:
        archive.extractall(into)


def test_garmin_uploads_still_in_their_zips_are_found(tmp_path: Path):
    packed = _zip(tmp_path / UPLOADS / "UploadedFiles_0-_Part1.zip", "a_1.fit", "a_2.fit")
    assert packed_garmin_uploads(tmp_path) == [packed]


def test_garmin_uploads_in_the_fitness_uploads_directory_are_found_too(tmp_path: Path):
    # Garmin's export FAQ names this second directory beside the first; an
    # account's export may use either.
    fitness = Path("DI_CONNECT") / "DI-Connect-Fitness-Uploaded-Files"
    packed = _zip(tmp_path / fitness / "UploadedFiles_0-_Part1.zip", "a_1.fit")
    assert packed_garmin_uploads(tmp_path) == [packed]
    unpack_garmin_uploads(tmp_path)
    assert (tmp_path / fitness / "UploadedFiles_0-_Part1" / "a_1.fit").is_file()
    assert packed_garmin_uploads(tmp_path) == []


def test_garmin_uploads_unpacked_beside_their_zips_are_not_reported(tmp_path: Path):
    uploads = tmp_path / UPLOADS
    zipped = _zip(uploads / "UploadedFiles_0-_Part1.zip", "a_1.fit", "a_2.fit")
    _unpack(zipped, uploads / "UploadedFiles_0-_Part1")
    assert packed_garmin_uploads(tmp_path) == []


def test_garmin_uploads_unpacked_loose_into_the_uploads_directory_are_not_reported(
    tmp_path: Path,
):
    uploads = tmp_path / UPLOADS
    zipped = _zip(uploads / "UploadedFiles_0-_Part1.zip", "a_1.fit", "a_2.fit")
    _unpack(zipped, uploads)
    assert packed_garmin_uploads(tmp_path) == []


def test_only_the_zip_left_packed_is_reported_when_one_of_two_is_unpacked(tmp_path: Path):
    uploads = tmp_path / UPLOADS
    unpacked = _zip(uploads / "UploadedFiles_0-_Part1.zip", "a_1.fit")
    packed = _zip(uploads / "UploadedFiles_0-_Part2.zip", "b_1.fit")
    _unpack(unpacked, uploads / "UploadedFiles_0-_Part1")
    assert packed_garmin_uploads(tmp_path) == [packed]


def test_a_garmin_upload_zip_that_cannot_be_read_is_reported(tmp_path: Path):
    uploads = tmp_path / UPLOADS
    uploads.mkdir(parents=True)
    broken = uploads / "UploadedFiles_0-_Part1.zip"
    broken.write_bytes(b"PK")
    assert packed_garmin_uploads(tmp_path) == [broken]


def test_an_export_zip_is_extracted_and_its_root_returned(tmp_path: Path):
    zipped = _zip(tmp_path / "export.zip", "activities.csv", "activities/1.fit.gz")
    root = extract_export(zipped, tmp_path / "raw" / "export")
    assert root == tmp_path / "raw" / "export"
    assert (root / "activities" / "1.fit.gz").is_file()
    assert detect_archive_kind(root) == "strava"


def test_an_export_zipped_inside_one_folder_is_found_inside_it(tmp_path: Path):
    """What zipping an unpacked export again from a file manager produces."""
    zipped = _zip(tmp_path / "export.zip", "my_export/activities.csv", "my_export/activities/1.fit")
    root = extract_export(zipped, tmp_path / "raw" / "export")
    assert root == tmp_path / "raw" / "export" / "my_export"


def test_extracting_twice_is_harmless(tmp_path: Path):
    """Re-dropping an archive is a no-op downstream, so unpacking it again must not fail."""
    zipped = _zip(tmp_path / "export.zip", "activities.csv")
    first = extract_export(zipped, tmp_path / "raw" / "export")
    assert extract_export(zipped, tmp_path / "raw" / "export") == first


@pytest.mark.parametrize("member", ["../escaped.fit", "/etc/escaped.fit", "a/../../escaped.fit"])
def test_a_member_that_would_land_outside_the_directory_is_refused(tmp_path: Path, member: str):
    zipped = _zip(tmp_path / "export.zip", "activities.csv", member)
    with pytest.raises(UnsafeArchiveError, match="escaped.fit"):
        extract_export(zipped, tmp_path / "raw" / "export")
    assert not (tmp_path / "raw" / "export").exists()
    assert not list(tmp_path.rglob("escaped.fit"))


def test_garmin_upload_zips_are_unpacked_beside_themselves(tmp_path: Path):
    _zip(tmp_path / UPLOADS / "UploadedFiles_0-_Part1.zip", "a_1.fit", "a_2.fit")
    assert unpack_garmin_uploads(tmp_path) == (
        [tmp_path / UPLOADS / "UploadedFiles_0-_Part1.zip"],
        [],
    )
    assert (tmp_path / UPLOADS / "UploadedFiles_0-_Part1" / "a_2.fit").is_file()
    assert packed_garmin_uploads(tmp_path) == []


def test_garmin_uploads_already_unpacked_are_left_alone(tmp_path: Path):
    uploads = tmp_path / UPLOADS
    zipped = _zip(uploads / "UploadedFiles_0-_Part1.zip", "a_1.fit")
    _unpack(zipped, uploads)
    assert unpack_garmin_uploads(tmp_path) == ([], [])
    assert not (uploads / "UploadedFiles_0-_Part1").exists()


def test_an_unreadable_garmin_upload_zip_is_reported_and_the_rest_unpacked(tmp_path: Path):
    uploads = tmp_path / UPLOADS
    uploads.mkdir(parents=True)
    broken = uploads / "UploadedFiles_0-_Part1.zip"
    broken.write_bytes(b"not a zip")
    good = _zip(uploads / "UploadedFiles_0-_Part2.zip", "b_1.fit")
    unpacked, errors = unpack_garmin_uploads(tmp_path)
    assert unpacked == [good]
    assert [path for path, _ in errors] == [broken]
    assert (uploads / "UploadedFiles_0-_Part2" / "b_1.fit").is_file()
