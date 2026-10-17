"""Build a demo store from the five committed fixture runs, for screenshots and trials.

    uv run python scripts/build_demo_store.py <root>                     # three years ending today
    uv run python scripts/build_demo_store.py <root> --end 2026-10-16    # a fixed end date
    uv run python scripts/build_demo_store.py <root> --weeks 6           # a short one

`<root>` is a store root like `--root`: the store lands in `<root>/data`, and
`uv run activity-analysis serve --root <root>` serves it. The script refuses a
root that already holds a `data` directory, so it cannot touch a real store.

Nothing in the result comes from anywhere but `data/examples/`. The five
fixture runs are ingested as they are, and every other activity is one of
their streams, or several of them joined end to end, re-timed: the positions,
the altitude and the distance channel are the fixture's own, and time, speed,
heart rate and cadence follow a scripted fitness trend with seeded noise.
The same `--end` and `--weeks` build the same store, apart from the
`ingested_at` stamps of the five fixtures and the ledger, which `ingest` takes
from the clock.

`docs/reference/demo-store.md` describes the history it writes and why.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import shutil
import sys
import tempfile
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import numpy as np
import numpy.typing as npt
import pandas as pd

from activity_analysis.analysis.pipeline import RecomputeResult, recompute
from activity_analysis.analysis.resample import GAP_STOP, find_gaps
from activity_analysis.config import INGEST_VERSION, Paths
from activity_analysis.geo import haversine_m
from activity_analysis.identity import compute_activity_id
from activity_analysis.ingest.discover import sha256_file
from activity_analysis.ingest.fit_reader import read_fit
from activity_analysis.ingest.garmin_metrics import read_max_met
from activity_analysis.ingest.ledger import append_ledger
from activity_analysis.ingest.normalize import normalize
from activity_analysis.ingest.pipeline import SOURCE_GARMIN_EXPORT, ingest
from activity_analysis.models import (
    ACTIVITY_SCHEMA,
    LAP_SCHEMA,
    PROFILE_OBSERVATION_SCHEMA,
    SOURCE_GARMIN_FIT,
    STREAM_SCHEMA,
    Activity,
)
from activity_analysis.store.writer import (
    read_activities,
    read_activity_metrics,
    read_best_efforts,
    read_fitness_series,
    upsert_activities,
    upsert_device_vo2max,
    upsert_laps,
    upsert_profile_observations,
    write_streams,
)

Floats = npt.NDArray[np.float64]

REPO = Path(__file__).resolve().parent.parent
EXAMPLES = REPO / "data" / "examples"

#: The five fixture runs, keyed by their date. ``21``, ``23`` and ``28`` start
#: and finish at one point and ``25`` and ``26`` at another 2.5 km away, so
#: only loops from the same start are joined into one longer run.
FIXTURE_FILES = {
    "21": "run-2026-08-21.fit",
    "23": "run-2026-08-23.fit",
    "25": "run-2026-08-25.fit",
    "26": "run-2026-08-26.fit",
    "28": "run-2026-08-28.fit",
}
#: The Strava GPX copy of the 2026-08-28 run, ingested so the store holds a
#: deduplicated pair the way a real one does. ``data/examples/garmin/`` is
#: left out: its breathing session is from 2022, outside any demo history.
FIXTURE_GPX = "run-2026-08-28.gpx"
FIXTURE_DATES = {date(2026, 8, int(day)) for day in FIXTURE_FILES}
#: The Mondays of the two weeks the fixtures fall in. Those weeks hold the
#: fixtures and nothing synthetic.
FIXTURE_WEEKS = {date(2026, 8, 17), date(2026, 8, 24)}
LAST_FIXTURE_DATE = max(FIXTURE_DATES)

#: Every activity in the store, the five fixtures included, belongs to this
#: athlete. An id hashes the athlete with the start minute, so under the
#: default athlete a synthetic run starting in the same minute as one of the
#: maintainer's real activities would carry that activity's real id: about
#: one in every two seeds did on a three-year history. Under its own athlete
#: no demo id can equal an id from any real store.
DEMO_ATHLETE_ID = "demo"

ZONE = ZoneInfo("Europe/Stockholm")
DEFAULT_SEED = 20261016
DEFAULT_WEEKS = 156

#: The fitness trend runs over this many weeks before ``--end``, whatever
#: ``--weeks`` is, so a short demo is a slice of the same athlete.
TREND_WEEKS = 156

#: Heart rate rises this much per m/s of speed between runs, and cadence this
#: much. The efficiency fit's shared slopes recover roughly these.
HR_SLOPE_BPM_PER_MPS = 22.0
CADENCE_SLOPE_SPM_PER_MPS = 10.0
#: At the start of the trend heart rate at a fixed pace sits this much above
#: the fixtures' and cadence at a fixed pace this much below; both close to
#: zero along the trend. That is the signal the Trends page reads.
HR_FITNESS_SPAN_BPM = 10.0
CADENCE_FITNESS_SPAN_SPM = 4.0
#: Easy-run speed is this fraction of the fixtures' at the start of the trend.
SLOWEST_SPEED_FRACTION = 0.90
#: Every ordinary run is kept at or above this moving speed, so it stays a run
#: under the 9:00/km reclassification and enters the efficiency fit, whose walk
#: filter is 8:00/km, 2.083 m/s.
MIN_RUN_SPEED_MPS = 2.15
#: Race speeds at full fitness, m/s: 21:06 for 5 km, 44:48 for 10 km and
#: 1:41:02 for the half marathon. Set well away from the records of the
#: athlete whose runs the fixtures are, so the demo's records do not read as
#: that athlete's.
RACE_SPEED_MPS = {"race_5k": 3.95, "race_10k": 3.72, "race_half": 3.48}
RACE_DISTANCE_M = {"race_5k": 5030.0, "race_10k": 10030.0, "race_half": 21150.0}
RACE_HR_BONUS_BPM = {"race_5k": 9.0, "race_10k": 2.0, "race_half": 0.0}
#: A race sits near threshold from the first kilometre, so its heart rate
#: swings this fraction of the fixture's around the fixture's median.
RACE_HR_SPREAD = 0.6
#: Cardiac drift on a run longer than an hour, per hour past the first.
DRIFT_BPM_PER_H = 3.0
DRIFT_CAP_BPM = 12.0
HR_FLOOR_BPM = 60.0
#: Above this, heart rate rises at a fraction of the rate the model asks for,
#: so a hard effort tops out short of the 207 bpm maximum instead of flat.
HR_SOFT_CAP_BPM = 188.0
HR_SOFT_CAP_GAIN = 0.4
HR_CEILING_BPM = 203.0

#: When the races and the ultra fall, in weeks before ``--end``. Each one
#: outside ``--weeks`` is dropped.
RACE_WEEKS_BEFORE = {
    "race_5k": (3, 30, 61, 96, 132),
    "race_10k": (6, 44, 81, 116),
    "race_half": (13, 52, 105),
}
ULTRA_WEEKS_BEFORE = 18
#: The injury: five weeks with no running, this many weeks before ``--end``.
INJURY_WEEKS_BEFORE = range(66, 71)
#: Heart rate is recorded from this many weeks after the history starts, and
#: the profile messages with it, as on a watch bought partway through.
HR_STARTS_AFTER_WEEKS = 18
#: The resting heart rate setting changes once, this many weeks before the end.
RESTING_HR_EDIT_WEEKS_BEFORE = 50

#: The ultra: loops from the 21/23/28 start, slowing over the day, with a
#: stop at four of the joins.
ULTRA_LOOPS = ("23", "21", "28", "23", "21", "28", "23", "21", "28", "23", "21")
ULTRA_FIRST_SCALE = 0.93
ULTRA_LAST_SCALE = 0.77
ULTRA_STOPS_S = {2: 300.0, 4: 480.0, 6: 720.0, 8: 360.0}


@dataclass(frozen=True)
class Track:
    """One fixture run as canonical arrays, times and distances from zero."""

    key: str
    t: Floats
    d: Floats
    lat: Floats
    lon: Floats
    alt: Floats
    speed: Floats
    hr: Floats
    cadence: Floats
    moving_speed_mps: float
    #: The device's barometric totals over the sum of the stream's own
    #: altitude steps, which overcounts; applied per sample so laps sum right.
    ascent_ratio: float
    descent_ratio: float
    kcal_per_m: float
    lap_start_t: Floats
    lap_triggers: list[str]
    lap_ascent: list[float]
    lap_descent: list[float]
    profile: dict[str, Any]
    device_manufacturer: str | None
    device_product: str | None


@dataclass(frozen=True)
class Segment:
    track: str
    scale: float
    truncate_m: float | None = None
    #: Seconds standing still before this segment starts.
    stop_before_s: float = 0.0


@dataclass
class Session:
    kind: str
    local_start: datetime
    fitness: float
    has_hr: bool
    segments: list[Segment] = field(default_factory=list)
    #: True to keep the fixture's own laps, re-timed; false for 1 km auto laps.
    fixture_laps: bool = False


@dataclass
class Summary:
    root: Path
    fixtures: int = 0
    synthetic: int = 0
    by_kind: dict[str, int] = field(default_factory=dict)
    ultra_activity_id: str | None = None
    ultra_elapsed_s: float = 0.0
    first_day: date | None = None
    last_day: date | None = None
    distance_km: float = 0.0
    device_vo2max_days: int = 0
    recompute: RecomputeResult | None = None
    seconds: dict[str, float] = field(default_factory=dict)


def _array(frame: pd.DataFrame, column: str) -> Floats:
    return frame[column].to_numpy(dtype=np.float64)


def load_tracks() -> dict[str, Track]:
    """Read each fixture through the project's own reader and normaliser."""
    tracks: dict[str, Track] = {}
    for key, name in FIXTURE_FILES.items():
        path = EXAMPLES / name
        normalized = normalize(
            read_fit(path),
            source=SOURCE_GARMIN_FIT,
            source_file=name,
            source_file_sha256=sha256_file(path),
            athlete_id=DEMO_ATHLETE_ID,
            ingested_at=datetime(2000, 1, 1, tzinfo=UTC),
        )
        streams = normalized.streams
        activity = normalized.activity
        alt = _array(streams, "altitude_m")
        steps = np.diff(alt)
        start = pd.Timestamp(activity.start_time_utc)
        laps = normalized.laps
        lap_start: Floats = np.array(
            (pd.to_datetime(laps["start_time_utc"], utc=True) - start).dt.total_seconds(),
            dtype=np.float64,
        )
        assert normalized.profile_observation is not None, f"{name} carries no profile"
        timer_s = float(activity.timer_time_s or activity.elapsed_time_s or 1.0)
        distance_m = float(activity.distance_m or 1.0)
        d = _array(streams, "distance_m")
        tracks[key] = Track(
            key=key,
            t=_array(streams, "t_s"),
            d=np.maximum.accumulate(d - d[0]),
            lat=_array(streams, "lat_deg"),
            lon=_array(streams, "lon_deg"),
            alt=alt,
            speed=_array(streams, "speed_mps"),
            hr=_array(streams, "hr_bpm"),
            cadence=_array(streams, "cadence_spm"),
            moving_speed_mps=distance_m / timer_s,
            ascent_ratio=float(activity.ascent_m or 0.0) / float(steps[steps > 0].sum()),
            descent_ratio=float(activity.descent_m or 0.0) / float(-steps[steps < 0].sum()),
            kcal_per_m=float(activity.calories or 0.0) / distance_m,
            lap_start_t=lap_start,
            lap_triggers=[str(v) for v in laps["trigger"]],
            lap_ascent=[float(v) for v in laps["ascent_m"]],
            lap_descent=[float(v) for v in laps["descent_m"]],
            profile=dict(normalized.profile_observation),
            device_manufacturer=activity.device_manufacturer,
            device_product=activity.device_product,
        )
    return tracks


