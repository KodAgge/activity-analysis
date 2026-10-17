# Activity tags

What kind of session a run was, and whether it stands out against the athlete's own history.

Implemented in `src/activity_analysis/analysis/tags.py`.
Tested in `tests/test_tags.py` against synthetic laps and grids with known answers.
Every number quoted from the real store lives here rather than in an assertion: the Intervals prevalence count that justified the rule below over the per-kilometre rule it replaced, the heart rate coverage distribution behind `MIN_HR_COVERAGE`, and the record counts behind the eligibility rule.

## What is being computed

A tag is one exclusive **effort classification** plus zero or more additive **flags**.

The four effort tags - Easy, Steady, Intervals, All out - describe what kind of session it was.
They cannot both be true of one run, so they share a slot: `classify_effort` returns at most one of them, or `None` with a stated reason when the data cannot support a call.

Long run and PR are not kinds of session.
They are facts about a session relative to the athlete's history - this run was unusually long, or this effort was faster than every earlier one at the same distance.
A run can be both a Long run and a PR, or an Easy run that also happens to be a Long run.
So these are computed separately by `TagHistory.flags` and returned as a list, rather than forced into the same slot as the effort tag.

Every tag and flag carries the numbers that fired it, not just its name.
A classifier whose reasoning is hidden stops being trusted the first time it is wrong, and this one was wrong the first time it was shown to the athlete: a hand-drawn mockup of the 2026-08-25 session, built against the original per-kilometre rule, called an interval session Steady.

## The Intervals rule

`interval_reps(laps, avg_moving_pace_s_per_km)` walks the recorded laps once and labels each one:

- **R** (a rep): the lap's average cadence is at or above `REP_CADENCE_SPM` and its pace is at or below `avg_moving_pace_s_per_km * REP_PACE_FRACTION`.
- **W** (a recovery): the lap's average cadence is below `RECOVERY_CADENCE_SPM`.
- **-** (neither): everything else, including a lap with no recorded cadence.

**A recovery is decided on cadence alone, and deliberately does not require a pace.**
A rep does require one, because "fast for this run" is a statement about pace, so a lap with no usable distance cannot be a rep.
A recovery needs no such thing: a lap at walking cadence is a recovery whatever distance the watch credited it with.
The distinction matters because an athlete who stops the watch through every recovery records those laps with a `distance_m` of 0.0.
Requiring a pace there labels every recovery `-`, leaves no rep with the neighbour it needs, and hands a genuine five-rep session to the heart rate rules instead.
`test_a_recovery_lap_with_no_distance_is_still_a_recovery` is that shape.

A labelled **R** only counts as a rep if a **W** sits immediately beside it, before or after.
The rep count is then how many **R** labels satisfy that adjacency, and `classify_effort` tags the session Intervals when that count is at least `MIN_REPS`.

That count is carried in its own `rep_count` field on the Intervals row, not only inside `reason`'s prose, for the same reason a PR row carries `distance_key` of its own: a client asking "how many reps" would otherwise have to parse a sentence to get a number back out of it.
`rep_count` is null on every tag that is not Intervals.

The full label sequence itself - `interval_reps`'s second return value, the same string quoted inside `reason` - is carried too, in `rep_pattern` (added `ANALYSIS_VERSION` 4).
`rep_count` says how many reps fired; `rep_pattern` says which recorded laps they were, one `R`/`W`/`-` character per lap in recorded order.
A frontend that wants to show a recovery lap differently from a rep needs this: `rep_count` alone cannot say *which* laps to badge, and re-deriving that from `avg_speed_mps` or `avg_cadence_spm` in a client would be recomputing this module's own rule with different, unvalidated thresholds - measured wrong on five of the nine real interval sessions, whose laps carried no `avg_speed_mps` at all in the store.
That was later traced to `fit_reader` dropping a FIT field the message repeats, fixed in `INGEST_VERSION` 3, not to the athlete stopping the watch as first assumed; one session still records no lap speed in either export, and the rule a client would have to reproduce is not lap speed alone in any case: `rep_count` counts only an `R` lap that sits beside a `W`.
`rep_pattern` is null on every tag that is not Intervals, and on a row written before this column existed.

