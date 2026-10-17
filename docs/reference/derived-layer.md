# The derived layer

Reference for `data/derived/`, produced by `activity-analysis recompute` from the canonical store.
Read this before changing anything under `src/activity_analysis/analysis/`.

This document is the derived layer's reference: what the columns mean and which conventions are load-bearing.

## Rebuilding

```bash
uv run activity-analysis recompute
```

Always a full rebuild, never incremental.
Over the real history, 307 runs, this takes roughly 14 seconds in process, about 3 of them the efficiency pass's bootstrap and most of the rest writing 307 Parquet files.
Incremental logic would be more code than the thing it accelerates, and a stale derived row is a silent bug rather than a loud one.

Every derived row carries `analysis_version`, from `config.ANALYSIS_VERSION`.
Bump it when a metric definition changes, so an old file is identifiable rather than silently mixed with a new one.

The rebuild also deletes every derived grid it did not itself write, whether the activity left the canonical store, had no streams, or failed.
A full rebuild that leaves orphans behind is not a full rebuild, and the invariant it upholds is that an activity present in `streams_1hz` is present in `activity_metrics` too.
An activity that fails is reported in `RecomputeResult.errors` and contributes nothing to any derived table.

Only running activities are processed: 307 of the 1944 ingested.
Best efforts and the efficiency fits that come later are running metrics, so other sports stay canonical-only until there is a reason.
A run slower than 9:00/km is counted as a walk and gets nothing past its own judgement; see "Sport reclassification" below.

## The gap rule: stops and outages

Three constants, all in `analysis/resample.py`, all fixed by measurement over the real history on 2026-08-29.
Do not scatter copies of them.

| Constant | Value | Why |
| --- | --- | --- |
| `PAUSE_MIN_GAP_S` | 15 s | The device's smart recording reaches 9 s during ordinary running, and 99% of all 171146 measured gaps fall at or below that |
| `PAUSE_MAX_IMPLIED_SPEED_MPS` | 0.5 m/s | At 20 to 30 seconds the median implied speed across a gap is 0.11 m/s, so the athlete had stopped |
| `PAUSE_UNCONDITIONAL_GAP_S` | 120 s | Nothing plausible keeps a running watch silent for two minutes mid-effort |

`find_gaps` classifies every unrecorded stretch as one of two things, and the difference is load-bearing.

| Kind | When | Flag | Counts as moving time |
| --- | --- | --- | --- |
| **Stop** | Gap over 15 s **and** the distance advanced across it implies under 0.5 m/s | `paused` | No |
| **Outage** | Gap over 120 s that is not a stop, so the odometer did advance | `outage` | Yes |

**Distance is never held, across either kind.**
`distance_m` and the positional channels interpolate linearly across every gap without exception, including one whose distance channel is simply null; `speed_mps`, `hr_bpm` and `cadence_spm` are null across stops and outages, because nothing measured them there.

A gap of 15 to 120 s across which the athlete kept moving is neither a stop nor an outage.
It is ordinary smart recording, so every channel interpolates across it and its seconds count as measured.
That band is what `PAUSE_UNCONDITIONAL_GAP_S` exists to bound, and it is deliberate.

Holding distance was tried and it was a mistake.
A genuine stop advances the odometer by approximately nothing, so interpolating across it adds approximately nothing and a coffee stop still does not become a slow kilometre, which was the entire purpose of holding.
When the odometer does advance across a gap, holding compresses the whole advance into the single second the recording resumed, and `best_effort` then interpolates a window start inside that jump.
Measured against the two cases that were caught: a 150 s outage advancing 450 m produced a 400 m effort of 0.89 s, and a 300 s stop advancing 140 m of GPS drift produced 400 m in 88 s at 4.5 m/s, at least half as fast again as the athlete ever ran, both with `contains_pause` false so no consumer could filter them.
Spreading the advance over the seconds it actually occupied is what happened: 140 m over a 300 s stop is 0.47 m/s, which cannot trouble a best effort.

**What the classification is still for.**
A stop is time the athlete was not training, so those seconds leave `moving_time_s`.
An outage is time they were running unobserved, so those seconds stay in it.
Neither kind reaches time in zone: heart rate is null across both, and a second with no heart rate cannot be attributed to a zone.
So `sum(zone_time.seconds_s)` is below `moving_time_s` by the length of every outage, by construction rather than by accident.

**Duration alone is not enough to find a stop, and this is the part that is easy to get wrong.**
In the 10 to 14 second band, 1433 gaps across 131 runs, the median implied speed is 1.60 m/s: the athlete was still running, and nulling those samples would tear holes in over 40% of the history.
The 15 to 19 second band is genuinely mixed, 31 of its 62 gaps stopped when re-measured on 2026-09-05, and only the distance separates the two cases.

## The 1 Hz grid, `streams_1hz/<activity_id>.parquet`

One row per second of elapsed time, including seconds spent standing still.

