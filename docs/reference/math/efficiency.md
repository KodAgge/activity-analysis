# Efficiency: cadence and heart rate at a reference pace, and decoupling

What cadence and heart rate would have been at a fixed pace, so that their trend over months is fitness rather than scheduling, and how much of a run's efficiency was lost between its first half and its second.

Implemented in `src/activity_analysis/analysis/efficiency.py`, written by the efficiency pass in `analysis/pipeline.py` to `activity_efficiency.parquet` and `athlete_fit.parquet`.
Tested in `tests/test_efficiency.py` against synthetic series with known answers and in `tests/test_pipeline_efficiency.py` for the wiring.
`docs/reference/derived-layer.md` describes the two tables' shapes; this document holds the reasoning and every measured number.

Two kinds of measurement appear below and are kept apart.
The **pilot** figures were measured on 2026-09-05 during design, on subsets of the store chosen by hand, before this module existed.
The **store** figures were re-measured the same day after this module landed, on exactly the activities the module fits, again on 2026-09-12 after the walk exclusion below narrowed that population by one, and again on 2026-10-16 on the store rebuilt from the full Strava and Garmin exports: 227 of the 335 runs, every one of them carrying heart rate.
Where the two differ the difference is the population, and both are quoted so the drift is visible rather than hidden.
A figure dated 2026-09-12 below is kept as the record of an argument made then, and says so.

## What the metric answers, and why raw values do not

Heart rate and cadence both rise with speed.
Between runs, this athlete's median speed spans 17% of the median reference speed from the 10th to the 90th percentile of the store.
That spread, multiplied by the between-run slope of heart rate on speed below, is the heart rate variation an ordinary week of training carries that is nothing but pace.
It comes to 0.64 times the fitness signal this project exists to find, the yearly fall in heart rate at fixed pace from the same fit (pilot: 1.06).
So one week of pace variation moves raw average heart rate by two thirds of what a year of progress moves it, and a raw series over time mixes the two at the same order of size; raw cadence does the same.

The fix is to ask a counterfactual instead: what would the channel have read at a reference pace?
That number is comparable between a hilly Tuesday jog and a flat Sunday long run, and its trend is the athlete rather than the session.

## The reference paces

Three of them, the 25th, 50th and 75th percentile of per-activity median speed over the activities that enter the fit.

**Why derived rather than fixed.**
The original design fixed 5:00/km, and measured against the store on 2026-10-16 only 35 of the 335 runs have an interquartile speed band containing it (pilot: 23 of the 223 runs with heart rate).
Evaluating a fit there is an extrapolation for the other 300.
A derived reference sits where the athlete actually runs, and moves with the athlete.

**Why the median of per-activity medians.**
Four candidate definitions were measured for the middle reference:

| Definition | Value against the third row | On 2026-09-12 | What it weights |
| --- | --- | --- | --- |
| median over all unpaused seconds carrying a speed, pooled | -1.31% | -1.19% | every second equally, so a three-hour run outweighs six half-hour runs |
| median over all unpaused seconds carrying a speed and a heart rate, pooled | -1.31% | +0.45% | as above, but only on days a strap was worn |
| median of per-activity medians, all 335 runs | 0 | 0 | every run equally |
| median of per-activity medians, seconds carrying a heart rate | 0 | +1.50% | every run equally, but depends on which days a strap was worn |

Each activity contributes one value, so a long run does not outweigh a short one for no stated reason, and heart rate presence is not required, because the same reference serves the cadence metric, which needs no heart rate.
On 2026-09-12, 84 runs carried no heart rate at all and the heart-rate rows sat apart from the others.
On 2026-10-16 every unpaused second carrying a speed also carries a heart rate, so the second and fourth rows equal the first and third; the rule is kept for the first run recorded without a strap.

**Which population.**
The reference was first defined over every run, 307 of them then, and was changed on 2026-09-06 to the population this module uses.
This module takes the quartiles over the 227 activities that enter the fit, which sit 0.57% faster, 0.07% faster and 0.82% slower than the quartiles over all 335 runs.
The reason is the same one that excludes a treadmill from the fit: a footpod's speed is not comparable with an outdoor run's, so it should not set the paces an outdoor fit is read at, and an interval session's median speed is a blend of reps and recoveries that nobody ran.
The band from the slow to the fast reference spans 9.1% of the median reference because this athlete's sessions are evenly paced, and that narrowness is the point: these are three paces actually run rather than three spread far enough apart to look impressive and mostly extrapolated.

```sql
-- the first definition, over every run
WITH per AS (
  SELECT activity_id, median(speed_mps) AS m FROM streams_1hz
  WHERE NOT paused AND NOT outage AND speed_mps IS NOT NULL GROUP BY 1)
SELECT quantile_cont(m, 0.25), quantile_cont(m, 0.5), quantile_cont(m, 0.75) FROM per;

-- what the module stores
SELECT ref_slow_mps, ref_median_mps, ref_fast_mps FROM athlete_fit;
```

