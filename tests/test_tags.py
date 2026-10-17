"""The activity tag rules.

Every fixture here is synthetic: laps and grids built with a known answer,
not activities pulled from the real store. The real-store prevalence figures
that justify these rules, such as how many of the 307 real runs classify as
Intervals and how the 88 real all_out tags split between its two branches,
live in docs/reference/math/tags.md instead.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from activity_analysis.analysis.tags import (
    MIN_HR_COVERAGE,
    MIN_REPS,
    Flag,
    TagHistory,
    classify_effort,
    interval_reps,
)


def lap(distance_m: float, elapsed_s: float, cadence: float, trigger: str = "manual") -> dict:
    return {
        "distance_m": distance_m,
        "elapsed_time_s": elapsed_s,
        "avg_cadence_spm": cadence,
        "trigger": trigger,
    }


def interval_laps(reps: int = 5) -> pd.DataFrame:
    """A warm-up kilometre, then `reps` fast kilometres each followed by a walk."""
    rows = [lap(1000.0, 460.0, 148.0, "distance")]
    for _ in range(reps):
        rows.append(lap(1000.0, 260.0, 175.0, "distance"))
        rows.append(lap(160.0, 90.0, 105.0, "manual"))
    return pd.DataFrame(rows)


def steady_laps() -> pd.DataFrame:
    """Seven kilometres within 2.7% of each other, the reference fixture's shape."""
    paces = [388.0, 385.0, 388.0, 396.0, 418.0, 388.0, 397.0]
    return pd.DataFrame([lap(1000.0, p, 160.0, "distance") for p in paces])


def grid_at_hr(hr: float, seconds: int = 1800) -> pd.DataFrame:
    return pd.DataFrame({"hr_bpm": np.full(seconds, hr, dtype=float)})


def grid_with_partial_hr(hr: float, recorded_s: int, seconds: int) -> pd.DataFrame:
    """A grid of `seconds` where only the first `recorded_s` carry a heart rate."""
    channel = np.full(seconds, np.nan)
    channel[:recorded_s] = hr
    return pd.DataFrame({"hr_bpm": channel})


def no_efforts() -> pd.DataFrame:
    return pd.DataFrame(columns=["activity_id", "distance_key", "elapsed_time_s"])


def flags_for(
    activity_id: str,
    activities: pd.DataFrame,
    efforts: pd.DataFrame,
    excluded: tuple[str, ...] = (),
) -> dict[str, Flag]:
    """The flags for one activity, keyed by tag, through the prepared history."""
    history = TagHistory(activities, efforts, excluded_activity_ids=excluded)
    return {flag.tag: flag for flag in history.flags(activity_id)}


