# Best efforts

The fastest time in which an activity covered each of a set of standard distances.

Implemented in `src/activity_analysis/analysis/best_efforts.py`.
Tested in `tests/test_best_efforts.py` against synthetic runs whose answers are exact.
Every number quoted from the real store lives here and not in an assertion.

Phase 4 consumes this table directly: the VDOT estimate in `vo2max.md` is an inversion of a best effort, and the race predictions in `predictions.md` are fitted through several of them.
Whatever this module gets wrong about an effort therefore propagates into a predicted race time, which is why its limitations are stated at the end rather than left implicit.

## What is being computed

Let $D(t)$ be cumulative distance on the 1 Hz grid, a monotone non-decreasing function of elapsed time, and let $L$ be a target distance.
A best effort at $L$ is

$$E(L) = \min \{\, b - a \;:\; D(b) - D(a) \ge L \,\}$$

over every window $[a, b]$ inside the activity.
Twenty-two targets are computed, listed under "The distance table" below.
A run shorter than the target has no effort at that distance rather than a null one.

Three things about that definition are decisions, derived below: that the time is elapsed rather than moving, that the window may span a pause, and that $a$ is a real number rather than a sample index.

## The two-pointer sweep

The grid has $n$ samples $(t_i, D_i)$ with $D$ non-decreasing.
For each end index $r$, the fastest window ending at $t_r$ starts as late as possible, at the largest $a$ with $D(a) \le D_r - L$.
Call the threshold $\theta_r = D_r - L$.

`best_effort` keeps a start index $l$ and advances it with

```
while l + 1 < r and D[r] - D[l + 1] >= L:
    l += 1
```

**Invariant.** After the loop, $l$ is the largest index below $r$ with $D_{l+1} > \theta_r$, so $\theta_r$ lies in $[D_l, D_{l+1})$ and the window start lies in $[t_l, t_{l+1})$.
The loop stops exactly when $D_r - D_{l+1} < L$, which is $D_{l+1} > \theta_r$, and it advanced only while $D_r - D_{l+1} \ge L$, so every index it passed satisfied $D_{l+1} \le \theta_r$.
The starting condition $D_r - D_0 \ge L$ is checked first, so $D_l \le \theta_r$ holds throughout.

**Neither pointer moves backwards.**
$r$ increases by construction.
As $r$ increases, $D_r$ does not decrease, so $\theta_r$ does not decrease, so any index that satisfied $D_{l+1} \le \theta_r$ still does at the next $r$; the largest such index is therefore non-decreasing in $r$, and $l$ never has to retreat.

**Linear time.**
$l$ advances at most $n$ times over the whole sweep and $r$ exactly $n$ times, so the sweep is $O(n)$ whatever the target.
A naive search over all $(a, b)$ pairs is $O(n^2)$, which on a 3982-row grid is 16 million windows per distance and twenty-two distances per activity.

## Interpolating the window start

The threshold $\theta_r$ falls between two samples.
Taking the window start to be $t_l$, the last sample at or below the threshold, would report a window covering more than $L$ and therefore a time that is too long, by up to one sampling interval.
Instead the start is placed where the linearly interpolated $D$ crosses $\theta_r$:

$$a = t_l + \frac{\theta_r - D_l}{D_{l+1} - D_l}\,(t_{l+1} - t_l).$$

This is consistent with the grid, whose `distance_m` is itself linearly interpolated between records ([resampling.md](resampling.md)), so the start is placed on the same curve the distance was read from.

The difference is easy to see on a synthetic run at exactly 5:00 per kilometre, where the right answer for 5 km is exactly 1500 s.
On a 1 Hz grid the target happens to land on a sample and both approaches agree.
Sampled every 7 s, so that 5000 m falls between samples, snapping the start to a sample reports 1505.0 s and interpolation reports 1500.0 s.
Shifting the whole run by 0.3 s, so that no sample sits on a second boundary, still returns 1500.0 s: the answer depends on where the athlete was, not on where the clock ticks fell.