## Why the per-activity fit fails

The original design fitted `hr ~ speed` inside each activity and read it off at the reference.
That estimator is not identifiable on this athlete's data, because there is almost no speed to fit through: the within-run interquartile speed range has a median of 8.8% of the median reference speed.

The pilot measured the standard rescues and none of them rescued it:

| Estimator (pilot) | Runs | SD of slopes over their median | Negative slopes |
| --- | --- | --- | --- |
| Per activity, all runs | 169 | 1.51 | 25 |
| + restricted to `easy` and `steady` | 97 | 1.39 | 11 |
| + heart rate shifted back 15 s | 97 | 1.27 | 10 |
| + shifted 30 s and gated on speed spread | 86 | 1.20 | 9 |

Over 218 runs the pilot found 30 negative slopes: heart rate falling as speed rises, which is physiologically backwards.
On the store, the 227 heart rate fits this module makes have own slopes whose standard deviation is 1.86 times their median, and 44 negative, 19% of them.
A slope whose spread is nearly twice its size is not a measurement of anything.

## Why the warm-up cannot be excluded

The natural refinement is to drop the first minutes, on the grounds that heart rate is still climbing to steady state and pollutes the fit.
Measured, it makes the fit worse, and the reason inverts the assumption.

| Window | Runs | Median slope against the whole run's | SD over median | Negative | Pilot: median against whole run / SD over median / negative |
| --- | --- | --- | --- | --- | --- |
| Whole run | 227 | 1 | 1.86 | 44 (19%) | 1 / 1.18 / 16 (10%) |
| Drop first 5 min | 218 | 0.41 | 3.12 | 76 (35%) | 0.40 / 2.88 / 45 (29%) |
| Drop first 10 min | 210 | 0.25 | 4.58 | 72 (34%) | 0.28 / 3.34 / 46 (30%) |
| Drop first 15 min | 187 | 0.30 | 3.34 | 59 (32%) | 0.33 / 2.49 / 40 (27%) |

Splitting each run at the five-minute mark and fitting each channel against time shows the mechanism.

- **In the first five minutes** heart rate and speed both climb steeply against time (the store figure filters seconds under 1 m/s, which removes the standing start).
  Speed and heart rate move together, strongly.
- **After five minutes** heart rate drifts up at 7.1% of its first-five-minute median rate, rising in 90% of runs, while speed is flat at 2.3% of its own (pilot: 7.1%, 88%, 1.5%).
  In 30% of runs heart rate rises while speed falls (pilot: 28%), which forces a negative slope whatever the physiology.

The warm-up is not noise in the fit.
It is the only stretch of a steadily paced run in which speed and heart rate genuinely co-vary, and removing it leaves a regression dominated by drift, which is confounded with elapsed time rather than with speed.

That drift is cardiac drift, and it is not removed anywhere in this module, because it is the signal of another metric in the same module: aerobic decoupling, below.
Cleaning it out of one metric while reporting it as another would be incoherent.

## The shared slope, fitted between runs

If a slope cannot be read inside a run, read it across runs.
Each eligible activity contributes one point, its median usable speed against its median channel value, and one straight line is fitted through all of them with a time term:

$$\bar h_i = \beta_v\, \bar v_i + \beta_t\, y_i + c,$$

where $\bar v_i$ and $\bar h_i$ are the medians and $y_i$ is years since the first activity in the history.
The time term is carried so that the athlete getting fitter, heart rate falling at fixed pace over the years, is not absorbed into the speed coefficient.

On the store, over the 227 activities, $\beta_v$ carries a standard error of 0.41 of its own size and $\beta_t$ one of 0.15, and the pilot's $\beta_v$ is 0.85 of the store's, inside that error.
Without the time term the store's $\beta_v$ comes out 0.61 times as large (pilot: 1.12), and a within-run fit pooled over every second of every fitted run, which has no time term either, gives 0.58 times it (the pilot's gave 1.16 times its own $\beta_v$).
Both routes without the time term sit about one standard error of $\beta_v$ below it.
On 2026-09-12 the three routes agreed to within 17%, which was the evidence that the slope is a property of the athlete rather than an artefact of pooling; the next paragraph is why the two without a time term have since come apart from it.

On 2026-09-12 the time term barely moved the slope, because run-median speed and date were nearly orthogonal, correlating at r = -0.093 (pilot: -0.109).
The term was kept on the grounds that relying on that would be building on a coincidence, and the 2026-10-16 store is the case it was kept for.
Over the longer history run-median speed and date correlate at r = +0.14, and heart rate at fixed pace falls with time by a yearly amount whose standard error is 0.15 of its size.
A fit without the term credits part of the later runs' lower heart rate to their higher speed and comes out flatter, by exactly $\beta_t$ times the slope of date on run-median speed, which is least squares' omitted-variable identity.
`test_the_shared_slope_is_not_confounded_by_a_fitness_trend` constructs that case on synthetic data and checks the term recovers the slope.