class TestIntervalReps:
    def test_counts_reps_in_a_session_of_five(self) -> None:
        count, pattern = interval_reps(interval_laps(5), avg_moving_pace_s_per_km=340.0)
        assert count == 5
        assert pattern == "-RWRWRWRWRW"

    def test_a_steady_run_has_no_reps(self) -> None:
        count, pattern = interval_reps(steady_laps(), avg_moving_pace_s_per_km=394.0)
        assert count == 0
        assert set(pattern) <= {"-"}

    def test_a_rep_needs_a_recovery_beside_it(self) -> None:
        """Three fast kilometres in a row are a tempo block, not intervals."""
        rows = [lap(1000.0, 260.0, 175.0, "distance") for _ in range(3)]
        count, _ = interval_reps(pd.DataFrame(rows), avg_moving_pace_s_per_km=340.0)
        assert count == 0

    def test_reps_recorded_as_manual_laps_are_found(self) -> None:
        """A real session's shape: the athlete pressed lap at both ends of each rep,
        so reps and recoveries are both `manual`. The rule ignores the trigger."""
        rows = []
        for _ in range(4):
            rows.append(lap(550.0, 137.0, 172.0, "manual"))
            rows.append(lap(25.0, 120.0, 12.0, "manual"))
        count, _ = interval_reps(pd.DataFrame(rows), avg_moving_pace_s_per_km=340.0)
        assert count == 4

    def test_a_recovery_lap_with_no_distance_is_still_a_recovery(self) -> None:
        """The athlete stopped the watch through every recovery.

        Those laps are recorded with a distance of 0.0, so they have no pace
        at all. A recovery is decided on cadence alone, so the session is
        still five reps each beside a walk; requiring a pace made every
        recovery neutral, left no rep with a neighbour, and threw a genuine
        interval session at the heart rate rules instead.
        """
        rows = [lap(1000.0, 460.0, 148.0, "distance")]
        for _ in range(5):
            rows.append(lap(1000.0, 260.0, 175.0, "distance"))
            rows.append(lap(0.0, 90.0, 105.0, "manual"))
        count, pattern = interval_reps(pd.DataFrame(rows), avg_moving_pace_s_per_km=340.0)
        assert count == 5
        assert pattern == "-RWRWRWRWRW"

    def test_a_lap_with_no_cadence_is_neither(self) -> None:
        rows = [lap(1000.0, 260.0, np.nan, "distance") for _ in range(4)]
        count, pattern = interval_reps(pd.DataFrame(rows), avg_moving_pace_s_per_km=340.0)
        assert count == 0
        assert set(pattern) <= {"-"}

    def test_no_laps_is_no_reps(self) -> None:
        count, pattern = interval_reps(
            pd.DataFrame(columns=["distance_m", "elapsed_time_s", "avg_cadence_spm", "trigger"]),
            340.0,
        )
        assert count == 0
        assert pattern == ""

    def test_a_zero_average_pace_yields_no_reps(self) -> None:
        """A missing or zero distance must make nothing count as fast.

        The pipeline falls back to 0.0 for avg_moving_pace_s_per_km when an
        activity has no reliable distance, precisely so that no lap pace
        (always positive) can be at or below the threshold. The opposite
        fallback, a very high or infinite pace, would make the threshold
        unreachably loose instead and classify any high-cadence run as
        intervals regardless of how fast it actually was.
        """
        count, _ = interval_reps(interval_laps(5), avg_moving_pace_s_per_km=0.0)
        assert count == 0