| Column | Meaning |
| --- | --- |
| `t_s` | Seconds since the first record. Always integral, always contiguous |
| `timestamp_utc` | Wall clock, advancing exactly one second per row |
| `distance_m` | Cumulative, monotone non-decreasing |
| `speed_mps`, `hr_bpm`, `cadence_spm`, `altitude_m`, `lat_deg`, `lon_deg` | Linearly interpolated between recorded samples |
| `paused` | True for seconds inside a detected stop. Excluded from moving time and from time in zone |
| `outage` | True for seconds inside a recording outage. Counted as moving time, but nothing there was measured |

**Across a gap of either kind, `distance_m` interpolates and the row is still emitted.**
The row is emitted rather than skipped because the clock has to keep running for best efforts to span the stop.
Distance interpolates because the odometer is the only record of what happened, and spreading its advance over the seconds it occupied is the honest reading.
`speed_mps`, `hr_bpm` and `cadence_spm` are null across a classified stop or outage, so no measurement is invented there; `lat_deg`, `lon_deg` and `altitude_m` interpolate along with distance, since they come from the same track.

**A channel is never extrapolated beyond where it was recorded.**
If the heart rate monitor connected four seconds into the run, those four seconds are null rather than backfilled with the first reading.

## Sport reclassification, `sport_reclassifications.parquet`

One row per activity recorded as `running` whose average moving pace is slower than 9:00/km, `ANALYSIS_VERSION` 13.
`recompute` judges every run right after resampling it, on `activity_metrics.avg_speed_mps` as it would be: the canonical distance over the grid's moving time.
An activity that fails gets this row and nothing else: no grid, no row in any other derived table, and no place in a population a run is judged against, so it is not the previous run of the next one and not one of the runs a long run is measured against.
A run with no streams, or one whose rebuild failed, was never judged and stays a run.
On the store of 2026-10-06 that is 10 of 345 runs, eight of them treadmill sessions.
`docs/reference/math/reclassification.md` has the rule, the measurements and what it leaves out.

| Column | Meaning |
| --- | --- |
| `recorded_sport` | What the device wrote, `running` |
| `sport` | What the activity is counted as, `walking` |
| `avg_speed_mps` | The pace it was judged on |
| `threshold_mps` | The speed it fell below, 1000/540 m/s |

Canonical keeps the recorded sport.
The DuckDB `activities` view serves the counted one as `sport`, with the recorded one as `recorded_sport`; see "DuckDB" below.
`athlete_profile` is still versioned from the recorded sport, since an activity started on the running profile carries that profile's settings.

## Best efforts, `best_efforts.parquet`

One row per activity per standard distance the run actually covered.
Twenty-two distances, in ascending order: 400 m, 1 km, 1 mile, 2 km, 3 km, 4 km, 3 miles, 5 km, 6 km, 8 km, 5 miles, 10 km, 8 miles, 15 km, 10 miles, 20 km, half marathon, 15 miles, 25 km, 30 km, 35 km, marathon.
The order is part of the contract: the records ladder and the activity badges both sort by position in it, because `'10k'` sorts before `'1k'` alphabetically and after it in metres.

A distance appears only where an activity reached it, so the table has 2680 rows over the 307 real runs and holds nothing at 30 km, 35 km or the marathon, the athlete never having run 30 km.
8 km and 5 miles are 46.7 m apart and both are kept deliberately; `docs/reference/math/best-efforts.md` has the measurement and the cost.

**Efforts are measured in elapsed time and windows span pauses.**
A run of 5 km in 30:00, five minutes standing still, then 5 km in 30:00 yields a 10 km effort of **65:00**.

Two alternatives were considered and rejected.
Restricting windows to contiguous moving segments reports no 10 km effort at all for that run, discarding a distance the athlete genuinely covered.
Measuring in moving time reports 60:00, which is the one rule under which resting is free.
Under elapsed time a pause can only ever make an effort slower, so the longest recorded stop, 43.7 minutes, simply produces a very slow effort that never troubles a record.
That invariant is why the grid never holds distance: holding was the one thing that could make a stop produce a faster effort.

The window start is interpolated between the two samples straddling the target distance, so the answer does not depend on where the second boundaries happen to fall.
A synthetic 5 km at exactly 5:00/km returns exactly 1500.0 s whether or not the run starts on a second boundary.

Three flags say what an effort's window crossed.
`contains_pause` marks a stop, `contains_outage` a recording outage where every metre is interpolated and nothing was measured, and `contains_jump` an advance in the recorded distance faster than a human can move, which credits metres nobody ran whatever produced it.
They are the same shape as `is_indoor` and `is_gpx_sourced`.
The consumer decides what to exclude, but it cannot decide what it cannot see.

The first two are not corrections: under elapsed time both make an effort slower rather than faster, and an outage window reports the outage's own average speed, which understates any real surge.
`contains_jump` is different, because a jump does inflate the effort, and the decision was to flag now and correct later: the trace stays exactly as the device wrote it, and nothing is clamped, redistributed or dropped.

