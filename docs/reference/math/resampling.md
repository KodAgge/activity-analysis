# Resampling to a uniform 1 Hz grid

How an irregularly sampled recording becomes one row per second, and what each gap in the recording is taken to mean.

Implemented in `src/activity_analysis/analysis/resample.py`.
Tested in `tests/test_resample.py` against synthetic streams with known answers.
Every downstream metric in this project - best efforts, time in zone, the efficiency fits - reads the grid this module produces and never the raw records, so a decision made here is inherited by all of them.

## What the device records

A Garmin watch on smart recording writes a `record` message when something changes and stays quiet when nothing does.
On the 2026-08-28 reference fixture the 626 records are spaced as follows:

| Interval | 1 s | 2 s | 3 s | 4 s | 5 s | 6 s | 7 s | 8 s | 9 s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Records | 99 | 87 | 71 | 47 | 47 | 61 | 73 | 115 | 25 |

The range is 1 to 9 s, and the distribution is bimodal: dense at 1 to 3 s while pace or heart rate is changing, sparse at 7 to 8 s while the athlete cruises.
Across the whole store, 99.09% of all 171146 sample intervals are at or below 9 s.
Two of the five committed fixtures reach beyond that: one has a single 12 s interval, and the 2026-08-25 fixture has a 20 s and a 377 s interval, which are the two stops used as examples below.

```python
import numpy as np
from datetime import UTC, datetime
from pathlib import Path
from activity_analysis.ingest.fit_reader import read_fit
from activity_analysis.ingest.normalize import normalize
from activity_analysis.models import SOURCE_STRAVA_FIT

f = Path("data/examples/run-2026-08-28.fit")
streams = normalize(read_fit(f), source=SOURCE_STRAVA_FIT, source_file=f.name,
                    source_file_sha256="x", athlete_id="t",
                    ingested_at=datetime(2026, 8, 29, tzinfo=UTC)).streams
dt = np.diff(np.sort(streams["t_s"].to_numpy(float)))
print(dict(zip(*np.unique(dt, return_counts=True))))
```

## Why a uniform grid at all

Every trend metric here is a statistic over a window of time: a mean over thirty seconds, a fit over a run, a count of seconds in a zone.
On an irregular grid the plain sample mean of a channel $v$ over a window is

$$\bar v_{\text{samples}} = \frac{1}{N} \sum_{i=1}^{N} v_i,$$

which gives every sample the same weight whatever stretch of time it stands for.
The quantity the metric actually wants is the time average,

$$\bar v_{\text{time}} = \frac{1}{T} \int_0^T v(t)\,dt \approx \frac{1}{T} \sum_{i} v_i\,\Delta t_i,$$

and the two differ exactly when the sampling interval $\Delta t_i$ correlates with the signal.
Smart recording guarantees that it does: the device samples densely while heart rate and pace are changing and sparsely while they are steady, so the sample mean over-weights the transitions.

Measured on the reference fixture, the sample mean of heart rate is 154.55 bpm and the time-weighted mean over the grid is 155.83 bpm, a 1.28 bpm difference on a run with a 25 bpm range.
Over the five fixtures the difference runs from -1.47 to +0.25 bpm for heart rate and up to 0.064 m/s for speed.
That is small on a whole run and not small inside a thirty-second window, where a burst of 1 s samples can outnumber the 8 s samples ten to one while covering a fifth of the time.

Two ways to fix it were considered.

**Weight every downstream statistic by $\Delta t_i$.**
Rejected because every consumer would carry the same weights, every window would have to be defined in samples rather than seconds, and a "30 second window" would hold anywhere from 4 to 30 samples depending on how the athlete happened to be running.
The weighting is not hard; having it in six places is.

**Resample once onto a uniform grid, and let every consumer count rows.**
Chosen.
The interpolation cost is paid once, in one module, and everything downstream is arithmetic over rows of equal duration: a mean is a mean, a window is a row count, a second in a zone is a row.
One second is the grid spacing because it is the finest interval the device records at, so nothing recorded is thrown away, and because the watch itself works internally at 1 Hz, which is what makes its own `time_in_zone` totals a usable oracle in [zones.md](zones.md).