```python
import numpy as np
from activity_analysis.analysis.best_efforts import best_effort

v = 1000.0 / 300.0
def snapped(t, dist, target):
    best = None
    for r in range(len(dist)):
        if dist[r] - dist[0] < target:
            continue
        l = np.searchsorted(dist, dist[r] - target, side="right") - 1
        best = t[r] - t[l] if best is None else min(best, t[r] - t[l])
    return best

for step in (1.0, 7.0):
    k = np.arange(0.0, 1700.0, step)
    print(step, best_effort(k, k * v, 5000.0).elapsed_time_s, snapped(k, k * v, 5000.0))
k = np.arange(0.0, 1700.0)
print(best_effort(k + 0.3, k * v, 5000.0).elapsed_time_s)      # 1500.0
```

`test_a_five_kilometre_run_at_five_minute_pace_takes_exactly_twenty_five_minutes` and `test_the_window_starts_where_the_target_distance_actually_begins` pin this.

### What "exact" means here, and the residual

The sweep is exact over every window whose end is a grid second, with the start free.
The true continuous minimum can have its end between two grid seconds.
With $D$ piecewise linear, the elapsed time $e(b) = b - a(b)$ of the window ending at $b$ is piecewise linear in $b$, with kinks wherever $b$ or $a(b)$ crosses a sample, so its minimum sits at a kink, and a kink where $a(b)$ crosses a sample need not be a grid second.
The sweep misses those by at most the slope of $e$ times one second.

Measured on the five fixtures by brute force over a 0.05 s grid of end times, across 14 efforts at 400 m, 1 km and 5 km, the sweep's answer exceeds the continuous minimum by 0.000 to 0.083 s.
That is below the 1 s resolution of the grid and of every timestamp the device wrote, so it is recorded here and not corrected.

## Elapsed time, spanning pauses

Take 5 km in 30:00, five minutes standing still, then 5 km in 30:00.
What is the 10 km effort?

| Rule | 10 km effort | What it says about the rest |
| --- | --- | --- |
| Windows confined to one contiguous moving segment | none | the athlete never ran 10 km |
| Moving time, the pause deducted | 60:00 | resting is free |
| **Elapsed time, the window spanning the pause** | **65:00** | resting costs exactly what it took |

The first discards a distance that was genuinely covered: the athlete did run 10 km that day, and a race clock would have said so.
The second is the one rule under which resting is free, and a rule under which resting is free rewards stopping.
An athlete who ran every kilometre flat out and walked in between would post a moving-time 10 km no continuous runner could match.

Under elapsed time a pause can only ever make an effort slower.
That is the invariant the whole table rests on, and it is worth stating as a derivation rather than a preference: for any window $[a, b]$, inserting $p$ seconds of rest anywhere inside it leaves $D(b) - D(a)$ unchanged and makes the window $b - a + p$ long, so the effort gets slower by exactly $p$.
The longest stop in the real history therefore produces a very slow effort that never troubles a record, and needs no special handling.

It also has a consequence the extractor exploits without being told to.
On the 2026-08-25 fixture there is a 20 s stop from 705 to 725 s.
The best 5 km window starts at 730.08 s, five seconds after the stop ends, and takes 1507.9 s.
Forcing the window to start at 700 s, so that it spans the stop, gives 1537 s: the same distance, 29 s slower, of which 20 s is the stop.
The minimum found the window that leaves the stop out, because a window that includes one is never the fastest unless the running either side of it was faster still.

```python
import numpy as np
from datetime import UTC, datetime
from pathlib import Path
from activity_analysis.analysis.best_efforts import best_effort
from activity_analysis.analysis.resample import resample_to_1hz
from activity_analysis.ingest.fit_reader import read_fit
from activity_analysis.ingest.normalize import normalize
from activity_analysis.models import SOURCE_STRAVA_FIT

f = Path("data/examples/run-2026-08-25.fit")
s = normalize(read_fit(f), source=SOURCE_STRAVA_FIT, source_file=f.name,
              source_file_sha256="x", athlete_id="t",
              ingested_at=datetime(2026, 8, 29, tzinfo=UTC)).streams
g = resample_to_1hz(s)
t = g["t_s"].to_numpy(float); d = g["distance_m"].to_numpy(float)
print(best_effort(t, d, 5000.0))                          # starts at 730.08 s, 1507.9 s
j = np.searchsorted(d, d[700] + 5000.0)
print(t[j] - 700.0)                                      # 1537.0 s
```