### Where the three constants came from

**`REP_CADENCE_SPM = 140.0`** and **`RECOVERY_CADENCE_SPM = 120.0`** come from cadence being the cleanest signal in a lap.
A runner's cadence while covering a fast lap and a runner's cadence while walking or jogging a recovery do not overlap, even though their paces can.
The committed fixture `data/examples/run-2026-08-25.fit` shows the shape on one session: reps at 173 to 176 spm against recoveries at 98 to 118 spm.
Measuring across the nine sessions this rule fires on today (see "Reproduced against the real store" below) confirms the same shape holds generally.
The distance between the two clusters is about 1.2 times the 20 spm band between the two constants at the extremes and about 3.25 times it between the two medians, but that is the wrong quantity for judging the error that survives, because it measures cluster to cluster rather than threshold to nearest real point.
The quantity that actually bounds the error is the margin from each threshold to the nearest observed value in the class it is meant to exclude.
`REP_CADENCE_SPM` at 140.0 sits about a ninth of that band below the lowest observed rep cadence, so an unusually shuffling rep would fall under the threshold, read as a recovery instead, and be lost from the rep count.
`RECOVERY_CADENCE_SPM` at 120.0 sits about a twelfth of that band above the highest observed recovery cadence, so an unusually brisk recovery lap would rise above the threshold, fail to register as the `W` a rep needs beside it, and the adjacent rep would be lost from the count for the same reason.
Both margins are under an eighth of the band, so both constants are bracketed tightly by real data rather than sitting in the middle of a wide, safe gap.
The two thresholds are deliberately not one boundary.
The 20 spm band between 120 and 140 is "neither", which is where a warm-up or cool-down kilometre - run at an ordinary training cadence, not a walk - lands without being mistaken for either a rep or a recovery.

**`REP_PACE_FRACTION = 0.90`** is relative to the activity's own average moving pace rather than an absolute pace, because a rep is fast for this run, not fast in some universal sense.
A rep for a 6:30/km easy-day athlete and a rep for a 3:30/km speed session are different absolute paces.
Anchoring to the run's own average is what makes one rule work for both.

**`MIN_REPS = 3`** keeps the count of three the original per-kilometre rule used.
Two fast stretches with a walk between them is a fartlek or a hill repeat picked up by chance, not a structured interval session.

**The adjacency requirement** (a rep needs a recovery immediately beside it) is what tells an interval session apart from a tempo block.
Three fast kilometres run back to back, with no recovery between any of them, are three **R** labels with no **W** neighbour, so none of them counts as a rep.
`test_a_rep_needs_a_recovery_beside_it` is this case.

**The lap `trigger` field is deliberately not read.**
A rep can arrive as a `distance` lap, when it happens to be a full kilometre and the watch's auto-lap coincides with it, or as a `manual` lap, when the athlete pressed lap at the start and end of every rep by hand.
`test_reps_recorded_as_manual_laps_are_found` is the synthetic case for the second shape.
Two of the nine real sessions are that shape, see "Rejected rules" below.

## The effort tags

`classify_effort` tries Intervals first, because it needs no heart rate at all.
84 of the 307 real runs have none recorded, and a rule that could not classify them would leave a large fraction of the history untagged for a reason that has nothing to do with what kind of session it was.

When there are fewer than `MIN_REPS` reps, the function falls back to heart rate, evaluated against the athlete's own maximum for that activity (`max_hr_bpm`), from the most extreme end inward, so that a session which is both hard and even reads as All out rather than Steady:

| Tag | Condition |
| --- | --- |
| All out | at least 10% of recorded seconds at or above `ALL_OUT_ABOVE` (90%) of max HR, evaluated first |
| Easy | median HR below `EASY_BELOW` (75%) of max |
| Steady | median HR between `EASY_BELOW` and `STEADY_BELOW` (85%) of max |
| All out | median HR at or above `STEADY_BELOW`, evaluated last as the remaining case |

The three fractions come from the original tag table.

