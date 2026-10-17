# VO2max, estimated two ways

Module: `src/activity_analysis/analysis/fitness.py`, functions `vdot`, `hr_vo2max`, `smooth_series` and `fitness_rows`.
Table: `data/derived/fitness_series.parquet`, one row per activity that produced at least one estimate.
Served by `GET /api/fitness`.

VO2max is the highest rate at which the body can take up and use oxygen, in millilitres per kilogram of body mass per minute.
It is measured in a laboratory with a gas analyser during an exhaustive treadmill test.
Nothing in this project measures it.
Both numbers here are estimates from a model, and on this athlete the heart-rate estimate sits at about 1.6 times VDOT, which is the first thing to understand about them.

The reason to compute them anyway is that raw heart rate and raw pace over months mostly measure how fast the athlete happened to run that day.
An estimate that combines the two into one number, and does so the same way every time, can show whether the athlete is getting fitter even though its absolute level cannot be trusted.
**The shape is the signal; the level is a model output.**
Every surface that shows either number has to say so.

## VDOT, the performance-based estimate

### What Daniels and Gilbert did

In 1979 Jack Daniels and Jimmy Gilbert published *Oxygen Power*, a set of tables relating race times across distances to a single number they called VDOT, the spoken form of $\dot{V}O_2$, the dot marking a rate.
The observation behind it is that race performance is governed jointly by maximal oxygen uptake and running economy, the oxygen cost of holding a given speed, and that neither can be read from a race time alone.
Their move was to collapse both into one number: **the VO2max that a runner of average economy would need in order to run the times actually run.**

That makes VDOT an inversion of performance rather than a measurement of physiology.
A runner with an unusually good economy and a modest VO2max gets the same VDOT as one with the reverse, because they run the same times.
That is exactly why it is the natural input to race prediction, which only cares about times, and why an effort estimates fitness only if it was run near maximally.
A 5 km window inside an easy jog is a real performance, and its VDOT is a real number, but it is the VDOT of a jog: on the real store the median per-activity VDOT is 22% below the fastest clean 5 km's.

### The two curves

Two empirical fits, neither derived from physiology.
With $d$ the distance in metres, $t$ the time in minutes and $v = d / t$ the speed in metres per minute:

$$
\mathrm{VO}_2(v) = -4.60 + 0.182258\,v + 0.000104\,v^2
$$

is the oxygen cost of running at $v$, a quadratic fitted to laboratory measurements of runners at steady speeds.

$$
p(t) = 0.8 + 0.1894393\,e^{-0.012778\,t} + 0.2989558\,e^{-0.1932605\,t}
$$

is the fraction of VO2max a runner can sustain for $t$ minutes, and

$$
\mathrm{VDOT} = \frac{\mathrm{VO}_2(v)}{p(t)} .
$$

**The percentage curve is the whole idea.**
At $t = 5$ minutes $p$ is about 0.97, at 30 minutes about 0.93, at 60 minutes about 0.89, and at three hours about 0.80.
So the same oxygen cost implies a very different VO2max depending on how long it was held: holding 4:00/km for 10 km is a far better performance than holding it for 3 km, and VDOT says so, whereas a pace alone does not.
Below about two minutes the curve exceeds 1.0, which is the formula stepping outside the range it was fitted over, and one reason `predictions.md` treats 400 m efforts as outside the model's domain.

### Worked example

The fixtures' fastest clean 5 km, 25:07.9 within the 2026-08-25 run, `6116b2e90f551a6c`:

| step | value |
| --- | --- |
| $t$ | 25.132 min |
| $v = 5000 / 25.132$ | 198.9 m/min |
| $\mathrm{VO}_2 = -4.60 + 0.182258 \cdot 198.9 + 0.000104 \cdot 198.9^2$ | 35.8 |
| $p(25.132)$ | 0.940 |
| $\mathrm{VDOT} = 35.8 / 0.940$ | **38.1** |

`test_vdot_matches_a_hand_computed_value` pins this.
The athlete's all-time eligible bests on the real store agree with each other across distances, which is the property a good performance scale has; against the 5 km's VDOT the 1 km's is 2.9% higher, the 3 km's 0.5% lower, the mile's 3.4% lower, and the 10 km, 15 km and half marathon's 8.6%, 11.0% and 15.6% lower.
The fall-off past 10 km is the athlete's, not the model's: the longer bests were not raced.

