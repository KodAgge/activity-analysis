# Threshold heart rate, estimated zones and load

The heart rate at the athlete's lactate threshold, estimated from the history's own hard efforts, five zones as percentages of it, and a training load, Banister's TRIMP on the measured resting and maximum heart rate, smoothed into fitness, fatigue and form.

Implemented in `src/activity_analysis/analysis/threshold.py`, `src/activity_analysis/analysis/trimp.py` and `src/activity_analysis/analysis/load.py`, and wired into `recompute` in `src/activity_analysis/analysis/pipeline.py`.
Tested in `tests/test_threshold.py`, `tests/test_trimp.py` and `tests/test_load.py` against synthetic grids and synthetic readings with known answers, and the wiring in `tests/test_pipeline_threshold.py` against a synthetic store.
The tables are described in `docs/reference/derived-layer.md` under "Threshold heart rate and load".

## Why a second set of zones

The device's zones are percentages of a configured maximum heart rate.
They are a setting rather than a measurement, and nothing checks them against the athlete: on the real store a run the athlete calls easy lands in the device's zone 3, and the last 26 weeks put most of the running time in zones 3 and 4.
A plan that steers easy runs by heart rate needs zones that say where easy ends for this athlete.

Lactate threshold heart rate, LTHR, anchors them in something the history can measure.
It is the heart rate at the intensity above which blood lactate accumulates faster than it is cleared, which for a trained runner is roughly the pace that can be held for about an hour.

## Friel's 20-minute rule

Friel's field test for runners is a 30-minute solo time trial run as hard as can be sustained, with the average heart rate over its final 20 minutes taken as LTHR (Friel, "Quick Guide to Setting Zones", TrainingPeaks, 2009).
The first 10 minutes are discarded because heart rate takes several minutes to rise to a steady effort, so an average over the whole 30 would read low by however long the climb took.

The history holds no deliberate time trials, but it holds best efforts: for every run, the fastest time over each standard distance (`docs/reference/math/best-efforts.md`).
A best effort of 30 to 60 minutes is the same shape as Friel's test whenever the athlete was running all out, so its final 1200 s are read the way the test reads its final 20 minutes.

A **reading** is

$$\text{reading} = \frac{1}{|W|} \sum_{t \in W} \text{hr}_t, \qquad W = \{\, t : t_\text{end} - 1200 < t \le t_\text{end},\ t \text{ not paused},\ \text{hr}_t \text{ known} \,\}$$

over the 1 Hz grid, with $t_\text{end}$ the effort's last second, before "The lock-on guard" below narrows $W$.

## Which efforts give a reading

An effort is eligible when all of the following hold.
Each part exists because of a specific way the reading would otherwise be wrong.

- **On a run tagged all out.**
  The run's effort tag, `tags.classify_effort` in `docs/reference/math/tags.md`, must be `all_out`: at least 10% of its heart-rate seconds at or above 90% of the maximum in the profile, or its median at 85% or more.
  Friel's test is a maximal effort, and an ordinary run of 8 to 10 km has 30 to 60 minute best efforts too, so length alone admits easy and steady running.
  "Why intensity comes from the tag" below measures what that costs.
- **An effort that was itself hard.**
  At least 10% of the effort's own heart-rate seconds at or above 90% of the maximum in force for the run, the rule the tag's first branch applies to the whole run.
  A run can be tagged all out by its median alone, and then its fastest 30 to 60 minutes can be a stretch of a long run that never reached 90% of the maximum.
  An effort that is not hard falls through to the run's next-highest-VDOT effort, like one without a reading.
- **1800 to 3600 s of elapsed time.**
  Shorter than 30 minutes, the final 20 are most of the effort and include the climb Friel's test discards, and a 15-minute effort is run above threshold.
  Longer than an hour, the pace sits below threshold and heart rate drifts upward with time rather than intensity.
- **No pause, outage or jump.**
  A pause lets heart rate fall and the effort's time counts the stop, an outage leaves the window without a measurement, and a jump in the recorded distance makes the effort faster than it was run, which would rank it wrongly below.
- **Outdoors.**
  A treadmill's speed comes from an uncalibrated footpod, so its VDOT does not rank its efforts against each other the way an outdoor run's does.
  The run must be known to be outdoors: a null `is_indoor` is excluded with the treadmill runs, the same rule records and VDOT follow (`docs/reference/derived-layer.md`, "Best efforts").
- **A heart rate the sensor had locked onto, on at least 90% of the window.**
  "The lock-on guard" below sets out the rule: a late lock-on at the window's start is cut, a tail shorter than 900 s gives no reading, and in what is left the share of unpaused seconds carrying a heart rate within 20 bpm of the window's median must be 0.9 or more, so that a reading is not the mean of a few minutes.
- **One reading per run, its effort with the highest VDOT.**
  `best_efforts` holds one row per run per distance, so an ordinary 10 km run has 6 km, 8 km, 5 mile and 10 km rows over the same seconds.
  Taking them all would count one run several times, and the highest VDOT is the hardest of them (`docs/reference/math/vo2max.md` derives VDOT).
  When that effort's final 1200 s give no reading, the run's reading falls through to its next-highest-VDOT effort that gives one, since an effort without a reading is not eligible.
  The fallen-through reading comes from a slightly slower effort of the same run.