**`distance_trusted` is the column a consumer excludes on, not `contains_jump`** (`ANALYSIS_VERSION` 10, decided 2026-09-27).
It is true when the window holds no jump, or when the recorded distance is within `SPEED_AGREEMENT_TOLERANCE`, 1%, of `speed_distance_m`, the distance the device's measured speed accounts for over the same window.
One half marathon is the case it exists for: one second of its odometer gains 15.16 m, nearly five times what the speed channel reads in that second, and over the whole effort the two agree to 0.20%, so it is now the half marathon record.
The check only readmits: an effort with no jump is trusted whatever its speed channel says.
`speed_distance_m` is null when the speed channel was derived from the distance itself, which GPX always is, because it then confirms nothing, and such an effort cannot be readmitted.
`best_efforts.distance_trusted` is the one in-memory reading of the rule, `best_efforts.jump_reasons` says which of three reasons applies when it fails, and `docs/reference/math/best-efforts.md`, "The speed-agreement check", derives the integral and measures the tolerance.

| Column | Meaning |
| --- | --- |
| `speed_distance_m` | Metres the measured speed accounts for over the window, the trapezoid of each grid interval clipped to it. An interval with a null speed contributes nothing. Null when the stream's speed channel is the odometer's own derivative |
| `distance_trusted` | `not contains_jump or abs(distance_m / speed_distance_m - 1) <= 0.01`. Null on a file written before `ANALYSIS_VERSION` 10 |

`IMPLAUSIBLE_SPEED_MPS`, 12.5 m/s, sits just above the peak speed of the 100 m world record, roughly 12.4 m/s, so no human locomotion can exceed it and the flag cannot false-positive for any athlete.
Measured over the real history on 2026-08-30, sample-to-sample implied speed has p99.9 of 7.35 m/s and p99.99 of 20.76 m/s, so the threshold sits inside that knee: 50 samples across 31 of 307 runs exceed it.

**It deliberately under-detects, and that is the known limitation.**
460 samples across 124 of 307 runs exceed this athlete's own demonstrated best speed, so most of those are very likely spurious advances too.
Separating them from real running needs an athlete-relative or trajectory-based model rather than a universal physical bound, which is not built yet.

**Treadmill efforts are computed but must not become records.**
Their distance comes from an uncalibrated footpod.
Join to `activity_metrics.is_indoor` and exclude, as personal records, best-effort trends and race prediction all must.

## Time in zone, `zone_time.parquet`

Long rather than wide: one row per activity per zone.
A week's zone distribution is then a `GROUP BY` rather than an unnest, and the number of zones is a device setting rather than a constant.

`n` boundaries define `n + 1` zones.
The device supplies six, 104 / 124 / 145 / 166 / 186 / 207 bpm, so there are seven zones.
Zone 0 is everything below the first boundary and zone 6 everything at or above the last.
**A sample sitting exactly on a boundary belongs to the zone that boundary opens**, so 104 bpm is zone 1, not zone 0.

Paused seconds and seconds with no heart rate are excluded.
Standing still is not time in zone 1, and an unrecorded second is not a measurement.

**The device's own totals are the test oracle.**
Every FIT carries `time_in_zone` messages, per lap and per session, holding the device's own answer.
This is the rare case where a derived metric has real ground truth on real data, and `tests/test_zones.py` asserts against it.

The two do not agree exactly and should not be expected to.
The device works from its internal one-second sampling while this works from the smart recorded samples the file actually contains, so interpolation moves some seconds across a boundary.
On the reference activity the totals agree to within 2 s and the largest per-zone difference is 46 s out of 2931.

Note when reading these messages: a file also holds a `split`-referenced `time_in_zone` whose boundary tuple is all nulls.
It is not a settings record and must be skipped, which is why `fit_reader` checks the tuple's contents rather than only its presence.

## The two profile tables

`profile_observations.parquet` is **canonical**: one row per activity that carried `user_profile` or `zones_target`, recording what the device was configured with at that moment.
`athlete_profile.parquet` is **derived**: consecutive identical observations collapsed into intervals, with `effective_to` null for the interval still in force.

Splitting them this way is what makes the rebuild possible.
Collapsing needs every observation at once, so the raw observations have to survive as facts and the intervals have to be recomputed rather than merged into.

**Zone settings are per sport, and mixing them produces nonsense.**
`zones_target` carries the maximum heart rate configured for the sport of that activity: 207 bpm for running, 205 bpm for walking and training.
Observations are stored for every sport, because they are facts about the file, but `athlete_profile` is built from running observations alone via `observations_for_sport`.
Scoped that way the real history collapses to six intervals as of 2026-10-05; unscoped, when it held five, it produced 297, every one of them recording which sport happened next rather than anything the athlete edited.

The versioning captures configuration changes, not physiology.
A profile that has stood for a year means nobody touched the setting, not that body mass held steady.

**Nothing is extrapolated backwards.**
The 84 earliest runs carry no profile messages, so `profile_at` returns None for them and they get no zone rows.
They also carry no heart rate at all, so there is nothing to attribute to a maximum and nothing to backfill.

The boundaries the device supplies are a default rather than the law.
Athlete-configurable zones and maximum heart rate are not built yet.

## Garmin's own VO2max, `device_vo2max.parquet`