### Which effort an activity's VDOT comes from

An activity records best efforts at up to twenty-two distances at once, and VDOT reads nine of them.
Its `vdot` is the highest among its **eligible** efforts at one of `VDOT_DISTANCES_M`, and `vdot_distance_key` says which one, so a reader can tell a peak from a kilometre from a peak from a half marathon.
On the real store the 5 km supplies it most often (65 activities), then 3 km (52), then 400 m (25).

**Why nine and not all of them.**
`STANDARD_DISTANCES_M` grew from nine targets to twenty-two on 2026-09-12, and `VDOT_DISTANCES_M` was split out at the same time to hold the original nine: 400 m, 1 km, 1 mile, 3 km, 5 km, 10 km, 15 km, half marathon and marathon.
The two sets answer different questions.
The twenty-two exist so that the records ladder and the progression picker cover the distances the athlete actually runs, and a rung can be added to that ladder whenever one is wanted.
VDOT is an inversion of race performance through the Daniels tables, so its candidate set is a modelling choice, and the maximum over a set moves when the set does: an activity whose best VDOT came from its 3 km would score higher at a newly added 2 km or 4 km, silently changing `vdot`, `vdot_distance_key` and `vdot_smoothed` across the whole store as a side effect of a display change.
Decoupling the two sets is what makes adding a rung a display change and nothing more.
`VDOT_DISTANCES_M` is derived from `STANDARD_DISTANCES_M` by key, so the nine cannot disagree with the twenty-two about what a mile is.

Eligibility is the analysis layer's rule for records, restated rather than reinvented: `activity_metrics.is_indoor` must be explicitly false and `best_efforts.distance_trusted` explicitly true.
A treadmill distance comes from an uncalibrated footpod and a jump the measured speed does not confirm credited metres nobody ran, and either would yield a fitness estimate derived from a number nobody measured.
A null flag means not known and is dropped like a known jump, the same reading `/api/records` and the `pr` tag give it.
Since `ANALYSIS_VERSION` 10 a jump the measured speed confirms within 1% no longer disqualifies an effort; on the real store that raised two activities' `vdot`, a half marathon's by 7.6% and another run's by 8.6%, and gave a third a `vdot` where it had none.
None of the three is inside the 90-day prediction window, so no predicted time moved.

No distance floor is applied to the series, although `predictions.md` refuses efforts under 1 km as a prediction source, and the two rules differ deliberately.
A prediction extrapolates from one anchor, so a noisy 400 m window would propagate into every predicted time; the series shows each raw per-activity point beneath a 42-day mean and names its distance in `vdot_distance_key`, so a consumer can exclude the 400 m points without a recompute.
On the real store the all-time 400 m VDOT is within 2.3% of the 1 km's and 0.5% of the 5 km's, so the short points are not currently pulling the series.
Should they prove noisy, applying the same floor to `fitness_rows` is a one-constant change.

### Inverting VDOT

`time_for_vdot` answers the other question: how long would a runner of a given VDOT take over a given distance.
There is no closed form, but VDOT is strictly decreasing in time at a fixed distance, so a bisection over $[1, 200\,000]$ seconds converges; sixty iterations take the bracket below a millisecond.
`predictions.md` uses it for the ordinary-run prediction.

## The heart-rate estimate, Garmin's family

### The idea

Oxygen cost is estimated from running speed, and how hard the heart was working says what fraction of the maximum that cost represents.
Divide the one by the other and the result is the maximum.
This is the family Firstbeat built for Garmin, and its virtue is that it works on any run of sufficient intensity rather than only on race days, which is what makes a dense series possible: 165 of the 254 real outdoor runs produce an estimate, against 244 that produce a VDOT and only a handful that were run near maximally.

For each 30 s segment of the 1 Hz grid, with $v$ the mean speed in metres per minute and $h$ the mean heart rate as a percentage of the configured maximum:

$$
\mathrm{VO}_2^{\text{seg}} = 0.2\,v + 3.5, \qquad
f^{\text{seg}} = \frac{1.5625\,h - 57.81}{100}, \qquad
\widehat{\mathrm{VO}_2\text{max}} = \operatorname{median}_{\text{seg}} \frac{\mathrm{VO}_2^{\text{seg}}}{\operatorname{clip}\!\left(f^{\text{seg}},\, 0.35,\, 1\right)} .
$$

The median rather than the mean, so a single segment at an unusual heart rate does not carry the run.

### Every constant, sourced

**`0.2 v + 3.5`** is the American College of Sports Medicine metabolic equation for running, whose full form is

$$
\mathrm{VO}_2 = 0.2\,v + 0.9\,v\,G + 3.5
$$

with $v$ in m/min and $G$ the fractional grade.
0.2 is the oxygen cost, in ml/kg/min, of moving one kilogram one metre horizontally per minute; 0.9 is the vertical component; 3.5 is resting metabolism, one MET.
The level form is used because grade adjustment is not built ([README.md](README.md#9-adjust-speed-for-gradient)), and if it lands the vertical term becomes available from the same work.
Until then, hills make a run look more economical than it was: the cost of the climb is spent but not counted.

**The qualifying rule** is Garmin's published one: a run of at least 10 minutes at 70% of maximum heart rate or above, compared over 20 to 30 second steady segments.
Here that is `SEGMENT_SECONDS` 30, the top of that range and a divisor of the grid; `QUALIFYING_HR_FRACTION` 0.70; `MIN_QUALIFYING_SEGMENTS` 20, which is ten minutes.
A segment must also be steady, within-segment speed standard deviation under `STEADY_SPEED_SD_MPS` 0.30 m/s, because during an acceleration heart rate is still catching up to a speed already reached and the pair says nothing about capacity; and it must be running, above `MIN_RUNNING_SPEED_MPS` 1.5 m/s, because the equation is for running.
Sensor channels are null across pauses and outages on the grid, so a segment containing either fails the gate by itself.
Treadmill and not-known-outdoors activities are excluded from the heart-rate estimate for the same reason they are excluded from VDOT: the speed the oxygen cost is computed from comes from an uncalibrated footpod, which is also why `efficiency.md` excludes indoor runs.
The 70% floor is not arbitrary: below roughly that intensity the heart rate to oxygen relation bends away from linear and the map in the next section stops holding.

**The two bounds on $f^{\text{seg}}$**, `_MIN_VO2_FRACTION` 0.35 and the hard 1.0, are guards on the division rather than part of the physiology, and neither is reached on the real store.
Measured across the 13685 qualifying 30 second segments the estimator uses, 0 segments in 0 activities exceed the upper bound and 0 segments in 0 activities fall below the lower one, and the largest fraction any segment reaches is 0.9143.
The upper bound would first bind at 101.00% of the configured maximum, which is 209.1 bpm against the 207 in force, so it takes a heart rate above the configured maximum to reach it, which is exactly the miscalibrated-maximum case it exists for.
Clipping there caps the fraction at one, so such a segment reports the raw oxygen cost rather than an estimate below it, which is the conservative answer given that the maximum is a device setting rather than a measurement, as "Why the level is a model output" below says of the 207.
The lower bound is defence the gate already makes unreachable: `QUALIFYING_HR_FRACTION` 0.70 puts every qualifying segment at $f^{\text{seg}} \ge 0.5156$, well above 0.35, so it exists only so that a future change to the gate cannot divide by something near zero.
Both are therefore guards against a state the current store does not contain rather than corrections that shape the reported numbers.

**The heart rate to oxygen map** is the regression published by Swain, Abernathy, Smith, Lee and Bunn in 1994, *Target heart rates for the development of cardiorespiratory fitness*, Medicine and Science in Sports and Exercise 26(1):112-116, over 81 men and 81 women aged 18 to 34 on incremental tests to exhaustion:

$$
\%\mathrm{HRmax} = 0.64\,\%\mathrm{VO}_2\text{max} + 37 .
$$

Their reported anchors are 63, 76, 89 and 92 %HRmax at 40, 60, 80 and 85 %VO2max.

### The inversion, stated as a weakness

The map above predicts heart rate from oxygen.
This method needs the reverse, and solving the equation algebraically gives

$$
\%\mathrm{VO}_2\text{max} = 1.5625\,\%\mathrm{HRmax} - 57.81 ,
$$

which is what `_SWAIN_SLOPE` and `_SWAIN_INTERCEPT` hold.

**Inverting a least-squares regression is not the same as fitting one in the other direction.**
A regression of $y$ on $x$ minimises error in $y$; its slope is $b_{yx} = r\,s_y / s_x$.
The regression of $x$ on $y$ has slope $b_{xy} = r\,s_x / s_y$, while the algebraic inverse has slope $1 / b_{yx} = s_x / (r\,s_y)$.
Their ratio is $b_{xy} / (1/b_{yx}) = r^2$: the inverted slope is too steep by a factor of $1/r^2$, and the effect grows as the scatter grows.
This is regression dilution, and it is pointedly the class of methodological error Swain's paper was written to criticise in the earlier target-heart-rate tables.
Using the inverted line without saying so would be the hidden assumption this directory exists to prevent.

**Quantifying it.**
Swain's correlation coefficient is not in the published abstract and the full text was not accessible when this was written, so $r^2$ cannot be applied directly.
A properly directed regression does exist: Londeree, Thomas, Ziogas, Smith and Zhang, *%VO2max versus %HRmax regressions for six modes of exercise*, Medicine and Science in Sports and Exercise, 1995, reported in secondary sources as

$$
\%\mathrm{VO}_2\text{max} = 1.408\,\%\mathrm{HRmax} - 45.1
$$

for cycle ergometry.
Its slope is 1.408 against the inverted 1.5625, which if the two samples were comparable implies $r^2 \approx 0.90$, consistent with the correlations of about 0.95 the literature reports for this relation.
Over the range the gate admits, the two lines differ by at most two percentage points of VO2max:

| %HRmax | inverted Swain | Londeree | ACSM 1991 anchor |
| --- | --- | --- | --- |
| 70 | 51.6 | 53.5 | 60 |
| 76 | 60.9 | 61.9 | |
| 80 | 67.2 | 67.5 | |
| 90 | 82.8 | 81.6 | 85 |
| 95 | 90.6 | 88.7 | |

Swapping the Londeree line into the estimator and rerunning it over the real store moves the median estimate up 0.5% and the maximum down 1.4%; the per-activity ratio between the two ranges from 0.968 to 1.019, with a median of 1.005.
So the inversion bias is under 2% of the estimate for a typical run and under 3.5% at the extremes, which is small beside the disagreement with VDOT discussed below.
The Swain inversion is kept because it is the relation Garmin's family is documented against and because the alternative was fitted on a bicycle; sourcing the running-mode coefficients from the Londeree paper itself has not been done, and would replace the inversion outright.

The ACSM anchors in the last column are the older tabled relation Swain corrected, and at 70% HRmax they sit eight points above either line, which is the size of error his paper set out to remove.

### Segment count

`qualifying_segments` is stored beside the estimate so a consumer can tell an estimate from ten minutes of data from one from an hour.
On the real store the run behind the highest estimate qualified on 39 segments, about twenty minutes.
A count below 20 is a run that did not qualify, and its estimate is null.

## The reported number is smoothed, and only the trend is claimed

A per-activity estimate is not a fitness estimate.
Measured on the real store over 165 qualifying runs, consecutive heart-rate estimates differ by a median of 8.8% of the median estimate and by 29% of it at the 95th percentile.
Fitness does not move 9% between Tuesday and Thursday; the model's inputs do.
Every figure in the table is a percentage of that same median estimate:

| smoothing | median step | 95th pct step | range over history, max minus min |
| --- | --- | --- | --- |
| none, raw per activity | 8.8% | 29.3% | 58.1% |
| rolling mean, last 6 activities | 1.4% | 5.4% | 36.1% |
| EWMA, span 10 activities | 1.2% | 4.4% | 32.1% |
| **rolling mean, trailing 42 days** | **0.7%** | **3.5%** | **27.3%** |
| rolling max, trailing 42 days | 0.0% | 13.5% | 51.1% |

The table is computed over the qualifying activities alone, so the rows are comparable.
The stored column also carries a value on an activity that did not qualify itself but falls inside a window with others that did, and over every stored row it steps 0.6% at the median and 3.2% at the 95th percentile.

**Decision.** `hr_vo2max_smoothed` and `vdot_smoothed` are trailing 42-day means of the raw columns, computed by `smooth_series`, with the raw values kept in the table so a chart can draw them faintly beneath and the smoothing never hides its own inputs.

A calendar window is chosen over an activity-count window deliberately.
A two-week break should appear as a gap rather than be invisibly bridged by whatever six activities came last, however long ago; `test_a_break_in_training_leaves_the_window_rather_than_being_bridged` constructs that case.
42 days matches the window the consistency metrics already use.
The rolling maximum was rejected on measurement: it steps by 13.5% at the 95th percentile and by up to 32.6% when a peak ages out of the window, which is the single-activity sensitivity the smoothing exists to avoid, and it reports the history's noisiest point as its level.
A run that did not qualify contributes nothing to the windows it falls in, not a zero.
`smooth_series` raises on unsorted input rather than sorting it, because every window here is trailing and a series in the wrong order would average over the future.

## Why the level is a model output

The two series disagree, and the disagreement is informative.

Over the 190 activities where both smoothed values exist, the heart-rate series sits at a median **1.62 times** VDOT, with a standard deviation of 0.08 in that ratio, and the two correlate at $r = 0.47$.
By year, as the change in each series' median from the year before:

| change in the yearly median | 2025 | 2026 |
| --- | --- | --- |
| heart rate based | +11.4% | +3.5% |
| performance based, VDOT | +2.9% | -1.8% |

Heart rate at a given pace kept improving while best performances plateaued.
Both statements are true and they are about different things, which is the argument for showing both series on one chart.
The VDOT medians are low because most activities' best efforts were not raced; the athlete's actual best performances sit a quarter to a third above them.

**The heart-rate series has an implausible upper tail.**
23 of 165 qualifying runs estimate more than 14% above the median estimate, 8 more than 24% above it, and the highest reads **39% above it**.
That run was steadily paced at a mean heart rate of 75% of the configured maximum of 207.
Nothing about it is anomalous; the model inflates when a modest oxygen cost is divided by a small fraction, and that heart rate at that pace is the athlete having a very good day.
The sanity check is the athlete's own performances: an estimate at the top of that tail corresponds to a 5 km 23% to 27% shorter than the athlete's actual best.
Note that this same activity contains that fastest clean 5 km, so the estimate is correctly **ranked** even where its level is not defensible.

The absolute level also scales directly with the configured maximum heart rate.
207 is a device setting that has stood unchanged since the first profile interval to carry it, not a measurement, and the `athlete_profile` table is versioned so a change to it moves only the runs after it.
A true maximum five beats lower would lift every estimate by about 4%.

**Decision.** Report the raw model output.
State on the chart that the level is model-dependent and that only the trend is defensible.
Do not calibrate the series onto the VDOT scale: the offset is stable, but a correction derived from our own two models with no external reference would invent precision, and it would stop the number matching what the athlete's watch reports.
The ordinary-run race prediction in `predictions.md` does use a calibration, and the difference is that one is a regression of predicted performance on observed performance with a stated residual, not an adjustment of a headline number.
"Against Garmin's own" below tests this decision against an external reference and keeps it.

## Against Garmin's own

The Garmin Connect export that arrived on 2026-10-05 carries Garmin's running VO2max in `DI_CONNECT/DI-Connect-Metrics/MetricsMaxMetData_*.json`: one row per day the value was updated, 241 `RUNNING` rows over three years, all from one device.
`vo2MaxValue` is a whole number, and `maxMet` times 3.5 rounds to it on all 241 rows, so the comparison uses that unrounded value.
Each row of `fitness_series` is paired with the last Garmin value dated on or before the activity's local date.
249 of its 250 rows have one; the other is a run from before Garmin's first day, and 242 of the 249 find a value from the same day.
`ingest` stores these rows in `data/canonical/device_vo2max.parquet`, one per day, which collapses the 10 repeat updates and leaves 231 days, and the Trends page draws them as the VO2max chart's third line.

Garmin's number is a model too.
Firstbeat estimates from heart rate and running speed, the family the heart-rate estimate here belongs to, so agreement between the two says two models of one family agree, not that either level is right.
What the comparison can do is say which of the two estimates sits nearer the number the athlete's watch reports, and whether the gap to it is a constant a calibration could remove.

### Which estimate is closer

| estimate | runs | mean against Garmin | SD | r |
| --- | --- | --- | --- | --- |
| heart rate, smoothed | 190 | +8.0% | 4.4% | 0.70 |
| heart rate, raw | 165 | +8.7% | 11.7% | 0.30 |
| VDOT, smoothed | 249 | -33.4% | 4.0% | -0.10 |
| VDOT, raw | 243 | -33.4% | 8.0% | -0.08 |

The heart-rate estimate sits 8% above Garmin's and moves with it; VDOT sits a third below and does not correlate with it over the whole history.
The VDOT result follows from "VDOT, the performance-based estimate": a per-activity VDOT is the VDOT of whatever was run that day, and most days were not raced.
Garmin's value steps by a median of 0.15% from one update to the next and by 0.99% at the 95th percentile, against 8.9% at the median for the raw heart-rate estimate, so it behaves as a smoothed series and smoothed against smoothed is the comparison to read.
The raw heart-rate correlation of 0.30 is the per-run noise "The reported number is smoothed" measures.

### The gap swings, and the cause is open

By year the smoothed heart-rate estimate sits 0.3% below Garmin in 2024, 9.2% above it in 2025 and 7.7% above it in 2026.
The 2024 figure rests on 9 runs, because the heart-rate estimate needs a known maximum heart rate and the first `athlete_profile` interval carrying one starts in late November 2024, so the first estimate is in the first week of December.
A year table therefore shows a jump from 0 to 9% that is one quarter of December runs.
By quarter, as the mean over the paired runs of the heart-rate estimate against Garmin's:

| quarter | runs | gap |
| --- | --- | --- |
| 2024 Q4 | 9 | -0.3% |
| 2025 Q1 | 8 | +1.4% |
| 2025 Q2 | 25 | +9.0% |
| 2025 Q3 | 33 | +9.9% |
| 2025 Q4 | 25 | +10.9% |
| 2026 Q1 | 14 | +3.3% |
| 2026 Q2 | 34 | +10.2% |
| 2026 Q3 | 40 | +7.2% |
| 2026 Q4 | 2 | +7.3% |

From 2025 on, a straight line through the gap moves under half a percentage point per year, so it does not drift.
It swings instead: under 3.5% in three low quarters, 2024 Q4, 2025 Q1 and 2026 Q1, and 7.2% to 10.9% in the others.
The swing is in this project's series.
At each edge of a low quarter, 2025 Q1 to Q2, 2025 Q4 to 2026 Q1 and 2026 Q1 to Q2, the heart-rate estimate's quarterly mean moves +8.1%, -6.7% and +7.4% while Garmin's moves +0.5%, +0.1% and +0.7%.

The low quarters are not shown to be a season.
Two of them are the start of the series: the 9 runs of 2024 Q4 all fall in December, and the 42-day mean is not filled with heart-rate estimates until six weeks after the first.
2025 Q4 covers the same October to December months a year later and has the largest gap in the table.
That leaves 2026 Q1 as the one low quarter clear of the start, so a seasonal reading rests on a single winter.

The candidates are the start of the series, where the 42-day mean averages few runs from the first months of heart-rate estimates; slower running at a given heart rate on snow, on ice and in winter clothing, which lowers the oxygen cost the estimate divides; fewer qualifying runs, 8 and 14 against 25 to 40 in the other full quarters, so the 42-day mean rests on fewer points; and Garmin's own smoothing, whose window Garmin does not publish.
None of the four has been measured here.
A monthly breakdown separates 2025 Q4's December from its October and November.
The quarter's large gap is October and November, +14.7% over 11 runs and +15.1% over 3, while its December falls to +5.9% over 11.
From March 2025 on, clear of the start, the 18 runs from December to February sit 3.8% above Garmin, SD 4.2%, against 9.1%, SD 3.7%, for the other 160.
So the dip is in December to February of the one winter clear of the start; the first winter's months, -0.3%, +3.1% and +4.7%, fit it but cannot be told apart from the start.
March and April 2025 read low as well, 0.0% and +5.4%, which no winter explains, and the gap first reaches its overall mean of 8% in May 2025.

### What it settles

- **The configured maximum heart rate is not the cause of the gap.**
  Garmin's `heartRateZones.json` in the same export uses a running maximum of 207, the value this project reads from the device, so a wrong maximum would move both numbers together.
  It can still be wrong for both against a true value.
- **The Swain inversion cannot produce it alone.**
  "The inversion, stated as a weakness" measures its bias at under 2% for a typical run, against a gap of 8%.
- **What remains is the oxygen-cost model and whatever Garmin's method does that this one does not**, and Firstbeat does not publish its method in enough detail to separate the two.
- **The trend has an external check.**
  Both series rise: from 2025 to 2026 the yearly medians move +5.9% for Garmin and +3.3% here, and over the whole paired history the smoothed series correlate at r = 0.70.
  The direction agrees, which is what "the shape is the signal" claims; the size of each quarter's move does not.

**Decision.** Still report the raw model output, with no calibration onto Garmin's scale.
A constant correction of 8% would be off by 4.7 to 8.3 percentage points in each of those low quarters, and modelling the swing would need the cause above, which nobody has measured.

## Deliberately not modelled

- Grade. The ACSM vertical term is omitted, and grade-adjusted pace is shelved for the measurement in [README.md](README.md#9-adjust-speed-for-gradient).
- Cardiac drift within a run. The segment median absorbs some of it; `efficiency.md` measures it as its own metric.
- Temperature, altitude, fatigue and the day's hydration, all of which move heart rate at a given pace and none of which the export records.
- The athlete's true maximum heart rate. The configured value is used as configured.

## A note on the exploratory figures

The design of this module was argued from 150 qualifying runs, a median, a maximum and a heart-rate-to-VDOT offset, all from an exploratory script written before this module existed.
The figures above are what the implemented estimator produces and supersede them.
Over the store the exploratory script read, the qualifying count agrees once treadmill runs are excluded from the heart-rate estimate, and it is insensitive to the gate's details here, sitting between 145 and 150 for steadiness thresholds from 0.10 to 0.30 m/s and dropping to 127 only when twenty minutes of qualifying data are required instead of ten.
On that store the median and the maximum still differ, the exploratory ones 2.1% and 2.9% below the implemented estimator's, and the exploratory script's gate was not recorded, so that difference cannot be attributed.
Every conclusion drawn from the exploratory figures holds on these.

## Reproducing the numbers

```bash
uv run activity-analysis recompute
uv run python - <<'PY'
from pathlib import Path
import pandas as pd
from activity_analysis.config import Paths
from activity_analysis.store.writer import read_fitness_series
f = read_fitness_series(Paths(Path("."))).sort_values("start_time_utc")
raw = f["hr_vo2max"].dropna()
print(len(f), raw.size, f["vdot"].notna().sum())
print(raw.median(), raw.max(), raw.diff().abs().median(), raw.diff().abs().quantile(0.95))
print(f["hr_vo2max_smoothed"].diff().abs().median())
f["year"] = pd.to_datetime(f["start_time_utc"]).dt.year
print(f.groupby("year")[["hr_vo2max", "vdot"]].median().round(1))
PY
```

The two bounds on $f^{\text{seg}}$ are counted over the segments themselves, which reaches into the private `_qualifying_segments` deliberately, because the public `hr_vo2max` returns only the median of the estimates it derives from them:

```bash
uv run python - <<'PY'
from pathlib import Path
import numpy as np
import pandas as pd
from activity_analysis.analysis.fitness import _SWAIN_INTERCEPT, _SWAIN_SLOPE, _qualifying_segments
from activity_analysis.analysis.profile import profile_at
from activity_analysis.config import Paths
from activity_analysis.store.writer import (
    read_activities,
    read_athlete_profile,
    read_derived_stream,
    read_fitness_series,
)
paths = Paths(Path("."))
profile = read_athlete_profile(paths)
activities = read_activities(paths).set_index("activity_id")
fractions = []
for activity_id in read_fitness_series(paths).dropna(subset=["hr_vo2max"])["activity_id"]:
    activity = activities.loc[activity_id]
    settings = profile_at(
        profile, str(activity["athlete_id"]), pd.Timestamp(activity["start_time_utc"])
    )
    max_hr = float(settings["max_hr_bpm"])
    grid = read_derived_stream(paths, str(activity_id))
    _, mean_hr = _qualifying_segments(
        grid["speed_mps"].to_numpy(dtype=float), grid["hr_bpm"].to_numpy(dtype=float), max_hr
    )
    fractions.append((_SWAIN_SLOPE * (mean_hr / max_hr * 100.0) - _SWAIN_INTERCEPT) / 100.0)
f = np.concatenate(fractions)
print(f.size, int((f > 1.0).sum()), int((f < 0.35).sum()), f.max())
PY
```

"Against Garmin's own" reads `device_vo2max`, which holds the archive's 241 running rows as 231 days; it prints the counts, the four rows of the closeness table, the year and quarter tables, the 2025-on slope, the yearly medians, the gap by month and the December to February split, each gap as a percentage of Garmin's value on the same run:

```bash
uv run python - <<'PY'
from pathlib import Path
import numpy as np
import pandas as pd
from activity_analysis.config import Paths
from activity_analysis.store.writer import read_activities, read_device_vo2max, read_fitness_series
paths = Paths(Path("."))
g = read_device_vo2max(paths)
print(len(g), g["calendar_date"].min(), g["calendar_date"].max(), g["device_id"].nunique())
print((g["vo2max"].round() == g["vo2max_reported"]).all())
g = g.rename(columns={"vo2max": "garmin"})
g["date"] = pd.to_datetime(g["calendar_date"]).astype("datetime64[us]")
steps = g["garmin"].diff().abs() / g["garmin"].shift() * 100
print(round(steps.median(), 2), round(steps.quantile(0.95), 2))
f = read_fitness_series(paths)
offset = f["activity_id"].map(read_activities(paths).set_index("activity_id")["utc_offset_s"])
start = pd.to_datetime(f["start_time_utc"], utc=True).dt.tz_localize(None)
f["date"] = (start + pd.to_timedelta(offset.fillna(0), unit="s")).dt.normalize()
j = pd.merge_asof(f.sort_values("date"), g[["date", "garmin"]], on="date").dropna(subset=["garmin"])
print(len(j), j["date"].isin(g["date"]).sum())
for col in ["hr_vo2max_smoothed", "hr_vo2max", "vdot_smoothed", "vdot"]:
    k = j.dropna(subset=[col])
    d = 100 * (k[col] / k["garmin"] - 1)
    print(col, len(k), round(d.mean(), 1), round(d.std(), 1), round(k[col].corr(k["garmin"]), 2))
k = j.dropna(subset=["hr_vo2max_smoothed"]).assign(year=lambda x: x["date"].dt.year)
k["gap"] = 100 * (k["hr_vo2max_smoothed"] / k["garmin"] - 1)
print(k.groupby("year")["gap"].agg(["count", "mean"]).round(1))
k["quarter"] = k["date"].dt.to_period("Q")
by_quarter = k.groupby("quarter")[["garmin", "hr_vo2max_smoothed"]].mean().pct_change() * 100
print(k.groupby("quarter")["gap"].agg(["count", "mean"]).join(by_quarter).round(1))
late = k[k["date"] >= "2025-01-01"]
print(round(np.polyfit((late["date"] - late["date"].min()).dt.days / 365.25, late["gap"], 1)[0], 2))
print((k.groupby("year")[["garmin", "hr_vo2max_smoothed"]].median().pct_change() * 100).round(1))
k["month"] = k["date"].dt.to_period("M")
print(k.groupby("month")["gap"].agg(["count", "mean"]).round(1))
clear = k[k["date"] >= "2025-03-01"]
print(clear.groupby(clear["date"].dt.month.isin([12, 1, 2]))["gap"].agg(["count", "mean", "std"]).round(1))
PY
```