The tag and the effort rule read the device's maximum heart rate, a setting rather than a measurement, but only to decide which runs and efforts were hard; the reading itself is the measured heart rate.
A run from before the device recorded a maximum has no effort tag and so gives no reading.
On the real store that is the first 91 of its 351 runs, so the estimate starts only once three all-out readings exist after the device began recording one.

## Why intensity comes from the tag

Measured on the real store before this rule, over every run's reading under the eligibility above without the tag: the readings from the 41 runs tagged all out have a median 12.6 bpm above the 54 tagged steady, 13.7 bpm above the 12 tagged intervals and 25.8 bpm above the 11 tagged easy.
A steady run's final 20 minutes are not a threshold effort, and an interval session's include its recoveries.

The rule before this one kept every eligible effort and dropped, at the estimate, those with a VDOT more than 10% below the fastest in the window.
That was meant to leave the easy runs out by pace, and it did not: of the 11 readings the estimate at the newest run rested on, 4 came from runs tagged all out, and the others were steady and interval runs fast enough to pass, whose final 20 minutes read 10 bpm or more below an all-out effort's.
Pace did not separate the efforts: those steady and interval efforts were within 10% of the fastest VDOT in the window.
Heart rate separates them, so the tag decides, and the margin is gone.

The tag alone is not enough, because of how a run is tagged all out.
Its first branch needs 10% of the run's heart-rate seconds at or above 90% of the maximum; its second needs only a median at 85% or more, which a long run at a steady, high heart rate meets.
With the tag and the guard alone, 8 of the 18 readings in the year's window came from runs the second branch tagged, five of them runs of 94 to 132 minutes whose 30 to 60 minute best effort was a stretch of the long run.
None of the eight efforts put 10% of its seconds at 90% of the maximum, and the lowest reading in the window was one of them, a 5 km stretch of a run of nearly two hours.
The 10 readings from runs the first branch tagged had a median 2.0 bpm above the estimate the 18 gave.
Requiring the effort itself to meet the first branch's rule drops six of those eight runs; the other two give their reading from a slower effort of the same run that was hard.
Taking only runs the first branch tagged, with no rule on the effort, gives an estimate at the newest run 0.3 bpm higher on 10 readings rather than 12, with the same coverage to within one run; the effort rule is kept because it reads what the reading is taken from rather than the run around it.

With the tag and the effort rule in place the margin was measured again on top of them, in the table under "Choosing the window and the minimum", and it is not needed.
The fastest reading in the window is a breakthrough race whose next-fastest reading has a VDOT 9% below it, so a margin of 5% leaves no estimate at the newest run and one of 10% rests it on three or four readings.

## The lock-on guard

A wrist sensor can report a wrong, low heart rate for minutes and then lock on to the true one.
One all-out race on the real store did: for the first two thirds of it, at an even race pace, its heart rate read 30 to 85 bpm below what it read once locked on, and the final 1200 s began with 194 s of the low reading.
Their mean read 6.6 bpm below the mean of the 1006 s after the lock-on.
A second failure looks the same to the coverage rule: a walk or a stop inside the window lowers the heart rate genuinely, but the effort was not sustained, which is what Friel's test reads.

Within an effort's final 1200 s, the **floor** is $\text{median}(\text{hr}) - 20$ bpm.

1. The leading seconds whose heart rate is known and under the floor are cut: the sensor had not locked on.
   A second with no heart rate is not cut, so a window that starts without one still counts it against coverage.
2. What remains, the **tail**, must be at least 900 s long.
3. In the tail, a second under the floor is counted as a second without heart rate: it leaves the mean, and the share of the tail's seconds at or above the floor must be at least 0.9.

$$\text{reading} = \frac{1}{|K|} \sum_{t \in K} \text{hr}_t, \qquad K = \{\, t \in \text{tail} : \text{hr}_t \ge \text{floor} \,\}, \qquad |K| \ge 0.9\,|\text{tail}|$$

So a late lock-on is cut, and the reading is the tail's mean; a walk or a stop inside the window costs coverage, and more than a tenth of the tail rejects the effort, which then falls through to the run's next effort.

These were measured over the 41 all-out runs with an eligible effort before the effort rule above, which leaves fewer of them; the guard's constants do not depend on it.

**The 20 bpm.**
Over the 41 all-out runs' final windows, the lowest 30 s mean in a window without a stop or a misreading lies at most 19 bpm below that window's median, and the stops, walks and the misreading lie 23 to 57 bpm below it.
20 bpm is the round number at the bottom of that gap.
Which windows count as a stop or a misreading is a judgement, made by reading each with its pace: the gap's lower edge, 23 bpm, is a window whose heart rate fell for about 90 s while the pace held or quickened, which is read as a misreading rather than a genuine fall.
Per second, it removes 3 s from one window that was only rising, and moves its reading by under 0.1 bpm.