# --- The plan: which runs happen when -------------------------------------------------


def fitness_at(day: date, end: date, injury_end: date | None) -> float:
    """The scripted fitness trend, 0 three years before ``end`` and about 1 at it.

    A saturating rise, a small seasonal swing that peaks in summer, and a dip
    after the injury that recovers over a couple of months.
    """
    days_before = (end - day).days
    x = min(max(1.0 - days_before / (TREND_WEEKS * 7), 0.0), 1.0)
    base = (1.0 - math.exp(-2.5 * x)) / (1.0 - math.exp(-2.5))
    seasonal = 0.03 * math.sin(2 * math.pi * (day.timetuple().tm_yday - 110) / 365.25)
    dip = 0.0
    if injury_end is not None and day >= injury_end:
        dip = 0.18 * math.exp(-(day - injury_end).days / 50.0)
    return min(max(base + seasonal - dip, 0.0), 1.03)


def _speed_fraction(fitness: float) -> float:
    return SLOWEST_SPEED_FRACTION + (1.0 - SLOWEST_SPEED_FRACTION) * fitness


def _event_day(week_monday: date, kind: str) -> date:
    # Races on a Saturday, the half marathon on a Sunday, the ultra on a Saturday.
    return week_monday + timedelta(days=6 if kind == "race_half" else 5)


