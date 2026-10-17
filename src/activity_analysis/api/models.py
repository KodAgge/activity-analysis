"""Response models.

Field names are the store's, units included, so that the unit survives into
the generated TypeScript types and a reader of the frontend can see it without
looking it up.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, Field, model_validator


def _to_utc(value: datetime) -> datetime:
    """Pin an instant to UTC, whatever timezone it arrived in.

    DuckDB returns a TIMESTAMPTZ converted to the session timezone, so the
    same stored instant reaches Python as +02:00 on a machine at UTC+2 and
    as +00:00 on a UTC runner. Serialising that verbatim would make the
    payload depend on where the server happens to be, under a field name that
    says otherwise, and the frontend computes local wall clock as
    ``start_time_utc + utc_offset_s``: adding an offset to an already-offset
    timestamp lands two hours late.
    """
    return value.astimezone(UTC)


#: An instant, always in UTC. Pydantic serialises a UTC-aware datetime with
#: a trailing ``Z``, and keeps ``format: date-time`` in the OpenAPI schema, so
#: the generated client still gets a date rather than a bare string.
UtcInstant = Annotated[datetime, AfterValidator(_to_utc)]


class Health(BaseModel):
    """What store the server is looking at, and whether the code can read it."""

    root: str
    canonical: str
    derived: str
    counts: dict[str, int]
    expected_ingest_version: int
    expected_analysis_version: int
    #: The distinct versions actually present in the stored files. A list
    #: rather than a scalar because a partially rewritten store holds more
    #: than one, and that is exactly the state worth seeing.
    stored_ingest_versions: list[int]
    stored_analysis_versions: list[int]
    stale: bool


class ActivitySummary(BaseModel):
    """One row of the browser, and the summary block of the detail view."""

    activity_id: str
    #: The instant. Local wall clock is this plus ``utc_offset_s``, computed
    #: by the frontend. A preformatted local string is deliberately not sent:
    #: a string cannot be sorted, bucketed or compared, so the frontend would
    #: need the instant anyway, and sending both invites them to disagree.
    start_time_utc: UtcInstant
    #: The offset the watch was set to. Null for GPX, which records none.
    utc_offset_s: int | None
    #: The sport the activity is counted as: the recorded one, except for a run
    #: ``recompute`` counted as a walk for being slower than 9:00/km.
    sport: str | None
    #: What the device wrote, which differs from ``sport`` only for such a walk.
    recorded_sport: str | None
    sub_sport: str | None
    name: str | None
    distance_m: float | None
    elapsed_time_s: float | None
    #: The device's own timer, which stops under its auto-pause setting.
    timer_time_s: float | None
    #: The derived layer's own definition - elapsed minus paused time under
    #: this project's 15 s / 0.5 m/s rule (``activity_metrics.moving_time_s``),
    #: joined in rather than read from the canonical column of the same name.
    #: The canonical ``activities.moving_time_s`` is a byte-identical
    #: duplicate of ``timer_time_s`` - see docs/reference/api.md,
    #: "``moving_time_s`` is always the derived layer's" - and the browser
    #: needs the real one: the two disagree by tens of minutes on the real
    #: history, which elapsed time would silently show as moving time in a
    #: column a reader scans quickly. Null for every non-running activity,
    #: which the derived layer does not cover, and for a running one ingested
    #: but not yet recomputed.
    moving_time_s: float | None
    ascent_m: float | None
    descent_m: float | None
    #: ``coalesce(activity_metrics.avg_speed_mps, activities.avg_speed_mps)``,
    #: so it is the derived layer's wherever that layer covers the activity
    #: and the device's own session average everywhere else.
    #:
    #: The derived value is the activity's **canonical** distance over this
    #: project's ``moving_time_s``, which is why it agrees with the
    #: ``distance_m`` and ``moving_time_s`` rendered beside it: a row served
    #: that value multiplies out. The fallback carries the device's own
    #: definition instead, an average over the device's auto-paused timer,
    #: and it fires on every non-running activity, which the derived layer
    #: does not cover, and on running rows whose distance or moving time is
    #: not positive.
    #:
    #: **A client cannot tell from the row which of the two it received.**
    #: No field distinguishes them and none of the obvious candidates works.
    #: That is a cost accepted rather than overlooked; see
    #: docs/reference/math/units.md, which owns the measurements and the
    #: argument for the numerator.
    avg_speed_mps: float | None
    max_speed_mps: float | None
    avg_hr_bpm: float | None
    max_hr_bpm: float | None
    avg_cadence_spm: float | None
    calories: float | None
    source: str
    #: Which distances this activity holds a personal record at, ordered by
    #: the distance rather than by the key's spelling. Empty for the great
    #: majority of real runs, which hold none.
    #:
    #: Read from the analysis layer's own ``pr`` tags, never re-derived: the
    #: first eligible effort at a distance is a record, a treadmill effort
    #: cannot be one, and an effort whose ``distance_trusted`` is not true
    #: cannot be one either. See ``queries.PR_DISTANCE_KEYS_FROM`` for why
    #: that matters concretely.
    pr_distance_keys: list[str]


class Record(BaseModel):
    """The best eligible effort at one distance, and what it beat."""

    #: The analysis layer's own key, one of ``STANDARD_DISTANCES_M`` in
    #: ``analysis/best_efforts.py``. The served set is every standard
    #: distance some activity has an eligible effort at, so it grows with the
    #: history rather than being fixed here: as of 2026-09-12 the real store
    #: yields nineteen of the twenty-two, and a twentieth appears the day a
    #: run first covers 30 km.
    #:
    #: Not an enum, and not enumerated here either, because the set belongs
    #: to ``analysis/best_efforts.py`` and a closed one would 500 the whole
    #: endpoint the day a distance is added.
    distance_key: str
    #: The distance the key names, in metres, so a client can order the keys
    #: without hardcoding what they mean.
    distance_m: float
    #: Elapsed, not moving: a best effort spans its pauses, because the one
    #: rule under which resting is free is the wrong one. See CLAUDE.md,
    #: "Best efforts are elapsed time and span pauses".
    elapsed_time_s: float
    avg_hr_bpm: float | None
    #: How many *eligible* efforts at this distance the history holds - the
    #: number this one is the best of. Ineligible efforts are not counted,
    #: since they were never comparable.
    effort_count: int
    activity_id: str
    start_time_utc: UtcInstant
    #: The offset the watch was set to, for the local wall clock. Null for a
    #: GPX-sourced activity, which records none.
    utc_offset_s: int | None
    name: str | None


class Records(BaseModel):
    """Every distance the history holds an eligible effort at, shortest first."""

    items: list[Record]


class ActivityPage(BaseModel):
    total: int
    limit: int
    offset: int
    items: list[ActivitySummary]


class SportCount(BaseModel):
    sport: str | None
    count: int


class Lap(BaseModel):
    lap_index: int
    start_time_utc: UtcInstant
    trigger: str | None
    elapsed_time_s: float | None
    distance_m: float | None
    avg_speed_mps: float | None
    avg_hr_bpm: float | None
    max_hr_bpm: float | None
    avg_cadence_spm: float | None
    ascent_m: float | None
    descent_m: float | None
    calories: float | None


class ZoneBucket(BaseModel):
    """Seconds in one zone for one activity.

    Boundaries are repeated here because for a single activity there is one
    profile in force and those numbers are true of it. See ``ZoneTotal`` for
    why a sum across a period cannot say the same.
    """

    zone_index: int
    low_bpm: float | None
    high_bpm: float | None
    seconds_s: float


class BestEffort(BaseModel):
    """The fastest window at a standard distance.

    Elapsed time, so it spans pauses: 5 km, five minutes standing still, then
    5 km is a 65:00 ten kilometre. The three flags say what the window
    contained, so a consumer can qualify an effort rather than trust or
    discard it blindly.
    """

    distance_key: str
    distance_m: float
    elapsed_time_s: float
    start_t_s: float
    end_t_s: float
    avg_hr_bpm: float | None
    #: Nullable for the reason every column beside them is: a file written
    #: before a flag existed carries no value for it, and the store projects
    #: that as a null rather than raising. Never coalesced to False, which
    #: would assert an effort was clean when nobody looked.
    contains_pause: bool | None
    contains_outage: bool | None
    contains_jump: bool | None
    #: Metres the device's measured speed accounts for over the window. Null
    #: when the speed channel was derived from the distance itself, which
    #: GPX always is, since it then confirms nothing.
    speed_distance_m: float | None
    #: Whether the recorded distance may be trusted: no jump, or a jump the
    #: measured speed confirms within 1%. Null on a file written before it
    #: existed, never coalesced, like the flags above.
    distance_trusted: bool | None
    #: Whether this effort may be a record, and if not why: the progression
    #: chart's two columns for the same effort, from the same rule.
    is_eligible: bool
    ineligible_reason: str | None


class ActivityMetrics(BaseModel):
    elapsed_time_s: float | None
    moving_time_s: float | None
    paused_time_s: float | None
    distance_m: float | None
    ascent_per_km_m: float | None
    #: Nullable for the same reason the best-effort flags are: an
    #: ANALYSIS_VERSION bump that adds a flag leaves every stored file without
    #: it until recompute rewrites them, and null is what the store serves in
    #: the meantime.
    is_indoor: bool | None
    has_hr: bool | None
    has_gps: bool | None
    is_gpx_sourced: bool | None
    #: Where the activity started, resolved offline from its first fixed
    #: position - see ``analysis/places.py``. All four are null together for
    #: an activity with no position at all, every treadmill run among them.
    locality: str | None
    country_code: str | None
    country: str | None
    #: How far the start was from the place named above, in metres.
    #:
    #: Served rather than hidden because a match is not always close: the
    #: worst on the real history is 27.9 km, a remote start with nothing
    #: closer in the table. A client that wants to show
    #: only the country for a distant match needs this number to decide;
    #: making that decision in the derived layer would throw away the
    #: evidence for it.
    locality_distance_m: float | None


class ActivityTag(BaseModel):
    """One computed tag and the numbers that fired it.

    ``kind`` is ``effort`` for the exclusive session classification, of which
    there is at most one, or ``flag`` for an additive fact such as a personal
    record, of which there can be several. ``reason`` is always populated: a
    classifier whose reasoning is hidden stops being trusted the first time it
    is wrong.

    ``distance_key`` is the machine-readable half of a ``pr`` row: one run can
    record at several distances at once, so without it a client rendering
    ``tag`` as a chip shows the same chip repeated and has to parse ``reason``,
    which is prose. Null on every tag that is not about one distance.

    ``rep_count`` is the same argument for an ``intervals`` row: the count is
    otherwise only readable inside ``reason``'s prose, and that is explicitly
    not a parsing surface. Null on every tag that is not an ``intervals``
    effort.

    ``rep_pattern`` is the raw per-lap "R"/"W"/"-" string `interval_reps`
    found, one character per recorded lap in recorded order, so a client can
    tell which individual laps were reps and which were recoveries without
    recomputing ``analysis.tags``'s own cadence-and-pace rule. Null on every
    tag that is not an ``intervals`` effort, for the same reason
    ``rep_count`` is, and null on a row written before this column existed.
    """

    kind: str
    tag: str
    distance_key: str | None
    rep_count: int | None
    rep_pattern: str | None
    reason: str


class DecouplingOut(BaseModel):
    """One run's aerobic decoupling and the two halves it compares.

    The halves are halves of the seconds carrying both speed and heart rate,
    not of elapsed time; see docs/reference/math/efficiency.md.
    """

    #: First-half against second-half efficiency, as a percentage change.
    #: Positive means the second half cost more heart rate per unit speed.
    decoupling_pct: float
    first_half_speed_mps: float
    second_half_speed_mps: float
    first_half_hr_bpm: float
    second_half_hr_bpm: float
    #: Null when the store predates the column: not known, never false.
    is_aerobic_long_run: bool | None
    #: Null on a run in the population the 5% line is read over. Otherwise
    #: display prose saying why this run's number is not a durability
    #: reading, rendered in the open beside it.
    outside_population_reason: str | None


class DerivedBlocks(BaseModel):
    metrics: ActivityMetrics
    zones: list[ZoneBucket]
    best_efforts: list[BestEffort]
    #: Empty rather than null when a run could not be classified. Null is
    #: reserved for the whole derived block being absent.
    tags: list[ActivityTag]
    #: Null when the run has no decoupling value, paired with
    #: ``decoupling_absent_reason``; exactly one of the two is null.
    decoupling: DecouplingOut | None
    decoupling_absent_reason: str | None


class Reclassification(BaseModel):
    """Why an activity recorded as one sport is counted as another.

    Both speeds in m/s like every speed the API serves; the frontend formats
    them as pace.
    """

    recorded_sport: str
    sport: str
    #: The canonical distance over the derived moving time, the pace judged.
    avg_speed_mps: float
    #: The speed it fell below, 9:00/km.
    threshold_mps: float


class ActivityDetail(BaseModel):
    summary: ActivitySummary
    laps: list[Lap]
    #: Null for an activity the derived layer does not cover, which is every
    #: sport but running. Explicitly null rather than omitted, and paired with
    #: a reason, so the frontend can say what is missing instead of rendering
    #: a page of empty panels.
    derived: DerivedBlocks | None
    derived_absent_reason: str | None
    #: Null unless ``recompute`` counted this run as a walk, in which case it
    #: says so with the pace it was judged on; ``derived`` is then null too.
    reclassification: Reclassification | None
    #: Null for a run in no route and for a non-running activity, which
    #: ``analysis.routes`` never considers. Explicitly null rather than
    #: omitted, like ``derived``, so the frontend can tell "no route" from a
    #: field it forgot to ask for.
    route: ActivityRoute | None


class Streams(BaseModel):
    """One activity's 1 Hz grid, column-major.

    Column-major because it is what uPlot consumes. A row-major array of
    objects would be transposed in the browser on every load, and it repeats
    each field name once per sample, which is most of the bytes.

    Full resolution, no server-side decimation. Even the longest run in the
    real export is a small gzipped payload from a server on the same machine,
    so downsampling would buy nothing while costing a decimation policy, a
    refetch-on-zoom path, and a class of bug where the chart and the lap
    splits disagree because they were computed at different resolutions. The
    measured payload sizes are in ``docs/reference/api.md``.

    Named channels rather than a mapping, so the generated TypeScript carries
    a field per channel and a typo in the frontend is a compile error.

    ``paused`` and ``outage`` travel with the samples so the frontend can show
    where recording stopped instead of drawing a straight line through it as
    though the athlete had run it.
    """

    activity_id: str
    sample_count: int
    t_s: list[float]
    distance_m: list[float | None]
    speed_mps: list[float | None]
    hr_bpm: list[float | None]
    cadence_spm: list[float | None]
    altitude_m: list[float | None]
    lat_deg: list[float | None]
    lon_deg: list[float | None]
    #: Nullable like every other channel, because a grid written before the
    #: flag existed carries no value for it. Not paused and not known are
    #: different facts, and the second is never coalesced into the first.
    paused: list[bool | None]
    outage: list[bool | None]


class PeriodBucket(BaseModel):
    """Volume in one calendar period. Serves both weeks and months."""

    period_start: date
    runs: int
    distance_m: float
    moving_time_s: float


class ZoneTotal(BaseModel):
    """Seconds in a zone, summed over a period.

    Boundaries are deliberately not repeated here. They are time-versioned per
    athlete, so a sum across a period during which the athlete's maximum heart
    rate changed has no single pair of boundaries, and inventing one would
    present a guess as a measurement. ``Overview.zone_boundaries_bpm`` carries
    the currently configured boundaries instead, clearly as a separate thing.
    """

    zone_index: int
    seconds_s: float


class Streak(BaseModel):
    current_weeks: int
    longest_weeks: int
    longest_ended_week: date | None


class Consistency(BaseModel):
    """Weeks with a run out of weeks considered.

    A count out of a count, not a percentage: 30 of 52 is a fact and 58% is a
    rounding of it.
    """

    weeks_considered: int
    weeks_with_a_run: int


class Overview(BaseModel):
    weeks: list[PeriodBucket]
    months: list[PeriodBucket]
    zones: list[ZoneTotal]
    #: The boundaries from the profile in force now. Empty when no profile is
    #: stored, which is the state before the first FIT with zone settings.
    zone_boundaries_bpm: list[float]
    streak: Streak
    consistency: Consistency
    first_run_local_date: date | None
    last_run_local_date: date | None
    #: The latest activity of any sport, so where the store's history ends.
    #: A week after it is unknown rather than a week off: the export the store
    #: was built from ends there. Null on an empty store.
    last_activity_local_date: date | None


class ReferencePacesOut(BaseModel):
    """The three fixed paces the trends are reported at, as speeds.

    Speeds rather than paces because everything at this boundary is SI and
    pace is a presentation of speed. All three are null on a store with no
    fit yet, which is the state before the efficiency pass has run.
    """

    slow_mps: float | None
    median_mps: float | None
    fast_mps: float | None


class TrendPoint(BaseModel):
    """One activity's normalised efficiency: what heart rate and cadence would
    have been at each reference pace, rather than what they averaged at the
    pace the athlete happened to run."""

    activity_id: str
    start_time_utc: UtcInstant
    #: The offset the watch was set to, for the local wall clock. Null for a
    #: GPX-sourced activity, which records none.
    utc_offset_s: int | None
    #: The session classification the row was fitted under, so a client can
    #: narrow the trend to easy runs without a second request.
    effort_tag: str | None
    #: Each channel is nullable on its own: a run with no heart rate still
    #: has cadence, and 84 early runs on the real history have no heart rate
    #: at all.
    hr_at_slow_bpm: float | None
    hr_at_median_bpm: float | None
    hr_at_fast_bpm: float | None
    cadence_at_slow_spm: float | None
    cadence_at_median_spm: float | None
    cadence_at_fast_spm: float | None
    #: Trailing 42-day means of the six fields above. The raw values are 4.6
    #: times noisier than the gap between the three references, so a consumer
    #: plotting the raw ones gets one jagged band rather than three series;
    #: see docs/reference/math/efficiency.md.
    hr_at_slow_smoothed_bpm: float | None
    hr_at_median_smoothed_bpm: float | None
    hr_at_fast_smoothed_bpm: float | None
    cadence_at_slow_smoothed_spm: float | None
    cadence_at_median_smoothed_spm: float | None
    cadence_at_fast_smoothed_spm: float | None
    #: The slope after shrinkage toward the shared one, and how much of its
    #: own slope the activity kept. A weight of zero means it took the shared
    #: slope entirely, which is what a run held at one pace should do.
    hr_slope_shrunk_bpm_per_mps: float | None
    hr_slope_weight: float | None
    cadence_slope_shrunk_spm_per_mps: float | None
    cadence_slope_weight: float | None
    #: First-half against second-half efficiency, as a percentage change.
    decoupling_pct: float | None
    #: Whether this run is in the population decoupling is interpretable over:
    #: an easy or steady run of at least 40 fitted minutes. Across every
    #: session the metric measures the shape of the session rather than the
    #: athlete, so a client plotting it unfiltered plots noise.
    #:
    #: Nullable like every other flag read from a stored derived column: an
    #: ``activity_efficiency.parquet`` written before this column existed
    #: carries no value for it, and a null means not known rather than false.
    is_aerobic_long_run: bool | None
    #: Trailing 90-day mean of decoupling over that population, and so null on
    #: every run outside it.
    decoupling_smoothed_pct: float | None
    #: Seconds that entered the fit, so a reader can weigh a fit over 40
    #: minutes differently from one over 6.
    fit_seconds: int | None


class Trends(BaseModel):
    """The efficiency trend over the whole history, oldest first."""

    references: ReferencePacesOut
    #: The whole-history slopes the per-activity ones are shrunk toward.
    #: Served so a chart can state which fit the points were measured
    #: against; these drift as history grows.
    hr_slope_shared_bpm_per_mps: float | None
    cadence_slope_shared_spm_per_mps: float | None
    items: list[TrendPoint]


class DistributionRun(BaseModel):
    """One running activity's values for the distributions view, in SI.

    Every field the frontend can bucket a histogram on lives here, so a
    variable switch is a re-bucket of this same row rather than a second
    request. Every field but ``activity_id`` and the instant is nullable on
    its own: a value the view has nothing to bucket for a given
    run is a real absence, not a zero.
    """

    activity_id: str
    start_time_utc: UtcInstant
    #: The offset the watch was set to, for the local wall clock and for
    #: bucketing a run by the local day of week. Null for a GPX-sourced
    #: activity, which records none.
    utc_offset_s: int | None
    #: Null means not known, never coalesced to false - see CLAUDE.md's
    #: "athlete_profile is time-versioned" section and this file's "The
    #: derived layer's flags are nullable" above.
    is_indoor: bool | None
    #: The canonical session total, not ``activity_metrics``'s own
    #: ``distance_m``, which is the 1 Hz grid's odometer and disagrees with
    #: this figure on a treadmill run. See ``queries.distributions``.
    distance_m: float | None
    moving_time_s: float | None
    elapsed_time_s: float | None
    avg_speed_mps: float | None
    avg_hr_bpm: float | None
    max_hr_bpm: float | None
    avg_cadence_spm: float | None
    ascent_per_km_m: float | None
    #: Null on a run the efficiency pass has not fitted, which still carries
    #: every other field: the two joins in ``queries.distributions`` are
    #: independent, so a missing fit narrows only these two variables.
    hr_at_median_bpm: float | None
    cadence_at_median_spm: float | None
    decoupling_pct: float | None
    is_aerobic_long_run: bool | None
    #: Local calendar days since the previous running activity's start, over
    #: the whole history. Null on the first run. See
    #: docs/reference/math/rest-days.md.
    days_since_previous_run: int | None


class DistributionReferences(BaseModel):
    """The one reference pace a distributions variable is measured against.

    Named ``median_mps`` to match ``ReferencePacesOut.median_mps`` on
    ``/api/trends``: the same number, read from the same table, keeps the
    same name at this boundary. Null on a store with no fit yet, the state
    before the efficiency pass has run, and the two pace-at-reference
    variables then show their own absence state rather than a wrong pace.
    """

    median_mps: float | None


class Distributions(BaseModel):
    """Every running activity, one row each, for the frontend to bucket.

    No query parameters: the view needs every run at once, to fix the axis
    over the whole history, to switch variables without a round trip, and to
    list a bucket's runs, so paging or filtering here would just move the
    frontend's aggregation into a second request per interaction. See
    docs/reference/api.md.
    """

    references: DistributionReferences
    runs: list[DistributionRun]


class FitnessPoint(BaseModel):
    """One activity's VO2max estimates, by both methods.

    Either may be null on its own: the heart rate estimate needs a qualifying
    intensity and a known maximum heart rate, VDOT needs an eligible best
    effort, and those are different sets of runs.
    """

    activity_id: str
    start_time_utc: UtcInstant
    hr_vo2max: float | None
    #: The reported number. The raw column above is what a chart draws
    #: faintly underneath it.
    hr_vo2max_smoothed: float | None
    vdot: float | None
    #: Which distance the VDOT came from, so a reader can see whether a peak
    #: was a 400 m or a half marathon.
    vdot_distance_key: str | None
    vdot_smoothed: float | None
    #: Qualifying 30 s segments behind ``hr_vo2max``, so an estimate from 10
    #: minutes of data can be told from one from an hour.
    qualifying_segments: int | None


class DeviceVo2maxPoint(BaseModel):
    """Garmin's own running VO2max on one calendar day.

    A reference beside this project's two estimates, not a third estimate:
    see ``docs/reference/math/vo2max.md``, "Against Garmin's own".
    ``calendar_date`` is the day as the device recorded it; it is not
    ``date`` because a field named after its own type does not resolve.
    """

    calendar_date: date
    #: ``maxMet`` × 3.5, unrounded, ml/kg/min.
    vo2max: float
    #: The whole number the watch shows.
    vo2max_reported: int


class Fitness(BaseModel):
    """The VO2max series, both methods, oldest first, and Garmin's own by day."""

    items: list[FitnessPoint]
    #: Empty when no Garmin export has been ingested.
    device: list[DeviceVo2maxPoint]