**The 900 s.**
Cutting a lock-on shortens the window, and a shorter tail of an effort reads higher, because heart rate drifts up through a hard effort.
Over the 33 all-out windows the guard does not touch, the mean of the last 900 s reads a median 0.5 bpm above the mean of all 1200, at most 1.8; the last 600 s read a median 1.4 above, at most 3.6.
900 s keeps that bias under 2 bpm, and is three quarters of Friel's window.

What the guard does on the real store:

| What the final window holds | All-out runs | Effect |
| --- | ---: | --- |
| Nothing under the floor | 33 | reading unchanged |
| A few seconds under it inside the window | 3 | 3 to 89 s left out, reading up by 0.0 to 1.6 bpm |
| A late lock-on | 1 | 194 s cut, reading up by 6.6 bpm, from a 1006 s tail |
| A walk or a stop inside the window | 4 | 14% to 20% of the window under it, no reading |

None of the four rejected runs has a second eligible effort whose window avoids the stop, so they give no reading at all.

The rule cuts by level rather than by looking for the jump at a lock-on.
The lock-on raises the 60 s mean heart rate by 36 bpm within a minute, but the restarts after the four walks raise it by 23 to 29, so a threshold on the jump would sit a few bpm from mistaking one for the other: a jump alone cannot tell a sensor that locked on from a runner who started running again.
Cutting only the leading stretch and counting everything later against coverage needs no such distinction: a walk at the window's start leaves a tail of sustained running, which is a fair reading, and a walk later is rejected.

The floor is relative to the window's own median, so a misreading that covers more than half the window sets the median and is not seen.
The median of the readings is what protects against that, as it protects against a wrong reading the floor cannot see.
With the tag, the effort rule and the guard, the readings sit close to the estimate they inform: of the 24 with an estimate in force at their own start, none lies more than 10 bpm from it, the lowest 6.6 bpm below and the highest 5.0 above.
Under the margin rule, 10 of 61 lay more than 10 bpm below, the lowest 44 bpm below.

## The estimate on a date

The estimate in force at instant $t$ is the **median** of the heart rates of the readings from the trailing $D$ days, $t - D < t_i \le t$, provided there are at least $n$ of them.
With fewer, there is no estimate.

- The median rather than the mean, because a wrong reading the guard cannot see, a misread window or an effort on a hot day, moves a mean by its whole error divided by the count and a median not at all while it is in the minority.
- Every reading in the window counts: intensity was decided before it became a reading, by its run's tag.
- The window, so the estimate moves with fitness: a run is zoned on the threshold in force on its own date, the way `athlete_profile` versions the device settings.
  A run's own reading is inside its window, so an all-out run counts toward the estimate it is zoned on.

The five committed fixtures show the tag doing its job.
Four of them have best efforts of 30 to 60 minutes, and none was run all out: two are tagged steady, one easy and one intervals, so they give no reading and no estimate.
Under the margin rule three of them gave readings.
From the checkout, this prints the four runs' tags and the empty readings:

```python
import shutil
import tempfile
from pathlib import Path

from activity_analysis.analysis.pipeline import recompute
from activity_analysis.config import Paths
from activity_analysis.ingest.pipeline import ingest
from activity_analysis.store.writer import (
    read_activity_tags,
    read_best_efforts,
    read_threshold_readings,
)

root = Path(tempfile.mkdtemp())
(root / "dump").mkdir()
for fit in Path("data/examples").glob("*.fit"):
    shutil.copy(fit, root / "dump" / fit.name)
paths = Paths(root=root)
ingest(paths, root / "dump")
recompute(paths)
efforts = read_best_efforts(paths)
long_enough = set(efforts.loc[efforts["elapsed_time_s"].between(1800, 3600), "activity_id"])
tags = read_activity_tags(paths)
tags = tags[(tags["kind"] == "effort") & tags["activity_id"].isin(long_enough)]
print(sorted(tags["tag"]), len(read_threshold_readings(paths)))
```

## Choosing the window and the minimum

Measured on the real store on 2026-11-15, after a `recompute` at `ANALYSIS_VERSION` 15 under the final rules, the tag, the effort rule and the guard, over its 26 readings, every one of them from the last two years.
For each setting, the share of the last two years' 261 runs with an estimate, the estimate in force at the newest run with the count of readings it rests on, the median of the estimates across the covered runs, and the width from the 10th to the 90th percentile of those estimates.
Estimates are in bpm relative to the chosen setting's estimate at the newest run, since the absolute value is a body metric.
The last rows put the old VDOT margin back on top of the tag, to test whether it is still needed.

| Window, days | Margin | Minimum | Runs with an estimate | At the newest run | Median over the runs | 10th to 90th percentile |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 180 | none | 3 | 228 of 261 (87%) | +0.0 on 8 | +0.0 | 1.9 |
| 180 | none | 5 | 174 of 261 (67%) | +0.0 on 8 | +0.0 | 2.1 |
| **365** | **none** | **3** | **228 of 261 (87%)** | **+0.0 on 12** | **+0.2** | **1.1** |
| 365 | none | 5 | 205 of 261 (79%) | +0.0 on 12 | +0.2 | 1.0 |
| 540 | none | 3 | 228 of 261 (87%) | +0.2 on 22 | +0.2 | 0.4 |
| 540 | none | 5 | 205 of 261 (79%) | +0.2 on 22 | +0.2 | 0.2 |
| whole history | none | 3 | 228 of 261 (87%) | +0.1 on 26 | +0.2 | 0.4 |
| 365 | 5% | 3 | 180 of 261 (69%) | none | +2.1 | 3.4 |
| 365 | 10% | 3 | 223 of 261 (85%) | +0.2 on 3 | +0.5 | 2.3 |
| 365 | 10% | 5 | 92 of 261 (35%) | none | -0.2 | 2.9 |
| 540 | 10% | 3 | 223 of 261 (85%) | +1.4 on 4 | +0.6 | 1.8 |