def _local_start(day: date, kind: str, rng: np.random.Generator) -> datetime:
    """A start time of day: mornings, lunches and evenings on weekdays."""
    if kind == "ultra":
        hour, minute = 5, int(rng.integers(0, 30))
    elif kind.startswith("race"):
        hour, minute = (9, 30) if kind == "race_half" else (10, 0)
        minute += int(rng.integers(0, 4))
    elif day.weekday() >= 5 or kind == "long":
        if rng.random() < 0.75:
            hour, minute = int(rng.integers(7, 11)), int(rng.integers(0, 60))
        else:
            hour, minute = int(rng.integers(14, 17)), int(rng.integers(0, 60))
    else:
        slot = rng.random()
        if slot < 0.35:
            hour, minute = 6, int(rng.integers(0, 75))
        elif slot < 0.5:
            hour, minute = 11, int(rng.integers(30, 90))
        else:
            hour, minute = int(rng.integers(17, 20)), int(rng.integers(0, 60))
    return datetime(day.year, day.month, day.day) + timedelta(
        hours=hour, minutes=minute, seconds=int(rng.integers(0, 60))
    )


def _scale_for(track: Track, fitness: float, rng: np.random.Generator, *, factor: float) -> float:
    scale = _speed_fraction(fitness) * factor * float(rng.normal(1.0, 0.02))
    return max(scale, MIN_RUN_SPEED_MPS / track.moving_speed_mps)


def _long_loops(fitness: float, ultra_build: bool, rng: np.random.Generator) -> tuple[str, ...]:
    if ultra_build and rng.random() < 0.5:
        return ("23", "21", "28", "21")
    if fitness < 0.3:
        return ("21", "28")
    if fitness < 0.6:
        return ("23", "21")
    if fitness < 0.85:
        return ("23", "28") if rng.random() < 0.6 else ("23", "23")
    return ("23", "21", "28") if rng.random() < 0.5 else ("23", "23")


def _segments(
    kind: str, fitness: float, tracks: dict[str, Track], rng: np.random.Generator, ultra_build: bool
) -> tuple[list[Segment], bool]:
    """What one session runs: the loops, their speed scale, and whose laps."""
    if kind == "easy":
        key = str(rng.choice(["21", "28", "26"], p=[0.4, 0.4, 0.2]))
        return [Segment(key, _scale_for(tracks[key], fitness, rng, factor=1.0))], True
    if kind == "medium":
        return [Segment("23", _scale_for(tracks["23"], fitness, rng, factor=1.0))], True
    if kind == "intervals":
        return [Segment("25", _scale_for(tracks["25"], fitness, rng, factor=0.99))], True
    if kind == "long":
        loops = _long_loops(fitness, ultra_build, rng)
        return [
            Segment(key, _scale_for(tracks[key], fitness, rng, factor=0.97)) for key in loops
        ], False
    if kind in RACE_SPEED_MPS:
        target = RACE_SPEED_MPS[kind] * _speed_fraction(fitness) * float(rng.normal(1.0, 0.01))
        loops = {"race_5k": ("21",), "race_10k": ("23",), "race_half": ("23", "23", "21")}[kind]
        segments: list[Segment] = []
        covered = 0.0
        for key in loops:
            track = tracks[key]
            remaining = RACE_DISTANCE_M[kind] - covered
            truncate = remaining if remaining < track.d[-1] else None
            segments.append(Segment(key, target / track.moving_speed_mps, truncate_m=truncate))
            covered += float(track.d[-1])
        return segments, False
    if kind == "ultra":
        n = len(ULTRA_LOOPS)
        return [
            Segment(
                key,
                ULTRA_FIRST_SCALE + (ULTRA_LAST_SCALE - ULTRA_FIRST_SCALE) * i / (n - 1),
                stop_before_s=ULTRA_STOPS_S.get(i, 0.0),
            )
            for i, key in enumerate(ULTRA_LOOPS)
        ], False
    raise ValueError(kind)