class TestClassifyEffort:
    def test_intervals_wins_over_the_heart_rate_rules(self) -> None:
        effort = classify_effort(interval_laps(5), grid_at_hr(160.0), 340.0, max_hr_bpm=207.0)
        assert effort.tag == "intervals"
        assert "5" in effort.reason
        assert effort.rep_count == 5
        # The raw per-lap pattern, not just the count that summarises it: a
        # warm-up "-", then five "RW" pairs, one per rep-and-recovery.
        assert effort.rep_pattern == "-RWRWRWRWRW"

    def test_steady(self) -> None:
        effort = classify_effort(steady_laps(), grid_at_hr(161.0), 394.0, max_hr_bpm=207.0)
        assert effort.tag == "steady"
        assert "77" in effort.reason or "78" in effort.reason
        assert effort.rep_count is None
        assert effort.rep_pattern is None

    def test_easy(self) -> None:
        effort = classify_effort(steady_laps(), grid_at_hr(140.0), 394.0, max_hr_bpm=207.0)
        assert effort.tag == "easy"
        assert effort.rep_count is None
        assert effort.rep_pattern is None

    def test_all_out_from_sustained_time_above_the_threshold(self) -> None:
        """The `above >= 0.10` branch: a constant heart rate well above ALL_OUT_ABOVE."""
        effort = classify_effort(steady_laps(), grid_at_hr(195.0), 394.0, max_hr_bpm=207.0)
        assert effort.tag == "all_out"
        assert effort.rep_count is None
        assert effort.rep_pattern is None

    def test_all_out_from_median_at_or_above_steady_below(self) -> None:
        """The fall-through branch: median at or above STEADY_BELOW but never
        reaching ALL_OUT_ABOVE, so `above` is 0.0 and only the median fires it.

        207 * 0.87 = 180.09 bpm, which is at or above STEADY_BELOW (0.85 * 207
        = 175.95) but below ALL_OUT_ABOVE (0.90 * 207 = 186.3), so this run
        never spends any time in the sustained branch above and can only reach
        `all_out` through the median fall-through. 66 of the 88 real all_out
        tags come from the sustained branch and 22 from this one, so this
        branch is exercised on a real fifth of the real tags it produces.
        """
        effort = classify_effort(steady_laps(), grid_at_hr(180.09), 394.0, max_hr_bpm=207.0)
        assert effort.tag == "all_out"
        assert "180" in effort.reason
        assert "87" in effort.reason
        assert effort.rep_count is None
        assert effort.rep_pattern is None

    def test_no_heart_rate_still_classifies_intervals(self) -> None:
        """84 of 307 real runs have no heart rate at all. Intervals needs none."""
        grid = pd.DataFrame({"hr_bpm": np.full(1800, np.nan)})
        effort = classify_effort(interval_laps(5), grid, 340.0, max_hr_bpm=207.0)
        assert effort.tag == "intervals"
        assert effort.rep_count == 5
        assert effort.rep_pattern == "-RWRWRWRWRW"

    def test_no_heart_rate_and_no_reps_is_unclassified_with_a_stated_reason(self) -> None:
        grid = pd.DataFrame({"hr_bpm": np.full(1800, np.nan)})
        effort = classify_effort(steady_laps(), grid, 394.0, max_hr_bpm=207.0)
        assert effort.tag is None
        assert "heart rate" in effort.reason
        assert effort.rep_count is None
        assert effort.rep_pattern is None

    def test_no_max_heart_rate_is_unclassified_with_a_stated_reason(self) -> None:
        effort = classify_effort(steady_laps(), grid_at_hr(161.0), 394.0, max_hr_bpm=None)
        assert effort.tag is None
        assert "maximum heart rate" in effort.reason
        assert effort.rep_count is None
        assert effort.rep_pattern is None

    def test_a_short_burst_of_heart_rate_does_not_classify_the_run(self) -> None:
        """40 s of a spurious 190 bpm at the start of a 90 minute run.

        Every recorded sample is above 90% of a 207 bpm maximum, so without a
        coverage guard the median and the time-above fraction both come from
        those 40 s: the run is tagged all out and the reason claims 100% of it
        was spent there. Declining with a stated reason is the same shape as
        the other two absences.
        """
        grid = grid_with_partial_hr(190.0, recorded_s=40, seconds=5400)
        effort = classify_effort(steady_laps(), grid, 394.0, max_hr_bpm=207.0)
        assert effort.tag is None
        assert "0.7%" in effort.reason, effort.reason
        assert "5400" in effort.reason
        assert effort.rep_count is None
        assert effort.rep_pattern is None

    def test_ordinary_partial_heart_rate_coverage_still_classifies(self) -> None:
        """The guard must not reject a run that simply stopped at some lights.

        The derived grid nulls heart rate across pauses and outages, so real
        runs sit below full coverage as a matter of course. 70% is above
        MIN_HR_COVERAGE and classifies from the recorded seconds.
        """
        grid = grid_with_partial_hr(140.0, recorded_s=1260, seconds=1800)
        assert MIN_HR_COVERAGE < 1260 / 1800
        effort = classify_effort(steady_laps(), grid, 394.0, max_hr_bpm=207.0)
        assert effort.tag == "easy"
        assert effort.rep_count is None
        assert effort.rep_pattern is None