This invariant is also why the grid never holds distance across a gap.
Holding compressed a whole gap's odometer advance into one second and manufactured a 400 m effort of 0.89 s across an outage and one of 88 s at 4.5 m/s across a stop, both unflagged.
[resampling.md](resampling.md) derives the failure; the point here is that holding was the one thing that let a pause make an effort faster, and removing it is what lets the flags below be observability rather than corrections.

## The three flags

Each row says what its window crossed.
The consumer decides what to exclude, but it cannot decide what it cannot see.

| Flag | The window contains | Effect on the effort | What a consumer should do |
| --- | --- | --- | --- |
| `contains_pause` | one or more seconds of a classified stop | slower, by the stop's length | nothing, unless it wants only continuous running |
| `contains_outage` | one or more seconds the device did not record | slower or equal: every metre inside is the outage's own average, so any real surge is flattened | nothing for records; exclude where the pace profile inside matters |
| `contains_jump` | a sample-to-sample advance above `IMPLAUSIBLE_SPEED_MPS` | **faster**, by metres nobody ran | read `distance_trusted` instead, below |

The first two are not corrections, because both make an effort slower and a slower effort is never wrong in the direction that matters.
`contains_jump` is the odd one out: an implausible advance in the recorded distance credits distance that was not run, so the effort is inflated.
The decision on 2026-08-30 was to flag now and correct later.
The trace stays exactly as the device wrote it, nothing is clamped, redistributed or dropped.

Two more columns, added at `ANALYSIS_VERSION` 10 on 2026-09-27, decide whether a flagged effort may still count.
`speed_distance_m` is the distance the device's measured speed accounts for over the window, and `distance_trusted` is true when there is no jump or when that distance agrees with the recorded one; "The speed-agreement check" below derives both.
Every consumer that ranks efforts excludes an effort whose `distance_trusted` is not true, on both sides of a comparison, as `docs/reference/math/tags.md` derives for records.

### The implausible-speed bound and its known under-detection

`IMPLAUSIBLE_SPEED_MPS` is 12.5 m/s.
The peak speed recorded in the 100 m world record is roughly 12.4 m/s, so 12.5 is a bound no human locomotion reaches and the flag cannot false-positive for any athlete.

Measured over the real history on 2026-08-30 and re-measured on 2026-09-05, sample-to-sample implied speed across all 171146 intervals has a 99.9th percentile of 7.35 m/s and a 99.99th percentile of 20.76 m/s.
The threshold sits inside that knee: 50 samples across 31 of 307 runs exceed it.

It deliberately under-detects.
460 samples across 124 of 307 runs exceed the peak speed of this athlete's fastest genuine effort, so most of those are very likely spurious too.
A universal physical bound cannot separate those from real running; that needs a model that is either athlete-relative, comparing an advance against the athlete's own distribution, or trajectory-based, checking the advance against the coordinates, on the hypothesis that a spurious advance is a straight line to a point the athlete reached gradually.
Neither is built, and nor is any correction of a jump: deciding what the athlete did across one is a modelling question rather than a threshold, and a wrong answer would silently rewrite the odometer.

**What the flag asserts and what it does not.**
It asserts an advance in the recorded distance whose implied speed exceeds `IMPLAUSIBLE_SPEED_MPS`, and nothing about what caused it.
A GPS reacquisition is the leading explanation and it is not established: on one half marathon the position advances steadily through the flagged second, about 12% faster than the speed channel, which holds level, while the distance channel alone gains 15.2 m, nearly five times what the speed channel accounts for.
The odometer can be wrong on its own, and every measurement in this section is about the odometer, so none of them depend on the cause.

Because phase 4 consumes this table, an inflated effort that escapes the flag becomes an inflated VDOT and a predicted race time faster than the athlete can run.
The predictions therefore rank by eligibility and never read an effort whose `distance_trusted` is not true, but they cannot see the ones the bound misses.

## The speed-agreement check

The flag says one second of the odometer is impossible.
It does not say how much of the effort that second inflated, and on that half marathon the answer is almost none: the odometer gains 15.16 m in one second, then under a quarter of what the athlete covers in each of the next two, about 7 m of net excess in 21.1 km, 0.03%.
That run is 3.7% faster than the half marathon record then on the ladder, and until 2026-09-27 the flag kept it off.
The maintainer's decision that day, after the measurements below, was to let a flagged effort count when a second channel confirms its distance.