def _week_days(n: int, rng: np.random.Generator, taken: set[int]) -> dict[int, str]:
    """Weekday index to session kind for an ordinary week of ``n`` runs."""
    plan: dict[int, str] = {}
    if n >= 3:
        long_day = 6 if rng.random() < 0.7 else 5
        if long_day not in taken:
            plan[long_day] = "long"
    if n >= 4 and rng.random() < 0.7:
        day = 1 if rng.random() < 0.5 else 3
        if day not in taken:
            plan[day] = "intervals"
    weights = np.array([0.6, 1.0, 1.0, 1.0, 0.6, 0.8, 0.5])
    while len(plan) < n:
        free = [d for d in range(7) if d not in plan and d not in taken]
        if not free:
            break
        p = weights[free] / weights[free].sum()
        day = int(rng.choice(free, p=p))
        plan[day] = "medium" if rng.random() < 0.3 else "easy"
    return plan


def plan_sessions(
    end: date, weeks: int, tracks: dict[str, Track], rng: np.random.Generator
) -> list[Session]:
    end_monday = end - timedelta(days=end.weekday())
    first_monday = end_monday - timedelta(weeks=weeks - 1)
    injury = [w for w in INJURY_WEEKS_BEFORE if w < weeks - 10]
    injury_end = end_monday - timedelta(weeks=min(injury)) + timedelta(days=7) if injury else None

    events: dict[date, str] = {}
    for kind, offsets in RACE_WEEKS_BEFORE.items():
        for weeks_before in offsets:
            if weeks_before < weeks:
                monday = end_monday - timedelta(weeks=weeks_before)
                events[_event_day(monday, kind)] = kind
    ultra_monday = end_monday - timedelta(weeks=ULTRA_WEEKS_BEFORE)
    if weeks > ULTRA_WEEKS_BEFORE:
        events[_event_day(ultra_monday, "ultra")] = "ultra"

    eligible_rest = [w for w in range(4, weeks - 4) if w not in injury]
    rest_weeks = (
        {int(w) for w in rng.choice(eligible_rest, size=3, replace=False)}
        if weeks >= 52 and len(eligible_rest) >= 3
        else set()
    )
    hr_from = first_monday + timedelta(weeks=HR_STARTS_AFTER_WEEKS) if weeks >= 52 else first_monday

    sessions: list[Session] = []
    for w in range(weeks):
        monday = first_monday + timedelta(weeks=w)
        weeks_before = weeks - 1 - w
        if monday in FIXTURE_WEEKS or weeks_before in injury:
            continue
        week_events = {
            (day - monday).days: kind
            for day, kind in events.items()
            if monday <= day < monday + timedelta(days=7)
        }
        week_kinds = set(week_events.values())
        christmas = any(
            (monday + timedelta(days=i)).month == 12
            and (monday + timedelta(days=i)).day in (24, 25)
            for i in range(7)
        )
        after_injury = injury_end is not None and 0 <= (monday - injury_end).days < 21
        if weeks_before in rest_weeks:
            n = int(rng.integers(0, 2))
        elif christmas:
            n = 1
        elif after_injury:
            n = int(rng.integers(2, 4))
        elif "ultra" in week_kinds:
            n = 3
        elif monday == ultra_monday + timedelta(weeks=1):
            n = 2
        else:
            n = int(rng.choice([3, 4, 5], p=[0.25, 0.45, 0.30]))
        ultra_build = 0 < (ultra_monday - monday).days <= 70
        plan = _week_days(max(n - len(week_events), 0), rng, set(week_events))
        if after_injury or christmas or "ultra" in week_kinds:
            plan = {d: "easy" for d in plan}
        if "ultra" in week_kinds:
            plan = {d: k for d, k in plan.items() if d < 4}
        if week_events:
            # No long run in a race week.
            plan = {d: "easy" if k == "long" else k for d, k in plan.items()}
        plan.update(week_events)

        for weekday in sorted(plan):
            day = monday + timedelta(days=weekday)
            if day > end or day in FIXTURE_DATES:
                continue
            kind = plan[weekday]
            fitness = fitness_at(day, end, injury_end)
            segments, fixture_laps = _segments(kind, fitness, tracks, rng, ultra_build)
            sessions.append(
                Session(
                    kind=kind,
                    local_start=_local_start(day, kind, rng),
                    fitness=fitness,
                    has_hr=day >= hr_from,
                    segments=segments,
                    fixture_laps=fixture_laps,
                )
            )
    return sessions


# --- Rendering one session into canonical rows ---------------------------------------


@dataclass
class Rendered:
    t: Floats
    d: Floats
    lat: Floats
    lon: Floats
    alt: Floats
    speed: Floats
    hr: Floats
    cadence: Floats
    ascent: Floats
    descent: Floats
    kcal: Floats
    lap_bounds_t: list[float]
    lap_triggers: list[str]
    lap_ascent: list[float] | None
    lap_descent: list[float] | None