class RaceModel(BaseModel):
    """One model's prediction at one distance."""

    #: ``riegel``, ``cameron`` or ``ordinary_runs``. Not
    #: an enum, for the same reason ``Record.distance_key`` is not: the set
    #: belongs to the analysis layer.
    model: str
    predicted_time_s: float
    low_s: float | None
    high_s: float | None
    #: ``best_efforts`` or ``ordinary_runs``. The two are shown differently:
    #: the best-effort models are read together as a range, the ordinary-run
    #: prediction stands alone with its own band.
    source: str

    @model_validator(mode="after")
    def _ordinary_runs_must_carry_a_band(self) -> RaceModel:
        """A prediction from ordinary running is about 5% wide on a 5 km.

        Reporting the number without the band invites it to be read with the
        precision of a best-effort prediction, which it does not have. The
        best-effort models may omit the band because their spread is the
        range across the two models, shown by the caller.
        """
        if self.source == "ordinary_runs" and (self.low_s is None or self.high_s is None):
            raise ValueError("an ordinary_runs prediction must carry low_s and high_s")
        return self


class Prediction(BaseModel):
    """Every model's prediction at one distance."""

    distance_key: str
    distance_m: float
    models: list[RaceModel]


class Predictions(BaseModel):
    """Race predictions, or an explicit statement that there are none.

    ``insufficient_data`` with a ``reason`` is a real state rather than an
    empty list, because the alternative is extrapolating from a single effort
    and presenting the result as a prediction.
    """

    items: list[Prediction]
    insufficient_data: bool
    reason: str | None