`device_vo2max.parquet` is **canonical**: one row per athlete and calendar day, Garmin's own running VO2max, written by `ingest` from a Garmin export's `DI_CONNECT/DI-Connect-Metrics/MetricsMaxMetData_*.json` files.
The columns are `athlete_id`, `calendar_date`, `vo2max` (`maxMet` × 3.5, ml/kg/min, converted once at ingestion), `vo2max_reported` (the whole number the watch shows), `device_id`, `updated_at` and `source_file_sha256`.
`updated_at` is Garmin's `updateTimestamp`, which states no zone, so it is stored without one and used only to order one day's updates.
Writing upserts on athlete and day and keeps the later `updated_at`, so a newer export overlapping an older one replaces the days they share and an older file cannot roll a day back.
Each MaxMet file is ledgered by content hash like a FIT file, with `source` `garmin_export` and `status` `vo2max`.
No derived table reads it; `GET /api/fitness` projects it as `device`.

## Per-activity metrics, `activity_metrics.parquet`

One row per running activity.

| Column | Meaning |
| --- | --- |
| `elapsed_time_s` | The span the grid covers, last second minus first, so total seconds including stops. Not the canonical `activities.elapsed_time_s`, which for a FIT with a session is the device's own `total_elapsed_time` |
| `moving_time_s`, `paused_time_s` | Elapsed split by the `paused` flag |
| `distance_m` | Last value on the grid |
| `avg_speed_mps` | The **canonical** `activities.distance_m` over the `moving_time_s` in this table, null rather than zero unless both are positive. **Not `distance_m` over `moving_time_s` from this same row**: the grid's odometer is a footpod estimate indoors, where there is no satellite fix, and the two differ by up to 17.6% on the real treadmill runs. Mixing the two sources is the same shape as `ascent_per_km_m` below and has the same justification, that the device's number is the better one for that term. Served unchanged by the API, and read by the efficiency fit to tell a walk from a run. See `docs/reference/math/units.md` |
| `ascent_per_km_m` | From the device's barometric total, not from summing per-second altitude differences, which inflates badly |
| `is_indoor` | `sub_sport == "treadmill"`, 81 of 335 runs. Not the same set as `has_gps` false, which is 86: five Garmin FIT runs with `sub_sport` `generic` recorded no position either |
| `has_hr`, `has_gps` | Whether the channel exists at all, so consumers can say what they excluded |
| `is_gpx_sourced` | GPX carries 10.2 times the sample-to-sample speed noise of FIT |
| `locality`, `country_code`, `country`, `locality_distance_m` | Where the activity started, resolved offline; see "Where an activity happened" below |
| `days_since_previous_run` | Local calendar days since the previous running activity's start, over the whole history rather than any filtered view. Null on the first run, and 0 rather than negative when travel west puts a later run on an earlier local date. See `docs/reference/math/rest-days.md` |

The flags matter as much as the numbers.
Treadmill runs count towards distance, time and zone totals, because those kilometres were run, and are excluded from records and predictions.
Every consumer should state which side of `is_indoor` it is on.

## Activity tags, `activity_tags.parquet`

Long, one row per tag, not one row per activity.
An activity can carry two kinds of tag, distinguished by the `kind` column.

`effort` is the exclusive classification of the session: at most one row per activity.
`flag` is an additive fact about the session: an activity can carry zero, one or several.
Every row's `reason` states the numbers that produced it, because a classifier whose reasoning is hidden stops being trusted the first time it is wrong.

`distance_key` is populated on a `pr` row and null everywhere else.
One run records at several distances at once, so several `pr` rows share an `activity_id` and a `tag`, and the distance has to be a column rather than something a consumer digs out of the prose in `reason`.

`rep_count` is populated on an `intervals` effort row and null everywhere else, for the same reason: the rep count is otherwise only readable inside `reason`'s prose.

`rep_pattern` (added `ANALYSIS_VERSION` 4) is populated on an `intervals` effort row and null everywhere else: the raw per-lap `R`/`W`/`-` string `interval_reps` produced, one character per recorded lap in recorded order.
It lets a consumer colour individual recorded laps as a rep or a recovery without recomputing `analysis.tags`'s own cadence-and-pace classification.
Null on a row written before this column existed, the same as every other flag in this file.

**Records exclude the efforts the best-efforts invariant above says they must**, on both sides of the comparison: an ineligible effort neither sets a record nor becomes the baseline a later record has to beat.
That is treadmill activities via `activity_metrics.is_indoor`, plus efforts whose `distance_trusted` is not true.
`docs/reference/math/tags.md` has the measured effect, which is that eleven genuine records were hidden behind uncalibrated ones.

**The first eligible effort at a distance is a record** (`ANALYSIS_VERSION` 6, decided 2026-09-05).
Its `reason` says it was the first eligible effort at the distance rather than that it beat anything.
The earlier rule tagged nothing for a first effort, which made the tags disagree with `/api/records` for exactly one case, a distance with a sole eligible effort; the progression chart forced the question because a first point must either be marked or not.
On the real history this is one extra `pr` row per distance key, eight in all.

A run with no `effort` row was not classified, and the `reason` on the classifier's null result says which absence stopped it: no recorded reps and no heart rate, or heart rate present but no maximum heart rate in the athlete profile for that activity.
Measured over the real history on 2026-08-30, 86 of 307 running activities carry no `effort` tag: 84 of them have no heart rate at all, the same 84 that carry no zone rows, and two more fall in the few days after the athlete profile's first observation, where a `user_profile` message exists but its own `max_hr_bpm` is null.