def _smooth_noise(t: Floats, rng: np.random.Generator, sd: float) -> Floats:
    """A pace wobble that changes over minutes rather than from sample to sample."""
    knots = np.arange(0.0, float(t[-1]) + 600.0, 600.0)
    values = rng.normal(1.0, sd, len(knots))
    out: Floats = np.interp(t, knots, values)
    return out


def render(session: Session, tracks: dict[str, Track], rng: np.random.Generator) -> Rendered:
    """Join and re-time a session's segments into one stream.

    Positions, altitude and distance are the fixtures' own. Time between two
    samples is the fixture's divided by the segment's scale and a slow wobble,
    and speed is multiplied by the same, so distance over time and the speed
    channel agree and the best-effort speed check confirms every metre.
    """
    parts: dict[str, list[Floats]] = {
        name: []
        for name in (
            "t",
            "d",
            "lat",
            "lon",
            "alt",
            "speed",
            "hr",
            "cadence",
            "ascent",
            "descent",
            "kcal",
        )
    }
    day_hr = float(rng.normal(0.0, 2.0))
    day_cadence = float(rng.normal(0.0, 1.0))
    hr_offset = HR_FITNESS_SPAN_BPM * (1.0 - min(session.fitness, 1.0)) + day_hr
    hr_offset += RACE_HR_BONUS_BPM.get(session.kind, 0.0)
    cadence_offset = -CADENCE_FITNESS_SPAN_SPM * (1.0 - min(session.fitness, 1.0)) + day_cadence

    t_end = 0.0
    d_end = 0.0
    last_pos: tuple[float, float] | None = None
    for k, segment in enumerate(session.segments):
        track = tracks[segment.track]
        keep = (
            np.ones(len(track.t), dtype=bool)
            if segment.truncate_m is None
            else track.d <= segment.truncate_m
        )
        t0, d0 = track.t[keep], track.d[keep]
        wobble = _smooth_noise(t0, rng, 0.015)
        scale = segment.scale * wobble
        dt = np.diff(t0) / ((scale[1:] + scale[:-1]) / 2.0)
        t_seg = np.concatenate([[0.0], np.cumsum(dt)])
        if k == 0:
            t_shift, d_shift = 0.0, 0.0
        else:
            assert last_pos is not None
            join_m = haversine_m(last_pos[0], last_pos[1], float(track.lat[0]), float(track.lon[0]))
            join_s = max(2.0, join_m / (track.moving_speed_mps * segment.scale))
            t_shift = t_end + join_s + segment.stop_before_s
            d_shift = d_end + join_m

        speed_delta = (segment.scale - 1.0) * track.moving_speed_mps
        hr = track.hr[keep]
        if session.kind in RACE_SPEED_MPS:
            median = float(np.median(track.hr))
            hr = median + RACE_HR_SPREAD * (hr - median)
        hr = hr + HR_SLOPE_BPM_PER_MPS * speed_delta + hr_offset
        if k > 0:
            # A joined loop's own warm-up is not one: the athlete is already warm.
            warm = t0 < 300.0
            hr[warm] = np.maximum(hr[warm], float(np.median(track.hr)) + hr_offset)
        cadence = track.cadence[keep].copy()
        running = cadence >= 120.0
        cadence[running] += CADENCE_SLOPE_SPM_PER_MPS * speed_delta + cadence_offset

        steps = np.diff(track.alt[keep], prepend=track.alt[keep][0])
        parts["t"].append(t_seg + t_shift)
        parts["d"].append(d0 + d_shift)
        parts["lat"].append(track.lat[keep])
        parts["lon"].append(track.lon[keep])
        parts["alt"].append(track.alt[keep])
        parts["speed"].append(track.speed[keep] * scale)
        parts["hr"].append(hr)
        parts["cadence"].append(cadence)
        parts["ascent"].append(np.clip(steps, 0.0, None) * track.ascent_ratio)
        parts["descent"].append(np.clip(-steps, 0.0, None) * track.descent_ratio)
        parts["kcal"].append(np.diff(d0, prepend=d0[0]) * track.kcal_per_m)
        t_end = float(parts["t"][-1][-1])
        d_end = float(parts["d"][-1][-1])
        last_pos = (float(track.lat[keep][-1]), float(track.lon[keep][-1]))

    joined = {name: np.concatenate(values) for name, values in parts.items()}
    t = joined["t"]

    # An ordinary run sometimes waits at a crossing: a gap long enough, and an
    # advance across it small enough, for the gap rule to call it a stop.
    if session.kind in ("easy", "medium", "long") and rng.random() < 0.3:
        dd = np.diff(joined["d"])
        candidates = np.flatnonzero((dd < 8.0) & (t[:-1] > 120.0) & (t[:-1] < t[-1] - 120.0))
        if candidates.size:
            i = int(rng.choice(candidates))
            t = t.copy()
            t[i + 1 :] += float(rng.uniform(30.0, 90.0))

    # Drift past the first hour, on the run's own clock.
    hours = t / 3600.0
    hr = joined["hr"] + np.minimum(np.clip(hours - 1.0, 0.0, None) * DRIFT_BPM_PER_H, DRIFT_CAP_BPM)
    hr = np.where(
        hr > HR_SOFT_CAP_BPM, HR_SOFT_CAP_BPM + (hr - HR_SOFT_CAP_BPM) * HR_SOFT_CAP_GAIN, hr
    )
    hr = np.clip(np.round(hr + rng.normal(0.0, 1.0, len(hr))), HR_FLOOR_BPM, HR_CEILING_BPM)
    cadence = joined["cadence"]
    running = cadence >= 120.0
    cadence = np.where(
        running, np.round(cadence + rng.normal(0.0, 0.7, len(cadence))), cadence
    ).astype(np.float64)
    if not session.has_hr:
        hr = np.full(len(t), np.nan)

    if session.fixture_laps:
        track = tracks[session.segments[0].track]
        original_t = track.t
        bounds = [float(v) for v in np.interp(track.lap_start_t, original_t, t)]
        triggers = list(track.lap_triggers)
        lap_ascent: list[float] | None = list(track.lap_ascent)
        lap_descent: list[float] | None = list(track.lap_descent)
    else:
        total = float(joined["d"][-1])
        marks = np.arange(0.0, total, 1000.0)
        bounds = [float(v) for v in np.interp(marks, joined["d"], t)]
        bounds[0] = 0.0
        triggers = ["distance"] * (len(bounds) - 1) + ["session_end"]
        lap_ascent = lap_descent = None
    bounds.append(float(t[-1]))

    return Rendered(
        t=np.round(t, 3),
        d=np.round(joined["d"], 2),
        lat=joined["lat"],
        lon=joined["lon"],
        alt=joined["alt"],
        speed=np.round(joined["speed"], 3),
        hr=hr,
        cadence=cadence,
        ascent=joined["ascent"],
        descent=joined["descent"],
        kcal=joined["kcal"],
        lap_bounds_t=bounds,
        lap_triggers=triggers,
        lap_ascent=lap_ascent,
        lap_descent=lap_descent,
    )


