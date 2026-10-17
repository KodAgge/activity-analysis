"""Automatic activity tags, and the reasoning that produced each one.

A tag is one exclusive effort classification plus zero or more additive
flags. The four effort tags describe what kind of session it was and cannot
both be true; a personal record and a long run are facts about a session
rather than kinds of session, so forcing them into the same slot would throw
one of them away.

Every tag carries the numbers that fired it. A classifier whose reasoning is
hidden stops being trusted the first time it is wrong, and this one was wrong
the first time it was shown to the athlete: a hand-drawn mockup called an
interval session steady. See docs/reference/math/tags.md for the derivation
and for the rules that were rejected.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

import numpy as np
import pandas as pd

from activity_analysis.analysis.best_efforts import distance_trusted

#: A lap at or above this cadence is unambiguously running. Measured over the
#: nine real interval sessions, rep laps and recovery laps form two cadence
#: clusters with a gap between them. The margin that actually governs the
#: risk is threshold to nearest real point, not cluster to cluster: this
#: constant sits just below the lowest observed rep cadence, and
#: RECOVERY_CADENCE_SPM below sits just above the highest observed recovery
#: cadence. Both constants are bracketed
#: tightly by real data, so an unusually shuffling rep or an unusually brisk
#: recovery lap would be misread, and the rule would lose that rep.
REP_CADENCE_SPM = 140.0

#: Below this cadence the athlete is not running. Deliberately not the same
#: constant as REP_CADENCE_SPM: the band between them is "neither", which is
#: where warm-up and cool-down kilometres land.
RECOVERY_CADENCE_SPM = 120.0

#: A rep is at least this much faster than the activity's own average moving
#: pace. Relative rather than absolute, because a rep is fast for this run
#: rather than fast in general.
REP_PACE_FRACTION = 0.90

#: Three or more reps. Two fast stretches
#: with a walk between them is a fartlek or a hill, not an interval session.
MIN_REPS = 3

#: Fractions of maximum heart rate, tabulated in docs/reference/math/tags.md.
EASY_BELOW = 0.75
STEADY_BELOW = 0.85
ALL_OUT_ABOVE = 0.90

#: Heart rate has to cover at least this fraction of the run's seconds before
#: an effort tag is read from it. Without the guard a run whose optical sensor
#: recorded a short spurious burst and nothing else classifies from that
#: burst alone, so 40 s of 190 bpm in a 90 minute run reads as all out.
#: Measured over the real store on 2026-08-31: of the 223 runs carrying any
#: heart rate at all, the lowest coverage is 66.3% and the first percentile is
#: 84.6%, so 50% rejects none of them and leaves 16 points of margin below the
#: worst real run. The denominator is every second on the grid, including the
#: paused and outage seconds the derived layer nulls heart rate across, which
#: is why ordinary runs sit below 100% at all.
MIN_HR_COVERAGE = 0.50

#: A long run is in the top decile of the trailing window.
LONG_RUN_QUANTILE = 0.90
LONG_RUN_WINDOW_DAYS = 90

#: The trailing window as nanoseconds, the unit the prepared history compares
#: in. int64 nanoseconds sort and search identically to timestamps and take a
#: plain numpy array, where a tz-aware column would arrive as objects.
_LONG_RUN_WINDOW_NS = LONG_RUN_WINDOW_DAYS * 24 * 60 * 60 * 1_000_000_000

#: A trailing window with fewer runs than this has no meaningful decile.
LONG_RUN_MIN_RUNS = 5


def _instants_as_ns(when: pd.Series) -> pd.Series:
    """Instants as int64 nanoseconds, whatever resolution the column arrived in.

    ``astype("int64")`` on a datetime column yields that column's own unit, and
    pandas keeps the unit the data was parsed at rather than normalising to
    nanoseconds: the same activities frame is microseconds here and could be
    nanoseconds elsewhere. Comparing either against a window measured in
    nanoseconds is wrong by a factor of a thousand and wrong silently, so the
    unit is pinned once, here, rather than assumed at each comparison.
    """
    return pd.to_datetime(when, utc=True).dt.as_unit("ns").astype("int64")


def _format_duration(seconds: float) -> str:
    """A duration in seconds as minutes:seconds, or hours:minutes:seconds past an hour.

    ``reason`` is prose meant for display, the one place in this project's
    output where a formatted unit is allowed; see docs/reference/api.md.
    Every other reason in this module already reads that way (kilometres for
    a long run, percentages for heart rate), so a personal record read as a
    raw second count would be the one field that did not.
    """
    total = int(round(seconds))
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes}:{secs:02d}"


def _lap_pace_s_per_km(distance_m: float | None, elapsed_s: float | None) -> float | None:
    """A lap's pace, or None when there is no distance to divide by.

    NaN is checked explicitly rather than left to ``not distance_m``, which is
    False for NaN, so a lap with a missing distance returns None as the
    annotation promises instead of a NaN that silently fails every comparison
    it is later fed to.
    """
    if distance_m is None or pd.isna(distance_m) or float(distance_m) <= 0:
        return None
    if elapsed_s is None or pd.isna(elapsed_s):
        return None
    return float(elapsed_s) / (float(distance_m) / 1000.0)


def interval_reps(laps: pd.DataFrame, avg_moving_pace_s_per_km: float) -> tuple[int, str]:
    """Count reps in a lap sequence, and return the pattern that found them.

    The trigger is deliberately ignored. Reps arrive as `distance` laps when
    they happen to be a kilometre and the watch's auto-lap coincides, and as
    `manual` laps when the athlete pressed lap at both ends of each rep. Two
    of the nine real sessions are the second shape, so a rule keyed on the
    trigger misses them: that was the first rule tried and it scored 7 of 9.

    A rep is a lap that is running (cadence) and fast for this run (pace),
    with a non-running lap immediately beside it. The adjacency requirement is
    what separates an interval session from a tempo block: three fast
    kilometres in a row have no recovery between them and are not reps.

    A recovery is decided on cadence alone, so it is recognised even on a lap
    with no usable distance. An athlete who stops the watch through every
    recovery records those laps with a distance of zero, and requiring a pace
    there would leave every rep without the neighbour it needs and lose the
    whole session. Nothing is lost by not requiring one: a lap at walking
    cadence is a recovery whatever distance the watch credited it with.
    """
    if laps.empty:
        return 0, ""
    labels: list[str] = []
    for _, row in laps.iterrows():
        cadence = row.get("avg_cadence_spm")
        pace = _lap_pace_s_per_km(row.get("distance_m"), row.get("elapsed_time_s"))
        if cadence is None or pd.isna(cadence):
            labels.append("-")
        elif cadence < RECOVERY_CADENCE_SPM:
            labels.append("W")
        elif (
            pace is not None
            and cadence >= REP_CADENCE_SPM
            and pace <= avg_moving_pace_s_per_km * REP_PACE_FRACTION
        ):
            labels.append("R")
        else:
            labels.append("-")
    reps = sum(
        1
        for i, label in enumerate(labels)
        if label == "R"
        and ((i > 0 and labels[i - 1] == "W") or (i + 1 < len(labels) and labels[i + 1] == "W"))
    )
    return reps, "".join(labels)


@dataclass(frozen=True)
class Effort:
    """The exclusive effort classification `classify_effort` returns.

    ``tag`` is None when nothing could be classified; ``reason`` is always
    populated, whichever way it goes.

    ``rep_count`` names the reps an ``intervals`` tag fired at, so a client
    does not have to parse it out of ``reason``, which is prose and
    explicitly not a parsing surface: the same argument ``Flag.distance_key``
    makes for a ``pr`` row. It is None on every other branch, including the
    three where ``tag`` itself is None.
    """

    tag: str | None
    reason: str
    rep_count: int | None = None
    #: The raw per-lap pattern `interval_reps` found ("R"/"W"/"-" per lap, in
    #: recorded order), so a client can colour individual recorded laps
    #: without recomputing this module's own cadence-and-pace rule. Null on
    #: every tag that is not an "intervals" effort, for the same reason
    #: `rep_count` is: the string is prose-adjacent and the analysis layer
    #: already did the classifying.
    rep_pattern: str | None = None


def classify_effort(
    laps: pd.DataFrame,
    grid: pd.DataFrame,
    avg_moving_pace_s_per_km: float,
    max_hr_bpm: float | None,
) -> Effort:
    """The one exclusive effort tag, or None with a reason it could not be set.

    Intervals is tested first and needs no heart rate, which matters because
    84 of 307 real runs have none at all. The heart rate rules are then tried
    from the most extreme inward, so a session that is both hard and even
    reads as all out rather than steady.

    Heart rate must also cover ``MIN_HR_COVERAGE`` of the run's seconds before
    anything is read from it. A handful of recorded samples is not a
    measurement of the session, and classifying from them produces both a
    wrong tag and a reason that asserts something about the run which is
    demonstrably false.
    """
    reps, pattern = interval_reps(laps, avg_moving_pace_s_per_km)
    if reps >= MIN_REPS:
        return Effort(
            "intervals",
            f"{reps} recorded reps, faster than the run's average, "
            f"each beside a recovery ({pattern})",
            rep_count=reps,
            rep_pattern=pattern,
        )

    seconds = grid["hr_bpm"].to_numpy(dtype=float) if "hr_bpm" in grid else np.zeros(0)
    hr = seconds[~np.isnan(seconds)]
    if hr.size == 0:
        return Effort(None, "no heart rate recorded, and no recorded reps to classify from")
    coverage = hr.size / seconds.size
    if coverage < MIN_HR_COVERAGE:
        return Effort(
            None,
            f"heart rate recorded for only {coverage * 100:.1f}% of the run's "
            f"{seconds.size} s, under the {MIN_HR_COVERAGE * 100:.0f}% a "
            f"classification is read from, and no recorded reps to classify from",
        )
    if max_hr_bpm is None or pd.isna(max_hr_bpm) or max_hr_bpm <= 0:
        return Effort(None, "no maximum heart rate in the athlete profile for this activity")

    median = float(np.median(hr))
    fraction = median / float(max_hr_bpm)
    above = float((hr >= float(max_hr_bpm) * ALL_OUT_ABOVE).mean())
    if above >= 0.10:
        return Effort(
            "all_out",
            f"{above * 100:.0f}% of the seconds with heart rate recorded at or above "
            f"{ALL_OUT_ABOVE * 100:.0f}% of max heart rate",
        )
    if fraction < EASY_BELOW:
        return Effort("easy", f"median heart rate {median:.0f} bpm, {fraction * 100:.1f}% of max")
    if fraction < STEADY_BELOW:
        return Effort(
            "steady",
            f"median heart rate {median:.0f} bpm, {fraction * 100:.1f}% of max, no recorded reps",
        )
    return Effort("all_out", f"median heart rate {median:.0f} bpm, {fraction * 100:.1f}% of max")


@dataclass(frozen=True)
class Flag:
    """One additive flag, with the numbers that fired it.

    ``distance_key`` names the best-effort distance a personal record fired
    at. A breakthrough run records at several distances at once, so without it
    a reader sees a row of identical ``pr`` chips and the only thing telling
    them apart is ``reason``, which is prose and explicitly not a parsing
    surface. It is None on every flag that is not about one distance.
    """

    tag: str
    reason: str
    distance_key: str | None = None


class TagHistory:
    """The flags that need the rest of the history, prepared once.

    Everything that does not depend on which activity is being asked about is
    built in the constructor: the timestamp conversion, the trailing window's
    distances, and per distance the running best that a record has to beat.
    Doing it per activity instead re-merged both frames and re-converted both
    timestamp columns on every call, which is quadratic in the length of the
    history. A full recompute sees every activity, so there is no incremental
    path to keep in step with this one.

    A first eligible effort at a distance is a record, decided 2026-09-05.
    The earlier rule tagged nothing for an effort that beat nothing, so the
    tags and ``/api/records`` disagreed for exactly one case, a distance with
    a sole eligible effort: the records list named it as the holder while the
    activity carried no tag, no badge and no ``has_pr`` match. The progression
    chart forced the question, because a first point must either be marked
    or not, and marking it is what makes the tags, the records endpoint and
    the chart three views of one rule. The feared cost, tagging the first
    year of history wall to wall, does not arise: the first effort at each
    distance is one row per distance key that has any eligible effort, which
    is the same set ``/api/records`` lists and therefore nineteen on the real
    history as of 2026-09-12. It grows by one when a distance is first
    covered, not by one per activity.

    ``excluded_activity_ids`` are activities whose best efforts cannot be
    records, on either side of the comparison. The caller supplies them
    because this module reads no store; ``analysis.pipeline`` passes every
    activity not known to have been run outdoors, per the invariant in
    docs/reference/derived-layer.md. Excluding only the candidate side would
    miss the worse half of the fault, where an uncalibrated effort becomes the
    baseline and silently suppresses a genuine record for years. An effort
    whose ``distance_trusted`` is not True is dropped here rather than by the
    caller, since that flag travels on the effort row itself.
    """

    def __init__(
        self,
        activities: pd.DataFrame,
        efforts: pd.DataFrame,
        excluded_activity_ids: Iterable[str] = (),
    ) -> None:
        runs = (
            pd.DataFrame(
                {
                    "activity_id": activities["activity_id"].astype(str),
                    "when": pd.to_datetime(activities["start_time_utc"], utc=True),
                    "when_ns": _instants_as_ns(activities["start_time_utc"]),
                    "distance_m": pd.to_numeric(activities["distance_m"], errors="coerce"),
                }
            )
            .dropna(subset=["when"])
            .sort_values("when", kind="stable", ignore_index=True)
        )
        self._when_ns = runs["when_ns"].to_numpy(dtype="int64")
        self._distance_m = runs["distance_m"].to_numpy(dtype=float)
        self._runs: dict[str, tuple[int, float]] = {
            str(activity_id): (int(when_ns), float(distance_m))
            for activity_id, when_ns, distance_m in zip(
                runs["activity_id"], self._when_ns, self._distance_m, strict=True
            )
        }
        self._records = self._prepare_records(
            efforts, {str(activity_id) for activity_id in excluded_activity_ids}
        )

    def _prepare_records(self, efforts: pd.DataFrame, excluded: set[str]) -> dict[str, list[Flag]]:
        """Every personal record in the history, keyed by the activity that set it.

        One pass per distance rather than one per activity. Within a distance
        the efforts are ordered by when they were run, so the running minimum
        of the elapsed times is the record to beat, and a binary search finds
        how many efforts are strictly earlier than each one. Strictly: two
        efforts sharing a start instant cannot be earlier than one another.

        An effort with no elapsed time is dropped rather than compared. It can
        neither be a record nor be beaten, and a NaN reaching the duration
        formatter raises rather than producing a reason.
        """
        records: dict[str, list[Flag]] = {}
        if efforts.empty or "distance_key" not in efforts:
            return records

        pool = efforts.loc[:, ["activity_id", "distance_key", "elapsed_time_s"]].copy()
        pool["activity_id"] = pool["activity_id"].astype(str)
        pool["elapsed_time_s"] = pd.to_numeric(pool["elapsed_time_s"], errors="coerce")
        # A jump credits metres nobody ran, so unlike a pause or an outage it
        # makes an effort faster than it was, unless the measured speed says
        # the recorded distance is sound anyway. `distance_trusted` holds that
        # rule, and only its explicit True survives: a record is the one
        # consumer for which an unverified effort is worse than no effort.
        pool = pool[distance_trusted(efforts).to_numpy()]
        pool = pool[~pool["activity_id"].isin(excluded)]
        # Filtered to known activities before the map, not after: a missing key
        # would make the mapped column float64, and an instant in nanoseconds
        # is larger than a float64 holds exactly.
        when_by_id = {activity_id: when_ns for activity_id, (when_ns, _) in self._runs.items()}
        pool = pool[pool["activity_id"].isin(when_by_id)]
        pool = pool.dropna(subset=["elapsed_time_s", "distance_key"])
        if pool.empty:
            return records
        pool["when_ns"] = pool["activity_id"].map(when_by_id)

        for distance_key, group in pool.groupby("distance_key"):
            ordered = group.sort_values("when_ns", kind="stable")
            when_ns = ordered["when_ns"].to_numpy(dtype="int64")
            elapsed = ordered["elapsed_time_s"].to_numpy(dtype=float)
            strictly_earlier = np.searchsorted(when_ns, when_ns, side="left")
            best_so_far = np.minimum.accumulate(elapsed)
            for position, activity_id in enumerate(ordered["activity_id"]):
                earlier = int(strictly_earlier[position])
                this_time = float(elapsed[position])
                if earlier == 0:
                    # A first eligible effort at a distance is a record.
                    # Decided 2026-09-05. `/api/records` has always meant
                    # "your best", which exists as soon as there is one
                    # effort, while this tagger meant "beat a previous best";
                    # the two diverged only for a sole effort, and the
                    # progression chart forced the question because a first
                    # point must either be marked or not. The reason says it
                    # beat nothing rather than reusing the wording below,
                    # which would assert something false.
                    records.setdefault(str(activity_id), []).append(
                        Flag(
                            "pr",
                            f"{distance_key} in {_format_duration(this_time)}, "
                            f"the first eligible effort at this distance",
                            distance_key=str(distance_key),
                        )
                    )
                    continue
                best_before = float(best_so_far[earlier - 1])
                if this_time >= best_before:
                    continue
                plural = "effort" if earlier == 1 else "efforts"
                records.setdefault(str(activity_id), []).append(
                    Flag(
                        "pr",
                        f"{distance_key} in {_format_duration(this_time)}, beating "
                        f"{_format_duration(best_before)} over {earlier} earlier {plural}",
                        distance_key=str(distance_key),
                    )
                )
        return records

    def _long_run(self, when_ns: int, distance_m: float) -> Flag | None:
        if not np.isfinite(distance_m):
            return None
        # The window is every run in the trailing LONG_RUN_WINDOW_DAYS up to
        # and including this one, which on a sorted column is two searches.
        end = int(np.searchsorted(self._when_ns, when_ns, side="right"))
        start = int(np.searchsorted(self._when_ns, when_ns - _LONG_RUN_WINDOW_NS, side="right"))
        window = self._distance_m[start:end]
        window = window[~np.isnan(window)]
        if window.size < LONG_RUN_MIN_RUNS:
            return None
        # Strictly greater: a window of equal distances puts the decile
        # threshold on every one of them, and >= would call them all long.
        threshold = float(np.quantile(window, LONG_RUN_QUANTILE))
        if distance_m <= threshold:
            return None
        return Flag(
            "long_run",
            f"{distance_m / 1000:.1f} km, in the top decile of the last "
            f"{LONG_RUN_WINDOW_DAYS} days (threshold {threshold / 1000:.1f} km "
            f"over {window.size} runs)",
        )

    def flags(self, activity_id: str) -> list[Flag]:
        """Every additive flag for one activity, the long run first."""
        entry = self._runs.get(str(activity_id))
        if entry is None:
            return []
        when_ns, distance_m = entry
        found: list[Flag] = []
        long_run = self._long_run(when_ns, distance_m)
        if long_run is not None:
            found.append(long_run)
        found.extend(self._records.get(str(activity_id), ()))
        return found