class ProgressionPoint(BaseModel):
    """One effort at one distance, and where it stands in the record ladder."""

    activity_id: str
    start_time_utc: UtcInstant
    utc_offset_s: int | None
    name: str | None
    #: Elapsed, spanning pauses, like every best effort.
    elapsed_time_s: float
    avg_hr_bpm: float | None
    locality: str | None
    is_eligible: bool
    #: Whether this effort set a record when it happened: a staircase over
    #: eligible efforts in time order, not whether it is the current best.
    is_record: bool
    #: ``treadmill``, ``not known to be outdoors``, one of the three jump
    #: reasons in ``analysis.best_efforts`` when ineligible, so the chart can
    #: say why a faster point did not count rather than leaving it to be read
    #: as a bug. Null when eligible.
    ineligible_reason: str | None
    #: The raw flag, so an eligible effort that holds a jump the measured
    #: speed confirmed can say so rather than look like any clean one.
    contains_jump: bool | None


class Progression(BaseModel):
    """Every effort at one distance, oldest first, with the counts behind it."""

    distance_key: str
    distance_m: float
    effort_count: int
    eligible_count: int
    record_count: int
    items: list[ProgressionPoint]


class RouteSummary(BaseModel):
    """One recurring route: which runs follow it, and its current record.

    ``analysis.routes`` decides what a route is and what an eligible run on
    one is; this projects the ``routes`` table and the ``rank = 1`` row of
    ``route_runs`` unchanged, the same split every other endpoint in this
    file keeps.
    """

    route_id: str
    name: str
    locality: str | None
    run_count: int
    median_distance_m: float
    first_run_utc: UtcInstant
    last_run_utc: UtcInstant
    #: The rank 1 run's own speed and identity, read from that row rather
    #: than recomputed. All four null together when every run on the route
    #: is ineligible, so there is no rank 1 row to join: a route can exist
    #: with no record, and inventing one from an ineligible run would be
    #: exactly the mistake ``GET /api/records`` refuses to make.
    record_speed_mps: float | None
    record_activity_id: str | None
    record_start_time_utc: UtcInstant | None
    #: The rank 1 run's ``activities.utc_offset_s``, for the record's local
    #: wall clock. Also null when that run recorded no offset; a GPX-sourced
    #: run, the usual case of one, is never eligible and so never rank 1.
    record_utc_offset_s: int | None


