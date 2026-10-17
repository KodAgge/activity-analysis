# Race prediction

Module: `src/activity_analysis/analysis/fitness.py`, functions `riegel`, `cameron`, `predict_from_ordinary_run` and `race_predictions`.
Served by `GET /api/predictions`.

Three models, presented together.
Two read the athlete's best recent effort and are reported as a range, which is how far the two extrapolations disagree.
The third reads the smoothed heart-rate VO2max from `vo2max.md` and predicts without requiring a maximal effort, and it carries its own, wider, band.
It reads what typical training supports rather than what the best recent effort showed, so it is shown beside the range as a second reading and not folded into it.
A fourth model, a critical-speed fit across the per-distance bests, was removed on 2026-10-06; [the section below](#why-there-is-no-critical-speed-model) records why.

The predictions are evaluated when asked rather than stored.
They are closed forms over a handful of stored numbers, and "recent" is measured against the history: the window is the `PREDICTION_WINDOW_DAYS` (90) ending at the most recent run in the store, so the answer is a function of the store alone and an athlete who stopped running still sees the prediction their last block of training supports.
90 days is the window the long-run tag already calls recent; the 42-day smoothing window leaves the 15 km and half marathon almost never inside it on the real history, where those two have 20 and 5 eligible efforts across three years.

## Which efforts enter

The best eligible effort at each standard distance inside the window, under the records rule: `is_indoor` explicitly false and `distance_trusted` explicitly true, which since `ANALYSIS_VERSION` 10 admits a jump the measured speed confirms within 1%.
Efforts under `MIN_PREDICTION_DISTANCE_M` (1000 m) are neither a source nor a target.
The Daniels percentage curve exceeds 1.0 below about two minutes and his tables start at 1500 m; Riegel's exponent was fitted to race distances; and a 400 m window is short enough that one bad second dominates it, which is why the five fastest 400 m efforts on the real store all carry `contains_jump`.

On the real store as of 2026-10-06 the window holds a best at six distances, here by their VDOT against the highest of them, the 10 km's:

| distance | VDOT against the 10 km |
| --- | --- |
| 1 km | -0.2% |
| 1 mile | -7.8% |
| 3 km | -2.4% |
| 5 km | -0.7% |
| 10 km | 0 |
| 15 km | -22.7% |

The 5 km and the 10 km both come from one run, the window's most recent, whose 10 km is 13% faster than any other 10 km in the window.
The 15 km is a window inside an easy long run, its VDOT more than a fifth below the rest.
These are windows inside runs, not race results, and the per-distance bests therefore do not lie on one curve.

**The window returns efforts at `VDOT_DISTANCES_M` only**, the original nine of `analysis/best_efforts.py`'s twenty-two, from phase 1.
The models' candidate set is a modelling choice and the records ladder's is a display one, so the two are separate constants.
The models anchor on the highest-VDOT effort they are handed, and an activity that scored highest at 3 km would score higher at a new 2 km or 4 km rung, so adding a rung to the ladder would otherwise move every predicted time.
`vo2max.md` argues the split; `recent_eligible_efforts` applies it.

## Riegel

Peter Riegel's 1981 relation, from a fit to record performances across many events and species:

$$
T_2 = T_1 \left( \frac{D_2}{D_1} \right)^{1.06} .
$$

The exponent is above 1 because pace decays with distance.
From a 5 km in 25:00 it gives a 10 km of $1500 \cdot 2^{1.06} = 3127$ s, or 52:07, which `test_riegel_matches_the_published_exponent` pins.
Riegel is known to be optimistic at the marathon end, because a single exponent cannot capture the extra fatigue past two hours; that is the reason it is never reported alone.

## Cameron

Dave Cameron's 1998 model, fitted to observed times from 400 m to the marathon, converts each distance to a fatigue factor and scales pace by their ratio:

$$
f(d) = 13.49681 - 0.048865\,d + \frac{2.438936}{d^{0.7905}}, \qquad
\text{pace}_2 = \text{pace}_1 \cdot \frac{f(d_1)}{f(d_2)} ,
$$

with $d$ in **miles**, which is the unit the coefficients were fitted in.
The conversion from metres happens inside `cameron`, at the boundary, and nothing imperial is stored, which keeps the SI rule.
The factors fall with distance, 17.0 at 1 km, 14.3 at 5 km, 13.8 at 10 km and 12.4 at the marathon, so pace slows by their ratio.

Riegel and Cameron agree closely over a doubling and diverge at the long end, which is what makes reporting both informative.
From a synthetic 5 km in 25:00, in minutes:

| target | Riegel | Cameron | equal-VDOT time |
| --- | --- | --- | --- |
| 10 km | 52.1 | 52.1 | 51.9 |
| half marathon | 115.0 | 114.8 | 115.1 |
| marathon | 239.8 | 244.0 | 237.9 |

The third column is the time at which the target distance carries the same VDOT as the 5 km, from `time_for_vdot`; it is not reported as a model, since it is the same information as `vdot_smoothed` on the fitness chart, but it shows that three independent fits to observed performance agree to within a minute below the marathon.

Both Riegel and Cameron are anchored on one effort, **the recent eligible effort with the highest VDOT**, because that is the athlete's best recent performance under a scale that puts every distance on one footing.
Anchoring each target on its nearest distance was considered and rejected: it makes the reported range depend on which distances happened to be run.
On the real store the anchor is the window's 10 km, so both models return its own time at 10 km.

The range is therefore narrow from 3 km to the half marathon, where the two models agree closely, and wider at both ends, where the extrapolation from 10 km is longest.
From a synthetic 10 km anchor in 50:00, in minutes:

| target | Riegel | Cameron |
| --- | --- | --- |
| 1 km | 4.4 | 4.0 |
| 5 km | 24.0 | 24.0 |
| 10 km | 50.0 | 50.0 |
| half marathon | 110.3 | 110.2 |
| marathon | 230.0 | 234.3 |

Both models scale linearly with the anchor's time, so their ratio depends only on the distances and the real anchor's range has the same proportions: Cameron is 7.1% faster at 1 km, level with Riegel from 5 km to the half marathon, and 1.8% slower at the marathon.

Its width is the models' disagreement about extrapolation, not the uncertainty of the anchor, which neither model can see.

## Why there is no critical speed model

### The model

The hyperbolic relation between speed and time to exhaustion, in its distance form:

$$
D = CS \cdot t + D' .
$$

$CS$, the critical speed, is the asymptote: roughly the highest speed that can be sustained aerobically.
$D'$ is the finite distance available above it, the anaerobic reserve, typically one to three hundred metres for a runner.
It was fitted by ordinary least squares in $(t, D)$ over the per-distance bests in the window, and a prediction was $t = (D - D') / CS$.

### What it did on efforts that were not races

The model assumes every point is a maximal effort at its duration.
The window's bests are not: the longest is a window inside an easy long run, and in a least-squares fit over $t$ the longest point has the most leverage.
On the store as of 2026-10-06, with $CS$ and $D'$ against the fit without the 15 km and each predicted time against the window's own best at that distance:

| fitted over | $CS$ | $D'$ | 1 km | 5 km | 10 km |
| --- | --- | --- | --- | --- | --- |
| all six bests | 0.79 | 5.3 | 0.22 | 1.10 | 1.18 |
| without the 15 km | 1 | 1 | 1.02 | 1.01 | 1.00 |

With the easy 15 km in, the slope is the long run's pace and the intercept is three times a runner's reserve, so the model predicted a 10 km 18% slower than the one the window holds, a kilometre in under a quarter of the window's own best time, and a half marathon 23% slower than the clean fit's.
On the store as of 2026-09-05 the same fit gave a $CS$ within 2% of this one and a $D'$ four times the 2026-10-06 clean fit's, so this was the model's standing behaviour on this history, not one bad window.

### Why it was removed rather than repaired

Without the 15 km the fit is sensible, but keeping it out takes a rule: a duration cap, or a minimum VDOT relative to the best.
Either is a constant chosen to make the model behave on these inputs rather than measured from anything, which is the guard this document had already declined to add.
A clean fit would still err at the long end, because $CS$ cannot be held for the hours a half marathon or a marathon takes.
And what it contributed was the width of the range: it set whichever end was further out, so the range it produced measured the model's misfit rather than any uncertainty about the athlete.

## The prediction from ordinary runs

### Why the raw estimate cannot be inverted

The heart-rate VO2max from `vo2max.md` is a fitness estimate on days the athlete did not race, and inverting the Daniels relation at it gives a time.
Applied raw that time is wrong by a wide margin: measured during design, before this module existed, over 150 points with a smoothed estimate and at least two eligible 5 km efforts within 42 days, raw inversion predicts a median 5 km in 23.5% less time than the actual best.
The estimate's level is a model output, as its document says, and the inversion inherits every unit of its offset.

### The calibration

It does track performance well enough to calibrate.
Against the VDOT of the nearby best 5 km:

$$
\mathrm{VDOT} = 0.510 \cdot \mathrm{VO}_2^{\text{hr}} + 11.60, \qquad r = 0.528, \qquad \text{residual SD } 2.37 \text{ VDOT units},
$$

held in `ORDINARY_RUN_CALIBRATION_SLOPE`, `ORDINARY_RUN_CALIBRATION_INTERCEPT` and `ORDINARY_RUN_RESIDUAL_VDOT`.
These constants were fitted during design on an exploratory estimator rather than on the implemented `hr_vo2max`, and have not been refitted against the shipped `fitness_series`; "Why it runs slow after a breakthrough effort" below measures what a refit would change.
`predict_from_ordinary_run` maps the latest `hr_vo2max_smoothed` through it and inverts at the result, and at the result plus and minus one residual standard deviation for the band.
The band is computed by inverting at $\mathrm{VDOT} \pm 2.37$ rather than by adding seconds, because time is a nonlinear function of VDOT and a symmetric band in one is asymmetric in the other; `test_the_band_brackets_the_prediction_and_is_not_symmetric_in_time` checks that.
A higher VDOT is a lower time, so `low_s` comes from the upper VDOT.

Two things must be said wherever this prediction appears, and the response model enforces the first by refusing an `ordinary_runs` model without `low_s` and `high_s`.
**The band is wide**: for a synthetic 5 km in 25:00, from 1.24 minutes faster to 1.38 minutes slower, roughly 5%, against a much tighter prediction from actual best efforts, so where a recent eligible best effort exists that prediction is the better one.
**The slope of 0.510 is itself a finding**: the heart-rate estimate moves about twice as fast as measured performance does, which is the same overstatement visible in its yearly medians, now quantified.

### Why this is not the calibration that was rejected

`vo2max.md` records a decision not to calibrate the reported VO2max onto the VDOT scale.
That correction would have adjusted a headline number using an offset derived from our own two models with no external reference, inventing precision.
This one is different in kind: it is a regression of predicted performance on **observed** performance, fitted against the athlete's own recorded efforts, and it reports its own residual as a band on every number it produces.
The reported VO2max stays raw; only the race time derived from it is calibrated.

### Why it runs slow after a breakthrough effort

On the store as of 2026-10-06 the calibration maps the latest smoothed estimate to a 10 km 3.5% slower than the window's own best 10 km, with a band from 4.9% faster to 5.5% slower than the prediction.
The window's best is 3.3% faster than the prediction, so it is inside the band, near its fast edge, and the gap has three causes, none of them a defect.

- **It reads typical training.** The calibration's target is the best 5 km inside 42 days of training, and most of those are windows inside training runs rather than races, so the prediction says what training usually shows rather than what the athlete can race.
- **It is regressed toward the middle.** With $r$ between 0.53 and 0.60, a regression of VDOT on the estimate pulls every prediction toward the mean VDOT of the points it was fitted on, so it runs slow at the athlete's peaks and fast at the troughs.
- **It is smoothed over 42 days.** One fast run moves the estimate little, and only through heart rate at pace, which a single run on a good day does not change much.

A refit would not close the gap.
Refitted against the shipped estimator under the same selection rule, over 188 points, the calibration is $\mathrm{VDOT} = 0.586 \cdot \mathrm{VO}_2^{\text{hr}} + 5.92$ with $r = 0.597$ and a residual SD of 2.30, and it puts the same 10 km 7.1% slower than the window's best, further from it.

Showing it only where no recent best effort exists was considered and rejected, because measured over the history it would never be shown: all 190 runs that carry a smoothed estimate also have an eligible best effort of a kilometre or more in the 90 days before them.
It is therefore shown beside the best-effort range, visually secondary to it, and labelled as what typical training supports.

## The error that propagates from best efforts

Every best-effort model consumes `best_efforts` directly, so an error there becomes a predicted race time.
The eligibility rule removes the treadmill runs and the efforts the jump detector caught, and the jump detector under-detects badly.
Measured over the real history on 2026-08-30: 330 odometer advances above 6 m/s across 107 of 307 runs, median 14.3 m and the largest 107.8 m in 5 s, against only 50 samples across 31 runs caught by the 12.5 m/s bound the flag uses.
A 107.8 m jump inside a 1 km window credits a kilometre of which a tenth was never run, which is about 25 s off a four-minute kilometre, and that kilometre is exactly the kind of effort that becomes the highest-VDOT anchor for Riegel and Cameron.
The 1 km minimum removes the worst of it, since a jump is a larger fraction of a shorter window, but it does not remove it.
Jumps are not corrected, for the reason [best-efforts.md](best-efforts.md) gives, so a prediction anchored on a short effort can still be too fast by the margin above.

## Deliberately not modelled

- Course, weather and terrain. A prediction is for a flat course on a fair day.
- Taper and race-day effort. The inputs are training efforts; the athlete may race faster than any of them.
- Whether the athlete has ever run the target distance. A marathon prediction for a runner whose longest run is 15 km is an extrapolation of the models, and they say so by diverging there.

## Reproducing the numbers

```bash
uv run activity-analysis recompute
uv run python - <<'PY'
from pathlib import Path
import numpy as np
from activity_analysis.config import Paths
from activity_analysis.store.db import connect
from activity_analysis.api import queries
from activity_analysis.analysis.best_efforts import VDOT_DISTANCES_M
from activity_analysis.analysis.fitness import (
    MIN_PREDICTION_DISTANCE_M,
    PREDICTION_WINDOW_DAYS,
    race_predictions,
    time_for_vdot,
    vdot,
)
cur = connect(Paths(Path("."))).cursor()

# The window's bests.
rows = queries.recent_eligible_efforts(cur, window_days=PREDICTION_WINDOW_DAYS)
usable = [r for r in rows if r["distance_m"] >= MIN_PREDICTION_DISTANCE_M]
for r in usable:
    speed = r["distance_m"] / r["elapsed_time_s"]
    print(r["distance_key"], round(r["elapsed_time_s"] / 60, 1), round(speed, 2), round(vdot(r["distance_m"], r["elapsed_time_s"]), 1))

# The range, and the ordinary-run prediction with its band.
estimate = queries.latest_hr_vo2max_smoothed(cur, window_days=PREDICTION_WINDOW_DAYS)
print("estimate", round(estimate, 1))
for item in race_predictions(rows, estimate)["items"]:
    print(item["distance_key"], [
        (m["model"], round(m["predicted_time_s"] / 60, 1), m["low_s"] and round(m["low_s"] / 60, 1), m["high_s"] and round(m["high_s"] / 60, 1))
        for m in item["models"]
    ])

# The removed critical-speed fit, with and without the easy 15 km.
for label, sel in (("all six", usable), ("without 15k", [r for r in usable if r["distance_key"] != "15k"])):
    t = np.array([r["elapsed_time_s"] for r in sel])
    d = np.array([r["distance_m"] for r in sel])
    cs, d_prime = np.polyfit(t, d, 1)
    print(label, round(cs, 2), round(d_prime), [round((x - d_prime) / cs / 60, 1) for x in (1000, 5000, 10000, 21097.5)])

# The calibration refitted against the shipped estimator.
df = cur.execute("""
    WITH e AS (
        SELECT a.start_time_utc t, be.elapsed_time_s s FROM best_efforts be
        JOIN activities a USING (activity_id) JOIN activity_metrics m USING (activity_id)
        WHERE m.is_indoor IS FALSE AND be.distance_trusted IS TRUE AND be.distance_key = '5k')
    SELECT f.hr_vo2max_smoothed x, min(e.s) best_s
    FROM fitness_series f JOIN e ON e.t <= f.start_time_utc AND e.t > f.start_time_utc - INTERVAL 42 DAY
    WHERE f.hr_vo2max_smoothed IS NOT NULL
    GROUP BY f.activity_id, f.hr_vo2max_smoothed HAVING count(*) >= 2""").df()
x = df.x.to_numpy()
y = np.array([vdot(5000.0, s) for s in df.best_s])
slope, intercept = np.polyfit(x, y, 1)
residual = (y - (slope * x + intercept)).std(ddof=2)
print("refit", len(x), round(slope, 3), round(intercept, 2), round(np.corrcoef(x, y)[0, 1], 3), round(residual, 2))
print("10k from the refit", round(time_for_vdot(10000.0, slope * estimate + intercept) / 60, 1))

# How often a fallback-only rule would have shown the ordinary-run prediction.
keys = tuple(k for k, m in VDOT_DISTANCES_M.items() if m >= MIN_PREDICTION_DISTANCE_M)
print("runs with an estimate, of them with no recent effort", cur.execute(f"""
    WITH runs AS (SELECT start_time_utc t FROM fitness_series WHERE hr_vo2max_smoothed IS NOT NULL),
    e AS (SELECT a.start_time_utc t FROM best_efforts be
          JOIN activities a USING (activity_id) JOIN activity_metrics m USING (activity_id)
          WHERE m.is_indoor IS FALSE AND be.distance_trusted IS TRUE AND be.distance_key IN {keys})
    SELECT count(*), count(*) FILTER (WHERE NOT EXISTS (
        SELECT 1 FROM e WHERE e.t <= runs.t AND e.t >= runs.t - INTERVAL 90 DAY))
    FROM runs""").fetchone())
PY
```

`np.polyfit` stands in for the removed `critical_speed`, which fitted the same line by `np.linalg.lstsq`.
The refit's 42-day selection is the calibration's own rule: a smoothed estimate and at least two eligible 5 km efforts in the 42 days up to the run.