The rules themselves, the reasoning behind each threshold, and the rejected alternatives are in `docs/reference/math/tags.md`.
This file only describes the table's shape.

## Efficiency, `activity_efficiency.parquet`

One row per running activity that entered the efficiency fit.
On the real history that is 227 of 335 on 2026-10-16.

An activity gets a row when it is outdoors, is not tagged `intervals`, is not a walk, and has at least 600 seconds that are unpaused, outside an outage and faster than 1 m/s.
Treadmill runs are excluded because a footpod's distance is uncalibrated, so its speed cannot be compared across runs, which is the one thing this table exists to do.
Intervals are excluded because heart rate lags speed sharply through repetitions, so the relation being fitted does not hold inside one.
A walk is excluded as a whole activity, by its own moving speed being under 2.0833 m/s (8:00/km), because the per-second speed filter cannot see one: a walk with brisk stretches has plenty of seconds above 1 m/s. It excludes no activity today: the one it did exclude, a run 40% slower than 9:00/km, is counted as a walk since `ANALYSIS_VERSION` 13 and never reaches the fit. It stays because it guards the reference pace between 8:00 and 9:00/km, a band the reclassification leaves to running.
`easy`, `steady`, `all_out` and unclassified runs all take part, and `effort_tag` carries which, copied from `activity_tags` so a consumer can narrow the trend without a join; it was null for the 53 of 208 rows whose run was never classified on 2026-09-12.

| Column | Meaning |
| --- | --- |
| `hr_slope_own_bpm_per_mps`, `cadence_slope_own_spm_per_mps` | The activity's own least-squares slope of the channel against speed, before shrinkage. Kept so a reader can see how far shrinkage moved it |
| `hr_slope_se_bpm_per_mps`, `cadence_slope_se_spm_per_mps` | The standard error of that slope from a moving-block bootstrap with 120 s blocks. **Not an ordinary least-squares error**, which is about nine times smaller on these grids because consecutive seconds are autocorrelated. Null when the channel had fewer than 600 finite usable seconds, or when the run's speed did not vary and so no slope exists |
| `hr_slope_weight`, `cadence_slope_weight` | `tau^2 / (tau^2 + se^2)`, the share of the activity's own slope that survived. Zero means it took the shared slope entirely |
| `hr_slope_shrunk_bpm_per_mps`, `cadence_slope_shrunk_spm_per_mps` | `weight * own + (1 - weight) * shared` |
| `hr_at_{slow,median,fast}_bpm`, `cadence_at_{slow,median,fast}_spm` | The activity's level, refitted at its shrunk slope, evaluated at the three reference paces in `athlete_fit`. `(fast - slow) / (ref_fast_mps - ref_slow_mps)` recovers the shrunk slope |
| `decoupling_pct` | Percentage loss of speed per heartbeat from the first half of the usable seconds to the second. Positive means the second half cost more heart rate at the same speed |
| `decoupling_{first,second}_speed_mps`, `decoupling_{first,second}_hr_bpm` | The mean speed and mean heart rate of each half of the seconds `decoupling_pct` compares, which reproduce it exactly. Null together with it. Halves of the seconds carrying both channels, not of elapsed time: the halfway second falls between 45% and 52% of elapsed time on 90% of the 167 runs with a value, and at 33% and 62% at the extremes, measured on 2026-10-03 |
| `hr_at_{slow,median,fast}_smoothed_bpm`, `cadence_at_{slow,median,fast}_smoothed_spm` | Trailing 42-day means of the six columns above, which is the form a trend is readable in. Raw, the gap between the fast and slow heart rate series is a fifth of the step from one run to the next; smoothed, it is nearly three times it |
| `is_aerobic_long_run` | Whether the run is in the population decoupling is interpretable over: `effort_tag` is `easy` or `steady` and `fit_seconds` is at least 2400. 46 of the 218 rows on 2026-10-03. An unclassified run is outside it rather than assumed aerobic |
| `decoupling_smoothed_pct` | Trailing 90-day mean of `decoupling_pct` over that population, and null on every row outside it, which is 172 of the 218 on 2026-10-03. A wider window than the reference paces use because the population is a quarter the size |
| `fit_seconds` | Usable seconds that entered the fit, so a consumer can tell a fit over 40 minutes from one over 6 |

Every heart rate column, the weight and the shrunk slope included, is null on a run whose heart rate channel has fewer than 600 finite usable seconds, while its cadence columns are filled: 51 of the 208 on 2026-09-12, and none of the 227 on 2026-10-16.
That is a different case from a run whose speed did not vary: that run has no slope of its own, so it takes the shared slope at weight 0, and its level is the channel mean minus the shared slope times mean speed, which leaves its `*_at_*` columns defined.
`decoupling_pct` needs 600 seconds carrying both speed and heart rate.

**A consumer must not substitute an ordinary least-squares error for `*_slope_se_*`.**
The two differ by a factor of about nine on this data, and feeding the smaller one into the weight formula sends every weight to 1 and undoes the shrinkage.
`docs/reference/math/efficiency.md` derives the estimator, the reference paces and the bootstrap, and holds every measured figure; this section only describes the table's shape.

## The athlete fit, `athlete_fit.parquet`