**That table also conditioned Easy and Steady on pace variation, and the implementation does not.**
It defined Easy as "Median HR below 75% of max, low pace variation" and Steady as "Median HR 75 to 85% of max, split pace variation under 5%".
The implementation above classifies both from median heart rate alone.
The pace-variation half of each rule is not implemented.
The consequence: an evenly paced run and a ragged one with the same median heart rate receive the same tag today, although the original table excluded the ragged one from Steady.
See "Deliberately not modelled" below.

**Heart rate has to cover `MIN_HR_COVERAGE` (50%) of the run's seconds before any of the four rows above is read from it.**
The rules above are a median and a fraction over the seconds that carry a heart rate, and neither says anything about the session if there are only a handful of them.
Concretely: a 90 minute run whose optical sensor records 40 s of a spurious 190 bpm at the start and nothing afterwards has a median of 190 and spends 100% of its recorded seconds above 90% of a 207 bpm maximum, so without the guard it is tagged All out with a reason asserting something about the run that is demonstrably false.
`test_a_short_burst_of_heart_rate_does_not_classify_the_run` is that case.

The threshold comes from the real distribution rather than from taste.
The denominator is every second on the derived grid, including the paused and outage seconds across which the derived layer nulls heart rate, which is why ordinary runs sit below full coverage at all.
Measured on 2026-08-31 over the 223 of 307 runs that carry any heart rate: the lowest coverage is 66.25%, the first percentile is 84.6%, the fifth is 91.0% and the median is 100%.
50% therefore rejects none of them and leaves over 16 points of margin below the worst real run, while the failure it exists for sits at 0.7%.
`test_ordinary_partial_heart_rate_coverage_still_classifies` pins the other direction, that a run at 70% coverage is still classified.

The reason strings say **recorded seconds** rather than "the run" wherever the denominator is the recorded seconds, because those are not the same number and the All out reason used to claim the larger one.

So `classify_effort` declines in three cases, always with a reason string naming which input was missing rather than guessing: no heart rate at all and no qualifying reps, heart rate covering less than `MIN_HR_COVERAGE` of the run, or heart rate present but no maximum HR recorded in the athlete profile interval covering the activity.
`test_no_heart_rate_and_no_reps_is_unclassified_with_a_stated_reason`, `test_a_short_burst_of_heart_rate_does_not_classify_the_run` and `test_no_max_heart_rate_is_unclassified_with_a_stated_reason` are these cases.

## The history flags

`TagHistory` needs the rest of the activity history, so the flags are computed during a full recompute rather than incrementally.

**It is prepared once and then queried per activity**, which is not only a speed concern.
Everything that does not depend on which activity is being asked about is built in the constructor: the timestamp conversion, the trailing window's distances, and per distance the running best that a record has to beat.
The first implementation took the whole activity and effort frames per call and rebuilt all of that on every one of them, which is quadratic in the length of the history.
Measured over the real store on 2026-08-31, the flag pass alone took 5.12 s, against the roughly 12 s a whole rebuild takes in `docs/reference/derived-layer.md`; prepared once it takes 0.017 s for the same 97 flag rows, and the constructor is where the growth now lives.

**Long run** fires when an activity's distance exceeds the `LONG_RUN_QUANTILE` (90th percentile) of the distances run in the trailing `LONG_RUN_WINDOW_DAYS` (90 days) up to and including that activity, and the window holds at least `LONG_RUN_MIN_RUNS` (5) runs.
The comparison is strict (`>`, not `>=`): a window whose distances are all equal makes the decile threshold equal to every one of them, and `>=` would then tag every run in it as a long run, which is not what "top decile" is supposed to mean.
`test_a_typical_run_is_not_a_long_run` is a window of ten 5 km runs and one more 5 km run: the threshold is exactly 5000 m, and the eleventh run is not longer than that, so it is not flagged.
`test_long_run_fires_in_the_top_decile_of_ninety_days` is the same window with one 20 km run added, which clears the threshold with room to spare.