def _stopped_s(t: Floats, d: Floats, start: float, end: float) -> float:
    """Seconds inside stops, by the resampler's own gap rule, within a window."""
    total = 0.0
    for gap in find_gaps(t, d):
        if gap.kind == GAP_STOP:
            total += max(0.0, min(gap.end_t_s, end) - max(gap.start_t_s, start))
    return total


def _mean_or_none(values: Floats) -> float | None:
    finite = values[np.isfinite(values)]
    return float(finite.mean()) if finite.size else None


def _max_or_none(values: Floats) -> float | None:
    finite = values[np.isfinite(values)]
    return float(finite.max()) if finite.size else None


def _cadence_mean(values: Floats) -> float | None:
    """A lap or session cadence the way the device averages it.

    Over every sample, walking and standing included: on the 2026-08-25
    fixture that reproduces the device's lap figures to within 6 spm, and an
    average over running samples alone erases the walked recoveries that
    ``analysis.tags`` finds intervals by. Rounded to FIT's 1/64 spm grid.
    """
    finite = values[np.isfinite(values)]
    return None if finite.size == 0 else round(float(finite.mean()) * 64) / 64


def _round_or_none(value: float | None) -> float | None:
    return None if value is None else float(round(value))


def _source_sha(seed: int, activity_id: str) -> str:
    return hashlib.sha256(f"demo-store|{seed}|{activity_id}".encode()).hexdigest()


def to_canonical(
    session: Session,
    rendered: Rendered,
    tracks: dict[str, Track],
    *,
    seed: int,
    ingested_at: datetime,
    resting_hr_edit: date,
) -> tuple[Activity, pd.DataFrame, pd.DataFrame, dict[str, Any] | None]:
    """The activity row, laps, stream and profile observation for one session."""
    aware = session.local_start.replace(tzinfo=ZONE)
    offset = aware.utcoffset()
    assert offset is not None
    start = aware.astimezone(UTC)
    activity_id = compute_activity_id(DEMO_ATHLETE_ID, start)
    t, d = rendered.t, rendered.d
    start_ts = pd.Timestamp(start)

    laps: list[dict[str, Any]] = []
    bounds = rendered.lap_bounds_t
    for i in range(len(bounds) - 1):
        a, b = bounds[i], bounds[i + 1]
        inside = (t >= a) & (t <= b)
        distance = float(np.interp(b, t, d) - np.interp(a, t, d))
        elapsed = b - a
        timer = elapsed - _stopped_s(t, d, a, b)
        if rendered.lap_ascent is not None and rendered.lap_descent is not None:
            ascent, descent = rendered.lap_ascent[i], rendered.lap_descent[i]
        else:
            in_lap = (t > a) & (t <= b)
            ascent = float(round(rendered.ascent[in_lap].sum()))
            descent = float(round(rendered.descent[in_lap].sum()))
        in_lap_open = (t > a) & (t <= b)
        laps.append(
            {
                "activity_id": activity_id,
                "lap_index": i,
                "start_time_utc": start_ts + pd.Timedelta(seconds=a),
                "trigger": rendered.lap_triggers[i],
                "elapsed_time_s": round(elapsed, 3),
                "distance_m": round(distance, 2),
                "avg_speed_mps": round(distance / timer, 3) if timer > 0 else None,
                "avg_hr_bpm": _round_or_none(_mean_or_none(rendered.hr[inside])),
                "max_hr_bpm": _round_or_none(_max_or_none(rendered.hr[inside])),
                "avg_cadence_spm": _cadence_mean(rendered.cadence[inside]),
                "ascent_m": ascent,
                "descent_m": descent,
                "calories": float(round(rendered.kcal[in_lap_open].sum())),
            }
        )
    lap_frame = pd.DataFrame(laps, columns=LAP_SCHEMA.names)

    elapsed_s = float(t[-1])
    timer_s = elapsed_s - _stopped_s(t, d, 0.0, elapsed_s)
    distance_m = float(d[-1])
    first = tracks[session.segments[0].track]
    local_name = f"demo-{session.local_start:%Y-%m-%d-%H%M}-{session.kind}.fit"
    activity = Activity(
        activity_id=activity_id,
        athlete_id=DEMO_ATHLETE_ID,
        source=SOURCE_GARMIN_FIT,
        source_file=local_name,
        source_file_sha256=_source_sha(seed, activity_id),
        start_time_utc=start,
        utc_offset_s=int(offset.total_seconds()),
        sport="running",
        sub_sport="generic",
        name="Run",
        elapsed_time_s=round(elapsed_s, 3),
        timer_time_s=round(timer_s, 3),
        moving_time_s=round(timer_s, 3),
        distance_m=round(distance_m, 2),
        ascent_m=float(lap_frame["ascent_m"].sum()),
        descent_m=float(lap_frame["descent_m"].sum()),
        avg_speed_mps=round(distance_m / timer_s, 3),
        max_speed_mps=_max_or_none(rendered.speed),
        avg_hr_bpm=_round_or_none(_mean_or_none(rendered.hr)),
        max_hr_bpm=_max_or_none(rendered.hr),
        avg_cadence_spm=_cadence_mean(rendered.cadence),
        calories=float(lap_frame["calories"].sum()),
        device_manufacturer=first.device_manufacturer,
        device_product=first.device_product,
        ingested_at=ingested_at,
        ingest_version=INGEST_VERSION,
    )

    stream = pd.DataFrame(
        {
            "activity_id": activity_id,
            "t_s": t,
            "timestamp_utc": start_ts + pd.to_timedelta(t, unit="s"),
            "lat_deg": rendered.lat,
            "lon_deg": rendered.lon,
            "altitude_m": rendered.alt,
            "distance_m": d,
            "speed_mps": rendered.speed,
            "hr_bpm": rendered.hr,
            "cadence_spm": rendered.cadence,
            "power_w": np.nan,
            "temperature_c": np.nan,
            "moving": pd.array([pd.NA] * len(t), dtype="boolean"),
        },
        columns=STREAM_SCHEMA.names,
    )

    profile: dict[str, Any] | None = None
    if session.has_hr:
        profile = {
            **first.profile,
            "activity_id": activity_id,
            "athlete_id": DEMO_ATHLETE_ID,
            "observed_at": start,
        }
        if session.local_start.date() < resting_hr_edit:
            profile["resting_hr_bpm"] = 70.0
    return activity, lap_frame, stream, profile