One row, rewritten on every recompute.
These are whole-history quantities: properties of the athlete rather than of any activity, computed in a pass over every eligible activity before any activity's own slope can be shrunk.

| Column | Meaning |
| --- | --- |
| `ref_slow_mps`, `ref_median_mps`, `ref_fast_mps` | The 25th, 50th and 75th percentile of per-activity median usable speed over the activities that entered the fit. The paces every `*_at_*` column is evaluated at |
| `hr_slope_shared_bpm_per_mps`, `cadence_slope_shared_spm_per_mps` | The slope fitted between activities, one point each at its median speed and median channel value, with a time term so a fitness trend is not absorbed into it |
| `hr_slope_tau`, `cadence_slope_tau` | The standard deviation of true between-activity slopes, `sqrt(var(own) - mean(se^2))`, floored at zero. The numerator of every shrinkage weight |
| `activities_in_fit` | How many activities the row above was fitted over, 227 on the real history on 2026-10-16 |

Every one of these drifts as history grows, because a new activity moves the quartiles and the fit.
A consumer that displays a value at a reference pace should read the pace from this table rather than quote a constant, and the two tables carry the same `analysis_version` so a mismatch is detectable.
Whether the reference should be frozen once it stabilises is an open question.

## Fitness series, `fitness_series.parquet`

One row per running activity that produced at least one VO2max estimate, written by the fitness pass after the per-activity loop, since the smoothing needs the whole history in time order.
`hr_vo2max` is the heart-rate estimate, null when the run did not qualify: fewer than 20 steady 30 s segments at or above 70% of the maximum heart rate in force, or no maximum in the profile for that activity.
It is also null for a treadmill or not-known-outdoors activity, because the speed the oxygen cost is computed from comes from an uncalibrated footpod, the same reason `is_indoor` excludes an activity from the efficiency fits and its efforts from VDOT; such an activity therefore has no row at all.
`qualifying_segments` is the number of segments that passed, 0 without a maximum and 0 for an excluded activity.
`vdot` is the best Daniels VDOT among the activity's eligible best efforts under the records rule above, and `vdot_distance_key` names the effort it came from.
`hr_vo2max_smoothed` and `vdot_smoothed` are trailing 42-day means over the contributing activities; they are the reported numbers, and the raw columns are kept so a chart can show what was smoothed.
`docs/reference/math/vo2max.md` derives both estimators and the smoothing.

## Routes, `routes.parquet` and `route_runs.parquet`

Which runs followed the same path, and how each one compares to the others on it.
Written by `analysis.routes`, run after the tags pass, over every running activity with `has_gps` and not `is_indoor`.
`docs/reference/math/routes.md` derives the grouping rule, the thresholds and every measurement behind them; this section only describes the tables' shape.

Two runs group into a route when their traces, each resampled to 200 points by distance, stay within 20 m of each other on average and within 150 m at every point once the first and last 5% are trimmed, and a group needs 3 or more runs to become a route.
A route's `route_id` is the `activity_id` of its earliest run, so it holds when a later run joins.

`routes.parquet`, one row per route:

| Column | Meaning |
| --- | --- |
| `route_id` | The earliest run's `activity_id` |
| `name` | Most common locality among the route's runs plus the median distance to 0.1 km, for example `Jönköping 7.5 km`. `Route` in place of the locality when none of the runs has one, for example `Route 7.5 km`. ` A` / ` B` appended when two routes would otherwise share a name |
| `locality` | The locality the name was built from, null when none of the runs has one |
| `run_count` | Runs in the route |
| `reference_activity_id` | The medoid: the run with the smallest summed distance to every other run in the route, drawn on the map |
| `median_distance_m` | Median recorded `distance_m` over the route's runs |
| `first_run_utc`, `last_run_utc` | Earliest and latest `start_time_utc` among the route's runs |
| `analysis_version` | |

`route_runs.parquet`, one row per run that belongs to a route:

| Column | Meaning |
| --- | --- |
| `route_id`, `activity_id` | |
| `start_time_utc` | |
| `distance_m`, `elapsed_time_s` | From `activity_metrics`, the same figures a best effort is measured from |
| `speed_mps` | `distance_m` over `elapsed_time_s`, so it spans any pause the way a best effort does. Pace is never stored |
| `direction` | `forward` or `reverse` against the route's earliest run, the `route_id` run: `reverse` only when the earliest run read backwards is under half as far, point by point, as read forwards, and `forward` on every run of an out-and-back |
| `eligible`, `ineligible_reason` | See "Route eligibility" below |
| `rank` | 1 for the fastest eligible run in the route, null when the run is ineligible |
| `is_record` | The fastest eligible run so far when it was run; the first eligible run in the route always is one |
| `mean_distance_m`, `worst_distance_m` | The two pair measures of this run's link to the reference run, zero on the reference run itself |
| `analysis_version` | |

