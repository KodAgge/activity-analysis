# Time in heart rate zones

How many seconds of a run the heart spent in each of the athlete's configured zones.

Implemented in `src/activity_analysis/analysis/zones.py`.
Tested in `tests/test_zones.py`, against synthetic grids for the arithmetic and, uniquely in this project, against real data for the result: every FIT file carries the device's own `time_in_zone` totals, which is genuine ground truth for a derived metric.

## What is being computed

The athlete's profile supplies $n$ boundaries $B_1 < B_2 < \dots < B_n$ in bpm.
They define $n + 1$ zones, indexed from 0.
A heart rate $h$ falls in zone

$$z(h) = \#\{\, k : B_k \le h \,\},$$

the number of boundaries at or below it.
Zone 0 is everything below $B_1$, zone $n$ everything at or above $B_n$, and zone $k$ for $0 < k < n$ is the half-open interval $[B_k, B_{k+1})$.
Time in zone $k$ is the count of grid seconds that carry a heart rate, are not inside a classified stop, and have $z(h) = k$.

On the 1 Hz grid every row is one second, so counting rows is counting seconds, and the whole computation is one `searchsorted` and one `bincount`.

## Where the boundaries come from

The device supplies them.
The reference fixture's running profile carries 104, 124, 145, 166, 186 and 207 bpm, which is seven zones, and the numbers are not arbitrary: 207 is the configured maximum heart rate and the six boundaries are $\operatorname{round}(p \cdot 207)$ for $p$ = 0.5, 0.6, 0.7, 0.8, 0.9 and 1.0.

| $p$ | $p \cdot 207$ | Boundary |
| --- | --- | --- |
| 0.5 | 103.5 | 104 |
| 0.6 | 124.2 | 124 |
| 0.7 | 144.9 | 145 |
| 0.8 | 165.6 | 166 |
| 0.9 | 186.3 | 186 |
| 1.0 | 207.0 | 207 |

So these are Garmin's default zones, percentages of maximum heart rate, materialised in bpm.
Zone 6, at or above the maximum, exists because the last boundary is the maximum itself and a real heart rate can exceed a configured maximum.

**Why read them from the file rather than compute them from a formula.**
An age formula for maximum heart rate, such as Tanaka's $208 - 0.7 \cdot \text{age}$, has a between-subject standard deviation of about 10 bpm, so a computed zone 3 would be somebody else's zone 3 for a sizeable fraction of athletes.
The device's boundaries are what the athlete has been looking at on the watch and in Garmin Connect for years, so time in zone computed from them matches the number the athlete already knows, which is what makes the oracle below possible at all.
And they are versioned: `athlete_profile` records when the configured maximum changed, so a run from 2024 is scored against the zones in force in 2024 rather than today's.

They are a default rather than the law.
Threshold-based or lactate-based zones are a different model, and so are boundaries the athlete sets by hand; neither is built, because an override needs a writable settings store and the HTTP API is read-only.

## The boundary convention, derived

A recorded heart rate is an integer.
Every one of the 626 samples on the 2026-08-28 reference fixture is, and 48 of them sit exactly on one of the six boundaries.
After interpolation onto the grid, 120 of the 2932 seconds do.
So whether a sample at exactly 166 bpm is zone 3 or zone 4 is not a corner case; it decides where two minutes of this run go.

There are two consistent conventions.

- **Half-open below, a boundary opens its zone:** zone $k$ is $[B_k, B_{k+1})$, so 166 bpm is zone 4. This is `searchsorted(..., side="right")`.
- **Half-open above, a boundary closes its zone:** zone $k$ is $(B_k, B_{k+1}]$, so 166 bpm is zone 3. This is `side="left"`.

Two arguments pick the first, and the second is a measurement.

The definitional one: Garmin defines zone 4 as "80% to 90% of maximum", and a heart rate at 80% of maximum is in zone 4 by the plain reading of that sentence.
A boundary is the floor of the zone it names.