**PR** fires when a best effort at some distance beats every earlier eligible effort at that same distance, strictly, and on the first eligible effort at a distance.
The first case was the original rule; the second was added on 2026-09-05 (`ANALYSIS_VERSION` 6), resolving a documented disagreement with `/api/records`.
That endpoint means "your best", which exists as soon as there is one effort, while the tag meant "beat a previous best", and the two diverged for exactly one case: a distance with a sole eligible effort, which the Records view named as the holder while the activity carried no tag.
The progression chart forced the question, because a first point must either be marked as a record or not, and marking it makes the tags, the endpoint and the chart three views of one rule.
The feared cost of the second case, tagging the first year of history wall to wall, does not arise: it is one row per distance key that has any eligible effort, the same set `/api/records` lists, which is nineteen on the real history as of 2026-09-12 and grows by one when a distance is first covered rather than by one per activity.
The first effort's `reason` says it was the first eligible effort at the distance rather than that it beat anything, since reusing the "beating X over N earlier efforts" wording would assert something false.
`test_a_first_ever_eligible_effort_is_a_record`, `test_the_first_effort_reason_says_it_beat_nothing` and `test_the_second_effort_is_measured_against_the_first` are this case; `test_an_ineligible_first_effort_is_still_not_a_record` pins that eligibility is unchanged by it.

Each PR row carries the distance in a `distance_key` field of its own, not only inside its prose.
A breakthrough 5 km records at every extracted distance it covers, which since 2026-09-12 is eight of them (400 m, 1 km, 1 mile, 2 km, 3 km, 4 km, 3 miles and 5 km), so eight rows arrive with the same `tag`, and a client rendering `tag` as a chip would show the same chip eight times with the distance readable only by parsing `reason`, which is prose and explicitly not a parsing surface.
The flag is `None` there for every tag that is not about one distance.

**Not every best effort is eligible to be a record.**
Two classes of effort are excluded, on **both** sides of the comparison: as the candidate, and as the earlier best the candidate has to beat.

- **Efforts from activities the caller marks ineligible.** `analysis.pipeline` passes every activity not known to have been run outdoors, which is the treadmill runs plus any whose `is_indoor` is not known.
  The invariant is stated under "Best efforts" in `docs/reference/derived-layer.md`: a treadmill distance comes from an uncalibrated footpod, so it must not become a record.
  `TagHistory` takes the identifiers as an argument rather than reading `activity_metrics` itself, because nothing in `analysis/` does I/O.
- **Efforts whose `distance_trusted` is not true.** An implausible advance in the recorded distance credits metres nobody ran, and unlike a pause or an outage it makes an effort *faster* than it was.
  Since `ANALYSIS_VERSION` 10 a flagged effort still counts when the measured speed confirms its distance within 1%, which `best-efforts.md`, "The speed-agreement check", derives; on the real store that made one long run the record at 10 miles, 20 km and the half marathon, three more PR rows.
  `contains_pause` and `contains_outage` are not excluded, because under elapsed time both can only make an effort slower.

Excluding only the candidate side would leave the worse half of the fault in place.
An over-reading footpod produces a 5 km nobody can beat outdoors, and while it stands as the baseline it suppresses every genuine record after it silently: no wrong tag appears, a right one simply never does.
Measured over the real store on 2026-08-31, that is not hypothetical: the exclusion raises the number of PR rows from 43 to 54 and the number of activities carrying one from 30 to 32.
Eleven genuine records were being hidden behind uncalibrated ones.
`test_an_excluded_activity_cannot_set_a_record` and `test_an_excluded_activity_is_not_the_record_to_beat_either` are the two directions, with `test_an_effort_containing_a_jump_cannot_set_a_record` and its counterpart for the flag, and `test_a_jump_the_measured_speed_confirms_can_be_a_record` for the readmission.

A null flag is read as "not known" rather than as "clean", so an activity with an unknown `is_indoor` and an effort with an unknown `distance_trusted` are both excluded.
A record is the one consumer for which an unverified effort is worse than no effort at all.

## Rejected rules