**Why between rather than within.**
Leverage.
Run-median speed spans 17% of the median reference speed from the 10th to the 90th percentile of the store, against 8.8% inside a typical run, so the between-run fit has nearly twice the spread of speed to work with, and it is untouched by within-run drift because each run enters at its steady-state medians.

The physical reading matches the statistical one: the slope is a property of the athlete's cardiovascular response and does not need re-estimating from forty minutes of nearly constant pace, whereas the level is exactly what fitness moves.

## The autocorrelation problem, and the block bootstrap

A shared slope alone has a defect that "Three reference paces are translations" below makes concrete: it gives every run the same slope, so evaluating at more than one reference pace adds nothing.
The remedy is to let a run keep as much of its own slope as its own data credibly supports, which needs an honest standard error for that slope, and ordinary least squares does not give one.

The OLS standard error of a slope over $n$ points,

$$\operatorname{se}^2 = \frac{\sum r_i^2 / (n-2)}{\sum (x_i - \bar x)^2},$$

assumes the residuals $r_i$ are independent.
On a 1 Hz grid they are anything but: heart rate at second 1201 is nearly heart rate at second 1200.
For residuals following a first-order autoregression with coefficient $\rho$, the effective number of independent observations is about $n\,(1-\rho)/(1+\rho)$, and the true standard error is larger than the OLS one by roughly $\sqrt{(1+\rho)/(1-\rho)}$.
At $\rho = 0.9$ that is 4.4 times; at $\rho = 0.99$ it is 14 times.

Measured directly on the store, by the bootstrap described next:

| Channel | Runs | Median bootstrap se over median OLS se | Pilot ratio, 60 runs |
| --- | --- | --- | --- |
| Heart rate | 227 | 8.2x | 9.3x |
| Cadence | 227 | 8.3x | 9.9x |

**The moving-block bootstrap.**
Resampling individual seconds would destroy exactly the structure that makes the OLS error wrong.
Instead, `BLOCK_SECONDS` = 120 consecutive seconds are drawn as a block, `n // 120` blocks are concatenated into a resample of about the original length, the slope is refitted, and the standard deviation of the slope over `BOOTSTRAP_DRAWS` = 120 resamples is the error.
Within a block the correlation is preserved, so the spread of the resampled slopes reflects how much independent information the series actually carries.
A run shorter than one block has no estimable error and returns infinity, which sends its shrinkage weight to zero, below.

The block length has to be longer than the correlation length and short enough that a run yields many blocks.
Heart rate on this grid decorrelates over roughly a minute, so 120 s spans it with margin while a 40 minute run still yields about 20 blocks.
`test_the_block_bootstrap_error_exceeds_the_naive_one_under_autocorrelation` constructs an AR(1) series at $\rho = 0.99$ and asserts the bootstrap error exceeds the naive one by more than a factor of three.

**What the naive error would have done.**
Under OLS errors, 224 of 227 cadence slopes and 212 of 227 heart rate slopes on the store look individually significant at $|t| > 2$ (pilot: 216 of 218 cadence slopes).
Under the bootstrap, 173 and 72 do.
An earlier reading of this data that presented the cadence slope as precisely known in nearly every run was wrong for this reason, and the correction is why the shrinkage below is doing real work rather than leaving every run's own slope alone.

`naive_se` is kept in the module, unused by the estimator, so that this comparison is reproducible rather than asserted.

## Shrinkage

For activity $i$ with own slope $b_i$ and bootstrap error $\operatorname{se}_i$, and a shared slope $b$:

$$w_i = \frac{\tau^2}{\tau^2 + \operatorname{se}_i^2}, \qquad b_i^{\text{shrunk}} = w_i\, b_i + (1 - w_i)\, b.$$

**What $\tau$ is.**
The spread of own slopes observed across activities is the real spread of true slopes plus estimation noise, so the real spread is what remains after the noise is subtracted:

$$\tau^2 = \operatorname{var}(b_i) - \overline{\operatorname{se}_i^2},$$

floored at zero.
On the store $\tau$ is 0.73 of the observed standard deviation of the heart rate own slopes and 0.85 of the cadence one, so $\tau^2$ is 0.53 and 0.73 of the observed variance; the cadence $\tau$ is 0.68 of the heart rate one (pilot, 60 runs: 0.57).
So about half of the apparent between-run variation in the heart rate slope is real, and most of the cadence one is.

**What $w_i$ is.**
The fraction of this activity's apparent deviation from the shared slope that is credible rather than noise.
On the store the median weight is 0.69 for heart rate and 0.88 for cadence over all 227 rows, with means of 0.65 and 0.80 (pilot: 0.53 and 0.66).

**The two limits**, both pinned by tests.
A run with an infinite error, one held at a single pace or too short to block, has $w_i = 0$ and takes the shared slope exactly; that is `test_a_run_with_no_leverage_takes_the_shared_slope_exactly`, and it is what preserves everything the pooled decision was made for.
A run with a wide speed range and low noise has $w_i$ near 1 and keeps its own; that is `test_a_precisely_measured_run_keeps_almost_all_of_its_own_slope`.
With $\operatorname{se}_i = \tau$ the weight is exactly one half and the result is the midpoint, which `test_shrinkage_is_the_precision_weighted_average` asserts to twelve decimals.