The measured one: the device's own totals settle it.
On the reference fixture, computing both ways and comparing against the `time_in_zone` message the device wrote into the file:

| Zone | Device | Boundary opens its zone | Boundary closes its zone |
| --- | --- | --- | --- |
| 0 | 24.5 | 25 | 26 |
| 1 | 46.0 | 46 | 49 |
| 2 | 331.0 | 336 | 339 |
| 3 | 1997.5 | 2039 | 2140 |
| 4 | 531.9 | 486 | 378 |
| 5 | 0.0 | 0 | 0 |
| 6 | 0.0 | 0 | 0 |
| **largest disagreement** | | **46 s** | **154 s** |

Switching the convention moves 108 seconds out of zone 4 into zone 3 and triples the disagreement with the device.
The device counts a sample on a boundary as belonging to the zone that boundary opens, so this module does too.
`test_a_boundary_value_belongs_to_the_zone_it_opens` pins it.

The alternative would be an off-by-one that produces no error, no warning and no obviously wrong number, only a zone 3 that is quietly two minutes fatter than the watch says.
That is the class of bug this directory exists to prevent.

```python
import numpy as np
from datetime import UTC, datetime
from pathlib import Path
from activity_analysis.analysis.resample import resample_to_1hz
from activity_analysis.ingest.fit_reader import read_fit
from activity_analysis.ingest.normalize import normalize
from activity_analysis.models import SOURCE_STRAVA_FIT

f = Path("data/examples/run-2026-08-28.fit")
s = normalize(read_fit(f), source=SOURCE_STRAVA_FIT, source_file=f.name,
              source_file_sha256="x", athlete_id="t",
              ingested_at=datetime(2026, 8, 29, tzinfo=UTC)).streams
g = resample_to_1hz(s)
B = [104.0, 124.0, 145.0, 166.0, 186.0, 207.0]
hr = g["hr_bpm"].to_numpy(float)
ok = np.isfinite(hr) & ~g["paused"].to_numpy(bool)
device = np.array([24.457, 46.0, 331.0, 1997.533, 531.88, 0.0, 0.0])
for side in ("right", "left"):
    ours = np.bincount(np.searchsorted(B, hr[ok], side=side), minlength=7)
    print(side, ours, np.abs(ours - device).max())
print(int(np.isin(hr[ok], B).sum()))                     # 120 seconds exactly on a boundary
```

## What is excluded, and why

**Seconds inside a classified stop.**
Standing at a crossing with a heart rate of 110 is not training in zone 1.
The `paused` flag from [resampling.md](resampling.md) marks those seconds and they are dropped.
On the current grid heart rate is already null across a stop, so the flag removes nothing the null check did not, but the exclusion is the stated rule and stays explicit so that it holds if the grid ever interpolates a sensor channel across a stop.

**Seconds with no heart rate.**
An unrecorded second is not a measurement, and a measurement is what a zone is counting.
This covers the seconds before a strap connected, the seconds inside a recording outage, and every second of the 84 oldest runs, which carry no heart rate at all.

Together these fix the relation between this table and moving time: `sum(seconds_s)` over a run is at most `moving_time_s`, and it is below it by exactly the length of every outage, because an outage counts as moving and carries no heart rate.
That is by construction rather than by accident, and a consumer that expects the two to agree is wrong.

## The device as a test oracle

Every FIT carries `time_in_zone` messages, per lap and per session, holding the watch's own seconds per zone.
This is the one place in the project where a derived metric has real ground truth on real data, and `tests/test_zones.py::test_agrees_with_the_device_on_the_reference_activity` asserts against it.

The two do not agree exactly and should not be expected to.
The derivation of why is the interesting part.

The device works from its own internal one-second heart rate stream.
This module works from the smart-recorded samples the file actually contains, spaced 1 to 9 s apart, with the seconds between them filled by linear interpolation.
Where the true heart rate crossed a boundary between two records, the interpolated crossing lands wherever the straight line between the two records crosses it, which is generally not the second the real crossing happened.
Each crossing can therefore misplace up to one sampling interval's worth of seconds, and a boundary the athlete hovers near is crossed many times.