**Per-kilometre splits**, the original rule ("three or more pace swings crossing 10% either side of the median"), cannot score at all on a real interval session, because a rep run as a sub-kilometre lap does not line up with a kilometre split.
On the 2026-08-25 session the five reps ran 4:12, 4:27, 4:26, 4:28 and 4:33 per km, each followed by a roughly 90-second walk of 150 to 165 m.
The per-kilometre splits over the same run read 7:47, 6:53, 5:07, 5:17, 5:15, 5:06, 4:42, 13:31 and 6:53: every rep's pace is blended with part of the walk either side of it, so no split is even 10% faster than the median, and the three swings the rule needs would instead have come from the warm-up, the long stop and the cool-down.
Reproduced against the laps table for that activity: the recorded reps are 1000 m laps of 252.3, 266.6, 265.7, 267.7 and 272.9 s (4:12.3, 4:26.6, 4:25.7, 4:27.7 and 4:32.9 per km), which matches the rep paces above to the second.

**A rule keyed on `lap.trigger == "distance"`** was tried next: require a rep to be a `distance`-triggered lap, and keep the same cadence-and-pace-plus-adjacency test otherwise.
Reproduced against the nine sessions the shipped rule fires on:

```python
# reps require trigger == "distance"; recoveries are read from any trigger, as before
if pace is None or cadence is None or pd.isna(cadence):
    label = "-"
elif row["trigger"] == "distance" and cadence >= REP_CADENCE_SPM and pace <= avg_pace * REP_PACE_FRACTION:
    label = "R"
elif cadence < RECOVERY_CADENCE_SPM:
    label = "W"
else:
    label = "-"
```

this scores 7 of 9: it finds 5 reps on seven sessions, the 2026-08-25 fixture among them, but it finds 0 reps on one and only 1 on the session the table below lists last.
Both misses are sessions where the athlete pressed lap at the start and end of every rep by hand, so every lap - rep and recovery alike - carries `trigger == "manual"`, and a rule that requires `trigger == "distance"` for a rep cannot see any of them.
The shipped rule ignores `trigger` entirely and fires on all nine.

## The error that survives

The rep count is the count of qualifying laps, not the count of reps the athlete intended to run.
A fast final kilometre that happens to sit beside a recovery lap, run at the end of a session as a strong finish rather than as a planned rep, is counted the same as any other rep.

On one real session this reports 7 reps where the athlete ran 6 planned intervals and then finished the last kilometre fast.
The pattern found is `RRWRWRWRWRWRWRW-R-`, which carries nine `R` labels but counts seven.
Three of those labels sit outside the plain alternating body: the two leading `R`s and the late `R` at index 16.
Only the second of the leading pair is counted, because it is the only one of the three with a `W` immediately beside it - the first has an `R` after it and nothing before it, and the late one sits between two `-`.
That single extra count is the whole overcount: six planned reps become seven.
This is a known, bounded error: it can only ever overcount by laps that are themselves genuinely fast and cadence-consistent with running, never by walks or warm-up kilometres.
It is left as is rather than patched with a heuristic for "which R was the last real rep", which would need information the lap sequence does not carry.

## Reproduced against the real store

Measured on 2026-08-30 over the 307 real runs in the export:

```bash
uv run python - <<'EOF'
from pathlib import Path
import pandas as pd
from activity_analysis.analysis.tags import interval_reps, MIN_REPS
from activity_analysis.config import Paths
from activity_analysis.store import db

con = db.connect(Paths(Path(".")))
laps = con.execute("""
  select l.activity_id, l.lap_index, l.trigger, l.distance_m, l.elapsed_time_s, l.avg_cadence_spm
  from laps l join activities a using (activity_id)
  where a.sport='running' order by l.activity_id, l.lap_index
""").df()
base = con.execute("""
  select a.activity_id, a.start_time_utc::date as d, m.moving_time_s, m.distance_m
  from activities a join activity_metrics m using (activity_id) where a.sport='running'
""").df().set_index("activity_id")

fired = []
for aid, g in laps.groupby("activity_id"):
    if aid not in base.index: continue
    row = base.loc[aid]
    if not row["distance_m"] or row["distance_m"] <= 0: continue
    reps, pattern = interval_reps(g, row["moving_time_s"] / (row["distance_m"] / 1000.0))
    if reps >= MIN_REPS:
        fired.append((str(row["d"])[:10], reps, pattern))
print(f"{len(fired)} of 307 runs classified as intervals")
for d, reps, pattern in sorted(fired, reverse=True):
    print(f"  {d}  {reps} reps  {pattern}")
EOF
```