**Route eligibility follows the records rule**: an ineligible run stays in its route and on its chart, but neither sets the record nor becomes the baseline a later run has to beat.
A run is eligible only when it is explicitly not GPX-sourced, its whole 1 Hz grid is trusted, and every one of its rows in `best_efforts` has `distance_trusted` explicitly true.
The grid is judged by `best_efforts.grid_jump_reason`, the best-effort rule applied to the whole run: trusted when no second advances faster than `IMPLAUSIBLE_SPEED_MPS`, or when the run's covered distance is within 1% of what its measured speed accounts for.
It exists because a jump outside every best-effort window still inflates the run's pace; on the real store the grid scan makes 3 more runs ineligible, and as of 2026-09-27 the speed check readmits none of the 13 route runs ineligible for a jump.
A run with no best-effort rows at all is eligible, since that rule holds with nothing to check it against.
`ineligible_reason` is `"GPX-sourced"` or one of the three jump reasons `best_efforts` defines: `"a jump in the recorded distance that the measured speed does not confirm"`, `"a jump in the recorded distance, with no measured speed to check it against"` or `"not known to be free of distance jumps"`, the grid's own reason ahead of the efforts'.
The jump strings are the ones `api/queries.py`'s `progression` serves for the same causes; `"GPX-sourced"` has no counterpart there, because that endpoint's own rule is about `is_indoor` instead, a check routes do not need since every run they consider is already outdoors.

`store/db.py` gets a view over each, `routes` and `route_runs`.

## Territory, `territory_claims.parquet`, `territory_regions.parquet` and `territory_parts.parquet`

The ground every outdoor loop run has enclosed, and how it accumulated.
Written by `analysis.territory`, run after the routes pass, over the same runs routes consider: every running activity with `has_gps` and explicitly not `is_indoor`.
GPX-sourced runs take part, because the ground a track encloses does not divide by its speed, which is where GPX's noise does its harm.
`docs/reference/math/territory.md` derives the closure rule, the enclosed ground, the sliver rule, the projection and the regions, with every measurement behind them; this section only describes the tables' shape.

A run closes a loop when its last position is within 200 m of its first.
Its ground is the union of the bounded faces of its track closed by a straight segment back to the start, less every strip narrower than 30 m, which an opening of radius 15 m removes.
Runs are taken in `start_time_utc` order, ties by `activity_id`, and each claiming run's ground is added to the union of its region.
After each union, every hole no 15 m disc fits in is filled, the sliver rule turned on unclaimed ground: such holes are the seams where two claims' tracks drew a shared edge centimetres apart, and the run that closed one off claims it.

**Every area is an ellipsoidal area in square metres**, read on the module's own ellipsoidal Lambert azimuthal equal-area projection, and agrees with the WGS84 geodesic polygon area to better than $10^{-7}$ on the real store.
Square kilometres are presentation.

`territory_claims.parquet`, one row per considered run, in start-time order:

| Column | Meaning |
| --- | --- |
| `activity_id`, `start_time_utc` | |
| `closure_m` | Metres from the last finite position to the first, on the ellipsoid. Null for a grid with fewer than 10 finite positions |
| `closes_loop` | `closure_m` is at most 200 m |
| `region_id` | The region the run claimed ground in. Null for a run that claimed none, whether it closed no loop or enclosed only slivers |
| `enclosed_m2` | The ground the closed track encloses, slivers removed. Null when the run closed no loop; 0 for a loop that enclosed only slivers |
| `sliver_m2` | The area the sliver rule took off the raw faces. Null when the run closed no loop |
| `new_m2` | What the run added to the union: the part of `enclosed_m2` no earlier run had claimed, plus any thin hole its ground closed off. 0 for a loop inside ground already claimed |
| `cumulative_m2` | All ground claimed by this run and every earlier one, over every region. Null when the run closed no loop |
| `analysis_version` | |

The last non-null `cumulative_m2` is the total, the sum of `territory_regions.area_m2`.
It is not the sum of `enclosed_m2`, which counts ground every time a run went round it: nearly four times the union on the real store.

`territory_regions.parquet`, one row per region:

| Column | Meaning |
| --- | --- |
| `region_id` | The earliest claiming run's `activity_id`, so it holds as later runs join |
| `name` | The `locality` most of its runs started in, else the bundled place nearest the centre of its box, else `Region`; ` A` / ` B` appended by area when two regions would share a name |
| `locality`, `country` | What the name was built from, null when nothing was found |
| `area_m2` | The region's union |
| `part_count`, `claim_count` | Connected parts in the union, and runs that claimed ground in it |
| `first_claim_utc`, `last_claim_utc` | Earliest and latest claiming run |
| `min_lat`, `min_lon`, `max_lat`, `max_lon` | The box of its parts' display outlines, in degrees |
| `analysis_version` | |

Two claiming runs are in one region when their tracks' boxes come within 50 km of each other, directly or through other runs.

`territory_parts.parquet`, one row per connected part of each region's union:

| Column | Meaning |
| --- | --- |
| `region_id` | |
| `part_index` | 0 for the region's largest part, then by area |
| `area_m2` | The part's true area, before the outline was simplified |
| `vertex_count` | Vertices in the display outline, every ring counted |
| `min_lat`, `min_lon`, `max_lat`, `max_lon` | The box of the outline |
| `geometry_geojson` | The display outline in `[lon, lat]` degrees, simplified at 1 m and snapped to the 6 decimal grid so that it is valid there: a GeoJSON `Polygon`, or a `MultiPolygon` when a neck of the part is thinner than a grid step. Exteriors anticlockwise, holes clockwise, and a hole is only ever one a 15 m disc fits in |
| `analysis_version` | |