# --- Garmin's own VO2max ---------------------------------------------------------------


def write_device_vo2max(paths: Paths, scratch: Path, rng: np.random.Generator) -> int:
    """A Garmin-style VO2max a little under the heart-rate estimate, one row per running day.

    Written as a MaxMet JSON file in the export's own shape and read back
    through ``read_max_met``, so it takes the same path a real export does.
    """
    series = read_fitness_series(paths)
    series = series[series["hr_vo2max_smoothed"].notna()]
    if series.empty:
        return 0
    offsets = read_activities(paths)[["activity_id", "utc_offset_s"]]
    series = series.merge(offsets, on="activity_id", how="left").sort_values("start_time_utc")
    local = pd.to_datetime(series["start_time_utc"], utc=True) + pd.to_timedelta(
        series["utc_offset_s"].fillna(0), unit="s"
    )
    rows: list[dict[str, Any]] = []
    value: float | None = None
    for when, smoothed in zip(
        local.dt.tz_localize(None), series["hr_vo2max_smoothed"], strict=True
    ):
        target = float(smoothed) - 1.5 + float(rng.normal(0.0, 0.4))
        # The watch moves slowly: a third of the way towards each new reading.
        value = target if value is None else value + (target - value) / 3.0
        max_met = round(value / 3.5, 5)
        rows.append(
            {
                "userProfilePK": 0,
                "calendarDate": f"{when:%Y-%m-%d}",
                "sport": "RUNNING",
                "subSport": "GENERIC",
                "maxMet": max_met,
                "vo2MaxValue": round(max_met * 3.5),
                "deviceId": 0,
                "updateTimestamp": f"{when + pd.Timedelta(hours=2):%Y-%m-%dT%H:%M:%S}.0",
            }
        )
    path = scratch / "MetricsMaxMetData_demo.json"
    path.write_text(json.dumps(rows, indent=1))
    sha256 = sha256_file(path)
    frame = read_max_met(path, athlete_id=DEMO_ATHLETE_ID, source_file_sha256=sha256)
    upsert_device_vo2max(paths, frame)
    append_ledger(
        paths,
        [
            {
                "source_file_sha256": sha256,
                "source_file": path.name,
                "activity_id": None,
                "source": SOURCE_GARMIN_EXPORT,
                "status": "vo2max",
                "ingested_at": datetime.now(UTC),
            }
        ],
    )
    return len(frame)


# --- The build -------------------------------------------------------------------------