On the reference fixture the athlete spent most of the run near the 166 bpm boundary between zones 3 and 4, and that is exactly where the disagreement sits: zone 3 reads 41 s high and zone 4 46 s low against the device, while zones 0 to 2 agree to within 5 s.
The totals agree to 1.1 s, 2932 against 2930.87, because a misplaced second changes which zone it is in and not whether it is counted.

| | Value |
| --- | --- |
| Largest per-zone difference | 46 s, zone 4, out of 2931 |
| Total seconds, this module against the device | 2932 against 2930.87 |
| Zone with the most time, both | zone 3 |

The device's fractional totals, 24.457 s in zone 0, show that it is not counting whole seconds either; how it weights the crossings is not documented and is not modelled here.

**The trap in the message.**
A FIT file also holds a `time_in_zone` message referenced to a `split` rather than a lap or session.
Its boundary tuple is all nulls.
It is not a settings record, and reading it as one would overwrite the real boundaries with nothing, so `fit_reader` checks the tuple's contents rather than only its presence before accepting it.

## Why the table is long rather than wide

`zone_time.parquet` has one row per activity per zone, with `zone_index`, `low_bpm`, `high_bpm` and `seconds_s`, rather than one row per activity with a column per zone.

The number of zones is a device setting, not a constant.
A wide table would fix seven columns into a schema that has to survive an athlete who configures five zones or a future export that carries eight.
And the questions asked of this table are aggregations: a week's zone distribution is

```sql
SELECT zone_index, sum(seconds_s) FROM zone_time
JOIN activities USING (activity_id)
WHERE start_time_utc >= now() - INTERVAL 7 DAY
GROUP BY zone_index ORDER BY zone_index;
```

which on a long table is a `GROUP BY` and on a wide one is an unnest first.
The boundaries travel with each row so that a zone 3 second from 2024 and one from 2026 can be told apart if the profile changed between them.

## Rejected alternatives

- **A maximum heart rate formula.** Rejected because its 10 bpm between-subject error would put the computed zones at odds with the ones the athlete already uses, and would destroy the oracle.
- **Reading the device's totals instead of computing.** Rejected because they are absent from GPX, absent from the 84 oldest runs, and answer only "this activity" rather than "this window": a week's zone distribution, or the seconds of a single best effort, need a computation over the grid. The device's totals are kept as the test oracle instead.
- **A boundary closing its zone.** Rejected by the device's own totals, above.
- **Counting paused seconds.** Rejected because standing still is not time in a zone.
- **A wide table.** Rejected because the zone count is a setting.

## The error that survives

- **Interpolation across boundary crossings**, measured at 46 s in the worst zone out of 2931 on the reference fixture, 1.6%, concentrated at the boundary the athlete ran nearest to. The total is unaffected to within 1.1 s.
- **Zones for runs with no profile.** The 84 oldest runs carry no `zones_target`, and nothing is extrapolated backwards, so they get no zone rows. They also carry no heart rate, so there would have been nothing to count.
- **The sub-second weighting the device applies** at a crossing is not modelled, and is the residual reason the two totals differ in the first decimal.

## Deliberately not modelled

- **Athlete-configured or threshold-based zones.** The boundaries are the device's, versioned by `athlete_profile`. Any other source needs the writable settings store named above.
- **Zones for non-running sports.** `zones_target` is per sport, and the profile this module reads is built from running observations alone. Mixing sports produced 297 spurious profile intervals where the truth was five; see `docs/reference/derived-layer.md`.
- **Time in zone during an outage.** No heart rate was recorded, so none is counted, even though the athlete was running.
- **Fractional attribution of a crossing second.** A second belongs to one zone. The device appears to split it; this module does not, and the difference is inside the residual above.