**The pooled estimator is the special case $w_i = 0$ for all $i$**, which is also what $\tau = 0$ produces: if the observed spread is no larger than the errors explain, there is no real between-activity variation and every run takes the shared slope.

Shrinkage reduces the count of negative heart rate slopes from 44 to 30 on the store rather than to zero.
That is the correct behaviour: a run whose own data say its slope is -30 with an error of 9 has a real claim to be unusual, and the estimator honours the claim in proportion to the evidence.

## Why the level is refitted at the shrunk slope

Each `*_at_*` column is $a_i + b_i^{\text{shrunk}}\, r$ for a reference pace $r$, and $a_i$ is not the activity's own OLS intercept.

For a fixed slope $b$, the intercept that minimises $\sum (y_j - a - b\,x_j)^2$ over the activity's seconds is

$$a = \bar y - b\,\bar x,$$

so the line passes through the activity's own centroid $(\bar x, \bar y)$.
Pairing a shrunk slope with the activity's own OLS intercept would produce a line that passes through neither the centroid nor anything else in the activity's data, and its value at the reference would be off by $(b_i - b_i^{\text{shrunk}})\,\bar x$, which for a run shrunk by 10 bpm per m/s at 3 m/s is 30 bpm.

## Three reference paces under a shared slope are translations

Under a single shared slope $b$, the value at reference $r$ is $a_i + b\,r$, so the three series differ from one another by $b\,(r - r_{\text{median}})$, a constant identical for every activity.
The pilot computed the two constants with the within-run pooled slope and the all-run references, and this module's shared slope and references give two smaller ones.
Either way, three exact vertical translations of one line carry no information the one line did not, and the two extra columns would be pointless.

Under shrinkage each activity has its own slope, so the gap between its fast and slow values varies run to run.
On the store the gap `hr_at_fast_bpm - hr_at_slow_bpm` has a standard deviation of **0.90 of its median** across the 227 runs, against exactly 0 under a shared slope.
That non-zero spread is the property the estimator change exists to deliver, `test_the_three_reference_values_are_not_parallel_across_activities` asserts it on synthetic data, and the definition of done for the phase checks it on the store.
A consumer reading all three columns recovers the shrunk slope directly as `(fast - slow) / (ref_fast_mps - ref_slow_mps)`.

## The smoothed series

The three reference values are stored raw and again as trailing 42-day means, in `hr_at_slow_smoothed_bpm` and its five siblings.
The smoothed form exists because the raw one is not readable as three series.

That spread the previous section celebrates is real, and it is also small next to the run-to-run noise.
Measured on 2026-10-16 over the 227 fitted runs.
A step is the absolute difference between one run's value at the median reference and the previous run's, in start-time order over the runs that carry the column, which is all 227 for both channels; a run with no fit on a channel closes the gap rather than breaking the series.

| Quantity | Heart rate | Cadence | On 2026-09-12, heart rate / cadence |
| --- | --- | --- | --- |
| Median gap between the fast and slow series on one run, as a multiple of the median raw step | **0.30x** | 1.53x | 0.22x / 1.25x |
| 95th percentile of the raw step, as a multiple of the median gap | 13.5x | 2.58x | 15.1x / 2.97x |
| Median step smoothed at 42 days, as a fraction of the median raw step | 0.085 | 0.088 | 0.072 / 0.096 |
| Median gap smoothed, as a fraction of the median raw gap | 0.98 | 1.14 | 0.96 / 1.19 |
| Smoothed gap as a multiple of the smoothed step | **3.44x** | 19.6x | 2.88x / 15.6x |

The heart rate row is the one that forces the decision.
Raw, the distance between the fast and slow lines is under a third of the distance either line jumps between neighbouring runs, so three series plotted raw are one jagged band and the eye cannot separate them.
The median understates that noise, too: the step's own distribution has a long tail, and at its 95th percentile a neighbouring pair sits thirteen times the gap apart.
At 42 days the same gap is three and a half times the residual step and the three lines come apart.

**Why a trailing calendar window.**
Trailing rather than centred, because a centred window would let a run's value depend on runs that had not happened yet, and the chart is read left to right as history.
Calendar rather than a count of activities, because a two-week break should show as a gap rather than be invisibly bridged by whatever six activities happened to come last.
`analysis/smoothing.py` holds the one implementation; it raises on unsorted input rather than sorting, because a caller that had lost its ordering would otherwise silently average over the future.

**Why 42 days.**
It is the window the VO2max series and the consistency metrics already use, so the three charts in the application move at the same rate.
Over the fitted runs the median 42-day window holds 12 of them, which is enough to average and short enough that a real six-week change is not flattened.
A null contributes nothing to the windows it falls in, so a run with no heart rate fit neither drags the heart rate series down nor breaks it; on 2026-09-12 that was 51 of the 208 fitted runs, and on 2026-10-16 it is none of the 227.