**The second channel is the speed the device measured.**
The Venu 2 Plus writes `enhanced_speed` beside `distance`, and on that run the speed channel holds level through the three seconds in which the odometer credits 16.57 m, 1.8 times what that speed accounts for.
Over a window $[a, b]$ the distance the speed channel accounts for is the trapezoid of each grid interval, clipped to the window:

$$S(a, b) = \sum_i \tfrac{1}{2}\,(v_{i-1} + v_i)\,\big(\min(t_i, b) - \max(t_{i-1}, a)\big)^+$$

The clip honours the fractional window start the sweep interpolates, and for a constant speed $v$ the trapezoid is exact, $S = v\,(b - a)$.
An interval with a null speed at either end contributes nothing, so a metre the speed channel did not see is not a metre it confirms.
That makes an outage inside a flagged window count against the effort, which is the conservative side for a check whose only use is to let an effort back in.

The recorded distance's lead over it is $g = L / S - 1$, and

$$\texttt{distance\_trusted} = \lnot\,\texttt{contains\_jump} \;\lor\; \big(S > 0 \,\land\, |g| \le \tau\big), \qquad \tau = \texttt{SPEED\_AGREEMENT\_TOLERANCE} = 0.01$$

**The check only readmits.**
An effort with no jump is trusted whatever its speed channel says, because the tolerance was measured and decided as a way back in for a flagged effort, not as a second test on clean ones; "Rejected alternatives" below says what the stricter rule would cost.

**A speed channel computed from the distance confirms nothing.**
`ingest.normalize` fills a missing speed channel with the odometer's own derivative, always for GPX and for any FIT whose device wrote no speed field.
That channel agrees with the distance by construction, so `best_efforts.speed_is_measured` tests for exactly that identity on the raw stream, where it holds to floating point, and a stream that fails it has `speed_distance_m` null and cannot readmit anything.
The test is read on the raw stream rather than the 1 Hz grid, because the grid interpolates both channels and the identity no longer holds there.

**Why 1%.**
Measured on 2026-09-27 over the 2175 outdoor efforts in the store, the 2032 unflagged ones run a median 1.6% ahead of their speed channel, and the 143 flagged ones a median 3.3%, with a tail to 447%.
A 1% tolerance readmits only an effort that agrees more closely than a typical clean one.

| $\tau$ | flagged efforts readmitted | from runs | records that change |
| --- | --- | --- | --- |
| 0.5% | 14 of 143 | 3 of 30 | 10 mi, 20 km, half |
| 1% | 26 of 143 | 5 of 30 | 10 mi, 20 km, half |
| 2% | 47 of 143 | 11 of 30 | 10 mi, 20 km, half |
| 3% | 62 of 143 | 18 of 30 | 10 mi, 20 km, half |

The records are the same at every tolerance in that range, so the choice moves which flagged efforts the progression chart draws as eligible, not which runs hold a record.
All three changes are that half marathon run: its half, 20 km and 10 mile windows, which run 0.20%, 0.20% and 0.31% ahead of the measured speed.
Its shorter windows around the jump dilute it less: the 400 m to 5 mile efforts there hold no jump, and the flagged 10 km and 8 miles run 0.44% and 0.43% ahead, which also pass but hold no record.
The five fastest flagged 400 m efforts run 56% to 447% ahead and stay out.

**A whole run gets the same test.**
A route record times the whole run, so `best_efforts.grid_jump_reason` applies the check with $[a, b]$ the whole grid and $L$ the grid's covered distance, catching a jump outside every best-effort window as the flag alone did before.
On the store as of 2026-09-27 it readmits no route run: all 13 route runs that were ineligible for a jump stay ineligible.

## Treadmill efforts are computed, and flagged rather than filtered

A treadmill run's distance comes from an uncalibrated footpod, so a treadmill 5 km is not comparable with an outdoor one and must not become a record or feed a prediction.
That is a fact about the activity rather than about the window, so it lives on `activity_metrics.is_indoor` and consumers join to it.

The efforts are still computed, for two reasons.
The kilometres were run, and the activity view of a treadmill session should show its own fastest kilometre like any other run's.
And a filter here would be one consumer's rule applied to all of them: the records rule is "exclude", the activity view's rule is "show", and the derived layer's job is to make both possible.
`docs/reference/math/tags.md` measures what the records rule is worth: excluding ineligible efforts on both sides of the comparison surfaced eleven genuine records that footpod efforts had been hiding.