The 33 runs of the last two years without an estimate under any setting are the earliest, from before three readings existed.
Without a margin, the estimates at the newest run lie within 0.2 bpm of each other, and a minimum of 3 covers the same runs under every window.
The rule was the one used before: among the settings whose estimate at the newest run lies within 2 bpm of their median, the one with an estimate on the most runs.
All the settings without a margin pass, and those with a minimum of 3 tie on coverage, so the window is chosen by argument.

- **365 days**, because it holds each season once.
  Heat raises the heart rate an effort reads, and a 180-day window holds a summer or a winter, so the estimate would swing with the seasons rather than with fitness; a 540-day window holds one season twice.
  It rests today's estimate on 12 readings; its spread across the runs, 1.1 bpm, is wider than the longer windows' 0.4, which is the cost of following the seasons and fitness.
- **A minimum of 3**, which gives the same estimate as 5 wherever both have one and gives one on 23 more of the last two years' runs.

The window still earns its place though the whole history gives an estimate within 0.1 bpm of it today: the tagged history is under two years long, and as it grows a window is what keeps an all-out effort from years ago out of today's zones.

The margin on top of the tag is not needed, and it is harmful.
At 5% no estimate exists at the newest run, because the fastest reading in the window is a breakthrough race and the next-fastest has a VDOT 9% below it, so every margin under 9% keeps the race alone.
At 10% the estimate at the newest run rests on three or four readings, it covers fewer runs, its spread across them doubles, and a minimum of 5 leaves it on a third of them.

Over the whole history, 228 of the 351 runs carry an estimate.
The 123 without are the earliest: 91 from before the device recorded a maximum heart rate, which the tag needs, and 32 from before three readings existed after it did.

## Five zones

Friel's running zones as percentages of LTHR are zone 1 below 85%, zone 2 from 85% to 89%, zone 3 from 90% to 94%, zone 4 from 95% to 99%, and zones 5a, 5b and 5c from 100% to 102%, 103% to 106% and above 106% (Friel, 2009).
The three zone-5 bands are merged into one, at and above 100%, so that the zone numbers run 1 to 5.
The boundaries are

$$b = (0.85, 0.90, 0.95, 1.00) \times \text{LTHR}$$

applied by the same `zones.zone_time` the device zones use, so a sample exactly on a boundary belongs to the zone it opens and paused and heart-rate-less seconds count nowhere (`docs/reference/math/zones.md`).
`zone_index` 0 is zone 1.

The device's zones stay what `zone_time.parquet` holds and the activity page draws, because `tests/test_zones.py` asserts that table against the device's own `time_in_zone` totals, the one place in the project where a derived metric has ground truth on real data.
The estimated zones go to a table of their own, `zone_time_estimated.parquet`, and to the plans.

Over the last 26 weeks of the real store the device's zones put 14% of the running time in zones 1 and 2 and 79% in zones 3 and 4.
The estimated zones put the same seconds 50% in zones 1 and 2, 44% in zones 3 and 4 and 6% in zone 5.

## Load

A run's load is Banister's training impulse, TRIMP, summed second by second over the 1 Hz grid.
Each unpaused second with a heart rate is placed in the heart-rate reserve,

$$x = \min\!\left(1, \max\!\left(0, \frac{\text{hr} - \text{rest}}{\text{max} - \text{rest}}\right)\right)$$

and weighed on an exponential of it,

$$\text{TRIMP} = \sum_\text{seconds} \frac{1}{60}\, x \cdot 0.64\, e^{1.92 x}$$

so a minute at a constant heart rate contributes $x \cdot 0.64\, e^{1.92 x}$.
Banister introduced the impulse as minutes times the reserve fraction (Banister, 1991); the exponential weighting, and its constants 0.64 and 1.92, come from the rise of blood lactate with the heart-rate reserve in men, fitted by Morton, Fitz-Clarke and Banister (1990, *J Appl Physiol* 69(3)).
Their constants for women, 0.86 and 1.67, are not used: the application has no setting for sex, and the male pair is a constant in `analysis/trimp.py`.

**Why the reserve rather than raw heart rate.**
The same 150 bpm is a stroll for an athlete resting at 40 and threshold work for one resting at 70 with a maximum of 175.
The reserve fraction $x$ puts both ends of the athlete's own range at 0 and 1, so a minute's weight says how hard that minute was for this heart, and TRIMP from two athletes, or from one athlete years apart, is on one scale.
The exponential then makes a minute near the maximum cost several minutes near rest, as lactate does: with example values of rest 45 and max 191, a minute at 130, 150 and 170 bpm weighs 1.14, 1.83 and 2.84.

