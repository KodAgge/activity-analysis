import shutil
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from activity_analysis.analysis.pipeline import recompute
from activity_analysis.api.main import create_app
from activity_analysis.config import Paths
from activity_analysis.ingest.pipeline import ingest


@pytest.fixture(autouse=True)
def _no_default_store(tmp_path_factory: pytest.TempPathFactory, monkeypatch: pytest.MonkeyPatch):
    """Point the default root at a temporary directory for every test.

    A checkout's ``.envrc`` exports ``ACTIVITY_ANALYSIS_HOME`` as the checkout,
    so a test that left out ``--root`` would read and write the real store.
    """
    monkeypatch.setenv("ACTIVITY_ANALYSIS_HOME", str(tmp_path_factory.mktemp("default-root")))


EXAMPLES = Path(__file__).resolve().parents[1] / "data" / "examples"

#: The 2026-08-28 activity, present as both FIT and GPX. The detailed
#: reference fixture, with golden values in docs/reference/test-fixtures.md.
REFERENCE_FIT = EXAMPLES / "run-2026-08-28.fit"
REFERENCE_GPX = EXAMPLES / "run-2026-08-28.gpx"

#: Two files from the Garmin Connect export. A guided breathing session,
#: which records heart rate but no distance and no position, and a
#: ``monitoring_b`` file, the all-day wellness kind a Garmin export holds
#: by the tens of thousands next to its activities.
GARMIN_BREATHING_FIT = EXAMPLES / "garmin" / "breathing.fit"
GARMIN_MONITORING_FIT = EXAMPLES / "garmin" / "monitoring.fit"


@pytest.fixture
def reference_fit() -> Path:
    assert REFERENCE_FIT.exists(), f"missing fixture: {REFERENCE_FIT}"
    return REFERENCE_FIT


@pytest.fixture
def reference_gpx() -> Path:
    assert REFERENCE_GPX.exists(), f"missing fixture: {REFERENCE_GPX}"
    return REFERENCE_GPX


@pytest.fixture
def garmin_breathing_fit() -> Path:
    assert GARMIN_BREATHING_FIT.exists(), f"missing fixture: {GARMIN_BREATHING_FIT}"
    return GARMIN_BREATHING_FIT


@pytest.fixture
def garmin_monitoring_fit() -> Path:
    assert GARMIN_MONITORING_FIT.exists(), f"missing fixture: {GARMIN_MONITORING_FIT}"
    return GARMIN_MONITORING_FIT


@pytest.fixture
def all_fit_fixtures() -> list[Path]:
    files = sorted(EXAMPLES.glob("*.fit"))
    assert len(files) == 5, f"expected 5 FIT fixtures, found {len(files)}"
    return files


@pytest.fixture
def ingested_store(tmp_path: Path, all_fit_fixtures: list[Path]) -> Paths:
    """A real store, built the way a user builds one: ingest then recompute."""
    dump = tmp_path / "dump"
    dump.mkdir()
    for fixture in all_fit_fixtures:
        shutil.copy(fixture, dump / fixture.name)
    paths = Paths(root=tmp_path / "store")
    ingest(paths, dump)
    recompute(paths)
    return paths


@pytest.fixture
def api_client(ingested_store: Paths) -> Iterator[TestClient]:
    # As a context manager deliberately: that is what runs the lifespan, and
    # without it ``app.state.con`` never exists.
    with TestClient(create_app(ingested_store)) as client:
        yield client


@pytest.fixture
def empty_api_client(tmp_path: Path) -> Iterator[TestClient]:
    """A store that has never been ingested into. Not an error state."""
    with TestClient(create_app(Paths(root=tmp_path / "never-used"))) as client:
        yield client