The raw columns are kept beside the smoothed ones.
One activity's own fitted value is what the activity view shows, and the smoothed value is not a property of that activity at all.

## Aerobic decoupling

Efficiency is speed per heartbeat, $v / h$.
Decoupling compares the first half of a run's usable seconds against the second:

$$\text{decoupling} = 100 \cdot \frac{\overline{v}_1 / \overline{h}_1 - \overline{v}_2 / \overline{h}_2}{\overline{v}_1 / \overline{h}_1}.$$

Positive means the second half cost more heart rate for the same speed, which is the usual direction and is the standard measure of endurance durability.
On the store the median is 9.59%, the interquartile range 5.18% to 14.51%, and 210 of 227 runs are positive.
`test_decoupling_is_positive_when_heart_rate_drifts_up_at_the_same_speed` checks the arithmetic on a run whose second half is 15 bpm dearer at the same speed: 9.09%.

`analysis.efficiency.decoupling` returns the four means $\overline{v}_1$, $\overline{v}_2$, $\overline{h}_1$ and $\overline{h}_2$ beside the percentage, and `activity_efficiency` stores them, because the percentage alone cannot say which of the two moved.
Measured on 2026-10-03: on the 2026-08-28 reference run the second half's speed was 4.4% lower, its pace 4.6% longer, and its heart rate 14.8 bpm higher, 6:31 to 6:49 /km and 148 to 163 bpm, for 13.08%; on one real run pace held to within 1% while heart rate rose by about 27%, for 20.50%.
`test_the_halves_reproduce_the_percentage_on_an_odd_count` checks that the four means reproduce the percentage.

Comparing a run against itself is what makes this the one metric in the module that is nearly insensitive to terrain.
Both halves were run by the same athlete on the same day, so a hilly course inflates both sides of the ratio; only a route whose second half is systematically hillier than its first leaks through.
It is also why the cardiac drift documented under "Why the warm-up cannot be excluded" is left alone: there it is a nuisance, here it is the measurement, and one module cannot honestly treat the same seconds both ways.

A run needs `MIN_DECOUPLING_SECONDS` = 600 seconds carrying both speed and heart rate, or the column is null.

## The population decoupling is interpretable over

Decoupling is computed for every run that has the seconds for it, and it is only *interpretable* on long aerobic efforts.
Across all of them it measures the shape of the session rather than the state of the athlete.

Measured on 2026-10-16, it does not separate by session type in any useful direction:

| Population | Runs | Median decoupling | On 2026-09-12 |
| --- | --- | --- | --- |
| all runs with a value | 227 | 9.59% | 9.37% over 157 |
| all-out | 64 | 10.37% | 10.29% over 61 |
| steady | 69 | 8.00% | 7.72% over 61 |
| easy | 35 | 8.70% | 9.19% over 33 |
| **easy or steady, 40 fitted minutes or more** | **46** | **7.65%** | 6.98% over 39 |
| easy or steady, 60 fitted minutes or more | 26 | 6.33% | 3.42% over 22 |

The first four rows are the problem: an all-out session and an easy one differ by under two points, against an interquartile range across all runs over nine points wide, so a chart over all 227 mostly plots which kind of session happened that week.
The last two narrow toward the efforts the metric is defined on, and the median falls with each restriction.
At 60 minutes the median is 6.33%, above the conventional 5% line for aerobic durability, with 12 of the 26 under it; on 2026-09-12 it was under the line.
The population is where reading a run against that line means something, and whether the athlete's long runs clear it is what the series then shows.

`is_aerobic_long_run` marks the 46 rows of the bolded population: `effort_tag` in `AEROBIC_TAGS` = {`easy`, `steady`} and `fit_seconds` at least `MIN_AEROBIC_LONG_RUN_SECONDS` = 2400.
40 minutes rather than 60 because 26 runs is too thin a series to read, and 46 is only just enough.

A run the classifier could not tag is **outside** the population rather than assumed aerobic.
90 of the 335 runs carry no effort tag, 29 of them on a treadmill, and a run that cannot be shown to have been easy does not qualify; on 2026-09-12 most of the untagged runs carried no heart rate at all.

**The 90-day window.**
`decoupling_smoothed_pct` is the trailing mean over that population only, at `DECOUPLING_SMOOTHING_WINDOW_DAYS` = 90 rather than the 42 the reference paces use.
The population is a fifth the size, 46 runs against 227, so a 42-day window would often hold one qualifying run and smooth nothing.
At 90 days the median window holds 7 of them, the thinnest holds 1, and the largest gap between two qualifying runs is 74 days.

The masking runs on both sides of the window.
A non-qualifying run's value is nulled before the mean, so no window ever averages a session type the metric does not hold for; and the output is nulled at every non-qualifying run, so the series does not repeat one window's mean across a run of points no activity measured.
The column is therefore null on 181 of the 227 rows by construction, which is what a chart drawing only the qualifying runs needs.