class RouteRun(BaseModel):
    """One run on a route, and where it stands against the others on it.

    ``eligible`` and ``ineligible_reason`` are ``analysis.routes``'s own rule,
    restated here rather than invented: a GPX-sourced run, or one whose 1 Hz
    grid carries a distance jump anywhere, stays on the chart but can neither
    set the record nor become the baseline a later run has to beat.
    """

    activity_id: str
    start_time_utc: UtcInstant
    #: The offset the watch was set to, for the local wall clock. Null for a
    #: GPX-sourced run, which records none.
    utc_offset_s: int | None
    name: str | None
    distance_m: float
    #: Elapsed, not moving, the same as every other best effort: CLAUDE.md,
    #: "Best efforts are elapsed time and span pauses".
    elapsed_time_s: float
    speed_mps: float
    #: Against the route's earliest run, whose id is the route's: always
    #: ``forward`` on that run itself and on every run of an out-and-back.
    direction: Literal["forward", "reverse"]
    eligible: bool
    ineligible_reason: str | None
    #: 1 for the fastest eligible run on the route, null when this run is
    #: ineligible - it was never comparable, so it neither holds a place nor
    #: takes one.
    rank: int | None
    #: The fastest eligible run so far when it was run, not whether it is the
    #: current record: the first eligible run on a route is always one.
    is_record: bool


