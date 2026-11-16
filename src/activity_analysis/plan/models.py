"""The plan file's schema.

These models are the single source of truth for a plan: the CLI validates a
draft against them, the API serves them, and the generated TypeScript types
come from them. Everything stored is SI and every date is the athlete's local
calendar date, so a plan never depends on the timezone of the machine reading it.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date, datetime
from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

SessionKind = Literal[
    "easy",
    "long",
    "intervals",
    "tempo",
    "threshold",
    "strides",
    "time_trial",
    "race",
    "rest",
    "cross_training",
]

#: Every kind but the two that are not running. The runs-per-week limit counts these.
RUNNING_KINDS: frozenset[str] = frozenset(
    {"easy", "long", "intervals", "tempo", "threshold", "strides", "time_trial", "race"}
)

Weekday = Literal["mon", "tue", "wed", "thu", "fri", "sat", "sun"]

VersionStatus = Literal["proposed", "accepted", "superseded", "rejected", "withdrawn"]
GoalStatus = Literal["proposed", "active", "archived", "closed"]

ID_PATTERN = r"^[a-z0-9][a-z0-9-]{0,99}$"

#: How far a week's planned zone minutes may differ from its sessions' planned duration.
ZONE_MINUTES_TOLERANCE = 0.10


def planned_trimp(minutes: Sequence[float], per_minute: Sequence[float | None]) -> float | None:
    """Zone minutes weighted by the athlete's TRIMP per minute in each zone.

    None when a zone with planned minutes has no factor.
    """
    total = 0.0
    for m, p in zip(minutes, per_minute, strict=True):
        if m > 0:
            if p is None:
                return None
            total += m * p
    return total


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SpeedRange(_Strict):
    low_mps: float = Field(gt=0)
    high_mps: float = Field(gt=0)

    @model_validator(mode="after")
    def _ordered(self) -> Self:
        if self.low_mps > self.high_mps:
            raise ValueError("low_mps must not exceed high_mps")
        return self


class HeartRateRange(_Strict):
    #: A range without a floor is a ceiling: "up to high_bpm".
    low_bpm: float | None = Field(default=None, gt=0)
    high_bpm: float = Field(gt=0)

    @model_validator(mode="after")
    def _ordered(self) -> Self:
        if self.low_bpm is not None and self.low_bpm > self.high_bpm:
            raise ValueError("low_bpm must not exceed high_bpm")
        return self


StepRole = Literal["warmup", "work", "recovery", "cooldown", "strides"]


class Step(_Strict):
    #: Strides are their own role, not work: a few short pickups inside an easy
    #: run, which no check or chart reads as the session's quality.
    role: StepRole
    repeat: int = Field(default=1, ge=1)
    distance_m: float | None = Field(default=None, gt=0)
    duration_s: float | None = Field(default=None, gt=0)
    speed: SpeedRange | None = None
    heart_rate: HeartRateRange | None = None
    note: str | None = None

    @model_validator(mode="after")
    def _one_extent(self) -> Self:
        if (self.distance_m is None) == (self.duration_s is None):
            raise ValueError("a step needs exactly one of distance_m and duration_s")
        return self


class Session(_Strict):
    id: str = Field(pattern=ID_PATTERN)
    date: date
    kind: SessionKind
    title: str
    description: str
    planned_distance_m: float | None = Field(default=None, gt=0)
    planned_duration_s: float | None = Field(default=None, gt=0)
    steps: list[Step] = []


class Week(_Strict):
    start_date: date
    phase: str
    focus: str
    planned_distance_m: float = Field(ge=0)
    detailed: bool
    sessions: list[Session] = []
    #: Minutes planned in heart-rate zones 1 to 5.
    planned_zone_minutes: list[float] | None = Field(default=None, min_length=5, max_length=5)
    expected_vdot: float | None = Field(default=None, gt=0)
    expected_garmin_vo2max: float | None = Field(default=None, gt=0)
    #: One or two sentences on how to run the week given its load, written by Claude.
    load_note: str | None = None

    @field_validator("planned_zone_minutes")
    @classmethod
    def _non_negative(cls, value: list[float] | None) -> list[float] | None:
        if value is not None and any(m < 0 for m in value):
            raise ValueError("planned_zone_minutes must not be negative")
        return value


class Goal(_Strict):
    goal_id: str = Field(pattern=ID_PATTERN)
    distance_m: float = Field(gt=0)
    target_time_s: float = Field(gt=0)
    race_date: date
    surface: Literal["track", "road", "trail", "other"]
    note: str | None = None


class Constraints(_Strict):
    runs_per_week: int = Field(ge=1, le=14)
    run_days: list[Weekday] | None = None
    track_days: list[Weekday] | None = None
    notes: str | None = None


class Citation(_Strict):
    label: str
    #: A JSON Pointer (RFC 6901) into the version's stored context.
    pointer: str = Field(pattern=r"^/")


class Assessment(_Strict):
    summary: str
    #: Claude's own estimate of the goal distance today, None when no recent
    #: effort supports one and a time trial is scheduled instead.
    estimate_s: float | None = Field(default=None, gt=0)
    estimate_reasoning: str
    verdict: Literal["likely", "possible", "unlikely"]
    citations: list[Citation] = []


class ChangeEntry(_Strict):
    title: str
    reason: str
    session_ids: list[str] = []
    goal_change: bool = False


class Outcome(_Strict):
    session_id: str
    verdict: Literal["done", "partial", "missed", "moved", "replaced"]
    activity_ids: list[str] = []
    note: str = ""


class Checkpoint(_Strict):
    session_id: str
    description: str
    target_time_s: float | None = Field(default=None, gt=0)


class RaceResult(_Strict):
    time_s: float | None = Field(gt=0)
    achieved: bool
    note: str = ""


class PlanDraft(_Strict):
    """The file Claude writes; the CLI adds provenance when it stores it."""

    goal: Goal
    constraints: Constraints
    assessment: Assessment
    weeks: list[Week]
    changes: list[ChangeEntry] = []
    outcomes: list[Outcome] = []
    checkpoints: list[Checkpoint] = []
    result: RaceResult | None = None


class SnapshotPrediction(_Strict):
    distance_key: str
    distance_m: float
    model: str
    predicted_time_s: float
    low_s: float | None
    high_s: float | None


class LoadPoint(_Strict):
    """Fitness, fatigue and form at the end of one local day."""

    local_date: date
    ctl: float
    atl: float
    form: float


class ExpectedLoadWeek(_Strict):
    """One Monday-started week of the expected series, as ``training_load_weekly`` has it."""

    week_start: date
    #: How many of the week's days the series holds, under 7 only in the race week.
    days: int
    #: The week's TRIMP: measured on the days up to the start, planned after it.
    trimp: float
    ctl_mean: float
    atl_mean: float
    form_mean: float
    #: The end of the Sunday before the week; null on a stamp from before it existed.
    start: LoadPoint | None = None
    #: The end of the week's Sunday, or race morning in the race week.
    end: LoadPoint | None = None


class ExpectedLoad(_Strict):
    """Fitness, fatigue and form carried from the last measured day through the planned load.

    ``propose`` computes it; Claude never writes it. See
    docs/reference/math/plan-projection.md.
    """

    #: The context's last ``load`` day, which the projection starts from.
    start: LoadPoint
    #: The end of the day before the race.
    race_morning: LoadPoint
    #: From the week holding the day after ``start`` through the race week.
    weeks: list[ExpectedLoadWeek]
    #: Goals whose plans supplied the planned load before this plan's first week.
    bridged_from: list[str] = []


class Provenance(_Strict):
    number: int = Field(ge=1)
    revises: int | None
    created_at: datetime
    data_through: date | None
    snapshot: list[SnapshotPrediction]
    lthr_bpm: float | None = None
    zone_boundaries_bpm: list[float] | None = None
    #: The athlete's TRIMP per minute in zones 1 to 5 when the plan was proposed.
    trimp_per_minute: list[float | None] | None = None
    target_vdot: float | None = None
    estimate_vdot: float | None = None
    #: What the planned load does to fitness and fatigue, or null when it cannot be projected.
    expected_load: ExpectedLoad | None = None

    @field_validator("trimp_per_minute")
    @classmethod
    def _five_zones(cls, value: list[float | None] | None) -> list[float | None] | None:
        if value is not None and len(value) != 5:
            raise ValueError("trimp_per_minute needs exactly five values, one per zone")
        return value


class PlanVersion(PlanDraft):
    """The stored version: a draft plus what the CLI stamped on it."""

    provenance: Provenance


class VersionEntry(_Strict):
    number: int
    status: VersionStatus


class GoalIndex(_Strict):
    goal_id: str = Field(pattern=ID_PATTERN)
    status: GoalStatus
    versions: list[VersionEntry]