## The cadence slope as its own metric

The fitted `cadence ~ speed` slope is a byproduct of a fit already being made, and whether it trends was asked on 2026-09-05.

On the store 223 of 227 own slopes are positive (pilot: 214 of 218), which is the expected sign: cadence rises with speed.
A linear trend in the own slope over the athlete's history has **t = 0.92**, a standard error larger than the trend itself, and t = 1.28 on the shrunk one (pilot: t = 1.20).
Yearly medians do not move in one direction either:

| Year | 2023 | 2024 | 2025 | 2026 |
| --- | --- | --- | --- | --- |
| Median own cadence slope, against the whole history's median | 0.78 over 11 runs | 0.96 | 0.89 | 1.19 |
| Pilot | 1.46 | 1.01 | 0.87 | 1.15 |

**It does not trend on this history**, and the tables and the frontend say so rather than labelling it improvement.
The interpretation has to be stated carefully: a *lower* slope means the athlete gains speed more by lengthening stride than by raising turnover, which describes running style and is not obviously better or worse.

The level does trend, and sharply: cadence at the median reference pace rises with **t = 23** on a linear trend across the 227 runs, and heart rate at the same pace falls with t = 6.6 across the same runs (t = 1.4 over 157 on 2026-09-12).
Those two are the trends the phase exists to show.

## Which sessions feed the fit

Only `intervals` is excluded.
Heart rate lags speed sharply through repetitions, so the relation being fitted does not hold inside one.
`easy`, `steady`, `all_out` and unclassified runs all take part, and the row carries `effort_tag` so a consumer wanting a narrower set can filter without a recompute.

The pilot measured what that width costs: fitted heart rate at one reference speed has a standard deviation within `easy`, `steady` and `all_out` of 0.79, 0.69 and 0.82 of the one across all tags, with `all_out` sitting above `easy` at the same speed by 0.59 of that all-tag standard deviation.
It buys a trend over 227 runs rather than the 104 of them tagged `easy` or `steady`.

The other two eligibility rules are the caller's, in `analysis/pipeline.py`, because this module reads no store: treadmill runs are excluded since a footpod's distance is uncalibrated, and seconds that are paused or inside an outage never reach the module at all.
Inside the module a second must carry a speed above `MIN_FIT_SPEED_MPS` = 1.0 m/s, below which the athlete is walking or the sensor is drifting, and a run must have `MIN_FIT_SECONDS` = 600 such seconds, the same order as Garmin's own qualifying rule for a VO2max estimate.

**Walks are excluded as activities, not only as seconds.**
`MIN_FIT_SPEED_MPS` drops the walking seconds inside a run.
It cannot drop a walk, because a walk with a few brisk stretches has plenty of seconds above 1.0 m/s, and those seconds then set a slope and a level like any other run's.
`MIN_FIT_MOVING_SPEED_MPS` = 1000/480 = 2.0833 m/s, which is 8:00 per kilometre, drops the activity: a sample whose own moving speed is below it never reaches the fit.

Moving speed rather than elapsed, because elapsed keeps the stopped seconds and a run with a long stop in it would read as a walk.

**Moving time excludes stopped seconds but not outage seconds, and the rule inherits that limit.**
An outage is a gap over 120 s that is not a stop, so by design its seconds stay in moving time while its metres interpolate across it.
A run carrying a long outage across which the odometer barely advanced could therefore fall under 2.0833 m/s and be dropped from the fit as a walk, silently, while `fit_seconds` over the same grid stays comfortably eligible because the fitted window excludes the outage seconds the denominator keeps.
Nothing in the current history is in that state: the one activity the rule excluded was a genuine walk, and since `ANALYSIS_VERSION` 13 it excludes none; see below.
Whether any run sits near the boundary under a denominator that also removed outage seconds has not been measured.

This is not an argument for elapsed time, which is worse on both counts because it keeps the stopped seconds too.
The choice is between moving time as defined and a third definition that also excludes outage seconds, and settling it is a metric definition change rather than a correction.
The caller passes `activity_metrics.avg_speed_mps`, which is the activity's canonical distance over its derived moving time, and a null means not known rather than slow, so an activity whose moving time has not been computed stays in the fit.
That is the same column the API serves as the browser's Pace, so the speed that decides whether an activity is a walk is the speed a reader sees beside it, rather than a second definition that could drift from it.
The numerator is the canonical distance rather than the grid's odometer, which matters nowhere in this fit as it happens: treadmill runs are excluded before the threshold is reached, and on the 254 outdoor runs the two distances are identical.

