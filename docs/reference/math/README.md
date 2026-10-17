# The calculations

This directory explains the arithmetic behind every metric this project computes.

It exists for two reasons.
The first is practical: several of these calculations look like one-liners and are not, and the reasoning that picked one formula over an equivalent-looking alternative is invisible in the code.
The second is that a training analysis tool is a genuinely interesting piece of applied geometry, numerical analysis and physiology, and there is no good reason to hide that.
If you arrived here curious about how a watch turns a stream of coordinates into a race prediction, start reading at stage 1 below and keep going.

Each document derives its formulas rather than asserting them, states what the alternatives were and why they lost, and quantifies the error that remains.
Where a number appears, it was computed from the committed fixtures in `data/examples/` or measured on a real export, not recalled from a reference.
Most documents include the snippet needed to reproduce their numbers.

## How to read the notation

All mathematics here is written in the units the code actually stores, which are SI throughout.
See `CLAUDE.md` for the reasoning behind that rule.

| Symbol | Meaning | Unit |
| --- | --- | --- |
| $\varphi$ | latitude, positive north | radians in formulas, degrees in the schema |
| $\lambda$ | longitude, positive east | radians in formulas, degrees in the schema |
| $R$ | Earth radius used by the sphere model | m |
| $\sigma$ | central angle subtended by two points at the Earth's centre | radians |
| $d$ | distance along the ground | m |
| $z$ | altitude above the ellipsoid | m |
| $v$ | speed | m/s |
| $t$ | time | s |
| $g$ | gradient, rise over horizontal run | dimensionless |
| $\varepsilon$ | machine epsilon of IEEE 754 binary64, $2^{-52} \approx 2.22 \times 10^{-16}$ | dimensionless |
| $u$ | unit roundoff of IEEE 754 binary64, $u = \varepsilon/2 = 2^{-53} \approx 1.11 \times 10^{-16}$ | dimensionless |

A subscript indexes a sample: $d_i$ is cumulative distance at sample $i$.
A $\Delta$ prefix is a forward difference: $\Delta \varphi = \varphi_2 - \varphi_1$.

Pace never appears as a stored quantity, only as a presentation of $v$.
A pace of 5:00 per kilometre is $v = 1000 / 300 = 3.\overline{3}$ m/s.

## The pipeline

A sample enters as a row in a FIT or GPX file and leaves as a point on a trend chart.
These are the stages it passes through, in order.

