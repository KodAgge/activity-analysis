import sys
from pathlib import Path

from activity_analysis.config import Paths, default_paths, user_data_root


def test_paths_compose_from_root(tmp_path: Path):
    paths = Paths(root=tmp_path)
    assert paths.canonical == tmp_path / "data" / "canonical"
    assert paths.activities_parquet == tmp_path / "data" / "canonical" / "activities.parquet"
    assert paths.streams_dir == tmp_path / "data" / "canonical" / "streams"
    assert paths.stream_path("abc123") == paths.streams_dir / "abc123.parquet"


def test_ensure_creates_directories(tmp_path: Path):
    paths = Paths(root=tmp_path)
    assert not paths.canonical.exists()
    paths.ensure()
    assert paths.raw.is_dir()
    assert paths.canonical.is_dir()
    assert paths.derived.is_dir()
    assert paths.streams_dir.is_dir()


def test_derived_paths_sit_under_the_derived_directory(tmp_path: Path):
    paths = Paths(root=tmp_path)
    assert paths.derived_streams_dir == tmp_path / "data" / "derived" / "streams_1hz"
    assert paths.derived_stream_path("abc") == paths.derived_streams_dir / "abc.parquet"
    assert paths.best_efforts_parquet == tmp_path / "data" / "derived" / "best_efforts.parquet"
    assert paths.zone_time_parquet == tmp_path / "data" / "derived" / "zone_time.parquet"
    assert (
        paths.activity_metrics_parquet == tmp_path / "data" / "derived" / "activity_metrics.parquet"
    )
    assert (
        paths.athlete_profile_parquet == tmp_path / "data" / "derived" / "athlete_profile.parquet"
    )


def test_profile_observations_are_canonical_not_derived(tmp_path: Path):
    # They record what the device said, so they belong with the other facts.
    # The versioned table built from them is the derived thing.
    paths = Paths(root=tmp_path)
    assert (
        paths.profile_observations_parquet
        == tmp_path / "data" / "canonical" / "profile_observations.parquet"
    )


def test_ensure_creates_the_derived_stream_directory(tmp_path: Path):
    paths = Paths(root=tmp_path)
    paths.ensure()
    assert paths.derived_streams_dir.is_dir()


def test_the_environment_variable_names_the_root(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("ACTIVITY_ANALYSIS_HOME", str(tmp_path))
    assert default_paths().root == tmp_path


def test_an_empty_environment_variable_is_not_a_root(tmp_path: Path, monkeypatch):
    # `ACTIVITY_ANALYSIS_HOME=` would otherwise resolve to the working directory.
    monkeypatch.setenv("ACTIVITY_ANALYSIS_HOME", "")
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path))
    monkeypatch.setattr(sys, "platform", "linux")
    assert default_paths().root == tmp_path / "activity-analysis"


def test_without_the_variable_the_root_is_the_platform_data_directory(tmp_path: Path, monkeypatch):
    """Never the installed package's own location, which a wheel install puts in a venv."""
    monkeypatch.delenv("ACTIVITY_ANALYSIS_HOME", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "local"))
    monkeypatch.delenv("XDG_DATA_HOME", raising=False)

    monkeypatch.setattr(sys, "platform", "linux")
    assert user_data_root() == tmp_path / ".local" / "share" / "activity-analysis"
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xdg"))
    assert user_data_root() == tmp_path / "xdg" / "activity-analysis"
    # The XDG spec says a relative value is invalid and is to be ignored.
    monkeypatch.setenv("XDG_DATA_HOME", "relative/dir")
    assert user_data_root() == tmp_path / ".local" / "share" / "activity-analysis"

    monkeypatch.setattr(sys, "platform", "darwin")
    assert user_data_root() == (tmp_path / "Library" / "Application Support" / "activity-analysis")

    monkeypatch.setattr(sys, "platform", "win32")
    assert user_data_root() == tmp_path / "local" / "activity-analysis"
    monkeypatch.delenv("LOCALAPPDATA")
    assert user_data_root() == tmp_path / "AppData" / "Local" / "activity-analysis"


def test_tests_never_default_to_a_real_store():
    """conftest points the variable at a temporary directory for every test.

    A checkout's .envrc exports it as the checkout, so a test that forgot
    --root would otherwise write into the developer's real store.
    """
    root = default_paths().root
    assert root != Path(__file__).resolve().parents[1]
    assert "pytest" in str(root)