class TestHistoryFlags:
    def test_long_run_fires_in_the_top_decile_of_ninety_days(self) -> None:
        activities = pd.DataFrame(
            {
                "activity_id": [f"a{i}" for i in range(10)] + ["long"],
                "start_time_utc": pd.to_datetime(["2026-08-01"] * 11, utc=True),
                "distance_m": [5000.0] * 10 + [20000.0],
            }
        )
        assert "long_run" in flags_for("long", activities, no_efforts())

    def test_a_typical_run_is_not_a_long_run(self) -> None:
        activities = pd.DataFrame(
            {
                "activity_id": [f"a{i}" for i in range(10)] + ["typical"],
                "start_time_utc": pd.to_datetime(["2026-08-01"] * 11, utc=True),
                "distance_m": [5000.0] * 10 + [5000.0],
            }
        )
        assert "long_run" not in flags_for("typical", activities, no_efforts())

    def test_a_run_outside_the_window_does_not_set_the_threshold(self) -> None:
        """The window is the trailing 90 days, not the whole history.

        Ten 20 km runs a year earlier put the decile threshold at 20 km if the
        window is ignored, so the 10 km run would not be flagged. Inside its
        own 90 days it is the longest of eleven and clears the threshold.
        """
        activities = pd.DataFrame(
            {
                "activity_id": [f"old{i}" for i in range(10)]
                + [f"a{i}" for i in range(10)]
                + ["long"],
                "start_time_utc": pd.to_datetime(
                    ["2025-08-01"] * 10 + ["2026-08-01"] * 11, utc=True
                ),
                "distance_m": [20000.0] * 10 + [5000.0] * 10 + [10000.0],
            }
        )
        flags = flags_for("long", activities, no_efforts())
        assert "long_run" in flags
        assert "over 11 runs" in flags["long_run"].reason

    def test_pr_fires_when_an_effort_beats_every_earlier_one(self) -> None:
        activities = two_runs()
        efforts = pd.DataFrame(
            {
                "activity_id": ["old", "new"],
                "distance_key": ["5k", "5k"],
                "elapsed_time_s": [1500.0, 1400.0],
                "distance_trusted": [True, True],
            }
        )
        flags = flags_for("new", activities, efforts)
        assert "pr" in flags
        assert "5k" in flags["pr"].reason

    def test_pr_carries_the_distance_it_fired_at(self) -> None:
        """The distance is a field, not something to be read out of the prose.

        One run records at several distances at once, so a client rendering
        `tag` as a chip would otherwise show the same chip repeated with the
        distance available only inside `reason`, which is prose.
        """
        activities = two_runs()
        efforts = pd.DataFrame(
            {
                "activity_id": ["old", "old", "new", "new"],
                "distance_key": ["1k", "5k", "1k", "5k"],
                "elapsed_time_s": [260.0, 1500.0, 250.0, 1400.0],
                "distance_trusted": [True, True, True, True],
            }
        )
        history = TagHistory(activities, efforts)
        records = [flag for flag in history.flags("new") if flag.tag == "pr"]
        assert {flag.distance_key for flag in records} == {"1k", "5k"}
        assert len(records) == 2

    def test_a_long_run_carries_no_distance_key(self) -> None:
        activities = pd.DataFrame(
            {
                "activity_id": [f"a{i}" for i in range(10)] + ["long"],
                "start_time_utc": pd.to_datetime(["2026-08-01"] * 11, utc=True),
                "distance_m": [5000.0] * 10 + [20000.0],
            }
        )
        assert flags_for("long", activities, no_efforts())["long_run"].distance_key is None

    def test_pr_does_not_fire_on_a_slower_effort(self) -> None:
        activities = two_runs()
        efforts = pd.DataFrame(
            {
                "activity_id": ["old", "new"],
                "distance_key": ["5k", "5k"],
                "elapsed_time_s": [1400.0, 1500.0],
                "distance_trusted": [True, True],
            }
        )
        assert "pr" not in flags_for("new", activities, efforts)

    def test_a_first_ever_eligible_effort_is_a_record(self) -> None:
        """Decided 2026-09-05. `/api/records` has
        always meant "your best", which exists as soon as there is one effort;
        the tagger meant "beat a previous best". They now agree."""
        flags = flags_for("first", one_run(), one_effort())
        assert list(flags) == ["pr"]
        assert flags["pr"].distance_key == "5k"

    def test_the_first_effort_reason_says_it_beat_nothing(self) -> None:
        """The reason column exists so a classifier's reasoning is never hidden.
        Reusing the "beating X over N earlier efforts" wording for an effort that
        beat nothing would assert something false."""
        reason = flags_for("first", one_run(), one_effort())["pr"].reason
        assert "first" in reason.lower()
        assert "beating" not in reason.lower()
        assert "23:20" in reason

    def test_an_ineligible_first_effort_is_still_not_a_record(self) -> None:
        """Eligibility is unchanged by this decision. A treadmill or jumped
        effort is excluded on both sides, so it cannot be the first record
        either."""
        jumped = one_effort().assign(contains_jump=[True], distance_trusted=[False])
        assert flags_for("first", one_run(), jumped) == {}
        assert flags_for("first", one_run(), one_effort(), excluded=("first",)) == {}

    def test_a_jump_the_measured_speed_confirms_can_be_a_record(self) -> None:
        """`distance_trusted` is the rule, so a flagged effort it readmits counts,
        and one it does not stays out even though its `contains_jump` is set."""
        confirmed = one_effort().assign(contains_jump=[True], distance_trusted=[True])
        assert "pr" in flags_for("first", one_run(), confirmed)
        unconfirmed = one_effort().assign(contains_jump=[True], distance_trusted=[False])
        assert flags_for("first", one_run(), unconfirmed) == {}

    def test_the_second_effort_is_measured_against_the_first(self) -> None:
        """The first effort is a record and also the baseline: a slower second
        effort is not one, and a faster one beats exactly one earlier effort."""
        activities = two_runs()
        slower = pd.DataFrame(
            {
                "activity_id": ["old", "new"],
                "distance_key": ["5k", "5k"],
                "elapsed_time_s": [1400.0, 1500.0],
                "distance_trusted": [True, True],
            }
        )
        assert "pr" in flags_for("old", activities, slower)
        assert "pr" not in flags_for("new", activities, slower)
        faster = slower.assign(elapsed_time_s=[1500.0, 1400.0])
        assert "over 1 earlier effort" in flags_for("new", activities, faster)["pr"].reason

    def test_an_excluded_activity_cannot_set_a_record(self) -> None:
        """A treadmill distance comes from an uncalibrated footpod.

        The fast effort here would be the athlete's best 5k by a minute and a
        half, and it is not a record because nothing measured that distance.
        """
        activities = two_runs()
        efforts = pd.DataFrame(
            {
                "activity_id": ["old", "new"],
                "distance_key": ["5k", "5k"],
                "elapsed_time_s": [1500.0, 1400.0],
                "distance_trusted": [True, True],
            }
        )
        assert "pr" not in flags_for("new", activities, efforts, excluded=("new",))

    def test_an_excluded_activity_is_not_the_record_to_beat_either(self) -> None:
        """The worse half of the same fault, and the reason both sides filter.

        An over-reading footpod produces a 5k nobody can beat outdoors, and if
        it stands as the baseline it suppresses every genuine record after it
        silently: no wrong tag appears, a right one just never does. Here the
        later outdoor effort is slower than the treadmill one and is still a
        record, because the treadmill effort is not in the comparison at all.
        """
        activities = pd.DataFrame(
            {
                "activity_id": ["treadmill", "older", "new"],
                "start_time_utc": pd.to_datetime(
                    ["2026-02-01", "2026-01-01", "2026-08-01"], utc=True
                ),
                "distance_m": [5000.0, 5000.0, 5000.0],
            }
        )
        efforts = pd.DataFrame(
            {
                "activity_id": ["treadmill", "older", "new"],
                "distance_key": ["5k", "5k", "5k"],
                "elapsed_time_s": [1000.0, 1500.0, 1400.0],
                "distance_trusted": [True, True, True],
            }
        )
        flags = flags_for("new", activities, efforts, excluded=("treadmill",))
        assert "pr" in flags
        assert "25:00" in flags["pr"].reason, flags["pr"].reason

    def test_an_effort_containing_a_jump_cannot_set_a_record(self) -> None:
        """A jump in the recorded distance credits metres nobody ran, so it inflates."""
        activities = two_runs()
        efforts = pd.DataFrame(
            {
                "activity_id": ["old", "new"],
                "distance_key": ["5k", "5k"],
                "elapsed_time_s": [1500.0, 1400.0],
                "contains_jump": [False, True],
                "distance_trusted": [True, False],
            }
        )
        assert "pr" not in flags_for("new", activities, efforts)

    def test_an_effort_containing_a_jump_is_not_the_record_to_beat_either(self) -> None:
        """The same two-sided shape as the ineligible-activity case above.

        Three efforts are needed for the fixture to discriminate. With only a
        jump-inflated baseline and a slower candidate, no record fires whether
        the flag is read or not, and the test asserts an absence that is true
        in both worlds. Here the 5 km of 23:20 is a recorded-distance artefact
        sitting between a genuine 25:00 and a genuine 23:20-beating 23:20 that
        is not: reading the flag makes the last one a record over the 25:00,
        and ignoring it suppresses the record behind a time nobody ran.
        """
        activities = pd.DataFrame(
            {
                "activity_id": ["older", "jumped", "new"],
                "start_time_utc": pd.to_datetime(
                    ["2026-01-01", "2026-02-01", "2026-08-01"], utc=True
                ),
                "distance_m": [5000.0, 5000.0, 5000.0],
            }
        )
        efforts = pd.DataFrame(
            {
                "activity_id": ["older", "jumped", "new"],
                "distance_key": ["5k", "5k", "5k"],
                "elapsed_time_s": [1500.0, 1000.0, 1400.0],
                "contains_jump": [False, True, False],
                "distance_trusted": [True, False, True],
            }
        )
        flags = flags_for("new", activities, efforts)
        assert "pr" in flags
        assert "25:00" in flags["pr"].reason, flags["pr"].reason

    def test_an_effort_with_no_elapsed_time_is_neither_a_record_nor_a_baseline(self) -> None:
        """A missing elapsed time is not a fast effort.

        It cannot be compared, so it is dropped rather than fed to the
        duration formatter, which raises on NaN and would take the whole
        rebuild's tag pass down with it. The earlier effort here is the
        null one, so the later real effort is the first eligible effort at
        the distance: the null was not a baseline it had to beat.
        """
        activities = two_runs()
        efforts = pd.DataFrame(
            {
                "activity_id": ["old", "new"],
                "distance_key": ["5k", "5k"],
                "elapsed_time_s": [np.nan, 1500.0],
                "distance_trusted": [True, True],
            }
        )
        assert "pr" not in flags_for("old", activities, efforts)
        assert "first" in flags_for("new", activities, efforts)["pr"].reason

    def test_an_unknown_activity_has_no_flags(self) -> None:
        assert flags_for("absent", two_runs(), no_efforts()) == {}


def one_run() -> pd.DataFrame:
    """A single run, the shape the first-effort record needs."""
    return pd.DataFrame(
        {
            "activity_id": ["first"],
            "start_time_utc": pd.to_datetime(["2026-08-01"], utc=True),
            "distance_m": [5000.0],
        }
    )


def one_effort() -> pd.DataFrame:
    """That run's only effort: a 5 km in 23:20."""
    return pd.DataFrame(
        {
            "activity_id": ["first"],
            "distance_key": ["5k"],
            "elapsed_time_s": [1400.0],
            "distance_trusted": [True],
        }
    )


def two_runs() -> pd.DataFrame:
    """An earlier run and a later one, the shape every PR case needs."""
    return pd.DataFrame(
        {
            "activity_id": ["old", "new"],
            "start_time_utc": pd.to_datetime(["2026-01-01", "2026-08-01"], utc=True),
            "distance_m": [5000.0, 5000.0],
        }
    )


def test_min_reps_is_three_as_specified() -> None:
    assert MIN_REPS == 3
