# The demo store

A store of about three years of running built from the five committed fixture runs and nothing else, for screenshots, demos and trying the app without an export.
`scripts/build_demo_store.py` builds it.
Read this before changing that script or using its output to argue anything about the analysis.

## Building it

```bash
uv run python scripts/build_demo_store.py <root>                    # 156 weeks ending today
uv run python scripts/build_demo_store.py <root> --end 2026-10-16   # a fixed end date
uv run python scripts/build_demo_store.py <root> --weeks 6          # a short history
uv run activity-analysis serve --root <root>
```

`<root>` is a store root, the same as `--root`: the store lands in `<root>/data`.
The script refuses a root whose `data` directory already exists, so it cannot write into a real store.
`--end` must be on or after 2026-08-28, the last fixture run, and `--weeks` at least 3.

The same `--end` and `--weeks` build the same store.
Only the five fixtures' `ingested_at` and the ledger's timestamps differ between two builds, because `ingest` takes them from the clock.
The default `--end` is today, so two builds on different days differ; pass `--end` for anything that has to be rebuilt, such as the README screenshots.
With `--end` today, the last synthetic run can be stamped later in the day than the build ran.

Measured on 2026-10-16 with `--end 2026-10-16`: 179 s wall time and 1.4 GB peak memory, of which `recompute` took 167 s.
Most of that is the project's own territory, best-effort and route passes, which scale with the number of runs and their total length: this store has 572 runs and 681 moving hours, where the real store of 2026-10-06 counts 335 runs.
`tests/test_demo_store.py` builds four weeks twice in about 9 s.

## The README screenshots