class RouteDetail(BaseModel):
    """One route's runs, oldest first, with the route's own summary."""

    route: RouteSummary
    #: The medoid run: the smallest summed distance to every other run on the
    #: route, drawn on the map. Direction is measured against the earliest
    #: run instead, ``route.route_id``, which a later run cannot move.
    reference_activity_id: str
    runs: list[RouteRun]


class ActivityRoute(BaseModel):
    """The route one activity belongs to, seen from the activity's own side.

    Null on ``ActivityDetail`` for a run in no route and for a non-running
    activity: ``analysis.routes`` only ever considers outdoor GPS runs, so
    neither case has a row to project.
    """

    route_id: str
    name: str
    run_count: int
    #: Null when this run is ineligible.
    rank: int | None
    direction: Literal["forward", "reverse"]


class BasemapArea(BaseModel):
    """One fetched map area: a box of tiles, in degrees."""

    id: str
    west: float
    south: float
    east: float
    north: float


class Basemap(BaseModel):
    """The fetched map areas. Empty when ``activity-analysis tiles`` never ran."""

    areas: list[BasemapArea]
    attribution: str


class TerritoryRegion(BaseModel):
    """One region of claimed ground: runs linked within 50 km of each other.

    ``analysis.territory`` decides what a region is and names it; this
    projects the ``territory_regions`` row unchanged. The box is the box of
    the served outlines, in degrees, for a map to fit to.
    """

    region_id: str
    name: str
    locality: str | None
    country: str | None
    area_m2: float
    part_count: int
    claim_count: int
    first_claim_utc: UtcInstant
    last_claim_utc: UtcInstant
    west: float
    south: float
    east: float
    north: float