## The distance table

`STANDARD_DISTANCES_M` holds twenty-two targets in ascending order, which is the order the records ladder renders in and the order two endpoints sort their items by, so the order is part of the contract rather than an accident of how the dict was typed.

One ascending list rather than a metric row over an imperial one, because the two units interleave: 1 mile falls between 1 km and 2 km, 3 miles between 4 km and 5 km, and 15 miles between the half marathon and 25 km.
A two-row layout aligned on matching numerals would put six of the twenty-two rungs in the wrong place, and this order is the ladder.

| key | metres | unit | added |
| --- | --- | --- | --- |
| `400m` | 400 | metric | phase 1 |
| `1k` | 1 000 | metric | phase 1 |
| `1mi` | 1 609.344 | imperial | phase 1 |
| `2k` | 2 000 | metric | 2026-09-12 |
| `3k` | 3 000 | metric | phase 1 |
| `4k` | 4 000 | metric | 2026-09-12 |
| `3mi` | 4 828.032 | imperial | 2026-09-12 |
| `5k` | 5 000 | metric | phase 1 |
| `6k` | 6 000 | metric | 2026-09-12 |
| `8k` | 8 000 | metric | 2026-09-12 |
| `5mi` | 8 046.72 | imperial | 2026-09-12 |
| `10k` | 10 000 | metric | phase 1 |
| `8mi` | 12 874.752 | imperial | 2026-09-12 |
| `15k` | 15 000 | metric | phase 1 |
| `10mi` | 16 093.44 | imperial | 2026-09-12 |
| `20k` | 20 000 | metric | 2026-09-12 |
| `half` | 21 097.5 | metric | phase 1 |
| `15mi` | 24 140.16 | imperial | 2026-09-12 |
| `25k` | 25 000 | metric | 2026-09-12 |
| `30k` | 30 000 | metric | 2026-09-12 |
| `35k` | 35 000 | metric | 2026-09-12 |
| `marathon` | 42 195 | metric | phase 1 |

Nine of them date from phase 1, and thirteen were added on 2026-09-12: 2 km, 4 km, 6 km, 8 km, 20 km, 25 km, 30 km, 35 km, and the imperial 3, 5, 8, 10 and 15 miles.
A mile is exactly 1609.344 m by international agreement, and every imperial target is that multiplied out rather than rounded.

**The original nine are a second constant, `VDOT_DISTANCES_M`**: 400 m, 1 km, 1 mile, 3 km, 5 km, 10 km, 15 km, half marathon and marathon, derived from this table by key so the two cannot disagree about a distance or fall out of one order.
Extraction, the records ladder, the activity badges and the progression picker all read the twenty-two.
VDOT and the race predictions read the nine, and only those three places do: the candidate selection in `fitness.fitness_rows`, the target list and the inside-the-reserve check in `fitness.race_predictions`, and the input filter in `queries.recent_eligible_efforts`.
The reason is that both of those take a maximum over whatever candidates they are handed, so sharing one set would have made adding a rung to a ladder move `vdot`, `vdot_distance_key` and every predicted time across the whole store.
`docs/reference/math/vo2max.md` argues it at length.

**A distance appears only when it was attempted**, and this needs no mechanism of its own: the sweep returns nothing for a target longer than the run, so the row is absent rather than null.
On the real store the twenty-two targets yield 2680 rows over 307 runs, from 303 at 400 m down to 1 at 25 km.
Three targets have no rows at all, because no run in the store reaches 30 km: 30 km, 35 km and the marathon.

**8 km and 5 miles are 46.7 m apart**, 0.58%, and both are kept deliberately.
On the 90 runs that reach both, the two records differ by 0.59%, as the two distances do.
A runner who thinks in miles is not served by being told the 8 km is close enough, and the cost of the near-duplicate is one row.

**Cost.** The sweep is linear in the samples and runs once per target, so the cost is proportional to the number of targets.
Measured on 2026-09-12 over the 307 runs with the grids already in memory, the extraction itself takes 3.3 s at nine targets and 5.7 s at twenty-two.
The whole `recompute` over the same store takes about 18 s, so the extra targets are not what a rebuild waits on.

## Rejected alternatives