**It replaced Edwards' zone-weighted load**, minutes in each estimated zone times the zone's number, which this pass computed before.
On the real store the two correlate at 0.99 per run and per week, so the trend did not change; what changed is the construction.
TRIMP has no step at a zone edge, needs no threshold estimate, so a run before the first estimate has a load, and does not re-weigh the whole history whenever the estimate or its rule moves.

Paused seconds and seconds without heart rate count nothing, as in `zone_time`.
A run with no heart rate at all has a null TRIMP rather than 0: a zero would say the run cost nothing, and a daily series built on it would read a week of runs without heart rate as a rest week.
The run still has its `run_load` row, with the estimate, rest and max in force on its date, since those belong to the date and not to the run's sensor.
A consumer that reads the threshold in force from the newest `run_load` row therefore gets it even when the newest run carried no heart rate.

`hr_histogram.parquet` keeps every run's seconds at each whole bpm, whether or not an estimate exists.
A plan writes an easy-run ceiling in bpm under the estimate in force when it was written, and the share of a run spent at or under that ceiling is a sum over the histogram, so it stays answerable after the estimate moves.

## Resting and maximum heart rate

Both ends of the reserve are measured, and both are in force on a date, as the threshold is, so a run from three years ago is weighed on the heart of three years ago.

**Rest** is the median of the daily resting heart rates in the 28 days up to and including the run's local date, from the canonical `resting_hr` table, which `ingest` reads from a Garmin export's daily summaries.
The watch measures it every day, so it is a measurement in a way the device's resting setting is not: that setting is whatever the athlete once typed in, and on the real store it is constant across every profile interval and higher than every 28-day median.
Weighed on the setting rather than the measured rest, every run's TRIMP on the real store is lower, by a median 10% and between 6% and 17% for 80% of the runs, because a higher rest pushes every second's $x$ down.
The median over 28 days, rather than the day's own value, keeps a single night of poor sleep or illness from moving a run's weight.
The window hardly matters beyond that: with 7 or 90 days in place of 28, the rest in force changes on more than half the runs with a TRIMP, by a median of 1 bpm, and on those runs TRIMP changes by a median 0.4%, by under 0.9% on 90% of them and by at most 3% and 8%.

**A run past the series' end carries the last measured rest forward**, for up to 90 days (`REST_CARRY_DAYS`).
Only a full Garmin export (Account, Data Management, Export Your Data) carries the daily summaries; the single-run "Export Original" zips a plan is kept fresh with do not, so the newest runs routinely lie past the series' end.
When the 28 days up to a run's date hold no measured day, its rest is the median of the 28 days up to the newest measured day before it, provided that day is at most 90 days before the run's date.
The same window then serves every run until the next full export, and resting heart rate moves slowly enough that a quarter-old median is still a better weight than a setting that sits above every measured median.
Each run row records the newest measured day its rest rests on, `rest_measured_through`, so a consumer can see how old it is; the training plan's context reports the newest measured day in the store, and the skill asks for a full export when it is over 28 days old.

**Max** is the median of the three highest per-run peaks in the trailing 540 days, the run's own included, where a run's peak, `peak_hr_10s_bpm`, is its highest mean heart rate over 10 consecutive unpaused seconds.
Ten seconds rather than one, because a wrist sensor can read a single implausible beat; the median of three rather than the highest, so that one spike cannot set the maximum: the median of three is the second highest, which a single run peaking far above every other in the window does not move.
540 days because maximum heart rate falls slowly, by about 0.7 beats a year with age (Tanaka, Monahan and Seals, 2001), and is reached only in rare all-out efforts, so a shorter window would let a year of easier running lower the maximum and inflate every TRIMP.
On the real store a 365-day window gives a different maximum on 52% of the runs, by a median of 0.25 bpm and at most 3 bpm, and changes those runs' TRIMP by a median 0.3% and at most 5%; the measurement did not decide the window, the argument above did, and it says the choice costs little either way.

**Each falls back to the device setting**, the `resting_hr_bpm` or `max_hr_bpm` in force in `athlete_profile`, when there is nothing measured: rest on a date with no resting heart rate on it or in the 90 days before it, which is every date of a store built from a Strava export alone, and max when fewer than three runs with a peak lie in the 540 days, which is a store's first two runs or a run after most of 540 days without one.
The run's `rest_from_setting` or `max_from_setting` is then true, so a consumer can tell a measured weight from a configured one; a fallback rather than a null, so that a Strava-only store still has a load.
On the real store no run falls back for its rest or carries one forward, since the newest run's own day is a measured day, and no run falls back for its max: the measured resting heart rate covers every run's date, and the two earliest runs, which have fewer than three peaks behind them, predate the device's first recorded maximum, so they have neither and their TRIMP is null.
A rest at or above the max leaves no reserve to divide by; only a bad setting can produce it, since a measured rest is a night's heart rate and a measured max a run's peak, and the run's TRIMP is then null rather than infinite, negative or clipped into a number that looks measured.
The row keeps the rest and max it was given, so it says why.

## TRIMP by zone