class TerritoryPolygon(BaseModel):
    """A GeoJSON Polygon: ``[lon, lat]`` rings, the exterior anticlockwise, holes after it."""

    type: Literal["Polygon"]
    coordinates: list[list[list[float]]]


class TerritoryMultiPolygon(BaseModel):
    """A GeoJSON MultiPolygon, each polygon wound as ``TerritoryPolygon`` is.

    A part is served as one only when a neck of it is thinner than the 6
    decimal grid its outline is snapped to, which splits the outline in two.
    """

    type: Literal["MultiPolygon"]
    coordinates: list[list[list[list[float]]]]


#: A part's display outline, told apart by its GeoJSON ``type``.
TerritoryGeometry = Annotated[TerritoryPolygon | TerritoryMultiPolygon, Field(discriminator="type")]


class TerritoryPartProperties(BaseModel):
    region_id: str
    #: 0 for the region's largest part.
    part_index: int
    #: The part's true ellipsoidal area, before the outline was simplified.
    area_m2: float


class TerritoryFeature(BaseModel):
    type: Literal["Feature"]
    properties: TerritoryPartProperties
    geometry: TerritoryGeometry


class TerritoryFeatureCollection(BaseModel):
    """Every part of the claimed ground, as a GeoJSON FeatureCollection a map can take whole."""

    type: Literal["FeatureCollection"]
    features: list[TerritoryFeature]