- **Moving time.** Rejected because it makes resting free, derived above.
- **Contiguous moving segments only.** Rejected because it discards distance genuinely covered.
- **Snapping the window start to a sample.** Rejected because the answer then depends on where the samples fall; 1505.0 s against the exact 1500.0 s above.
- **Per-kilometre splits as a proxy.** A split is a fixed window from one kilometre mark to the next; a best effort is the fastest window anywhere. The fastest kilometre of the 2026-08-25 fixture runs from 730.4 to 979 s and does not start on a kilometre mark. Splits are a different product and are computed separately.
- **Correcting jumps in this module.** Rejected on 2026-08-30 in favour of flagging, because deciding what the athlete did across a jump is a modelling question and getting it wrong silently rewrites the odometer.
- **Subtracting the flagged seconds' advance and re-extracting.** Considered on 2026-09-27 as a model-free way to readmit a jump: treat every flagged second as zero distance, so the new time is one the real effort cannot have been slower than. It makes that half marathon 6 s slower, 0.08%, but it also hands the 400 m record, 9% faster than the record it displaces, to a warm-up whose one flagged second is followed by 70 s of the odometer advancing at three to four times what the speed channel reads. The flag under-detects, so removing only what it caught leaves the rest in place. The speed-agreement check sees the whole window instead, and that effort runs 87% ahead.
- **Applying the speed-agreement check to unflagged efforts too.** Deferred on 2026-09-27, then measured and rejected on 2026-10-03, because on a short window the speed channel is the less reliable of the two channels it compares.
  - A flat tolerance cannot work, because most of the gap is an offset per run.
    Over whole runs, measured as `grid_jump_reason` measures one, the recorded distance runs ahead of the speed channel by 0.46% at the 5th percentile, 2.01% at the median and 8.04% at the 99th.
    The 10 km record runs 2.9% ahead, its run's own offset, and a flat 1% would disqualify it with 10 other records.
  - Measured from the run's own offset, the excess concentrates at 400 m and 1 km, and there the speed channel lags the athlete.
    The 400 m record runs 18.5% ahead of its speed channel against a run offset of 4.8%.
    Its window starts 3 s into a manually lapped rep, and for its first 8 s the speed channel reads 0.00 m/s while the odometer advances a tenth of the window and heart rate rises.
    The GPS path over the window is 400.8 m against the odometer's 403.7 m.
  - The record is typical of the excess.
    Of the 74 unflagged 400 m efforts more than 5% ahead of their run's offset, the GPS path agrees with the odometer to a median 0.71%, and 9% hold 10 m or more of odometer advance while the speed channel reads under 0.5 m/s.
    A best effort is the window built around a surge, and the speed channel underreads surges: the median 400 m best effort runs 2.14% ahead of its run's offset, and the median ordinary 400 m window 0.79% behind it.
  - At every cutoff from 2% to 10% over the run's offset, the rule changes one record: the 400 m, made 1.0% slower, against the evidence of the GPS path and the lap.

  The check therefore stays a way back in for flagged efforts only.
  The GPS path is not an independent referee either: on the 33 flagged efforts of 400 m to 1 mile it runs a median 4.7% longer than the odometer, because a reacquisition moves the position with it.
  The under-detection this rule targeted stays open.
- **Excluding treadmill efforts here.** Rejected because it is one consumer's rule, above.
- **Dropping 8 km or 5 miles as near-duplicates.** Rejected above: they are 0.58% apart and a runner who thinks in one unit is not served by the other.
- **Computing a target only once some run has covered it.** Rejected because it is the same answer for more machinery: a target longer than the run already produces no row, so 30 km and 35 km cost one comparison each per run until the day they do not.

## The error that survives

- **End resolution.** Window ends are grid seconds, so an effort is exact to within the residual measured above, at most 0.083 s on the fixtures and bounded by one grid second.
- **Distance interpolation.** `distance_m` between two records is a linear guess with a median error of 0.31 m and a 95th percentile of 1.79 m on the fixtures ([resampling.md](resampling.md)), which at 3 m/s is 0.1 to 0.6 s on the effort.
- **Undetected jumps.** 460 samples across 124 runs exceed the peak speed of the athlete's own best and are not flagged. This is the dominant error and it is one-sided: it only ever makes an effort faster.
- **A readmitted effort keeps its raw time.** The jump inside it is still in it. On that half marathon, the worst case, that none of the flagged second's 15.16 m was run, costs 6 s, 0.08% of its time. The check bounds how far the recorded distance leads the measured speed, not the jump itself, because the measured speed is not ground truth either: it reads a median 1.6% below the odometer on clean efforts.
- **Outage windows.** An effort across an outage reports the outage's average speed, which understates a surge. One-sided in the safe direction.

