# Test fixtures

Living reference for the committed sample data.
Read this before writing ingestion or parsing tests.
Update it when fixtures are added or removed.

## The fixture set

`data/examples/` holds five real Garmin Venu 2 Plus running activities spanning 2026-08-21 to 2026-08-28, roughly 37.5 km in total.
These are the highest-value fixtures available and are committed deliberately.
On 2026-10-16 their positions were moved to near Jönköping by a transform that preserves every distance to within the files' 1 cm resolution, the body measurements in their `user_profile` were replaced with 70.0 kg and 1.75 m, the watch serial with a constant, and the messages fitdecode cannot name were dropped.
Every distance, time, heart rate, cadence, lap and derived value below is unchanged by that; only positions, place names and the profile's body measurements differ from the recordings.
Two files from a Garmin Connect export sit beside them, described under "Garmin export fixtures".

| Date (UTC) | File | Distance | Elapsed | Records | Laps | Avg HR |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-08-21 18:53:01 | `run-2026-08-21.fit` | 6369.1 m | 2449.1 s | 562 | 7 | 152 |
| 2026-08-23 14:44:58 | `run-2026-08-23.fit` | 10432.2 m | 3981.7 s | 872 | 11 | 161 |
| 2026-08-25 15:41:23 | `run-2026-08-25.fit` | 9234.2 m | 3711.6 s | 764 | 14 | 165 |
| 2026-08-26 09:49:02 | `run-2026-08-26.fit` | 4069.2 m | 1791.3 s | 450 | 5 | 140 |
| 2026-08-28 18:19:14 | `run-2026-08-28.fit` | 7456.1 m | 2931.2 s | 626 | 8 | 156 |

The 2026-08-28 run is additionally present as `run-2026-08-28.gpx`, a Strava export of the same activity.
Its positions are the relocated FIT's, to 7 decimals, and everything else in it is as Strava wrote it.
That pair is the cross-format and deduplication fixture.

`scripts/build_demo_store.py` re-times these five runs into a three-year demo store for screenshots; `docs/reference/demo-store.md` describes it.

### Garmin export fixtures

`data/examples/garmin/` holds two files from the 2026-10-04 Garmin Connect export, renamed from `<email>_<upload id>.fit`.
They sit in a subdirectory so the five-run glob above still finds exactly five.

| File | `file_id.type` | What it is |
| --- | --- | --- |
| `breathing.fit` | activity | A guided breathing session, 2022-08-29 14:10:02 UTC, training / breathing, 948.5 s elapsed. 939 records, every one with heart rate and none with distance or position. 178 laps. |
| `monitoring.fit` | monitoring_b | 780 bytes of all-day wellness data: monitoring, stress and respiration messages. |

`breathing.fit` is the no-distance case: 5 breathing sessions and 1 bouldering session in the real export failed normalisation before speed derivation learned to skip a stream without distance.
It is also the duplicated-field case: every lap and its session carry `enhanced_avg_respiration_rate` twice, the field and then an empty copy fitdecode expands from a legacy field, the same shape that emptied the speeds of every Garmin-original running file, and `tests/test_fit_reader.py` reads it to prove the empty copy no longer erases the value.
`monitoring.fit` stands for the export's 31,706 files that are not activities: 16,649 `monitoring_b`, plus the types fitdecode does not name, 44, 49 (sleep) and 41.
The reader stops at their `file_id`, and `tests/test_fit_reader.py` proves it on a copy cut short after 200 bytes.

## Filenames are not identifiers

Strava names a file downloaded on its own after the activity, and "Löpning på kvällen", the GPX's track name, is Strava's default Swedish name for an evening run, so activity names collide freely across the history; a browser saving two of them appends `(1)` and `(2)`.
Any ingestion logic keyed on filename or activity name is wrong.
This is why identity is derived from content.

## Golden values for the 2026-08-28 reference activity

Verified during design, safe to assert against.

| Field | Value |
| --- | --- |
| `record` messages | 626 |
| `lap` messages | 8 |
| sport / sub_sport | running / generic |
| `total_distance` | 7456.06 m |
| `total_elapsed_time` | 2931.205 s |
| `enhanced_avg_speed` | 2.544 m/s |
| `enhanced_max_speed` | 2.855 m/s |
| `avg_heart_rate` | 156 bpm |
| `max_heart_rate` | 172 bpm |
| `avg_running_cadence` | 81 rpm |
| `avg_fractional_cadence` | 0.375, so 81.375 rpm, so **162.75 spm** |
| lap 1 `avg_running_cadence` / `avg_fractional_cadence` | 81 / 0.0546875, so **162.109375 spm** |
| `total_ascent` / `total_descent` | 56 m / 52 m |
| `total_calories` | 660 |
| `total_strides` | 3965 |
| `start_time` | 2026-08-28T18:19:14Z |
| `activity.local_timestamp` - `activity.timestamp` | +7200 s, so the run reads 20:19 local |
| first sample latitude | 57.7708879 |
| first sample longitude | 14.1830235 |

### Fractional cadence is not zero

`avg_fractional_cadence` is a real, non-zero value on both the session and every lap of this fixture.
Ignoring it gives 162 spm where the correct answer is 162.75, and a lap value of 162 where it is 162.109375.
Always apply `(cadence + fractional_cadence) * 2`, never `cadence * 2`.

Record-level and aggregate resolution differ, which matters when asserting on a stream rather than a summary.
Across all 626 records, `fractional_cadence` takes only the values 0.0 and 0.5, so the per-sample quantum is 1 spm.
Lap and session averages use the full FIT scale-128 grid, so their quantum is 1/64 spm.
`docs/reference/math/units.md` has the evidence and the consequences.

## Device field coverage

The Venu 2 Plus does **not** populate step length or any running-dynamics field.
`cycle_length16` is 0 in all 626 records of the reference activity.
Do not build metrics that depend on them.

## Cross-format consistency

Ingesting `run-2026-08-28.fit` and `run-2026-08-28.gpx` must produce the same `activity_id`, the same total distance to within 0.1%, and the same point count, with the FIT copy winning on source priority.
This exercises the deduplication logic against real data.

## What real data is and is not for

Use the real files for ingestion and parsing tests.
Use synthetic fixtures with known analytic answers for analysis maths.
Real noisy data has no independent ground truth, so a test against it proves nothing beyond "the code ran".

There is one exception, and only one.
Every FIT carries the device's own `time_in_zone` totals, which is real ground truth for a derived metric, so `tests/test_zones.py` asserts time in zone against the reference activity.
The tolerance and the reason the two answers differ are in `docs/reference/derived-layer.md`, section "Time in zone".