Measured on 2026-09-12 the rule excludes exactly one of the 209 activities that previously entered the fit, a walk, taking the population to 208.
A second outdoor activity is under the threshold, and it was already out for another reason.
Since `ANALYSIS_VERSION` 13 both are counted as walks before the fit sees them, by the 9:00/km reclassification in `reclassification.md`, so this rule excludes nothing on the store of 2026-10-16, where no outdoor run is under the threshold, and the population of 227 is unchanged by it.
It stays for the band between 8:00 and 9:00/km, which the reclassification leaves to running and this fit does not.
The rule is here for the history to come rather than for that one row: the cost of leaving it out is that the day the athlete logs a walk, it sets a reference pace and contributes a slope to the shared fit, and both are population quantities that every other run's reported value is read against.

## Rejected alternatives

- **A fixed reference pace of 5:00/km.** Rejected because it is an extrapolation for 300 of 335 runs.
- **A per-activity slope.** Rejected because it is not identifiable at a within-run speed range of 8.8% of the median reference; 19% of fits come out with the wrong sign.
- **The rescues for the per-activity slope**, tag restriction, lagging heart rate, gating on speed spread. Rejected on the pilot table above; none brought the negative count below 9.
- **Dropping the warm-up.** Rejected because it removes the only stretch where speed and heart rate co-vary and nearly doubles the share of negative slopes on the store, from 19% to 35% (pilot: from 10% to 29%).
- **A single shared slope with no shrinkage.** Rejected because it makes three reference paces redundant. It remains the zero-weight special case.
- **OLS standard errors in the shrinkage weight.** Rejected because they are about eight times too small and would send every weight to 1.
- **Keeping the activity's own intercept under a shrunk slope.** Rejected because the line then passes through none of the activity's data.
- **Removing cardiac drift before fitting.** Rejected because the same drift is what decoupling reports.
- **Reference paces over every run.** Rejected in favour of the eligible population, so that footpod speeds and interval sessions do not set the evaluation points of a fit they are excluded from.
- **Leaving the smoothing to the frontend.** Rejected because a smoothed series is a metric, and `docs/reference/frontend.md` forbids the frontend from recomputing one the analysis layer owns. It would also have to be recomputed on every render, and every consumer would have to agree on the window.
- **A centred smoothing window.** Rejected because a run's value would then depend on runs that had not happened yet.
- **A window counted in activities rather than days.** Rejected because it bridges a break invisibly: six activities either side of a two-month layoff average together as if they were a fortnight apart.
- **Decoupling over every session type.** Rejected on the table above: across all 227 runs the metric separates all-out from easy by under two points, which is inside its own noise.
- **A 60-minute threshold for the aerobic population.** Rejected because it leaves 26 runs, too few to read as a series, against 46 at 40 minutes.
- **Excluding walks by their seconds rather than as activities.** Rejected because the seconds of a walk with brisk stretches pass the per-second speed filter; only the whole-activity moving speed sees it.

## The error that survives

- **Terrain.** There is no grade adjustment, so a hilly run at a given pace is a harder effort than a flat one and reads as a higher heart rate at the reference. `ascent_per_km_m` on `activity_metrics` lets a consumer flag or filter hilly runs; decoupling is insulated because it compares a run against itself. Grade-adjusted pace was shelved on 2026-10-16 after measuring that it removes no bias on this athlete's runs ([README.md](README.md#9-adjust-speed-for-gradient)); if it lands only the heart-rate fit takes the adjusted speed column, because cadence follows the ground covered rather than metabolic cost.
- **Session type.** `all_out` sits above `easy` at the same speed by over half the all-tag spread of fitted heart rate, so the mix of sessions in a month moves the trend. The row carries the tag so the consumer can hold it fixed.
- **Reference drift.** The three paces move as history grows, so a value from 2023 and one from 2026 are evaluated at slightly different paces. The reference is not frozen once it has settled, so a value quoted from a chart can move slightly on the next recompute.
- **The bootstrap's own noise.** 120 draws give the standard error itself a relative error of roughly 7%, which enters the weight and not the reported value.
- **The block length.** 120 s is a judgement about the correlation length of heart rate on this grid, not a fitted quantity. A run whose drift is slower than that carries some correlation across blocks and its error is still somewhat understated.
- **GPX-sourced runs.** GPX speed carries 10.2 times the sample-to-sample noise of FIT (`geodesy.md`) and is not excluded here; a consumer that wants to can join `is_gpx_sourced`. The bootstrap error already grows with that noise, so such a run shrinks harder toward the shared slope.
  None of the 335 runs on the 2026-10-16 store is GPX-sourced.

## Deliberately not modelled

- **Grade adjustment**, above.
- **Heart rate lag.** Heart rate responds to a speed change with a delay of tens of seconds. Shifting it back was one of the pilot's rescues and did not help the per-activity fit, and the between-run fit at steady-state medians is indifferent to it. A 2026-10-16 probe with a simplified per-run fit against a trailing 60-second mean of speed did cut the within-run residual by 14%, but its effect on this module's fit and its trend has not been measured, so the fit still pairs each second's heart rate with that second's speed.
- **Temperature, wind, altitude, sleep.** All move heart rate at fixed pace and none are recorded.
- **A trend line.** The tables hold per-activity values, the smoothed series described above and the whole-history fit. Fitting a line through them and reporting a slope is the frontend's. Smoothing was the frontend's too until 2026-09-12, when it moved here: a smoothed series is a metric, and `docs/reference/frontend.md` forbids the frontend from recomputing one the analysis layer owns.
- **Cadence normalised by height or leg length.** The slope is reported as measured, and its interpretation as style rather than fitness is stated where it appears.