## Linear interpolation, and what it costs

For a channel with samples $v_i$ at times $t_i$, the grid value at a second $t$ with $t_i \le t < t_{i+1}$ is

$$\hat v(t) = v_i + \frac{t - t_i}{t_{i+1} - t_i}\,(v_{i+1} - v_i).$$

This is applied to `distance_m`, `altitude_m`, `lat_deg`, `lon_deg`, `hr_bpm`, `cadence_spm` and `speed_mps`, each between the first and last second it was recorded.
Nothing is extrapolated: a heart rate strap that connected four seconds into the run did not measure those four seconds, so they are null rather than backfilled.

For a signal with bounded second derivative the interpolation error on an interval of length $h$ is bounded by

$$|v(t) - \hat v(t)| \le \frac{h^2}{8}\,\max |v''|,$$

which is why the 8 s intervals matter and the 1 s ones do not.
The bound is not directly usable because $v''$ of a heart rate is not known, so the error was measured instead, by leaving out every sample that has a recorded neighbour on each side, interpolating it from those neighbours, and comparing.
Over the five fixtures, 3264 samples qualify:

| Channel | Median absolute error | 95th percentile | Largest |
| --- | --- | --- | --- |
| `distance_m` | 0.31 m | 1.79 m | 9.4 m |
| `hr_bpm` | 0.33 bpm | 1.67 bpm | 9 bpm |
| `cadence_spm` | 0.68 spm | 3.5 spm | 165 spm |
| `altitude_m` | 0.10 m | 0.40 m | 1.05 m |

The cadence outlier is a sample where the athlete stopped striding between two samples that show a running cadence, which no interpolation can recover and which is why the metrics that read cadence fit over thousands of seconds rather than reading any one.

```python
import numpy as np
from datetime import UTC, datetime
from pathlib import Path
from activity_analysis.ingest.fit_reader import read_fit
from activity_analysis.ingest.normalize import normalize
from activity_analysis.models import SOURCE_STRAVA_FIT

errors: dict[str, list[np.ndarray]] = {c: [] for c in ("distance_m", "hr_bpm", "cadence_spm", "altitude_m")}
for f in sorted(Path("data/examples").glob("*.fit")):
    s = normalize(read_fit(f), source=SOURCE_STRAVA_FIT, source_file=f.name,
                  source_file_sha256="x", athlete_id="t",
                  ingested_at=datetime(2026, 8, 29, tzinfo=UTC)).streams
    s = s.sort_values("t_s").reset_index(drop=True)
    t = s["t_s"].to_numpy(float)
    for c in errors:
        v = s[c].to_numpy(float)
        ok = np.isfinite(v)
        i = np.arange(1, len(t) - 1)
        i = i[ok[i - 1] & ok[i] & ok[i + 1]]
        frac = (t[i] - t[i - 1]) / (t[i + 1] - t[i - 1])
        errors[c].append(np.abs(v[i - 1] + frac * (v[i + 1] - v[i - 1]) - v[i]))
for c, e in errors.items():
    e = np.concatenate(e)
    print(c, len(e), np.median(e), np.percentile(e, 95), e.max())
```

### Position: the chord and the arc

Interpolating `lat_deg` and `lon_deg` linearly draws a straight chord between two fixes.
The athlete ran an arc.
For a chord of length $c$ on a circular path of radius $R$, the arc is longer than the chord by

$$2R \arcsin\frac{c}{2R} - c \approx \frac{c^3}{24 R^2},$$

and the midpoint of the chord sits inside the true path by the sagitta

$$R - \sqrt{R^2 - c^2/4} \approx \frac{c^2}{8R}.$$

At 3 m/s across a 9 s interval the chord is 27 m.
Around a street corner of radius 20 m the drawn track cuts 4.6 m inside the true one and the chord is 0.34 m, or 1.3%, shorter than the arc.

This affects the drawn route and nothing else, and the reason is a design decision recorded in [geodesy.md](geodesy.md): distance on a FIT activity is the device odometer, interpolated as a channel of its own, never re-derived from the interpolated coordinates.
The corner cut therefore never reaches a speed, a best effort or a fit.
Smoothing the coordinates to hide it was considered and rejected there, because smoothing coordinates cuts corners further, and the raw fixes are the record.

