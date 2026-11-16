# Race prediction

Module: `src/activity_analysis/analysis/fitness.py`, functions `_prediction_vdots`, `predict_from_ordinary_run`, `race_predictions` and `time_for_vdot`.
Table: the `best_efforts_vdot` and `ordinary_runs_vdot` columns of `data/derived/fitness_series.parquet`.
Served by `GET /api/predictions`, `GET /api/predictions/history` and each plan version's `expected_prediction`.

Two prediction series, both in VDOT, both shown together.
The best-efforts series reads the athlete's best recent runs and is the prediction.
The ordinary-runs series reads the smoothed heart-rate VO2max from `vo2max.md`, needs no maximal effort, carries its own band, and reads what typical training supports.
The gap between the two is information, so neither is folded into the other and no picker hides one.

Each is a daily value averaged over the 42 days up to the day, stored on every run's row as the value on that run's local day.
A time at any distance is `time_for_vdot` of the VDOT, evaluated on read; times are never stored.
The predictions table, the history charts and the Plan view's header read the same column, so a chart line ends at the time printed beside it.

Two models from one effort, Riegel and Cameron, were removed on 2026-11-16, and a critical-speed fit on 2026-10-06; [the sections below](#why-there-is-no-riegel-or-cameron-model) record why.

## The best-efforts series

1. **A run's VDOT** is the highest Daniels VDOT over its eligible efforts at `VDOT_DISTANCES_M` of at least `MIN_PREDICTION_DISTANCE_M` (1000 m).
2. **Each day's raw value** is the mean of the `PREDICTION_TOP_RUNS` (3) highest run VDOTs in the `PREDICTION_WINDOW_DAYS` (90) ending that day, or of all of them when there are fewer than three.
   A day with no such run in its 90 days has no raw value.
3. **The smoothed value** is the trailing mean of the raw values over the `SMOOTHING_WINDOW_DAYS` (42) ending that day, over the days that have one.
   It is `best_efforts_vdot`.

Days are local calendar days, `start_time_utc + utc_offset_s` with a null offset read as 0, as `queries.LOCAL_DATE_SQL` has them.

The mean is over distinct runs, so one run cannot fill it with its own 5 km and 10 km.
A single run's best effort is too noisy to carry a prediction: "What the measurement showed" below has the best run in 90 days 1.49 VDOT units above the best run of the following four weeks on average, against 0.35 for the mean of three.

### Which efforts enter

Eligible is the records rule: `is_indoor` explicitly false and `distance_trusted` explicitly true, which since `ANALYSIS_VERSION` 10 admits a jump the measured speed confirms within 1%.

Efforts under 1 km are neither a source nor a target.
The Daniels percentage curve exceeds 1.0 below about two minutes and his tables start at 1500 m, and a 400 m window is short enough that one bad second dominates it, which is why the five fastest 400 m efforts on the real store all carry `contains_jump`.

**Only efforts at `VDOT_DISTANCES_M` count**, the original nine of `analysis/best_efforts.py`'s twenty-two, from phase 1.
The prediction's candidate set is a modelling choice and the records ladder's is a display one, so the two are separate constants.
A run's VDOT is a maximum over its efforts, and an activity that scored highest at 3 km would score higher at a new 2 km or 4 km rung, so adding a rung to the ladder would otherwise move every predicted time.
`vo2max.md` argues the split.

## The ordinary-runs series

1. **Each day's raw value** is the calibrated VDOT of the latest `hr_vo2max_smoothed` in the 90 days ending that day: `ORDINARY_RUN_CALIBRATION_SLOPE * x + ORDINARY_RUN_CALIBRATION_INTERCEPT`.
2. **The smoothed value** is the trailing 42-day mean of the raw values, as above.
   It is `ordinary_runs_vdot`.

`hr_vo2max_smoothed` is itself a trailing 42-day mean, so this series is smoothed twice, which "The lag" below measures.
[The prediction from ordinary runs](#the-prediction-from-ordinary-runs) derives the calibration and its band.

## Per day, then stored per run

Both series are computed over every calendar day from the first run's day to the newest's, in memory during `recompute`, and each run's row stores the values on its own day.
A chart draws one point per run, as the VO2max chart does, and the newest row is what `/api/predictions` serves.

Averaging per day weighs each day once: a day without a run still holds the raw value its 90 days give, and three runs in one week do not count that week's raw value three times.
`test_smoothing_is_over_days_not_runs` constructs the case.

Averaging the raw values per run instead was measured on the real store on 2026-11-16 and rejected.
It is as accurate, scored on the 262 run days that have a run in the four weeks after them: a mean absolute error of 2.73 VDOT units against 2.77 for the series per day.
It steps on the run, though: with few runs in the window each one moves the mean, by up to 2.0 VDOT units, about 4% of a 5 km time, between consecutive runs 50 days apart, and by up to 1.76 between runs 14 days apart.
The series per day moves by at most 0.17 VDOT units on any day, so a step between two runs grows with the days between them; between consecutive runs at most 42 days apart its largest is 1.67, across 20 days.

## From a VDOT to a time

`time_for_vdot(distance_m, vdot)` inverts the Daniels relation at a fixed distance by bisection, as `vo2max.md` derives.
It is the only conversion from VDOT to a time anywhere, the same one the plan's `expected_vdot` goes through, so a plan's expected line and its measured line differ only by the athlete's fitness.

Times are not stored because a plan's goal can be any distance of at least 1 km, and a stored time per standard distance could not serve it.
The inversion holds no input of its own, so it cannot disagree with the stored layer.

`/api/predictions` inverts the newest row's two values at each of the `VDOT_DISTANCES_M` from 1 km up.
The newest row's day is the newest run's, so the 90 days end at the most recent run in the store, not today: the answer is a function of the store alone, and an athlete who stopped running still sees the prediction their last block of training supports.
90 days is the window the long-run tag already calls recent; the 42-day smoothing window would leave the 15 km and half marathon almost never inside it on the real history, where those two have 20 and 5 eligible efforts across three years.

## What the measurement showed

Measured on the real store on 2026-11-16 over 1139 days, scoring each rule's daily value against the highest run VDOT in the 28 days after it, in VDOT units.
A day without a run in those 28 days is not scored, and the ordinary-run rows score only the 710 of those days that have a heart-rate estimate in their 90 days.
The two smoothed rows are the stored columns: the script rebuilds them per day and checks every run's value against `fitness_series` before scoring.

| rule | days moving more than 1 VDOT | largest daily move | mean absolute error | bias |
| --- | --- | --- | --- | --- |
| best run in 90 days, the removed models' anchor | 18 | 4.04 | 2.83 | +1.49 |
| mean of three best runs in 90 days | 24 | 2.11 | 2.65 | +0.35 |
| the same, then 42-day mean, `best_efforts_vdot` | 0 | 0.17 | 2.88 | +0.14 |
| ordinary runs, unsmoothed | 10 | 3.27 | 2.63 | -0.08 |
| ordinary runs, then 42-day mean, `ordinary_runs_vdot` | 0 | 0.15 | 2.76 | -0.24 |

One VDOT unit is 2.1% of a 5 km time at VDOT 40, 1.9% at 45 and 1.7% at 50.

The single best run reads the best day of the window and so runs fast, 1.49 units above what the next four weeks show.
The mean of three takes most of that bias out and halves the largest daily move, but still moves more than a unit on 24 days, each a day a run entered or left the window.
The 42-day mean removes every such day for 0.23 units of mean absolute error, and that cost is the lag.

## The lag

The smoothing trails the athlete, and it trails a rise and a fall differently, because the raw value is a mean of the best runs in 90 days.
Measured by `_prediction_vdots` on synthetic histories with a run every second day, and pinned for the held steps by `test_a_held_rise_is_in_full_45_days_after_it` and `test_a_held_fall_waits_for_the_best_runs_to_leave_the_window`:

| change in the athlete's run VDOT | best-efforts series | ordinary-runs series |
| --- | --- | --- |
| held step up | half after 22 days, all after 45 | half after 40 days, all after 81 |
| steady rise | 23 days late | 41 days late |
| held step down | starts after 84 days, all after 129 | as a step up |
| steady fall | 107 days late | as a steady rise |
| one breakthrough run among unchanged ones | one third of its step, reached after 41 days, gone after 131 | |

In the ordinary-runs column the change is in the per-run heart-rate estimate.
It treats a rise and a fall alike, because its raw value is the latest estimate rather than a best of several.

**A rise.** The third run at a new level lifts the raw value to it, on day 4 here, and the 42-day mean holds only such days from day 45.
A steady rise shows about three weeks late: two days for the mean of the three newest runs, half a day for the days between runs, and 20.5 days for the mean over 42 days.
With a run every day it trails by 21.5 days and with one every third day by 24.5.

**A fall.** The three best runs in 90 days are the old ones until the first of them leaves the window, so a drop shows nothing for 84 days and is in full only after 129.
In a steady decline the three best runs are the oldest in the window, and the series trails by 107 days.
So the best-efforts series says what the athlete has shown they can run within the last three months, not what they can run today after a lay-off.

**One breakthrough run** among unchanged ones enters as one third of its step, the mean of three, reaches that after 41 days and is gone after 131.
The raw value reaches a new level only with three runs at it.

A plan's `expected_vdot` forecasts this series, so it keeps rising through a taper while the efforts of the block before it are still entering the mean.

## Why there is no Riegel or Cameron model

### The models

Peter Riegel's 1981 relation, from a fit to record performances across many events, scales a time by a power of the distance:

$$
T_2 = T_1 \left( \frac{D_2}{D_1} \right)^{1.06} .
$$

Dave Cameron's 1998 model, fitted to observed times from 400 m to the marathon, scales pace by the ratio of a fatigue factor at each distance:

$$
f(d) = 13.49681 - 0.048865\,d + \frac{2.438936}{d^{0.7905}}, \qquad
\text{pace}_2 = \text{pace}_1 \cdot \frac{f(d_1)}{f(d_2)} ,
$$

with $d$ in miles, the unit the coefficients were fitted in.

Both were anchored on the eligible effort with the highest VDOT in the 90 days, and reported together as a range.

### What they agreed on

From a synthetic 5 km in 25:00, in minutes, against the time at which the target carries the same VDOT, `time_for_vdot`:

| target | Riegel | Cameron | equal VDOT |
| --- | --- | --- | --- |
| 10 km | 52.1 | 52.1 | 51.9 |
| half marathon | 115.0 | 114.8 | 115.1 |
| marathon | 239.8 | 244.0 | 237.9 |

Three independent fits to observed performance agree to within a minute below the marathon.

### Why they were removed

- **They extrapolate from an effort, and the series is a VDOT.** Each needs a time at a distance to start from, so they would read the series through `time_for_vdot` at some anchor distance first, and their answer would depend on which distance was picked.
- **Their anchor was one effort.** The best run in 90 days is the first row of the table above: 1.49 VDOT units fast against the following four weeks, moving by up to 4.04 units in a day.
- **Their range measured the models.** Its width was how far two extrapolations disagree, narrow from 3 km to the half marathon and wider at either end, not any uncertainty about the athlete, which neither model can see.
- **One conversion everywhere.** The plan's `expected_vdot` was already a VDOT turned into a time by `time_for_vdot`, so the plan's expected line and the measured one could only be compared through the same conversion.

On the store as of 2026-11-16 the switch moved the headline little: the newest `best_efforts_vdot` is 0.7% below the old anchor's VDOT, and its predicted time is 1.1% slower than Riegel's from that anchor at 5 km, 0.6% at 10 km and 1.1% at the half marathon.

## Why there is no critical speed model

### The model

The hyperbolic relation between speed and time to exhaustion, in its distance form:

$$
D = CS \cdot t + D' .
$$

$CS$, the critical speed, is the asymptote: roughly the highest speed that can be sustained aerobically.
$D'$ is the finite distance available above it, the anaerobic reserve, typically one to three hundred metres for a runner.
It was fitted by ordinary least squares in $(t, D)$ over the per-distance bests in the 90-day window, and a prediction was $t = (D - D') / CS$.

### What it did on efforts that were not races

The model assumes every point is a maximal effort at its duration.
The window's bests are not.
On the store as of 2026-10-06 the window held a best at six distances, here by their VDOT against the highest of them, the 10 km's:

| distance | VDOT against the 10 km |
| --- | --- |
| 1 km | -0.2% |
| 1 mile | -7.8% |
| 3 km | -2.4% |
| 5 km | -0.7% |
| 10 km | 0 |
| 15 km | -22.7% |

The 15 km is a window inside an easy long run, and in a least-squares fit over $t$ the longest point has the most leverage.
With $CS$ and $D'$ against the fit without the 15 km, and each predicted time against the window's own best at that distance:

| fitted over | $CS$ | $D'$ | 1 km | 5 km | 10 km |
| --- | --- | --- | --- | --- | --- |
| all six bests | 0.79 | 5.3 | 0.22 | 1.10 | 1.18 |
| without the 15 km | 1 | 1 | 1.02 | 1.01 | 1.00 |

With the easy 15 km in, the slope is the long run's pace and the intercept is three times a runner's reserve, so the model predicted a 10 km 18% slower than the one the window holds, a kilometre in under a quarter of the window's own best time, and a half marathon 23% slower than the clean fit's.
On the store as of 2026-09-05 the same fit gave a $CS$ within 2% of this one and a $D'$ four times the 2026-10-06 clean fit's, so this was the model's standing behaviour on this history, not one bad window.

### Why it was removed rather than repaired

Without the 15 km the fit is sensible, but keeping it out takes a rule: a duration cap, or a minimum VDOT relative to the best.
Either is a constant chosen to make the model behave on these inputs rather than measured from anything.
A clean fit would still err at the long end, because $CS$ cannot be held for the hours a half marathon or a marathon takes.
And what it contributed was the width of the Riegel and Cameron range: it set whichever end was further out, so the range it produced measured the model's misfit rather than any uncertainty about the athlete.

## The prediction from ordinary runs

### Why the raw estimate cannot be inverted

The heart-rate VO2max from `vo2max.md` is a fitness estimate on days the athlete did not race, and inverting the Daniels relation at it gives a time.
Applied raw that time is wrong by a wide margin: over the 188 points the calibration below is fitted on, raw inversion predicts a median 5 km in 26.1% less time than the fastest eligible 5 km in the 42 days up to the run.
The estimate's level is a model output, as its document says, and the inversion inherits every unit of its offset.

### The calibration

It does track performance well enough to calibrate.
The fit is one least-squares regression over the `fitness_series` this module writes, so on the shipped `hr_vo2max`.
A run is a point when it has an `hr_vo2max_smoothed` and at least two eligible 5 km efforts in the 42 days up to and including it; its $x$ is that smoothed estimate and its $y$ is the VDOT of the fastest of those 5 km efforts.
Measured on 2026-11-14 over 188 points:

$$
\mathrm{VDOT} = 0.586 \cdot \mathrm{VO}_2^{\text{hr}} + 5.92, \qquad r = 0.597, \qquad \text{residual SD } 2.30 \text{ VDOT units},
$$

held in `ORDINARY_RUN_CALIBRATION_SLOPE`, `ORDINARY_RUN_CALIBRATION_INTERCEPT` and `ORDINARY_RUN_RESIDUAL_VDOT`.
The residual SD is taken with two degrees of freedom removed, one for each fitted coefficient.
These constants replaced a fit made during design, before this module existed, on an exploratory estimator; "Why it runs slow after a breakthrough effort" below measures what the replacement changed.

`_prediction_vdots` applies the calibration to each day's raw value, and `predict_from_ordinary_run` inverts the smoothed result, and the result plus and minus one residual standard deviation for the band.
The band is computed by inverting at $\mathrm{VDOT} \pm 2.30$ rather than by adding seconds, because time is a nonlinear function of VDOT and a symmetric band in one is asymmetric in the other; `test_the_band_brackets_the_prediction_and_is_not_symmetric_in_time` checks that.
A higher VDOT is a lower time, so `low_s` comes from the upper VDOT.

The response model refuses an `ordinary_runs` model without `low_s` and `high_s`, because **the band is wide**: for a synthetic 5 km in 25:00, from 1.20 minutes faster to 1.34 minutes slower, roughly 5%.

The slope of 0.586 is not a scale factor between the two series, and should not be read as the heart-rate estimate moving faster than performance.
A least-squares slope is $r \cdot \sigma_{\mathrm{VDOT}} / \sigma_{\mathrm{VO}_2^{\text{hr}}}$, and over the 188 points the ratio of standard deviations is 0.98, so a slope well below 1 is almost entirely the correlation, the scatter between the two, rather than a difference in how far each moves.

### Re-measured against the smoothed series

The calibration was fitted on the once-smoothed estimate, and the series applies it to each day's value and then averages over 42 days.
Re-measured on 2026-11-16 with the same selection over 203 points:

| $x$ | slope | intercept | $r$ | residual SD |
| --- | --- | --- | --- | --- |
| `hr_vo2max_smoothed` on the run, the fitted definition | 0.627 | 3.87 | 0.622 | 2.285 |
| the 42-day daily mean of it, as the series smooths it | 0.481 | 11.79 | 0.456 | 2.595 |

The script below recovers that mean by undoing the calibration on the stored `ordinary_runs_vdot`; computing it directly from `hr_vo2max_smoothed` puts the intercept 0.004 lower, at 11.78, and moves no other figure in the row.

Refitting on the series' own smoothing makes the fit worse, a residual SD 0.31 units wider and $r$ 0.456 against 0.622; the second mean adds about three weeks of lag against the 5 km efforts it is scored against.
The fitted definition refitted on the larger store moves the residual SD by 0.015 units, so the constants are kept.

### Why this is not the calibration that was rejected

`vo2max.md` records a decision not to calibrate the reported VO2max onto the VDOT scale.
That correction would have adjusted a headline number using an offset derived from our own two models with no external reference, inventing precision.
This one is different in kind: it is a regression of predicted performance on **observed** performance, fitted against the athlete's own recorded efforts, and it reports its own residual as a band on every number it produces.
The reported VO2max stays raw; only the race time derived from it is calibrated.

### Why it runs slow after a breakthrough effort

On the store as of 2026-11-16 the newest `ordinary_runs_vdot` is 2.23 VDOT units below the newest `best_efforts_vdot`, a 10 km 4.9% slower, and the best-efforts time lies just inside the band's fast edge.
Over the 205 runs that carry both, the ordinary-runs value sits a median 1.1 units below, and the best-efforts value is faster than the band on 24% of them and slower on 9%.
The gap has three causes, none of them a defect.

- **It reads typical training.** The calibration's target is the best 5 km inside 42 days of training, and most of those are windows inside training runs rather than races, so the prediction says what training usually shows rather than what the athlete can race.
- **It is regressed toward the middle.** With $r = 0.60$, a regression of VDOT on the estimate pulls every prediction toward the mean VDOT of the points it was fitted on, so it runs slow at the athlete's peaks and fast at the troughs.
- **It is smoothed twice.** One fast run moves the estimate little, and only through heart rate at pace, and a rise reaches the series 41 days late against 23 for the best-efforts series.

The design fit these constants replaced, $\mathrm{VDOT} = 0.510 \cdot \mathrm{VO}_2^{\text{hr}} + 11.60$ with a residual SD of 2.37, was nearer the best efforts on the store as of 2026-11-14 for the wrong reason: it was fitted on an exploratory estimator, and applied to the shipped estimator's 188 points it puts VDOT 1.64 units too high on average, so it was fast everywhere rather than right at that point.

Showing it only where no recent best effort exists was considered and rejected, because measured over the history it would never be shown: on the store as of 2026-11-14, all 190 runs that carried a smoothed estimate also had an eligible best effort of a kilometre or more in the 90 days before them.

## The error that propagates from best efforts

The best-efforts series consumes `best_efforts` directly, so an error there becomes a predicted race time.
The eligibility rule removes the treadmill runs and the efforts the jump detector caught, and the jump detector under-detects badly.
Measured over the real history on 2026-08-30: 330 odometer advances above 6 m/s across 107 of 307 runs, median 14.3 m and the largest 107.8 m in 5 s, against only 50 samples across 31 runs caught by the 12.5 m/s bound the flag uses.
A 107.8 m jump inside a 1 km window credits a kilometre of which a tenth was never run, which is about 25 s off a four-minute kilometre, and that kilometre is the kind of effort that becomes a run's VDOT and one of the three best in the window.
The mean of three dilutes it to a third of the raw value, and the 1 km minimum removes the worst of it, since a jump is a larger fraction of a shorter window, but neither removes it.
Jumps are not corrected, for the reason [best-efforts.md](best-efforts.md) gives, so a series lifted by a short effort can still be too fast by a third of the margin above.

## Deliberately not modelled

- Course, weather and terrain. A prediction is for a flat course on a fair day.
- Taper and race-day effort. The inputs are training efforts; the athlete may race faster than any of them.
- Whether the athlete has ever run the target distance. A marathon prediction for a runner whose longest run is 15 km is an equal-VDOT extrapolation, and nothing in it says so.
- A band on the best-efforts series. Its error against the best run of the next four weeks, a mean of 2.88 VDOT units in the table above, is not drawn.
- Fitness lost in a break. The series trails a fall by months, as "The lag" measures, and a chart breaks its line where runs are more than 42 days apart rather than drawing across the break.

## Reproducing the numbers

The table, the per-run alternative and the newest values against the removed anchor, on the real store:

```bash
uv run activity-analysis recompute
uv run python - <<'PY'
from pathlib import Path
import numpy as np
import pandas as pd
from activity_analysis.analysis.fitness import (
    MIN_PREDICTION_DISTANCE_M, ORDINARY_RUN_CALIBRATION_INTERCEPT, ORDINARY_RUN_CALIBRATION_SLOPE,
    ORDINARY_RUN_RESIDUAL_VDOT, PREDICTION_TOP_RUNS, PREDICTION_WINDOW_DAYS, SMOOTHING_WINDOW_DAYS,
    time_for_vdot, vdot,
)
from activity_analysis.analysis.smoothing import trailing_mean
from activity_analysis.api import queries
from activity_analysis.config import Paths
from activity_analysis.store.db import connect
cur = connect(Paths(Path("."))).cursor()

# Every fitness_series row on its local day, with its run VDOT over eligible efforts of 1 km up.
runs = cur.execute(f"""
    SELECT f.activity_id, d.local_date, f.hr_vo2max_smoothed x, f.best_efforts_vdot, f.ordinary_runs_vdot
    FROM fitness_series f
    JOIN (SELECT activity_id, {queries.LOCAL_DATE_SQL} local_date FROM activities) d USING (activity_id)
    ORDER BY f.start_time_utc, f.activity_id""").df()
efforts = cur.execute(f"""
    SELECT be.activity_id, be.distance_m, be.elapsed_time_s FROM best_efforts be
    JOIN activity_metrics m USING (activity_id)
    WHERE {queries._EFFORT_ELIGIBLE_SQL} AND be.distance_key IN {queries._VDOT_DISTANCE_KEYS_SQL}
      AND be.distance_m >= {MIN_PREDICTION_DISTANCE_M}""").df()
efforts["v"] = [vdot(d, s) for d, s in zip(efforts.distance_m, efforts.elapsed_time_s)]
runs["v"] = runs.activity_id.map(efforts.groupby("activity_id").v.max())
dates = pd.to_datetime(runs.local_date)
days = pd.date_range(dates.min(), dates.max(), freq="D")

# Each rule's raw daily value.
best1, best3, ordinary = (np.full(len(days), np.nan) for _ in range(3))
for i, day in enumerate(days):
    inside = ((dates > day - pd.Timedelta(days=PREDICTION_WINDOW_DAYS)) & (dates <= day)).to_numpy()
    top = np.sort(runs.v[inside].dropna().to_numpy())[::-1]
    if top.size:
        best1[i], best3[i] = top[0], top[:PREDICTION_TOP_RUNS].mean()
    hr = runs.x[inside].dropna()
    if len(hr):
        ordinary[i] = ORDINARY_RUN_CALIBRATION_SLOPE * hr.iloc[-1] + ORDINARY_RUN_CALIBRATION_INTERCEPT
when = pd.Series(days)
def smooth(raw):
    return pd.Series(trailing_mean(when, pd.Series(raw), window_days=SMOOTHING_WINDOW_DAYS).to_numpy(), index=days)
rules = {
    "best run in 90 days": pd.Series(best1, index=days),
    "mean of three best runs": pd.Series(best3, index=days),
    "best_efforts_vdot": smooth(best3),
    "ordinary runs, unsmoothed": pd.Series(ordinary, index=days),
    "ordinary_runs_vdot": smooth(ordinary),
}
for column in ("best_efforts_vdot", "ordinary_runs_vdot"):
    assert np.allclose(rules[column].reindex(dates), runs[column].astype(float), equal_nan=True), column

# Each rule against the highest run VDOT in the 28 days after the day.
future = pd.Series([runs.v[(dates > d) & (dates <= d + pd.Timedelta(days=28))].max() for d in days], index=days)
for name, s in rules.items():
    step, err = s.diff().abs(), (s - future).dropna()
    print(f"{name:26s} days moving >1 {int((step > 1).sum()):3d}  largest {step.max():.2f}"
          f"  MAE {err.abs().mean():.2f}  bias {err.mean():+.2f}  n {len(err)}")
print("one VDOT unit, % of a 5 km at 40, 45, 50",
      [round(100 * (time_for_vdot(5000, v - 0.5) / time_for_vdot(5000, v + 0.5) - 1), 2) for v in (40, 45, 50)])

# The per-run alternative, against the series per day, on the same run days.
per_run = trailing_mean(dates, pd.Series([
    runs.v[(dates > d - pd.Timedelta(days=PREDICTION_WINDOW_DAYS)) & (dates <= d)]
    .nlargest(PREDICTION_TOP_RUNS).mean() for d in dates]), window_days=SMOOTHING_WINDOW_DAYS)
run_future = pd.Series([runs.v[(dates > d) & (dates <= d + pd.Timedelta(days=28))].max() for d in dates])
gap = dates.diff().dt.days
for label, s in (("per day", runs.best_efforts_vdot.astype(float)), ("per run", per_run)):
    err, step = (s - run_future).dropna(), s.diff().abs()
    print(label, "MAE", round(err.abs().mean(), 2), "n", len(err),
          "steps over 1 (gap, step)", [(int(g), round(x, 2)) for g, x in zip(gap[step > 1], step[step > 1])])

# The newest values, against the removed models' anchor and each other.
best, ordinary_now = queries.latest_prediction_vdots(cur)
recent = [r for r in queries.recent_eligible_efforts(cur, window_days=PREDICTION_WINDOW_DAYS)
          if r["distance_m"] >= MIN_PREDICTION_DISTANCE_M]
anchor = max(recent, key=lambda r: vdot(r["distance_m"], r["elapsed_time_s"]))
print("series against the anchor's VDOT, %", round(100 * (best / vdot(anchor["distance_m"], anchor["elapsed_time_s"]) - 1), 1))
for d in (5000.0, 10000.0, 21097.5):
    riegel = anchor["elapsed_time_s"] * (d / anchor["distance_m"]) ** 1.06
    print(d, "against Riegel, %", round(100 * (time_for_vdot(d, best) / riegel - 1), 1),
          "ordinary against best, %", round(100 * (time_for_vdot(d, ordinary_now) / time_for_vdot(d, best) - 1), 1))
print("ordinary minus best now", round(ordinary_now - best, 2))
both = cur.execute("""SELECT ordinary_runs_vdot - best_efforts_vdot d FROM fitness_series
    WHERE ordinary_runs_vdot IS NOT NULL AND best_efforts_vdot IS NOT NULL""").df().d
print("rows", len(both), "median", round(both.median(), 2),
      "best faster than the band", round((both < -ORDINARY_RUN_RESIDUAL_VDOT).mean(), 3),
      "slower", round((both > ORDINARY_RUN_RESIDUAL_VDOT).mean(), 3))

# The calibration re-measured: x on the run, and x as the series smooths it.
df = cur.execute("""
    WITH e AS (
        SELECT a.start_time_utc t, be.elapsed_time_s s FROM best_efforts be
        JOIN activities a USING (activity_id) JOIN activity_metrics m USING (activity_id)
        WHERE m.is_indoor IS FALSE AND be.distance_trusted IS TRUE AND be.distance_key = '5k')
    SELECT f.activity_id, f.start_time_utc, a.utc_offset_s, f.hr_vo2max_smoothed x, min(e.s) best_s
    FROM fitness_series f JOIN activities a USING (activity_id)
    JOIN e ON e.t <= f.start_time_utc AND e.t > f.start_time_utc - INTERVAL 42 DAY
    WHERE f.hr_vo2max_smoothed IS NOT NULL
    GROUP BY ALL HAVING count(*) >= 2""").df()
y = np.array([vdot(5000.0, s) for s in df.best_s])
# ordinary_runs_vdot is linear in x, so undoing the calibration gives x's 42-day daily mean.
x_series = (smooth(ordinary) - ORDINARY_RUN_CALIBRATION_INTERCEPT) / ORDINARY_RUN_CALIBRATION_SLOPE
run_days = pd.to_datetime(df.activity_id.map(runs.set_index("activity_id").local_date))
for label, x in (("on the run", df.x.to_numpy()), ("42-day daily mean", x_series.reindex(run_days).to_numpy())):
    slope, intercept = np.polyfit(x, y, 1)
    print(label, len(x), round(slope, 3), round(intercept, 2), round(np.corrcoef(x, y)[0, 1], 3),
          round((y - (slope * x + intercept)).std(ddof=2), 3))
PY
```

The lag, on synthetic histories with a run every second day:

```bash
uv run python - <<'PY'
from datetime import date, timedelta
import numpy as np
import pandas as pd
from activity_analysis.analysis.fitness import (
    ORDINARY_RUN_CALIBRATION_INTERCEPT, ORDINARY_RUN_CALIBRATION_SLOPE, _prediction_vdots, smooth_series,
)

offsets = np.arange(-300, 301)  # a row every day, a run every second day
runs_on = offsets % 2 == 0
days = [date(2025, 1, 1) + timedelta(days=int(o)) for o in offsets]

def series(run_vdot=None, hr=None):
    nan = np.full(len(offsets), np.nan)
    hr = nan if hr is None else np.where(runs_on, hr, np.nan)
    run_vdot = nan if run_vdot is None else np.where(runs_on, run_vdot, np.nan)
    rows = pd.DataFrame({"local_date": days,
                         "hr_vo2max_smoothed": smooth_series(pd.Series(pd.to_datetime(days)), pd.Series(hr)).to_numpy()})
    return _prediction_vdots(rows, pd.Series(run_vdot)).set_axis(offsets)

def first(s, hit):
    return int(s[(s.index >= 0) & hit(s)].index[0])

a, b = 40.0, 42.0
up = series(np.where(offsets >= 0, b, a)).best_efforts_vdot
down = series(np.where(offsets >= 0, a, b)).best_efforts_vdot
print("rise: half", first(up, lambda s: s >= (a + b) / 2), "all", first(up, lambda s: s >= b - 1e-9))
print("fall: starts", first(down, lambda s: s < b - 1e-9), "all", first(down, lambda s: s <= a + 1e-9))
one = series(np.where(offsets == 0, b, a)).best_efforts_vdot[lambda s: s.index >= 0]
print("one run: share", round((one.max() - a) / (b - a), 3), "peak", int(one.idxmax()),
      "gone", first(one[one.index > 0], lambda s: s <= a + 1e-9))
r = 0.25 / 7
rise, fall = series(a + r * offsets).best_efforts_vdot, series(a - r * offsets).best_efforts_vdot
print("ramp: rise late by", round((a + r * 200 - rise[200]) / r, 1), "fall late by", round((fall[200] - (a - r * 200)) / r, 1))
o_up = series(hr=np.where(offsets >= 0, 62.0, 60.0)).ordinary_runs_vdot
lo, hi = o_up[-1], o_up.max()
print("ordinary rise: half", first(o_up, lambda s: s >= (lo + hi) / 2), "all", first(o_up, lambda s: s >= hi - 1e-9))
o_ramp = series(hr=60.0 + r * offsets).ordinary_runs_vdot
calibrated = ORDINARY_RUN_CALIBRATION_SLOPE * (60.0 + r * 200) + ORDINARY_RUN_CALIBRATION_INTERCEPT
print("ordinary ramp late by", round((calibrated - o_ramp[200]) / (ORDINARY_RUN_CALIBRATION_SLOPE * r), 1))
PY
```