`zone_time_estimated.parquet` carries, beside each estimated zone's seconds, the TRIMP of those seconds, with the boundary convention `zone_time` uses: a second exactly on a boundary is in the zone it opens.
The five values sum to the run's TRIMP.
A zone's summed TRIMP over its summed minutes, across runs, is what a minute in that zone has cost this athlete, which is how a plan turns its planned minutes per zone into a planned TRIMP without guessing a heart rate for each zone.
Only a run with an estimate and heart rate has zone rows, so the per-zone TRIMP covers fewer runs than the run TRIMP does.

## The daily series

The day's TRIMP is the sum of its runs' TRIMP, on the local calendar day the run started, $\lfloor t_\text{utc} + \Delta_\text{utc} \rfloor_\text{date}$ as `queries.LOCAL_DATE_SQL` has it, with an unknown offset read as zero.
Two runs on one day add; a day without a run is a 0, and so is a day whose only run has no heart rate.

Fitness, `ctl`, and fatigue, `atl`, are exponentially weighted moving averages of it,

$$x_d = x_{d-1} + \alpha\,(T_d - x_{d-1}), \qquad \alpha = 1 - e^{-1/\tau}, \qquad x \text{ is } 0 \text{ before the first day}$$

with $\tau = 42$ days for `ctl` and $\tau = 7$ for `atl`, and form is their difference, $\text{form} = \text{ctl} - \text{atl}$.
This $\alpha$ is the discrete form of a continuous exponential decay with time constant $\tau$: one day multiplies the old value by $e^{-1/\tau}$, so a day's TRIMP has half its weight after $\tau \ln 2$ days, 29.1 and 4.85.
It is Banister's impulse-response model of fitness and fatigue (Banister et al., 1975) with the two gains equal, the form the chronic and acute training loads in common use take.
A rest day enters as a zero because that is the model, not an approximation that assumes daily training: the impulse is what the day did, and a day of rest did nothing, so both means decay.
A constant weekly TRIMP spread over any number of runs settles `ctl` near a seventh of it.
Williams et al. (2017) write the same average with $\alpha = 2/(N+1)$, 0.25 for $N = 7$ against 0.133 here, and $1/\tau$ is a third common choice, 1.2% above $1 - e^{-1/\tau}$ at $\tau = 42$ and 7% above it at $\tau = 7$; the conventions differ in what "7 days" means, and the time constant is the one with a physical reading.

An exponential mean rather than a rolling sum, because a rolling 7-day sum drops a hard session all at once on the eighth day, which reads as a sudden fall in load that never happened.

Beside them, `distance_m` is the day's summed canonical run distance and `distance_7d_m` its sum over the 7 days ending that day.
TRIMP measures the heart and not the legs: a fit heart can absorb a jump in distance that the tendons cannot, so the distance is followed on its own.
It counts every run, a treadmill's session total included, and a run without heart rate too, which adds distance but no TRIMP.

The series runs from the first run's day to the last run's day.
It does not run on to today, so a consumer that reports today's value decays the last one over the days since; zeros in between are not stored.

**The ratio of `atl` to `ctl` is not stored or served.**
The acute:chronic workload ratio has been criticised as mathematical coupling, since the acute load is part of the chronic load it is divided by, and as a poor predictor of injury (Lolli et al., 2019; Impellizzeri et al., 2020).
The two series are stored for a reader to compare; the ratio would invite a threshold the evidence does not support.

## Why weekly means

At a few runs a week, the daily `atl` and form are a sawtooth.
Each run lifts `atl` by 13% of its TRIMP and `atl` then falls 13% a day until the next run.
The athlete of the real store ran 3.1 times a week over the last 26 weeks.
Over the last 16 weeks, the band between `atl`'s 10th and 90th percentiles is 70% of its mean, and its range within a single week averages 46% of it.
Daily form runs from half the mean `ctl` below zero to a quarter above it between its 5th and 95th percentiles and changes sign 18 times in those 16 weeks, which reads as a signal when it is the model's sawtooth.
`ctl` has a time constant six times as long and shows no visible sawtooth.

`training_load_weekly.parquet` therefore holds, per Monday-started week, the means of the daily `ctl`, `atl` and form over the week's days, with the week's TRIMP and distance summed.
A weekly mean is taken over a whole number of run-and-rest cycles, so the sawtooth averages out and what is left moves with the training: over the same 16 weeks the weekly form mean changes sign 6 times.
`days` counts the days of the week the series holds, which is under 7 only in its first week and its last; the last, the current week until it ends, is a mean over fewer days and moves until then.
The daily values stay stored, for a consumer that wants the model as it is.

## An outside check: Strava's Relative Effort

Strava's Relative Effort is a heart-rate score of its own, computed from heart-rate zones by a proprietary rule, so it is an independent check on TRIMP rather than a ground truth.
The Strava export's `activities.csv` carries it, as `Relativ insats` in a Swedish export, and each row names the activity's file, which the ingest ledger maps to the canonical activity id the Garmin copy of the same run won.
On the real store 260 of the 349 runs with a TRIMP have a Relative Effort.
The two correlate at 0.97 (Pearson) and 0.96 (Spearman), and at 0.98 on the 141 of those from the last 365 days.
They are not proportional: a log-log fit gives Relative Effort rising as TRIMP to the power 1.28, so Strava scores a high-TRIMP run relatively higher than a low one.
The check says TRIMP orders runs the way an independent heart-rate score does, which is what the trend needs; it says nothing about which of the two scales is right.