## Deliberately not modelled

- **Gradient.** A 5 km downhill and a 5 km uphill are the same effort here. Grade adjustment is stage 9 of the pipeline, shelved for the measurement in [README.md](README.md#9-adjust-speed-for-gradient).
- **Efforts spanning activities.** A window lives inside one recording.
- **Non-standard distances.** Twenty-two targets, fixed. Nothing is fitted to an arbitrary distance here; that is what the prediction models in `predictions.md` are for.
- **The marathon in practice.** It is one of the twenty-two and has no rows, because no run in the store reaches 30 km. So are 30 km and 35 km.
- **Any correction of the recorded trace.** Flagged, not fixed, per the 2026-08-30 decision. The speed-agreement check decides whether an effort counts; it changes no metre and no second.
- **Which channel is right when they disagree.** Both come from the same watch. The check asks only whether they agree, which is evidence that the odometer did not jump by more than the tolerance, not a measurement of the true distance.

## Reproduced against the real store

Measured on 2026-09-05 over the 307 runs in the export, which is not committed.
`OWN_PEAK_MPS` is the peak speed of the store's fastest genuine effort, read off that effort's grid.

```bash
uv run python - "$OWN_PEAK_MPS" <<'PY'
import sys
import numpy as np
from pathlib import Path
from activity_analysis.analysis.resample import IMPLAUSIBLE_SPEED_MPS, _interpolate
from activity_analysis.config import Paths
from activity_analysis.store.writer import read_activities, read_streams

paths = Paths(root=Path("."))
acts = read_activities(paths)
OWN_PEAK_MPS = float(sys.argv[1])
imps, over_bound, over_own = [], set(), set()
n_bound = n_own = 0
for aid in acts.loc[acts["sport"] == "running", "activity_id"]:
    s = read_streams(paths, str(aid)).sort_values("t_s")
    t = s["t_s"].to_numpy(float); d = s["distance_m"].to_numpy(float)
    known = ~np.isnan(d); mono = d.copy(); mono[known] = np.maximum.accumulate(d[known])
    dt = np.diff(t)
    with np.errstate(divide="ignore", invalid="ignore"):
        imp = np.nan_to_num(np.where(dt > 0, np.diff(_interpolate(t, t, mono)) / dt, 0.0))
    imps.append(imp)
    if (imp > IMPLAUSIBLE_SPEED_MPS).any():
        over_bound.add(aid); n_bound += int((imp > IMPLAUSIBLE_SPEED_MPS).sum())
    if (imp > OWN_PEAK_MPS).any():
        over_own.add(aid); n_own += int((imp > OWN_PEAK_MPS).sum())
imp = np.concatenate(imps)
print(np.percentile(imp, 99.9), np.percentile(imp, 99.99))   # 7.35 20.76
print(n_bound, len(over_bound), n_own, len(over_own))          # 50 31 460 124
PY
```

The speed-agreement figures, measured on 2026-09-27 after a `recompute` at `ANALYSIS_VERSION` 10, over the 324 runs then in the store:

```bash
uv run python - <<'PY'
import pandas as pd
be = pd.read_parquet("data/derived/best_efforts.parquet")
m = pd.read_parquet("data/derived/activity_metrics.parquet")[["activity_id", "is_indoor"]]
out = be.merge(m)
out = out[~out.is_indoor].assign(gap=out.distance_m / out.speed_distance_m - 1)
clean, flagged = out[~out.contains_jump], out[out.contains_jump]
print(len(out), len(clean), round(clean.gap.median(), 4))       # 2175 2032 0.016
print(len(flagged), round(flagged.gap.median(), 4))            # 143 0.0332
for tol in (0.005, 0.01, 0.02, 0.03):
    ok = flagged[flagged.gap.abs() <= tol]
    print(tol, len(ok), ok.activity_id.nunique())             # 14 3, 26 5, 47 11, 62 18
print(flagged[flagged.distance_key == "400m"].nsmallest(5, "elapsed_time_s").gap.round(3).tolist())
# [4.469, 0.704, 0.874, 0.562, 0.634]
PY
```

The figures that rejected the check on unflagged efforts, measured on 2026-10-03 at `ANALYSIS_VERSION` 11 over the 240 outdoor runs with a measured speed:

```bash
uv run python - <<'PY'
import numpy as np
import pandas as pd
from activity_analysis.analysis.best_efforts import speed_channel_distance_m

derived = "data/derived"
m = pd.read_parquet(f"{derived}/activity_metrics.parquet")[["activity_id", "is_indoor"]]
efforts = pd.read_parquet(f"{derived}/best_efforts.parquet").merge(m)
efforts = efforts[efforts.is_indoor.eq(False) & efforts.speed_distance_m.notna()].copy()

def path_m(lat, lon):
    la, lo = np.radians(lat), np.radians(lon)
    a = np.sin(np.diff(la) / 2) ** 2 + np.cos(la[:-1]) * np.cos(la[1:]) * np.sin(np.diff(lo) / 2) ** 2
    return 2 * 6371008.8 * np.arcsin(np.sqrt(a))

offset, ordinary = {}, []
for aid, rows in efforts.groupby("activity_id"):
    g = pd.read_parquet(f"{derived}/streams_1hz/{aid}.parquet")
    t, d, v = (g[c].to_numpy(float) for c in ("t_s", "distance_m", "speed_mps"))
    step = np.r_[np.nan, path_m(g.lat_deg.to_numpy(float), g.lon_deg.to_numpy(float))]
    advance = np.r_[np.nan, np.diff(d)]
    offset[aid] = (np.nanmax(d) - np.nanmin(d)) / speed_channel_distance_m(t, v, t[0], t[-1]) - 1
    for i, r in rows.iterrows():
        inside = (t > np.floor(r.start_t_s)) & (t <= r.end_t_s)
        efforts.loc[i, "path_m"] = np.nansum(step[inside])
        efforts.loc[i, "dropout_m"] = np.nansum(advance[inside & (v < 0.5)])
    # Ordinary 400 m windows: consecutive from the run's start, none holding a jump.
    ok = ~np.isnan(d)
    tt, dd = t[ok], d[ok]
    for start in np.arange(dd[0], dd[-1] - 400, 400):
        i, j = np.searchsorted(dd, start), np.searchsorted(dd, start + 400)
        if j >= len(dd) or (np.diff(dd[i : j + 1]) / np.diff(tt[i : j + 1]) > 12.5).any():
            continue
        ordinary.append((dd[j] - dd[i]) / speed_channel_distance_m(t, v, tt[i], tt[j]) - 1 - offset[aid])

efforts["excess"] = efforts.distance_m / efforts.speed_distance_m - 1 - efforts.activity_id.map(offset)
efforts["path_gap"] = efforts.path_m / efforts.distance_m - 1
print(np.round(np.quantile(list(offset.values()), [0.05, 0.5, 0.99]) * 100, 2))  # [0.46 2.01 8.04]
clean400 = efforts[~efforts.contains_jump & efforts.distance_key.eq("400m")]
high = clean400[clean400.excess > 0.05]
print(round(clean400.excess.median() * 100, 2), round(float(np.median(ordinary)) * 100, 2))  # 2.14 -0.79
print(len(high), round(high.path_gap.median() * 100, 2), round((high.dropout_m >= 10).mean() * 100))  # 74 0.71 9
short_flagged = efforts[efforts.contains_jump & efforts.distance_key.isin(["400m", "1k", "1mi"])]
print(len(short_flagged), round(short_flagged.path_gap.median() * 100, 1))  # 33 4.7
before = efforts[efforts.distance_trusted].groupby("distance_key").elapsed_time_s.min()
for tau in (0.02, 0.05, 0.10):
    keep = efforts.distance_trusted & ~(~efforts.contains_jump & (efforts.excess > tau))
    after = efforts[keep].groupby("distance_key").elapsed_time_s.min()
    print(tau, {k: (round(float(before[k]), 1), round(float(after[k]), 1)) for k in before.index if after[k] != before[k]})
# 0.02 changes only '400m', 1.0% slower, and the same at 0.05 and 0.1
PY
```