## Reproduced against the real store

Measured on 2026-09-05 over the 307 runs in the export, which is not committed, after `uv run activity-analysis recompute`, re-measured on 2026-09-12 after the walk exclusion narrowed the fitted population from 209 to 208, and re-measured on 2026-10-16 over the 335 runs and 227 fitted activities of the store rebuilt from the full exports.
Every store figure in this document carries the 2026-10-16 value unless it is labelled with an earlier date.

```bash
uv run python - <<'PY'
import numpy as np, pandas as pd
from pathlib import Path
from activity_analysis.analysis.efficiency import block_bootstrap_se, fit_slope, naive_se
from activity_analysis.config import Paths
from activity_analysis.store.db import connect
from activity_analysis.store.writer import read_derived_stream

paths = Paths(root=Path(".")); con = connect(paths)
print(con.execute("select * from athlete_fit").df().T)
print(con.execute("""
  select count(hr_slope_own_bpm_per_mps) n_hr, median(hr_slope_own_bpm_per_mps) med_hr,
         stddev(hr_slope_own_bpm_per_mps) sd_hr,
         sum(case when hr_slope_own_bpm_per_mps < 0 then 1 else 0 end) neg_hr,
         median(hr_slope_weight) w_hr, median(cadence_slope_weight) w_cad,
         stddev(hr_at_fast_bpm - hr_at_slow_bpm) gap_sd, median(decoupling_pct) decoupling
  from activity_efficiency""").df().T)

# the between-run fit, the OLS-versus-bootstrap ratio and the warm-up table
eff = con.execute("""
  select e.activity_id, a.start_time_utc
  from activity_efficiency e join activities a using (activity_id)""").df()
when = pd.to_datetime(eff.start_time_utc, utc=True)
eff["years"] = (when - when.min()).dt.days / 365.25
sp, hr, yrs, naive, boot = [], [], [], [], []
warm: dict[int, list[float]] = {0: [], 300: [], 600: [], 900: []}
for aid, years in zip(eff.activity_id, eff.years, strict=True):
    g = read_derived_stream(paths, aid)
    g = g.loc[~g.paused & ~g.outage]
    v, h, t = (g[c].to_numpy(float) for c in ("speed_mps", "hr_bpm", "t_s"))
    ok = np.isfinite(v) & (v > 1.0) & np.isfinite(h)
    if ok.sum() < 600:
        continue
    sp.append(np.median(v[ok])); hr.append(np.median(h[ok])); yrs.append(years)
    naive.append(naive_se(v[ok], h[ok])); boot.append(block_bootstrap_se(v[ok], h[ok], seed=0))
    for cut, slopes in warm.items():
        m = ok & (t >= cut)
        if m.sum() >= 600:
            slopes.append(fit_slope(v[m], h[m])[0])
X = np.column_stack([sp, yrs, np.ones(len(sp))])
coef, *_ = np.linalg.lstsq(X, np.array(hr), rcond=None)
print(len(sp), coef)                                          # 227, then speed, years, intercept
print(np.median(boot) / np.median(naive))                     # 8.2
for cut, slopes in warm.items():
    s = np.array(slopes)
    print(cut, len(s), round(np.median(s), 2), round(s.std(ddof=1), 2), (s < 0).sum())

# the smoothed-series table's run-to-run steps, in start-time order
steps = con.execute("""
  select e.hr_at_median_bpm h, e.hr_at_median_smoothed_bpm hs,
         e.cadence_at_median_spm c, e.cadence_at_median_smoothed_spm cs
  from activity_efficiency e join activities a using (activity_id)
  order by a.start_time_utc""").df()
for col in ("h", "hs", "c", "cs"):
    d = np.abs(np.diff(steps[col].dropna().to_numpy(float)))
    print(col, len(d) + 1, round(float(np.median(d)), 2), round(float(np.percentile(d, 95)), 2))
#   per column: runs, median step, 95th percentile step

# the decoupling population table
print(con.execute("""
  select coalesce(effort_tag, 'untagged') tag, count(decoupling_pct) n, median(decoupling_pct) med,
         count(*) filter (where effort_tag in ('easy', 'steady') and fit_seconds >= 2400) n40,
         median(decoupling_pct) filter (where effort_tag in ('easy', 'steady') and fit_seconds >= 2400) med40,
         count(*) filter (where effort_tag in ('easy', 'steady') and fit_seconds >= 3600) n60,
         median(decoupling_pct) filter (where effort_tag in ('easy', 'steady') and fit_seconds >= 3600) med60
  from activity_efficiency group by rollup (1)""").df())
#   the rollup's null row is the whole population
PY
```