class TerritoryGrowthPoint(BaseModel):
    """One claiming run: the ground it enclosed, how much was new, and the total after it."""

    activity_id: str
    start_time_utc: UtcInstant
    utc_offset_s: int | None
    name: str | None
    region_id: str
    enclosed_m2: float
    new_m2: float
    cumulative_m2: float


class TerritoryCounts(BaseModel):
    """How many runs each rule kept, so a view can say what it left out."""

    #: Outdoor running activities with a position, the ones considered.
    outdoor_runs: int
    #: Of those, the runs whose last position is within ``closure_max_m`` of the first.
    loop_runs: int
    #: Of those, the runs that enclosed ground once slivers were removed.
    claiming_runs: int
    regions: int
    parts: int


class Territory(BaseModel):
    """All the ground every outdoor loop has claimed, and how it grew.

    ``total_area_m2`` is the area of the union, not the sum of every run's
    own ground, which counts every overlap again. ``growth`` is one point per
    claiming run, oldest first; its last ``cumulative_m2`` is
    ``total_area_m2``.
    """

    total_area_m2: float
    #: The closure rule and the sliver radius the stored tables were built with.
    closure_max_m: float
    sliver_radius_m: float
    counts: TerritoryCounts
    regions: list[TerritoryRegion]
    territory: TerritoryFeatureCollection
    growth: list[TerritoryGrowthPoint]
