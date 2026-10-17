"""Path layout and project-wide constants."""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path

DEFAULT_ATHLETE_ID = "default"

#: Names the root when ``--root`` is not given. A checkout's ``.envrc`` can
#: point it at the checkout, which is where the store lived before there was
#: an installed package to keep it out of.
HOME_ENV_VAR = "ACTIVITY_ANALYSIS_HOME"

APP_DIR_NAME = "activity-analysis"

#: Stamped into every canonical activity row. Bump when the canonical row
#: shape or a normalisation rule changes, so a row written under the older
#: shape is identifiable rather than indistinguishable from a current one.
#: 2 added ``utc_offset_s``.
#: 3 stops an empty duplicated FIT field erasing its value, which emptied the
#: lap and session speeds of every Garmin-original file.
INGEST_VERSION = 3

#: Stamped into every derived row. Bump when a metric definition changes, so
#: an old derived file is identifiable rather than silently mixed with a new one.
#: 2 added the activity tag table. 3 added `rep_count` to it. 4 added
#: `rep_pattern` to it. 5 added the place columns to `activity_metrics`.
#: 6 is phase 4 and covers all three of its tables: `activity_efficiency`,
#: `athlete_fit` and `fitness_series`. One bump for the whole phase, since
#: the plans that fill them fill tables this version already declares.
#: 7 is the trends readability work: the smoothed reference-pace and
#: decoupling columns, the walk exclusion from the efficiency fit, thirteen
#: more best-effort distances and a derived `avg_speed_mps`. One bump again,
#: because every one of those changes what a stored row says.
#: 8 adds the route tables. 9 adds `activity_metrics.days_since_previous_run`.
#: 10 adds `speed_distance_m` and `distance_trusted` to the best efforts, which
#: let a jump the measured speed confirms count towards a record.
#: 11 adds the territory tables.
#: 12 adds the four decoupling half means to activity_efficiency.
#: 13 counts a run slower than 9:00/km as a walk, recorded in the new
#: sport_reclassifications table, and leaves it out of every other one.
ANALYSIS_VERSION = 13


@dataclass(frozen=True)
class Paths:
    """Filesystem layout under a root directory, which holds ``data/``."""

    root: Path

    @property
    def data(self) -> Path:
        return self.root / "data"

    @property
    def raw(self) -> Path:
        return self.data / "raw"

    @property
    def canonical(self) -> Path:
        return self.data / "canonical"

    @property
    def derived(self) -> Path:
        return self.data / "derived"

    @property
    def streams_dir(self) -> Path:
        return self.canonical / "streams"

    @property
    def activities_parquet(self) -> Path:
        return self.canonical / "activities.parquet"

    @property
    def laps_parquet(self) -> Path:
        return self.canonical / "laps.parquet"

    @property
    def ledger_parquet(self) -> Path:
        return self.canonical / "ingest_ledger.parquet"

    @property
    def profile_observations_parquet(self) -> Path:
        return self.canonical / "profile_observations.parquet"

    @property
    def device_vo2max_parquet(self) -> Path:
        return self.canonical / "device_vo2max.parquet"

    @property
    def derived_streams_dir(self) -> Path:
        return self.derived / "streams_1hz"

    @property
    def best_efforts_parquet(self) -> Path:
        return self.derived / "best_efforts.parquet"

    @property
    def zone_time_parquet(self) -> Path:
        return self.derived / "zone_time.parquet"

    @property
    def activity_metrics_parquet(self) -> Path:
        return self.derived / "activity_metrics.parquet"

    @property
    def athlete_profile_parquet(self) -> Path:
        return self.derived / "athlete_profile.parquet"

    @property
    def activity_tags_parquet(self) -> Path:
        return self.derived / "activity_tags.parquet"

    @property
    def activity_efficiency_parquet(self) -> Path:
        return self.derived / "activity_efficiency.parquet"

    @property
    def athlete_fit_parquet(self) -> Path:
        return self.derived / "athlete_fit.parquet"

    @property
    def fitness_series_parquet(self) -> Path:
        return self.derived / "fitness_series.parquet"

    @property
    def routes_parquet(self) -> Path:
        return self.derived / "routes.parquet"

    @property
    def route_runs_parquet(self) -> Path:
        return self.derived / "route_runs.parquet"

    @property
    def territory_claims_parquet(self) -> Path:
        return self.derived / "territory_claims.parquet"

    @property
    def territory_regions_parquet(self) -> Path:
        return self.derived / "territory_regions.parquet"

    @property
    def territory_parts_parquet(self) -> Path:
        return self.derived / "territory_parts.parquet"

    @property
    def sport_reclassifications_parquet(self) -> Path:
        return self.derived / "sport_reclassifications.parquet"

    @property
    def basemap_dir(self) -> Path:
        return self.data / "basemap"

    @property
    def basemap_manifest(self) -> Path:
        return self.basemap_dir / "manifest.json"

    @property
    def basemap_areas_dir(self) -> Path:
        return self.basemap_dir / "areas"

    @property
    def basemap_assets_dir(self) -> Path:
        return self.basemap_dir / "assets"

    def basemap_area_path(self, area_id: str) -> Path:
        return self.basemap_areas_dir / f"{area_id}.pmtiles"

    def stream_path(self, activity_id: str) -> Path:
        return self.streams_dir / f"{activity_id}.parquet"

    def derived_stream_path(self, activity_id: str) -> Path:
        return self.derived_streams_dir / f"{activity_id}.parquet"

    def ensure(self) -> None:
        """Create every directory this layout needs."""
        for directory in (
            self.raw,
            self.canonical,
            self.derived,
            self.streams_dir,
            self.derived_streams_dir,
        ):
            directory.mkdir(parents=True, exist_ok=True)


def user_data_root() -> Path:
    """The platform's per-user data directory for this application.

    Written out rather than taken from ``platformdirs``, which would be a
    dependency for three branches: ``%LOCALAPPDATA%`` on Windows,
    ``~/Library/Application Support`` on macOS, and ``$XDG_DATA_HOME`` or
    ``~/.local/share`` everywhere else.
    """
    if sys.platform == "win32":
        local = os.environ.get("LOCALAPPDATA")
        base = Path(local) if local else Path.home() / "AppData" / "Local"
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        # The XDG Base Directory spec says a relative value is to be ignored.
        xdg = os.environ.get("XDG_DATA_HOME")
        base = Path(xdg) if xdg and Path(xdg).is_absolute() else Path.home() / ".local" / "share"
    return base / APP_DIR_NAME


def default_paths() -> Paths:
    """Paths rooted where ``ACTIVITY_ANALYSIS_HOME`` says, or the user data directory.

    Never the package's own location: an installed wheel lives in a virtual
    environment, which ``uv`` and ``pipx`` delete and recreate freely, and the
    store would go with it.
    """
    configured = os.environ.get(HOME_ENV_VAR)
    return Paths(root=Path(configured).expanduser() if configured else user_data_root())