`web/scripts/readme-screenshots.mjs` takes them from a running demo store into `docs/images/`; its header has the four commands.
Build with a fixed `--end`, run `tiles` so the maps have a basemap (it sends only the box around the fixtures' area to Protomaps), and look at every image before committing it: they are public, and the privacy scan cannot read pixels.

## How it is built

1. The five fixture FITs and the 2026-08-28 GPX are ingested with `ingest`, so the GPX deduplicates into its FIT as it would in a real export.
   `data/examples/garmin/` is left out: its breathing session is from 2022, outside any demo history.
2. Every other activity is rendered from the fixtures' canonical streams and written through `store/writer.py`: `upsert_activities`, `upsert_laps`, `write_streams` and `upsert_profile_observations`, under the current schemas and `INGEST_VERSION`.
   Each id is `compute_activity_id` of the run's start, so it is what ingesting a FIT starting then would produce.
3. `recompute` builds the derived layer.
4. A Garmin VO2max series is written as a `MetricsMaxMetData` JSON file in the export's own shape, read back with `read_max_met` and stored with `upsert_device_vo2max`, so the Trends VO2max chart has Garmin's line.

**Every activity belongs to the athlete `demo`, the fixtures included.**
An id hashes the athlete with the start minute.
Under the default athlete, a synthetic run starting in the same minute as one of the maintainer's real activities gets that activity's real id, and on the three-year history for `--end 2026-10-16` 7 of 12 seeds tried did.
Under `demo`, no id in the demo store can equal an id from a store built under the default athlete.
Nothing past ingestion reads the athlete id.

## What a synthetic run is

Each synthetic run is one fixture's stream, or several joined end to end, re-timed.
Positions, altitude and the distance channel are the fixture's own, so routes repeat, and every outline on the Territory page is the ground a fixture loop encloses.
Time between two samples is the fixture's divided by a speed scale, and the speed channel is multiplied by the same scale, so the distance and speed channels agree.

| Channel | Change |
| --- | --- |
| Time and speed | Scaled by the session's speed factor times a slow wobble of 1.5% that changes every 10 minutes |
| Heart rate | Shifted by 22 bpm per m/s of speed change, plus a fitness offset falling from 10 bpm to 0, plus 2 bpm of day noise and 1 bpm per sample; drifts 3 bpm per hour past the first, up to 12 bpm; above 188 bpm it rises at 0.4 of the modelled rate |
| Cadence | Shifted by 10 spm per m/s of speed change, plus a fitness offset rising from -4 spm to 0, on samples at or above 120 spm only |
| Laps | Interval sessions keep the fixture's own laps, re-timed. Every other run gets 1 km auto laps. Lap speed, heart rate and cadence come from the rendered samples |
| Stops | 30% of easy, medium and long runs get one stop of 30 to 90 s, at a sample whose distance advances under 8 m, so the gap rule classifies it as a stop |

Loops are only joined when they start from the same point: the 2026-08-21, 08-23 and 08-28 runs share a start, and the 08-25 and 08-26 runs share another 2.5 km away.
A join adds the straight-line distance between one loop's last position and the next loop's first to the odometer, at most about 45 m between these fixtures, covered at the run's speed, so no second advances faster than the run.

The speed factor follows a fitness trend over the 156 weeks before `--end`: a saturating rise from 0 to 1, a 3% seasonal swing peaking in summer, and a dip of 0.18 after the injury that recovers with a 50-day time constant.
Easy-run speed is 90% of the fixture's at fitness 0 and 100% at fitness 1, and every ordinary run is kept at or above 2.15 m/s, so it stays a run under the 9:00/km reclassification and passes the efficiency fit's 8:00/km walk filter.
The constants are at the top of the script.

## The history

| Kind | Built from | Count |
| --- | --- | --- |
| Easy | One of the 08-21, 08-28 or 08-26 loops | 246 |
| Medium | The 08-23 loop, 10.4 km | 112 |
| Intervals | The 08-25 session, with its laps | 71 |
| Long | Two to four joined loops, 13.9 to 30.7 km, lengthening with fitness and in the ten weeks before the ultra | 125 |
| 5 km race | The 08-21 loop at race pace, cut at 5.03 km | 5 |
| 10 km race | The 08-23 loop at race pace, cut at 10.03 km | 4 |
| Half marathon | The 08-23 loop twice, then the 08-21 loop, cut at 21.15 km | 3 |
| Ultra | Eleven joined loops; see below | 1 |

Counts are for `--end 2026-10-16`: 567 synthetic runs plus the five fixtures, 2023-10-24 to 2026-10-16, 6115 km.

Weeks hold 3, 4 or 5 runs, with a long run at the weekend and intervals on a Tuesday or Thursday in most weeks of four or more.
Starts are mornings, lunches and evenings on weekdays and mornings or afternoons at weekends, with `utc_offset_s` from Europe/Stockholm, so it changes with daylight saving time.
The gaps are three random rest weeks of 0 or 1 runs, one run in each Christmas week, and an injury: five weeks with no running 66 to 70 weeks before `--end`, followed by three weeks of 2 or 3 easy runs.
The two fixture weeks, starting 2026-08-17 and 2026-08-24, hold the fixtures and nothing else.

The first 18 weeks of a history of a year or more record no heart rate and no profile messages, as on a watch bought partway through, so the Trends page's heart rate chart starts later than its cadence chart.
The resting heart rate setting changes once, from 70 to 67 bpm, 50 weeks before `--end`, so `athlete_profile` has two intervals.

Races fall 3, 30, 61, 96 and 132 weeks before `--end` for the 5 km, 6, 44, 81 and 116 for the 10 km, and 13, 52 and 105 for the half marathon, so each kind has an effort inside the 90-day prediction window.
Their heart rate swings 0.6 times the fixture's around its median, because a race sits near threshold from the first kilometre.

## The 12 hour ultra

One synthetic run lasts about 12 hours, for checking chart, map and replay performance at ultra length.
The project has no cap on grid size, and real runs longer than 12 hours are expected.

It falls on the Saturday 18 weeks before `--end`, starting between 05:00 and 05:30 local.
It is eleven loops from the 08-21, 08-23 and 08-28 start, in the order 23, 21, 28 three times and then 23 and 21, slowing from 0.93 to 0.77 of the fixtures' speed, with stops of 5, 8, 12 and 6 minutes at four of the joins.

With `--end 2026-10-16` it is activity `9a416f63b5bb9bee`, on 2026-06-13: 89.9 km, 42 677 s elapsed, 1918 s stopped, a moving pace of 7:34/km.
Its 1 Hz grid has 42 678 rows, and `GET /api/activities/9a416f63b5bb9bee/streams` serves 5.8 MB of JSON in 0.1 to 0.2 s.
Every budget `web/scripts/measure-moment.mjs` checks passes on it, recorded under "Replay" in `docs/reference/frontend.md`.
It carries the store's only 35 km and marathon efforts, and is in no route, since nothing else follows its trace.
The six 30.7 km long runs of the ten weeks before it reach 30 km too, and two of them have trusted efforts there; the other four contain the 2026-08-21 loop's jump, described under "Traps".
The id changes with `--end`; the build summary prints it.

## What it shows on the views

Measured on the 2026-10-16 build.

| View | What it has |
| --- | --- |
| Overview | 156 weekly buckets; a current streak of 53 weeks; 52 of the last 52 weeks with a run |
| Trends | 500 runs in the efficiency fit; heart rate at the median reference pace, smoothed, falls from 164.6 bpm in 2024-03 to 153.5 bpm in 2026-10, and cadence there rises from 160.1 to 163.3 spm; 57 of the 500 carry no heart rate |
| Fitness | 572 points; Garmin's line on 504 days, from 48.6 to 53.1 |
| Records | All 22 distances; 5 km in 21:26, 10 km in 44:38, half marathon in 1:45:49 |
| Progression | 5 km: 527 efforts, 500 eligible, 5 records |
| Predictions | All three models at every distance |
| Routes | 12, from 5 to 117 runs each, every one with a record; the five 5 km races form their own route |
| Territory | One region of 7 parts, 4.53 km², claimed by 563 runs |

The figures above are a property of the script's constants and seed.
They are not evidence about any metric: correctness is tested against synthetic fixtures with known analytic answers, as `docs/reference/test-fixtures.md` says.

## Traps

**The 2026-08-21 fixture holds a jump in its distance channel that its speed channel does not confirm.**
One sample advances 13.7 m in 1 s, past `IMPLAUSIBLE_SPEED_MPS`, 12.5 m/s, so the fixture's efforts across it are untrusted.
A run re-timed from it keeps that second past 12.5 m/s on the 1 Hz grid only for some scales and some alignments of its samples against the grid's seconds, so a few of the runs built from that loop are untrusted there and ineligible on their route, and the rest are not.
That is the records rule acting on real data, so the script leaves it in.

**`scripts/privacy_scan.py` cannot clear a store.**
It reads every pair of adjacent int32s in a binary file as a position, and over the 2026-10-16 build's 201 MB of Parquet that gives 147 hits per MB against 100 per MB on random bytes, plus three-byte literal matches inside compressed pages.
Every API response the views read, scanned as text, comes back clean, and the store was checked by reading what it holds: none of its 3 014 695 stream positions or 490 territory vertices lies within a denylisted place, and none of its 572 activity ids or 9343 string values matches a literal or pattern rule.
