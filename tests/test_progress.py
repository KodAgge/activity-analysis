import shutil
import zipfile
from collections.abc import Iterator, Sequence
from pathlib import Path

from activity_analysis.analysis.pipeline import recompute
from activity_analysis.config import Paths
from activity_analysis.ingest.archive import extract_export
from activity_analysis.ingest.pipeline import ingest
from activity_analysis.progress import SILENT, Progress


class Recording(Progress):
    """Records what each loop reported, and how many of its items were taken."""

    def __init__(self) -> None:
        self.events: list[tuple[str, int, int]] = []
        self.stages: list[str] = []

    def track[T](self, items: Sequence[T], label: str) -> Iterator[T]:
        index = len(self.events)
        self.events.append((label, len(items), 0))
        for item in items:
            yield item
            name, total, taken = self.events[index]
            self.events[index] = (name, total, taken + 1)

    def stage(self, label: str) -> None:
        self.stages.append(label)


def test_silent_yields_every_item_in_order():
    assert list(SILENT.track([3, 1, 2], "anything")) == [3, 1, 2]


def test_ingest_counts_every_file_it_reads(tmp_path: Path, all_fit_fixtures: list[Path]):
    dump = tmp_path / "dump"
    dump.mkdir()
    for fixture in all_fit_fixtures:
        shutil.copy(fixture, dump / fixture.name)
    progress = Recording()
    ingest(Paths(root=tmp_path / "store"), dump, progress=progress)
    assert progress.events == [
        ("reading files", len(all_fit_fixtures), len(all_fit_fixtures)),
    ]


def test_a_second_ingest_still_counts_the_files_it_skips(tmp_path: Path, reference_fit: Path):
    """Each file is hashed inside the loop, so the files a re-run skips are counted too.

    Hashing is what a re-run of a large export spends its time on, so a bar
    that counted only new files would stand still through all of it.
    """
    dump = tmp_path / "dump"
    dump.mkdir()
    shutil.copy(reference_fit, dump / reference_fit.name)
    paths = Paths(root=tmp_path / "store")
    ingest(paths, dump)
    progress = Recording()
    result = ingest(paths, dump, progress=progress)
    assert result.skipped_already_processed == 1
    assert progress.events == [("reading files", 1, 1)]


def test_recompute_counts_each_run_then_names_the_history_steps(
    tmp_path: Path, all_fit_fixtures: list[Path]
):
    dump = tmp_path / "dump"
    dump.mkdir()
    for fixture in all_fit_fixtures:
        shutil.copy(fixture, dump / fixture.name)
    paths = Paths(root=tmp_path / "store")
    ingest(paths, dump)
    progress = Recording()
    result = recompute(paths, progress)
    assert progress.events == [
        ("computing each run", len(all_fit_fixtures), len(all_fit_fixtures)),
    ]
    assert result.activities == len(all_fit_fixtures)
    assert progress.stages == [
        "comparing runs across the history",
        "finding recurring routes",
        "mapping territory",
    ]


def test_unpacking_an_export_counts_each_member(tmp_path: Path, reference_fit: Path):
    zipped = tmp_path / "export.zip"
    with zipfile.ZipFile(zipped, "w") as archive:
        archive.writestr("activities.csv", "Activity ID\n")
        archive.write(reference_fit, f"activities/{reference_fit.name}")
    progress = Recording()
    extract_export(zipped, tmp_path / "raw", progress)
    assert progress.events == [("unpacking the export", 2, 2)]
    assert (tmp_path / "raw" / "activities" / reference_fit.name).is_file()