| # | Stage | Status | Where the maths lives |
| --- | --- | --- | --- |
| 1 | Decode the source file | built | no maths beyond parsing, see `ingest/fit_reader.py` |
| 2 | Normalise units | built | [units.md](units.md) |
| 3 | Coordinates to distance | built | [geodesy.md](geodesy.md) |
| 4 | Establish activity identity, deduplicate | built | [identity.md](identity.md) |
| 5 | Resample to a uniform 1 Hz grid | built | [resampling.md](resampling.md) |
| 6 | Extract best efforts | built | [best-efforts.md](best-efforts.md) |
| 7 | Fit efficiency metrics and decoupling | built | [efficiency.md](efficiency.md) |
| 8 | Estimate VO2max, predict race times | built | [vo2max.md](vo2max.md), [predictions.md](predictions.md) |
| 9 | Adjust speed for gradient | shelved | [section 9 below](#9-adjust-speed-for-gradient) |
| 10 | Count streaks and consistency | built | [consistency.md](consistency.md) |
| 11 | Classify the session, tag it | built | [tags.md](tags.md) |
| 12 | Name where the activity happened | built | [places.md](places.md) |
| 13 | Count time in heart rate zones | built | [zones.md](zones.md) |
| 14 | Group runs into routes, extract route records | built | [routes.md](routes.md) |
| 15 | Count days since the previous run | built | [rest-days.md](rest-days.md) |
| 16 | Claim the ground each loop encloses, accumulate the territory | built | [territory.md](territory.md) |
| 17 | Count a run slower than 9:00/km as a walk | built | [reclassification.md](reclassification.md) |

Stage 17 runs between stages 5 and 6: it needs the grid's moving time, and an activity it counts as a walk reaches none of the stages after it. It is numbered last because it was added last, and the numbers above are cited elsewhere.

Stage 10 is the one stage that is not part of the derived pipeline: it is computed at read time by the API, from the local dates of the stored runs, because it depends on today's date and so has no fixed answer to store.

Stage 9 gets a document here only if its code lands, because a derivation written before the implementation drifts from it and there is nothing to check it against.

Stages 5, 6 and 13 shipped with phase 2 without their derivations, and got them in phase 4, when best efforts became the input to race prediction and the reasoning behind their extraction stopped being optional.

### 1. Decode the source file

A FIT file is a binary stream of typed messages, decoded by `fitdecode`.
The messages that matter are `record` (one per sample), `lap`, `session`, `user_profile`, `sport` and `activity`, the last of which carries the `local_timestamp` the recorded UTC offset is read from.
Records are smart-sampled by the device at irregular intervals, 1 to 9 seconds on the reference fixture, which is the single fact that forces stage 5 to exist.

GPX is XML, with heart rate and cadence hidden in a Garmin extension namespace.
It carries no laps, no zones and no athlete profile, and its speed must be derived rather than read.
[geodesy.md](geodesy.md) quantifies what that costs.

### 2. Normalise units

Three conversions, each applied exactly once, at the ingestion boundary.
Coordinates arrive as semicircles, a fixed-point angle encoding.
Cadence arrives as revolutions per minute for one foot, which is half the steps per minute a runner would recognise.
Speed and altitude arrive in two variants, and the enhanced one is preferred.

[units.md](units.md) derives all three and measures the resolution each one actually delivers.

### 3. Coordinates to distance

Needed only for GPX, because a FIT file carries a device-measured cumulative distance that is better than anything derivable from coordinates.

[geodesy.md](geodesy.md) derives the haversine formula from the spherical law of cosines, shows by measurement why the law of cosines itself is unusable at running sample rates, and bounds the error left over from modelling the Earth as a sphere.

### 4. Establish activity identity, deduplicate

The same run often arrives twice, once as a Garmin FIT file and once as a Strava export, and the two copies disagree about almost everything except when the run started.
Identity therefore hashes the start time alone, and reconciles everything else within a tolerance.

[identity.md](identity.md) works through why every more obvious identity scheme fails, what the tolerance windows cost, and the one property the reconciliation relation does not have.

### 5. Resample to a uniform 1 Hz grid

Rolling-window metrics on an irregular grid are either wrong or need per-sample weighting.
Every metric downstream of here therefore runs on a uniform 1 Hz derived grid.
The subtlety is deciding what each gap in the recording was, because duration alone cannot tell a stop from a slow stretch of smart recording.

[resampling.md](resampling.md) derives the two-part gap rule from the measured gap distribution, quantifies the interpolation error, and works through why the grid must never hold distance across a gap.

### 6. Extract best efforts

For each of a set of standard distances, the fastest time in which the activity covered that distance.
A two-pointer sliding window over the cumulative-distance array finds all of them, in time linear in the number of samples.

[best-efforts.md](best-efforts.md) proves the sweep's invariant, derives why efforts are elapsed time spanning pauses rather than moving time, derives the speed-agreement check that lets a flagged jump the measured speed confirms count, and states the known under-detection of implausible distance jumps that phase 4's predictions inherit.

### 12. Name where the activity happened

A nearest-neighbour search on a sphere against a bundled table of 170 911 populated places, entirely offline - a start position locates the athlete, and a geocoding API would receive every one of them.

The search is one vectorised haversine. The interesting part is that "nearest" is measurably the wrong answer: GeoNames' populated places include city districts, so a run from a city centre resolves to the district it started in, which is true and is not what anybody means.

[places.md](places.md) derives the correction, shows the two real starts that an unconditional population preference breaks, and measures the ratio gate that separates a city from its own district.

### 7. Fit efficiency metrics and decoupling

The stage that justifies the project.
Cadence and heart rate both rise with speed, so plotting either one raw over months mostly measures how fast the athlete happened to run.
Fitting the relationship and reading it off at a fixed reference pace separates the change in the athlete from the change in the session.
The fit is not the per-activity one the original design specified: this athlete's runs are too evenly paced to carry a slope, so each activity's own slope is shrunk toward one shared across the history, weighted by a standard error that has to come from a block bootstrap rather than from ordinary least squares.

[efficiency.md](efficiency.md) derives the three reference paces, the shrinkage and its weights, why the warm-up cannot be excluded, why the naive standard error is ten times too small, and aerobic decoupling.

### 8. Estimate VO2max, predict race times

Two estimates of VO2max, neither a measurement: Daniels' VDOT, which inverts a best effort into the VO2max an average-economy runner would need to run it, and a heart-rate estimate in Garmin's family, which divides the oxygen cost of a steady speed by the fraction of maximum the heart rate implies.
On the real history the heart-rate estimate sits at about 1.6 times VDOT, and the level of either is a model output; only the trend is claimed.

[vo2max.md](vo2max.md) derives both, sources every constant, states the regression inversion the heart-rate method rests on and bounds its bias against a properly directed published fit, shows by measurement why the reported series is a trailing 42-day mean, and compares both against Garmin's own VO2max.

Race times come from two models over the best recent effort, Riegel and Cameron, reported as a range rather than a single number, plus a calibrated prediction from ordinary running that needs no maximal effort, carries its own band, and reads what typical training supports.

[predictions.md](predictions.md) derives the three, records why a critical-speed fit over the per-distance bests was removed, measures why the ordinary-run prediction sits slower than the best efforts after a breakthrough run, and traces the error that propagates from an undetected jump in the recorded distance into a predicted race time.

### 9. Adjust speed for gradient

Not built.
The method would scale each second's speed by the metabolic cost of running at that second's gradient, from the Minetti et al. (2002) cost curve, relative to its cost on flat ground, with the gradient smoothed over about 40 m of distance and clamped to ±45%, the range the curve is validated over.
It was shelved on 2026-10-16 after a probe found it removes no terrain bias on this athlete's runs.
Over 103 easy, steady and long outdoor runs, with a simplified per-run linear fit, heart rate at the reference pace correlates with climb per kilometre at +0.109 on raw speed and +0.120 on grade-adjusted speed, and the adjustment narrows that value's spread across runs by 6%.
It makes the cadence fit worse, its residual growing by a median 10% per run, because cadence follows the ground covered rather than metabolic cost.
What remains of the case for it is terrain heavier than this history holds, and the route's pace colouring, which reads a climb as slow.

### 10. Count streaks and consistency

Whether the athlete trained, as opposed to how much, reduced to a current streak, a longest streak and a count of active weeks in the last year.

[consistency.md](consistency.md) derives why the unit is the week rather than the day, why an unfinished week cannot count against a streak, and what the bucket key has to be so that a run belongs to the week the athlete ran it in.
It also defines the Full history chart's 9-week distance trend and why its line ends before weeks the store knows nothing about.

### 11. Classify the session, tag it

One exclusive effort tag, Easy, Steady, Intervals or All out, plus the additive Long run and PR flags, each carrying the numbers that fired it.
The Intervals rule reads the recorded lap sequence rather than per-kilometre splits, which the original rule read and which cannot see a rep run as a sub-kilometre lap.

[tags.md](tags.md) derives the rule from cadence and pace, gives the score of the two rules it replaced, and quantifies the one error that survives.

### 13. Count time in heart rate zones

Seconds of a run spent in each of the athlete's configured heart rate zones, counted on the 1 Hz grid.
The device writes its own totals into every FIT, which makes this the one derived metric in the project with real ground truth on real data.

[zones.md](zones.md) derives the boundary convention from those totals, shows the alternative off-by-one that a boundary closing its zone would produce, and explains why the two answers still differ by up to 46 s.

### 14. Group runs into routes, extract route records

Whether the athlete is getting faster on a loop run repeatedly, which controls for the hills and the surface because the ground is the same one, unlike a best effort taken from any run.
Two runs are the same route when their resampled traces stay close on average and nowhere stray far once the first and last 5% are set aside.

[routes.md](routes.md) derives the projection, the grouping thresholds and why complete linkage was chosen over single linkage, and states the eligibility and ranking rules a route record follows.

### 15. Count days since the previous run

How many local calendar days separate a run from the one before it in the running history, added for the Distributions view's "days since previous run" variable.
Written into `activity_metrics.days_since_previous_run`, whole-history and null on the first run.

[rest-days.md](rest-days.md) derives the local-date arithmetic, why the unit is a calendar day and not elapsed hours, and why the column is computed once over the whole history rather than per filtered view.

### 16. Claim the ground each loop encloses, accumulate the territory

A run whose last position is within 200 m of its first closes a loop, and the ground its closed track encloses is claimed; the territory is the union of every claim, accumulated in start-time order so each run also records how much of its ground was new.
Every area is an ellipsoidal area, read on an equal-area projection this project implements.

[territory.md](territory.md) derives why the shoelace area of a self-crossing track is not the ground it encloses, measures the width at which an out-and-back's slivers stop and genuine ground starts, derives the ellipsoidal Lambert azimuthal equal-area projection and checks its areas against the WGS84 geodesic, and measures the region and display rules.

## Conventions for documents in this directory

A new stage's document is part of that stage's definition of done, not a follow-up.
Each one should:

- Derive its formulas, or cite a paper for anything empirical.
- Name the alternatives that were rejected, and say what measurement or argument rejected them.
- Quantify the error that survives, in units a reader can judge.
- Compute its numbers from the committed fixtures, and show how to reproduce them.
- Quote figures from the committed fixtures freely, and from a real export only sample sizes, proportions and relative errors, such as "15 of 324 runs" or "within 3% of the realised time".
  Never quote absolute performances, body metrics, place names, positions, dates of personal events or real activity ids: the repository is public, and a real export is someone's training history, positions and body.
- Say what is deliberately not modelled.