def build(root: Path, *, end: date, weeks: int) -> Summary:
    """Build the demo store under ``root``. ``root/data`` must not exist yet."""
    if end < LAST_FIXTURE_DATE:
        raise ValueError(f"--end must be on or after {LAST_FIXTURE_DATE}, the last fixture run")
    if weeks < 3:
        raise ValueError("--weeks must be at least 3")
    paths = Paths(root=root)
    if paths.data.exists():
        raise FileExistsError(f"{paths.data} already exists; the demo store needs a fresh root")

    summary = Summary(root=root)
    clock = time.perf_counter()
    rng = np.random.default_rng(DEFAULT_SEED)

    with tempfile.TemporaryDirectory() as scratch_name:
        scratch = Path(scratch_name)
        dump = scratch / "fixtures"
        dump.mkdir()
        for name in [*FIXTURE_FILES.values(), FIXTURE_GPX]:
            shutil.copy(EXAMPLES / name, dump / name)
        result = ingest(paths, dump, athlete_id=DEMO_ATHLETE_ID, archive_kind="garmin")
        if result.errors:
            raise RuntimeError(f"ingesting the fixtures failed: {result.errors}")
        summary.fixtures = result.ingested
        summary.seconds["ingest fixtures"] = time.perf_counter() - clock

        clock = time.perf_counter()
        tracks = load_tracks()
        sessions = plan_sessions(end, weeks, tracks, rng)
        ingested_at = datetime(end.year, end.month, end.day, tzinfo=UTC) + timedelta(days=1)
        resting_hr_edit = end - timedelta(weeks=RESTING_HR_EDIT_WEEKS_BEFORE)

        activities: list[dict[str, Any]] = []
        lap_frames: list[pd.DataFrame] = []
        observations: list[dict[str, Any]] = []
        ledger: list[dict[str, Any]] = []
        known_ids = set(read_activities(paths)["activity_id"])
        for session in sessions:
            rendered = render(session, tracks, rng)
            activity, laps, stream, profile = to_canonical(
                session,
                rendered,
                tracks,
                seed=DEFAULT_SEED,
                ingested_at=ingested_at,
                resting_hr_edit=resting_hr_edit,
            )
            if activity.activity_id in known_ids:
                raise RuntimeError(f"two activities share the id {activity.activity_id}")
            known_ids.add(activity.activity_id)
            write_streams(paths, activity.activity_id, stream)
            activities.append(vars(activity))
            lap_frames.append(laps)
            if profile is not None:
                observations.append(profile)
            ledger.append(
                {
                    "source_file_sha256": activity.source_file_sha256,
                    "source_file": activity.source_file,
                    "activity_id": activity.activity_id,
                    "source": SOURCE_GARMIN_FIT,
                    "status": "ingested",
                    "ingested_at": ingested_at,
                }
            )
            summary.by_kind[session.kind] = summary.by_kind.get(session.kind, 0) + 1
            if session.kind == "ultra":
                summary.ultra_activity_id = activity.activity_id
                summary.ultra_elapsed_s = float(activity.elapsed_time_s or 0.0)
        summary.synthetic = len(activities)
        if activities:
            upsert_activities(paths, pd.DataFrame(activities)[ACTIVITY_SCHEMA.names])
            upsert_laps(paths, pd.concat(lap_frames, ignore_index=True))
        if observations:
            upsert_profile_observations(
                paths, pd.DataFrame(observations)[PROFILE_OBSERVATION_SCHEMA.names]
            )
        append_ledger(paths, ledger)
        summary.seconds["synthesise"] = time.perf_counter() - clock

        clock = time.perf_counter()
        summary.recompute = recompute(paths)
        if summary.recompute.errors:
            raise RuntimeError(f"recompute failed: {summary.recompute.errors}")
        summary.seconds["recompute"] = time.perf_counter() - clock

        clock = time.perf_counter()
        summary.device_vo2max_days = write_device_vo2max(paths, scratch, rng)
        summary.seconds["device vo2max"] = time.perf_counter() - clock

    stored = read_activities(paths)
    local = stored["start_time_utc"] + pd.to_timedelta(stored["utc_offset_s"].fillna(0), unit="s")
    summary.first_day = local.min().date()
    summary.last_day = local.max().date()
    summary.distance_km = float(stored["distance_m"].sum()) / 1000.0
    return summary


def print_summary(summary: Summary, paths: Paths) -> None:
    rc = summary.recompute
    assert rc is not None
    metrics = read_activity_metrics(paths)
    efforts = read_best_efforts(paths)
    print(f"demo store at {paths.data}")
    print(f"  {summary.fixtures} fixture runs ingested, {summary.synthetic} synthetic runs added")
    print("  " + ", ".join(f"{kind} {n}" for kind, n in sorted(summary.by_kind.items())))
    print(
        f"  {summary.first_day} to {summary.last_day}, {summary.distance_km:.0f} km, "
        f"{metrics['moving_time_s'].sum() / 3600:.0f} h moving"
    )
    if summary.ultra_activity_id is not None:
        print(
            f"  ultra {summary.ultra_activity_id}: {summary.ultra_elapsed_s / 3600:.2f} h elapsed"
        )
    print(
        f"  recompute: {rc.activities} runs, {rc.best_efforts} best efforts "
        f"over {efforts['distance_key'].nunique()} distances, "
        f"{rc.efficiency_rows} efficiency rows, {rc.fitness_rows} fitness rows, "
        f"{rc.routes} routes, {rc.territory_claims} territory "
        f"claims ({rc.territory_area_m2 / 1e6:.2f} km2), {rc.profile_intervals} profile "
        f"intervals, {rc.reclassified} reclassified"
    )
    print(f"  device VO2max: {summary.device_vo2max_days} days")
    print("  " + ", ".join(f"{step} {s:.1f} s" for step, s in summary.seconds.items()))


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0] if __doc__ else None)
    parser.add_argument("root", type=Path, help="store root; <root>/data must not exist yet")
    parser.add_argument(
        "--end",
        type=date.fromisoformat,
        default=date.today(),
        help="last day of the history, YYYY-MM-DD (default: today)",
    )
    parser.add_argument("--weeks", type=int, default=DEFAULT_WEEKS, help="weeks of history")
    args = parser.parse_args(argv)
    try:
        summary = build(args.root, end=args.end, weeks=args.weeks)
    except (ValueError, FileExistsError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print_summary(summary, Paths(root=args.root))
    return 0


if __name__ == "__main__":
    sys.exit(main())