## The gap rule, derived from the measurement

An interval between two samples longer than the device's ordinary spacing is one of three things: ordinary smart recording that ran a little long, the athlete standing still, or the device failing to record while the athlete kept moving.
The grid has to tell them apart, because the three have different consequences for moving time and for the sensor channels.

The obvious rule is a duration threshold, and it does not work.
Measured over all 171146 intervals in the 307 runs on 2026-09-05, grouped by duration, with the implied speed across the interval being the odometer's advance divided by its length:

| Duration band | Intervals | Runs | Median implied speed | Reading |
| --- | --- | --- | --- | --- |
| at or below 9 s | 169 586 | 307 | - | ordinary smart recording, 99.09% of everything |
| 10 to 14 s | 1433 | 131 | 1.60 m/s | still running |
| 15 to 19 s | 62 | - | - | mixed: 31 of 62 under 0.5 m/s |
| 20 to 30 s | 40 | - | 0.11 m/s | stopped |

At 10 to 14 seconds the athlete was, by the odometer, still running at 1.60 m/s.
Nulling those intervals would tear holes in 131 of 307 runs for no reason.
At 20 to 30 seconds the athlete had stopped: 0.11 m/s is GPS drift while standing.
The 15 to 19 second band is a coin toss on duration alone, half stopped and half not, and only the distance channel separates the two.

So the rule needs both quantities.

**A stop** is an interval longer than `PAUSE_MIN_GAP_S`, 15 s, across which the implied speed is below `PAUSE_MAX_IMPLIED_SPEED_MPS`, 0.5 m/s.
The 15 s sits above the 9 s ceiling of ordinary recording with the 10 to 14 s band as margin.
The 0.5 m/s sits between the 0.11 m/s of a standing athlete's GPS drift and the 1.60 m/s of the slowest band that was still running, and below walking speed of roughly 1.4 m/s, so no form of locomotion reads as a stop.

**An outage** is an interval longer than `PAUSE_UNCONDITIONAL_GAP_S`, 120 s, that is not a stop.
The odometer advanced at 0.5 m/s or more, so the athlete moved, but nothing plausible keeps a running watch silent for two minutes mid-effort, so this was not smart recording either.
The device stopped observing while the run went on.

**Everything else is ordinary recording**, including an interval of 15 to 120 s across which the athlete kept moving.
Every channel interpolates across it and its seconds count as measured.

The two classified kinds are not interchangeable, and this is the load-bearing part.
A stop is time the athlete was not training, so its seconds leave moving time.
An outage is time the athlete was training unobserved, so its seconds stay in it.
Neither kind reaches time in zone, because heart rate is null across both and a second with no heart rate is not a measurement; see [zones.md](zones.md).

On the 2026-08-25 fixture the rule finds two stops and nothing else:

| Interval | Advance | Implied speed | Classification |
| --- | --- | --- | --- |
| 705 to 725 s, 20 s | 0.42 m | 0.021 m/s | stop |
| 2806 to 3183 s, 377 s | 0.10 m | 0.0003 m/s | stop |

```python
import numpy as np
from datetime import UTC, datetime
from pathlib import Path
from activity_analysis.analysis.resample import find_gaps
from activity_analysis.ingest.fit_reader import read_fit
from activity_analysis.ingest.normalize import normalize
from activity_analysis.models import SOURCE_STRAVA_FIT

f = Path("data/examples/run-2026-08-25.fit")
s = normalize(read_fit(f), source=SOURCE_STRAVA_FIT, source_file=f.name,
              source_file_sha256="x", athlete_id="t",
              ingested_at=datetime(2026, 8, 29, tzinfo=UTC)).streams.sort_values("t_s")
t = s["t_s"].to_numpy(float)
d = s["distance_m"].to_numpy(float)
for gap in find_gaps(t, d):
    i = int(np.searchsorted(t, gap.start_t_s))
    print(gap.kind, gap.start_t_s, gap.end_t_s, d[i + 1] - d[i])
```