**The outline is for drawing and `area_m2` for counting.**
Simplified at 1 m the outline's area is 0.014% under the true area over the whole union, and up to 2.9% under it, on one small part.
On the real store every outline is a `Polygon` and none has a hole.
The GeoJSON is stored as text so that the API parses and serves it without a geometry library.

`store/db.py` gets a view over each, `territory_claims`, `territory_regions` and `territory_parts`.

## Where an activity happened

`activity_metrics` carries four columns naming the activity's start location: `locality`, `country_code`, `country` and `locality_distance_m`.
All four are null together for an activity with no position at all: 86 of the 307 real runs, the 82 treadmill runs and four more that recorded no GPS fix.

Resolved at recompute from the activity's **first fixed position** on the 1 Hz grid, against a bundled GeoNames extract, with no network access.
That is not a convenience: most of these positions are near the athlete's home, and a reverse-geocoding API would send them to a third party for exactly the reason the route panel carries no basemap tiles.
There is no new runtime dependency either - the search is this project's own haversine, vectorised.

The first position rather than a mean: an average over a route is a point the athlete may never have been, and on an out-and-back it lands in the middle of the trace, halfway along the outbound leg.

**Nearest is not the rule, and the reason is measurable.**
GeoNames' populated places include city districts, so nearest-place alone labels this athlete's three clusters in one city by the names of a district, the same district again and a suburb, never by the city.
The rule is instead: the nearest place, unless something within 15 km is at least ten times more populous, which is the signature of a city against its own district rather than of the next town over.
When the nearest place's population is unknown - GeoNames records 0 for 11 893 of the bundled places - there is nothing to take a ratio against, and the alternative wins only if it is a city outright, 15 000 people or more.
`docs/reference/math/places.md` derives it, including the two real starts an unconditional population preference gets wrong.

**`locality_distance_m` is stored because a match is not always close.**
The worst on the real history is a start abroad whose nearest place in the table is 27.9 km away.
Keeping the distance lets a consumer name the place, name only the country, or say nothing - the same shape as the best-effort flags above, and for the same reason: flag it, and let the reader of the number choose.
On the real history 205 of the 221 placed runs match within 10 km, and 16 do not.
Note that the distance is measured to the named place's own point, not to its boundary, so a big city's outskirts can read as `near`: four of those sixteen are runs in one city 12.8 to 14.9 km from its own centroid, which is a fair description of a run that did not start in the middle of it.

The bundled table is `src/activity_analysis/data/places.parquet`, 170 911 places from GeoNames `cities1000` plus `countryInfo`, licensed **CC BY 4.0**.
`scripts/build_places.py` builds it and is committed so the binary in the tree has a stated provenance and a documented rebuild path.

## DuckDB

`store/db.py` exposes a view over both layers for each table a consumer queries: `activities`, `canonical_activities`, `sport_reclassifications`, `laps`, `streams`, `streams_1hz`, `best_efforts`, `zone_time`, `activity_metrics`, `athlete_profile`, `activity_tags`, `activity_efficiency`, `athlete_fit`, `fitness_series`, `routes`, `route_runs`, `territory_claims`, `territory_regions`, `territory_parts`.
`activities` is `canonical_activities` with `sport` replaced by the sport the activity is counted as and the recorded one added as `recorded_sport`, so every query that filters on `sport` leaves a reclassified walk out without knowing the rule.
`canonical_activities` is the stored table unadjusted.
`profile_observations` deliberately has none: it is the raw input `athlete_profile` is collapsed from, so it is read by the rebuild rather than queried.
Views exist even when nothing has been computed, so callers query unconditionally rather than branching on whether files exist.
None is that case today: the efficiency pass fills `activity_efficiency` and `athlete_fit`, and the fitness pass fills `fitness_series`.
Each is still written with its schema and no rows when its pass produced nothing, so the guarantee holds on an empty store and after a failed pass.

Each view is projected through the current schema rather than being a bare `SELECT *`, so a file written before a column existed does not break every query that names it.
A single-file table and the derived `streams_1hz` glob read such a column as null, which is the truth there.
The canonical `streams` glob cannot tell an absent column from one quietly discarded from every file but the first, so it reads as an error carrying the remedy instead, raised by the query that names the column rather than by opening the connection: a stale stream directory leaves row counts, the activity listing and every other view working.
Recovering from it needs `activity-analysis ingest <export> --force`, since a plain re-ingest skips the files already in the ledger and rewrites nothing.
The module docstring of `store/db.py` has the measured reason the two globs are read differently.

```sql
SELECT z.zone_index, sum(z.seconds_s) / 3600 AS hours
FROM zone_time z JOIN activities a USING (activity_id)
WHERE a.start_time_utc >= now() - INTERVAL 30 DAY
GROUP BY 1 ORDER BY 1;
```

## Testing

Correctness is verified against synthetic fixtures with known analytic answers, never against real noisy data, which has no independent ground truth.
Real fixtures are used for two things only: parsing, and the one place real ground truth exists, the device's `time_in_zone` totals.
