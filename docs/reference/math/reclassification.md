# Counting a very slow run as a walk

`analysis/reclassification.py`, called by `recompute` once per running activity, right after its 1 Hz grid is built.
This document owns the rule, the alternative each of its terms rejected, its measurements and what it leaves out.

## The rule

An activity recorded as `running` is counted as `walking` when

$$
\bar v = \frac{d_\text{canonical}}{t_\text{moving}} < v_\text{walk} = \frac{1000\ \text{m}}{540\ \text{s}} \approx 1.8519\ \text{m/s},
$$

that is, when its average moving pace is slower than 9:00/km.

- $d_\text{canonical}$ is `activities.distance_m`, the device's session total.
- $t_\text{moving}$ is `activity_metrics.moving_time_s`, the grid's elapsed time less every second inside a detected stop; see `resampling.md`.
- $\bar v$ is therefore exactly `activity_metrics.avg_speed_mps`, the column the efficiency fit's own walk exclusion reads and the API serves as the browser's Pace. The rule adds no second definition of an activity's speed.

A null $\bar v$, from a zero distance or a zero moving time, cannot be judged, and the activity stays a run.
A reclassified activity gets one row in `sport_reclassifications.parquet` and no row in any other derived table, and the DuckDB `activities` view serves `walking` as its `sport`.

## Why each term

**Moving time, not elapsed.**
Elapsed time keeps every stop, so a run with long stops reads as a walk under it.
The real store has that case: one run at a running pace and a running cadence whose long stops make its elapsed pace 1.51 times its moving pace, slower than 9:00/km.
Elapsed time would have counted it as a walk.

**The canonical distance, not the grid's odometer.**
Indoors the grid's odometer is an uncalibrated footpod estimate, while the session total is the device's corrected one, and the two differ by up to 17.6% on the real treadmill runs (`units.md`).
Eight of the ten activities the rule catches are treadmill sessions, so this term decides most of the cases.

**Pace, not cadence.**
Cadence does not separate the two populations at their edges: one activity that stays a run averages a cadence inside the walks' range, at a moving pace faster than 9:00/km.
Pace leaves an empty band between them, below.

**9:00/km.**
The maintainer chose the figure on 2026-10-02.
On the store of 2026-10-06 it falls in an empty band.
The slowest activity left a run is 11.9% quicker than 9:00/km, and the fastest one counted as a walk is 3.5% slower.
Any threshold in that band makes the same decision on today's history, so the choice within it changes nothing measurable.

## What it catches

On the store of 2026-10-06, after the Garmin export was ingested, 10 of the 345 running activities: eight treadmill sessions and two outdoor activities, one a long walk and one under half a kilometre.
Their moving paces run from 3.5% to 40% slower than 9:00/km, the long outdoor walk the slowest.

Every one has a walking cadence: the highest of the ten is 20% below the 5th percentile of the 335 that stay runs.
The long outdoor walk averages a lower heart rate than any of those 335 runs.

Between them they carried:

- 1.6% of the distance recorded as running;
- 52 best efforts, among them a 10 km that sat on the 10 km chart as an eligible effort;
- 70 zone rows;
- one `long_run` flag, on the long outdoor walk, and one `easy` effort tag, on the short one;
- one `fitness_series` row;
- two territory claims, whose new ground between them is $9.7 \times 10^{-6}$ of the territory's area.

None held a record, a route run or an efficiency row.
The efficiency fit already excluded the long outdoor walk under its own 8:00/km walk rule, and its other nine were treadmill sessions or too short.

## Effect on the derived layer

Measured by `recompute` on a copy of the store of 2026-10-06, before and after:

| Table | Before | After |
| --- | --- | --- |
| running activities with a grid | 345 | 335 |
| `best_efforts` | 2948 | 2896 |
| `zone_time` | 2415 | 2345 |
| `activity_tags` | 416 | 414 |
| `fitness_series` | 251 | 250 |
| `activity_efficiency` | 227 | 227 |
| `territory_claims` | 183 | 181 |

The 10 km chart goes from 77 efforts, 64 eligible, to 76 and 63; its slowest eligible effort now takes 58% of the time of the long outdoor walk's 10 km.
The territory total is unchanged to the two decimals of km² it is reported in.

## Reproducing

```bash
uv run activity-analysis recompute   # reports "N run(s) counted as walks"
```

```sql
SELECT a.start_time_utc, a.distance_m, r.avg_speed_mps, a.avg_cadence_spm
FROM sport_reclassifications r JOIN canonical_activities a USING (activity_id)
ORDER BY r.avg_speed_mps;
```

`tests/test_reclassification.py` covers the rule on synthetic paces either side of the threshold, the treadmill case, the long-stop case and the populations a walk leaves.

## Not modelled

- **No per-activity override.** A walk faster than 9:00/km stays a run, and a run slower than 9:00/km becomes a walk. An override needs somewhere to write it, and none exists: the HTTP API is read-only and `recompute` rebuilds the derived layer from the canonical one.
- **Outages count as moving time.** A run with a long recording outage across which the odometer barely advanced keeps those seconds in $t_\text{moving}$ and could fall under the threshold. Nothing in the history is in that state; `efficiency.md` records the same limit for the 8:00/km rule.
- **Only running is judged.** A walk recorded as a hike, or a run recorded as a walk, is left as the device wrote it.
- **The athlete profile is unchanged.** It is versioned from the recorded sport, because an activity started on the running profile carries that profile's settings whatever the athlete then did.