The whole-store table above cannot be reproduced from the committed fixtures, since the full history is not in the repository.
It was re-measured on 2026-09-05 with the snippet under "Reproduced against the real store" below.
The earlier measurement of 2026-08-29 counted 110 runs in the 10 to 14 s band against 131 here; the interval count, 1433, and the median speed, 1.60 m/s, are unchanged, so the difference is in how a run was counted rather than in the data.

## Why the grid never holds distance across a gap

The first version of this module held `distance_m` flat across a classified stop and let it jump to the next sample's value on the second the recording resumed.
The reasoning was that a stop should not become a slow kilometre.
It was wrong twice over, and the derivation of why is the most important thing in this document.

Write the odometer reading before a gap as $d_0$ at $t_0$ and after it as $d_1$ at $t_1$, with $\Delta d = d_1 - d_0$ and $\Delta t = t_1 - t_0$.
Holding makes the grid read $d_0$ for every second in $(t_0, t_1)$ and $d_1$ at $t_1$, so the whole advance $\Delta d$ lands in the one second ending at $t_1$ and the implied speed on the grid there is $\Delta d$ per second.
Interpolating spreads it as $\Delta d / \Delta t$ per second across the gap.

**First, holding never helped.**
A genuine stop advances the odometer by approximately nothing: 0.42 m over 20 s and 0.10 m over 377 s on the fixture above.
Interpolating that adds approximately nothing per second, so the stop still does not become a slow kilometre.
The problem holding was built to solve did not exist.

**Second, holding fabricates speed.**
When the odometer does advance across a gap, holding compresses the advance into one second.
Two real cases were caught on 2026-08-29.
A 150 s outage across which the odometer advanced at the athlete's ordinary running speed became a single grid second carrying the whole advance, and `best_effort` interpolated a window start inside that second and reported a 400 m effort of 0.89 s.
A 300 s stop across which GPS drift advanced the odometer 140 m became a 140 m second, and the extractor found 400 m in 88 s at 4.5 m/s, faster than any genuine 400 m in the history.
Both carried `contains_pause` false, because the window as computed lay entirely inside the resume second, so no consumer could have filtered them.

Spread across the seconds they actually occupied, the same advances are the athlete's ordinary running speed across the outage and 0.47 m/s across the stop, which cannot trouble any best effort.

The invariant this restores is stated in [best-efforts.md](best-efforts.md): under elapsed time, a pause can only ever make an effort slower.
Holding was the one thing in the pipeline that could make a stop produce a faster effort, and removing it is what makes the flags on a best effort observability rather than corrections.
`test_an_outage_cannot_manufacture_an_impossibly_fast_effort` and `test_a_stop_the_odometer_advanced_across_cannot_manufacture_a_fast_effort` are the two cases, kept as regression tests.

Only the sensor channels, `speed_mps`, `hr_bpm` and `cadence_spm`, are nulled across a classified gap.
Nothing measured them there, so nothing may be invented for them.
Distance and the positional channels interpolate, because the odometer and the track are the record of what happened and spreading their advance over the seconds it took is the honest reading of that record.

## Why a row is still emitted for every second of a gap

The grid runs from the first record to the last at one row per second, including the 377 seconds of the long stop on the fixture above: 3714 rows, of which 3319 are moving and 395 are paused.

Dropping the paused rows would be simpler and would break best efforts.
Those are measured in elapsed time and their windows span pauses, so a run of 5 km, a five-minute stop and another 5 km has to yield a 10 km effort of 65 minutes.
That needs the clock to keep running through the stop, which needs the rows to exist.
Moving time is a different quantity, and it is the `paused` flag's job to carry it: `moving_time_s` is the count of unpaused rows, so the same grid answers both questions.

## Rejected alternatives