## A worked example

Synthetic numbers, with a rest of 45 and a max of 191 bpm as example values.
An hour at a constant 135 bpm has

$$x = \frac{135 - 45}{191 - 45} = 0.6164, \qquad \text{TRIMP} = 60 \times 0.6164 \times 0.64\, e^{1.92 \times 0.6164} = 60 \times 1.2885 = 77.3$$

On a resting setting of 70 in place of 45, the same hour is 57.9, 25% less: a higher rest lowers every second's $x$, which is the direction the real store's fallback comparison above measured.

For the zones, take four runs in the window with efforts of 30 to 60 minutes: three tagged all out whose final 20 minutes averaged 178, 180 and 182 bpm, and an easy one at 150.
The easy run is not tagged all out, so it gives no reading, and the estimate is the median of the three, 180.
The boundaries are $0.85, 0.90, 0.95, 1.00 \times 180 = 153, 162, 171, 180$.

A 50-minute run the next day spends 20 minutes at 150 bpm, 20 at 158 and 10 at 175.
150 is below 153, zone 1; 158 lies in $[153, 162)$, zone 2; 175 lies in $[171, 180)$, zone 4.
At 45 and 191 a minute at 150, 158 and 175 weighs 1.831, 2.189 and 3.150, so the run's TRIMP by zone is

$$20 \times 1.831 + 20 \times 2.189 + 10 \times 3.150 = 36.62 + 43.78 + 31.49 = 111.90$$

with 36.62 in zone 1, 43.78 in zone 2, 31.49 in zone 4 and nothing in zones 3 and 5.

If that is the first day of the series, both means start from zero:

$$\text{atl} = 111.90 \times (1 - e^{-1/7}) = 14.90, \qquad \text{ctl} = 111.90 \times (1 - e^{-1/42}) = 2.633, \qquad \text{form} = -12.26$$

A rest day after it multiplies each by its decay: `atl` $14.90 \times e^{-1/7} = 12.91$, `ctl` $2.633 \times e^{-1/42} = 2.571$.
The fatigue falls by 13% a day and the fitness by 2.4%, which is the sense in which the first measures fatigue and the second fitness.

The hour at 135 is `test_trimp_of_a_constant_heart_rate_matches_the_closed_form` in `tests/test_trimp.py`, the three per-minute weights `test_per_minute_weights_match_the_worked_examples`, and the zone split `test_trimp_by_zone_sums_to_the_run_and_puts_a_boundary_second_in_the_zone_it_opens`.
The estimate is `test_estimate_is_the_median_of_the_readings_in_the_window` in `tests/test_threshold.py`, the easy run's missing reading `test_a_run_not_tagged_all_out_gives_no_reading`, and the boundaries `test_zone_boundaries_are_friel_fractions`.
The two means and their decay over a rest day are `test_daily_series_sums_two_runs_and_decays_over_empty_days` in `tests/test_load.py`.

## Reproducing the measurement

The table above comes from `threshold_readings.parquet` and `run_load.parquet` after a `recompute`, by setting the two constants in `analysis.threshold` and calling `estimate_at` at each run's start.
The rows with a margin filter the window's readings by VDOT before the median, as the rule before this one did:

```python
import itertools
import pandas as pd
import activity_analysis.analysis.threshold as th
from activity_analysis.config import default_paths
from activity_analysis.store.writer import read_run_load, read_threshold_readings

paths = default_paths()
readings = read_threshold_readings(paths)
starts = pd.to_datetime(read_run_load(paths)["start_time_utc"], utc=True).sort_values()
recent = starts[starts > starts.iloc[-1] - pd.Timedelta(days=730)]
for window, minimum in itertools.product((180, 365, 540, 100_000), (3, 5)):
    th.WINDOW_DAYS, th.MIN_READINGS = window, minimum
    estimates = [th.estimate_at(readings, s)[0] for s in recent]
    print(window, minimum, sum(e is not None for e in estimates), "of", len(recent))


def with_margin(at: pd.Timestamp, window: int, margin: float, minimum: int) -> float | None:
    start = readings["start_time_utc"]
    inside = readings[(start > at - pd.Timedelta(days=window)) & (start <= at)]
    if inside.empty:
        return None
    kept = inside[inside["vdot"] >= (1 - margin) * inside["vdot"].max()]
    return float(kept["final_hr_bpm"].median()) if len(kept) >= minimum else None


print(with_margin(starts.iloc[-1], 365, 0.10, 3))
```

The readings themselves do not depend on the window or the minimum, so one `recompute` serves every setting.
The lock-on guard's figures come from each all-out run's highest-VDOT eligible effort, read before the effort rule and the guard.
This prints the 41 windows' deepest 30 s mean below their median, which shows the gap from 19 to 23 bpm, and for the 33 with no second under the floor, how far the last 900 s and 600 s read above all 1200:

```python
import pandas as pd

from activity_analysis.analysis.fitness import vdot
from activity_analysis.config import default_paths
from activity_analysis.store.writer import (
    read_activity_metrics,
    read_activity_tags,
    read_best_efforts,
    read_derived_stream,
)

paths = default_paths()
tags = read_activity_tags(paths)
all_out = set(tags.loc[(tags["kind"] == "effort") & (tags["tag"] == "all_out"), "activity_id"])
metrics = read_activity_metrics(paths)
outdoors = set(metrics.loc[metrics["is_indoor"].eq(False), "activity_id"])
efforts = read_best_efforts(paths)
efforts = efforts[
    efforts["activity_id"].isin(all_out & outdoors)
    & efforts["elapsed_time_s"].between(1800, 3600)
    & ~efforts["contains_pause"]
    & ~efforts["contains_outage"]
    & ~efforts["contains_jump"]
]
efforts = efforts.assign(v=[vdot(d, t) for d, t in zip(efforts["distance_m"], efforts["elapsed_time_s"])])
rows = []
for activity_id, group in efforts.groupby("activity_id"):
    effort = group.loc[group["v"].idxmax()]
    grid = read_derived_stream(paths, activity_id)
    end = effort["end_t_s"]
    hr = grid.loc[(grid["t_s"] > end - 1200) & (grid["t_s"] <= end) & ~grid["paused"], "hr_bpm"]
    if hr.notna().mean() < 0.9:
        continue
    median = hr.median()
    rows.append(
        {
            "depth": median - hr.rolling(30).mean().min(),
            "untouched": bool((hr >= median - 20).all()),
            "bias900": hr.iloc[-900:].mean() - hr.mean(),
            "bias600": hr.iloc[-600:].mean() - hr.mean(),
        }
    )
frame = pd.DataFrame(rows)
print(len(frame), sorted(frame["depth"].round(1)))
clean = frame[frame["untouched"]]
print(len(clean), clean[["bias900", "bias600"]].describe().round(2))
```

The TRIMP figures come from `run_load.parquet`, `training_load.parquet` and the 1 Hz grids after a `recompute`.
This prints the fallback counts and the 365 against 540 day maximum; the rest comparisons swap `rest_bpm` for the profile's `resting_hr_bpm`, or set `trimp.REST_WINDOW_DAYS` and read the `bpm` of `rest_at` on each run's local date, the same way:

```python
import pandas as pd
import activity_analysis.analysis.trimp as tr
from activity_analysis.config import default_paths
from activity_analysis.store.writer import read_derived_stream, read_run_load

paths = default_paths()
loads = read_run_load(paths)
loads["start_time_utc"] = pd.to_datetime(loads["start_time_utc"], utc=True)
print(loads[["rest_from_setting", "max_from_setting"]].sum(), loads["trimp"].isna().sum())
tr.MAX_WINDOW_DAYS = 365
max365 = [tr.max_at(loads, t) for t in loads["start_time_utc"]]
differs, changes = 0, []
for (_, run), m in zip(loads.iterrows(), max365):
    if m is None or pd.isna(run["trimp"]) or m == run["max_bpm"]:
        continue
    differs += 1
    grid = read_derived_stream(paths, run["activity_id"])
    changes.append(tr.run_trimp(grid, run["rest_bpm"], m) / run["trimp"] - 1)
print(differs, "of", len(loads), pd.Series(changes).median())
```

The Relative Effort check reads the Strava export's `activities.csv` with `csv.reader`, maps each row's `Filnamn` to the `activity_id` the ingest ledger, `data/canonical/ingest_ledger.parquet`, records for that file name, and correlates `Relativ insats` with `trimp` on the runs both have.
The sawtooth figures are quantiles of `atl` and `form` over the last 16 weeks of `training_load.parquet`, and the weekly sign changes are read from `training_load_weekly.parquet`.

## Deliberately not modelled

- **A measured LTHR.** The estimate reads hard training runs, not a test run to a protocol; it is only as good as the hardest efforts in the window.
- **Heart-rate drift within the final 20 minutes.** The reading is the mean of the window's seconds after the lock-on guard, as Friel's test takes the mean, with no correction for the upward drift through a hard effort.
- **Terrain and heat.** A hilly or hot effort reads a higher heart rate at the same VDOT; the median across several efforts is the only defence.
- **A high misreading.**
  The lock-on guard looks only below the window's median.
  An optical sensor that locks onto the cadence reads high instead, and no such window was seen in the all-out runs; the median of the readings is the defence.
- **Load from other sports.** The derived layer covers running only, and cycling at the same heart rate would score the same TRIMP as running.
- **Sex.** TRIMP's constants are Morton's for men; the pair for women is documented above, not offered as a setting.
- **The day's own resting heart rate.** Rest is a 28-day median, so a run the morning after a night of fever is weighed on the athlete's usual rest, not that night's.
- **Separate gains for fitness and fatigue.** Banister's full model fits a gain to each and predicts performance as their weighted difference; form here is the plain difference, with no performance fitted to it.
- **A rule on how fast load may rise.** The daily and weekly series are stored for the training plan's author to read; no threshold on them is enforced in code.