gives exactly 9 of the 307 runs, no false positives against the other 298:

| session | reps | pattern |
| --- | --- | --- |
| 2026-08-25, the fixture | 5 | `-WRWRWRWRWR---` |
| real | 5 | `--RWRWRWRWRW--` |
| real | 5 | `--RWRWRWRWRW-----` |
| real | 5 | `--WRWRWRWRWRW-` |
| real | 5 | `RWRWRWRWRW-` |
| real | 5 | `--RWRWRWRWR--` |
| real | 5 | `--WRWRWRWRWRW--` |
| real | 5 | `-RWRWRWRWRW-R` |
| real | 7 | `RRWRWRWRWRWRWRW-R-` |

Eight of the nine show the plain alternating `RW` shape the rule is built around.
The last is the one carrying the known overcount described above.

Re-measured on 2026-08-31, after the recovery label stopped requiring a pace, after the heart rate coverage guard and after the record eligibility rule: still exactly 9 of 307, on the same nine sessions, with the same rep counts and patterns.
The other figures over the same 307 runs, for the same reason:

| Measurement | Value |
| --- | --- |
| Runs with no effort tag | 86, of which 84 have no heart rate at all and 2 have heart rate but no maximum HR in the profile interval covering them |
| Runs declined for heart rate coverage | 0, the lowest real coverage being 66.25% against a 50% threshold |
| All out tags | 88, of which 66 from the sustained branch and 22 from the median fall-through |
| Steady, Easy | 79 and 45 |
| PR rows | 54 over 32 activities, up from 43 over 30 before ineligible efforts stopped setting the baseline |
| Long run rows | 43, unchanged by the eligibility rule |
| Flag pass runtime | 0.017 s prepared once, against 5.12 s rebuilt per activity |

The two runs with heart rate but no maximum fall in a profile interval whose own `max_hr_bpm` is null, as `docs/reference/derived-layer.md` records, not a fault in this rule.
Inferring the missing maximum, say from the top zone boundary, is not done, because it would write an inferred value into the time-versioned profile every zone distribution and normalised trend reads.

## Deliberately not modelled

- **Pace variation in Easy and Steady.** The original tag table conditioned both on pace variation as well as median heart rate ("low pace variation" for Easy, "split pace variation under 5%" for Steady).
  Only the heart rate half of each rule is implemented, so an even-paced run and a ragged one with the same median heart rate get the same tag.
  See "The effort tags" above for the gap in full.
- **Intended rep count.** The rule counts qualifying laps, not the number the athlete planned.
  See "The error that survives".
- **Warm-up and cool-down as part of the session shape.** They are labelled `-` and play no role beyond not being mistaken for a rep or a recovery.
  Nothing here reports session structure such as "5 x 1 km with a 2 km warm-up".
- **Effort tags on non-running sports.** Every rule here reads laps and a grid produced by the running-specific derived layer, so a cycling or swimming activity is not tagged.
- **Combining Long run and PR into the effort tag.** They stay additive flags, per "What is being computed", rather than a fifth and sixth exclusive category.
- **Excluding treadmill runs from Long run.** Those kilometres were run, and `docs/reference/derived-layer.md` counts treadmill distance towards distance, time and zone totals while excluding it only from records, trends and predictions.
  A long treadmill run is a long run.
- **Excluding GPX-sourced efforts from records.** GPX carries 10.2 times the sample-to-sample speed noise of FIT, but its distance is still GPS-measured rather than footpod-estimated, and the invariant in `docs/reference/derived-layer.md` names `is_indoor` alone.
  If a GPX-sourced record ever looks wrong, `is_gpx_sourced` is already on `activity_metrics` and the exclusion is one identifier set away.
- **Session structure in a PR reason.** A record row names its distance and the time it beat, not what the rest of the session was.
- **A trend or history of tags.** This document covers the per-activity rule only.
  Whether Intervals sessions are becoming more or less frequent over time is a question for the trend layer, not for this one.