- **A duration-only gap rule.** Rejected on the measured table: the 10 to 14 s band is still running and the 15 to 19 s band is half and half, so duration alone either nulls a third of the history or misses half the stops.
- **Per-sample weighting instead of a grid.** Rejected because it puts the same weights into every consumer and defines windows in samples rather than seconds.
- **Holding rather than interpolating across gaps.** Rejected on two real fabricated efforts, above.
- **Step interpolation for the sensor channels.** Holding a heart rate flat between samples produces a staircase whose steps sit exactly on the zone boundaries this project counts seconds against, so every 8 s interval would dump its whole duration into one zone. Linear interpolation splits the crossing second in proportion instead.
- **A coarser grid**, at 5 s say. Rejected because the device records at 1 s when the signal changes and a coarser grid would throw those samples away in exactly the stretches where they carry information.
- **Smoothing the coordinates.** Rejected in [geodesy.md](geodesy.md): the fixes are the record, and the corner cut never reaches a metric because distance comes from the odometer.

## The error that survives

- **Interpolation error** as measured above: 0.3 m and 0.3 bpm at the median, 1.8 m and 1.7 bpm at the 95th percentile, over intervals of up to 9 s. A best effort at 3 m/s inherits about 0.1 s from the distance component.
- **The 15 to 19 s band** is classified by distance, so a shuffle slower than 0.5 m/s across 16 s reads as a stop. That is the correct reading of "not running", and it is stated here because it is where a borderline case would land.
- **An outage's seconds carry the outage's own average speed.** A surge inside an unobserved two minutes is invisible, and a best effort measured across it understates rather than overstates, which is the safe direction and is flagged with `contains_outage`.
- **The gap rule cannot see a stop shorter than 15 s.** A ten-second pause at a crossing interpolates as ordinary recording, with its near-zero advance spread as a very slow ten seconds. It stays in moving time, which slightly understates moving pace on a run with many short stops.

## Deliberately not modelled

- **Smoothing of any channel.** The grid reproduces the recorded samples exactly at the recorded times and interpolates between them. Filtering belongs to the consumer that knows what it is filtering for.
- **Jumps in the distance trace.** An advance faster than a human can move is flagged downstream by `contains_jump` on a best effort and is not corrected here; the trace stays as the device wrote it. The flag names the odometer rather than the GPS, because that is what it is defined on and the two do not always fail together. [best-efforts.md](best-efforts.md) measures how far the flag under-detects and says why no correction is built.
- **Sub-second timing.** Records carry whole-second timestamps and so does the grid.
- **What the athlete did during an outage.** Distance interpolates at the outage's average, and no attempt is made to reconstruct the pace profile inside it.

## Reproduced against the real store

Measured on 2026-09-05 over the 307 runs in the export, which is not committed.

```bash
uv run python - <<'PY'
import numpy as np
from pathlib import Path
from activity_analysis.config import Paths
from activity_analysis.analysis.resample import _interpolate, PAUSE_MAX_IMPLIED_SPEED_MPS
from activity_analysis.store.writer import read_activities, read_streams

paths = Paths(root=Path("."))
acts = read_activities(paths)
dts, imps, runs_10_14 = [], [], set()
for aid in acts.loc[acts["sport"] == "running", "activity_id"]:
    s = read_streams(paths, str(aid)).sort_values("t_s")
    t = s["t_s"].to_numpy(float); d = s["distance_m"].to_numpy(float)
    known = ~np.isnan(d); mono = d.copy(); mono[known] = np.maximum.accumulate(d[known])
    dt = np.diff(t); dd = np.diff(_interpolate(t, t, mono))
    with np.errstate(divide="ignore", invalid="ignore"):
        imp = np.where(dt > 0, dd / dt, np.nan)
    dts.append(dt); imps.append(imp)
    if ((dt >= 10) & (dt <= 14)).any():
        runs_10_14.add(aid)
dt = np.concatenate(dts); imp = np.concatenate(imps)
print(dt.size, (dt <= 9).mean())                                   # 171146 0.9909
b = (dt >= 10) & (dt <= 14); print(b.sum(), len(runs_10_14), np.nanmedian(imp[b]))   # 1433 131 1.60
b = (dt >= 15) & (dt < 20); print(b.sum(), (imp[b] < PAUSE_MAX_IMPLIED_SPEED_MPS).sum())  # 62 31
b = (dt >= 20) & (dt <= 30); print(b.sum(), np.nanmedian(imp[b]))  # 40 0.11
PY
```
