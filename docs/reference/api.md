# The API

The HTTP read layer over the canonical and derived stores.
Phase 3a. FastAPI, read-only, bound to localhost.

Start it with:

```bash
uv run activity-analysis serve            # http://127.0.0.1:8000
uv run activity-analysis serve --port 9000
```

There is no authentication, so the default bind is loopback and that is the premise the rest of this file rests on.
`--host` can override it, and `serve` echoes a warning when the resolved host is not a loopback address: the store is one athlete's real GPS traces, and anyone who can reach the port can read all of them.

Interactive documentation is at `/docs` and the OpenAPI schema at `/openapi.json`.
When a frontend build exists, `serve` also mounts it at `/` after every API route, so it never shadows one; see "Develop it with" in `docs/reference/frontend.md`.
The mount is not part of the OpenAPI schema.

The store is the one `--root` names, else `ACTIVITY_ANALYSIS_HOME`, else the platform's user data directory (`config.default_paths`); `/api/health` reports it as `root`.
Phase 3b generates its TypeScript client from that schema, which is why `tests/test_api_health.py` pins the endpoint set and the field names.

This file is the API's reference: what the endpoints are, what they return, why they are shaped that way, and what is easy to get wrong.

It is also where this layer's measured figures live.
The docstrings and comments in `src/activity_analysis/api/`, and `store.db.read_grid` which the stream route calls, state why the code is shaped the way it is and cite this file for the numbers, rather than restating values that would drift from it silently.
So a remeasurement lands here.

## The contract

**Everything is SI, with the unit in the field name.**
`distance_m`, `avg_hr_bpm`, `avg_cadence_spm`, `speed_mps`, `seconds_s`.
Pace, kilometres, minutes per kilometre and local formatting are the frontend's job.
There is no `pace` field anywhere and there will not be one.

**Time crosses the boundary as an instant plus an offset.**

```
start_time_utc  the instant, always serialised as UTC with a trailing Z
utc_offset_s    the offset the watch was set to; null for GPX
```

Local wall clock is `start_time_utc + utc_offset_s`, computed by the frontend.
A GPX-sourced activity records no offset, so the frontend renders those as UTC and marks them as such rather than guessing.

**`moving_time_s` is always the derived layer's, wherever it appears.**
It is `elapsed - paused` from the 1 Hz grid under this project's 15 s and 0.5 m/s pause rule.
`ActivitySummary` - the browser row, and the summary block of the detail response - carries it via a `LEFT JOIN` onto `activity_metrics.moving_time_s`, the same source `derived.metrics.moving_time_s` reads and the overview's buckets sum, so a summary and a derived block for the same activity never disagree under this name.
Null for every activity the derived layer does not cover, which is every sport but running, and for a running one ingested but not yet recomputed.
`ActivitySummary` also carries `timer_time_s`, the device's own timer, which stops under the device's auto-pause setting rather than this project's rule; the two can differ by close to 44 minutes on the longest real run, so a client after moving time should read `moving_time_s`, not `timer_time_s`.
The canonical layer separately stores a same-named `activities.moving_time_s` column that is a byte-identical duplicate of `timer_time_s`; nothing in the API reads it, and dropping the duplicate is not done yet.

**`avg_speed_mps` is the derived layer's**, from `ANALYSIS_VERSION` 7, read from `activity_metrics` and not computed here.
`analysis/metrics.py` stores it as the activity's canonical distance over this project's moving time, so **a row served that value multiplies out**: the numerator is the same `distance_m` this response carries and the denominator the same `moving_time_s` beside it, and a client rendering all three shows one distance rather than two.
The numerator is the canonical distance rather than the 1 Hz grid's odometer because the two are not the same number indoors, where there is no satellite fix and the stream's distance is a footpod estimate; `docs/reference/math/units.md` has the measurement and the argument.

The canonical `activities.avg_speed_mps` is the device's average over its own auto-paused timer rather than this project's moving time, and was null on most real runs before `INGEST_VERSION` 3; since the forced re-ingest of 2026-10-16 it is set on all 335 runs.
`docs/reference/math/units.md`, "Coverage", has the counts and the cause.
It survives only as the fallback in `coalesce(activity_metrics.avg_speed_mps, activities.avg_speed_mps)`, which fires where the derived column has no value: every sport but running, since the derived layer covers running alone, and the degenerate running rows whose distance or moving time is not positive.
**A client cannot tell from the row which of the two it received**, and the response carries no flag that would say.
That is accepted rather than overlooked.
How far apart the two can be is measured in `docs/reference/math/units.md`, and that table rather than any summary of it is the answer: they differ on treadmill runs, on non-running activities, on rows whose distance or moving time is not positive, and on the eight outdoor rows where the device's auto-paused timer parts company with this project's moving time.
A consumer that genuinely needed to distinguish them would need the API to serve a flag, and it does not.
The `sort=avg_speed_mps` ordering evaluates the identical coalesce, so the browser never sorts by one number and shows another.

**The API computes nothing that `analysis/` owns.**
Every number is read from a Parquet column or produced by an aggregate DuckDB evaluates in the query.
The single exception is the streak, which is new, and it lives in `analysis/consistency.py` with synthetic-fixture tests and a derivation under `docs/reference/math/`.

**The server never writes to `data/`.**
Ingestion and `recompute` stay in the CLI.

## Endpoints

| endpoint | serves |
| --- | --- |
| `GET /api/health` | store paths, row counts per table, stored versus expected schema versions, `stale` |
| `GET /api/sports` | sport values with counts, for the filter |
| `GET /api/activities` | one page of the browser, with the total beyond it |
| `GET /api/activities/{id}` | summary, laps, and the derived blocks |
| `GET /api/activities/{id}/streams` | the 1 Hz grid, column-major |
| `GET /api/overview` | weekly and monthly volume, zone totals, streak, consistency |
| `GET /api/records` | the best eligible effort at each extracted distance |
| `GET /api/trends` | heart rate and cadence at each of three reference paces raw and smoothed, the shrunk slope and its weight, decoupling raw and smoothed, per activity |
| `GET /api/distributions` | every running activity, one row each, with every value the Distributions view buckets |
| `GET /api/fitness` | the smoothed VO2max series, both methods, with the raw per-activity points, and Garmin's own VO2max by day |
| `GET /api/predictions` | two race models as a range from the best recent effort, plus the calibrated prediction from ordinary runs with its band, or an explicit insufficient-data state |
| `GET /api/progression/{distance_key}` | every effort at one distance with its eligibility and record status; 404 for a key the extractor does not know and for a distance with no efforts |
| `GET /api/routes` | every recurring route: name, run count, median distance, first and last run, and its current record |
| `GET /api/routes/{route_id}` | one route's runs in time order, each with speed, direction, eligibility, rank and record flag; 404 for an unknown id |
| `GET /api/territory` | all the ground outdoor loop runs have claimed: the total, the counts, the union as GeoJSON, the regions with their boxes, and the growth series |
| `GET /api/basemap` | the fetched basemap areas, each with its id and box, plus the attribution text every served map must carry |
| `GET /api/basemap/areas/{area_id}.pmtiles` | one area's `.pmtiles` archive, whole or by byte range |
| `GET /api/basemap/assets/{path}` | one glyph range or sprite file the map style needs |

### `GET /api/activities`

| parameter | default | notes |
| --- | --- | --- |
| `sport` | `running` | A value from `/api/sports`. `all` turns the filter off; `unknown` selects the activities whose sport is null, which is what GPX ingestion records and what `/api/sports` reports as a null bucket. The browser covers every sport; the default is running because that is the training this application is about. |
| `from`, `to` | none | Compared against the activity's **local calendar date**, `start_time_utc` shifted by `utc_offset_s`, so a run belongs to the day the athlete ran it and the filter agrees with the overview's weekly buckets. `from` is inclusive and `to` is exclusive; to cover through the 31st, send the 1st of the next month. Both bounds carry that in their OpenAPI `description`, since a client author cannot infer it from `string($date)`. |
| `source` | none | `garmin_fit`, `strava_fit` or `gpx`, closed as an enum in the schema. Anything else is a 422 rather than an empty page, which would be indistinguishable from no matching data. |
| `has_hr` | none | True selects activities with an average heart rate. |
| `has_pr` | none | True selects the activities that set a personal record at some distance, false those that set none. The two partition the list. The analysis layer decides what a record is - see `GET /api/records`. |
| `min_distance_m`, `max_distance_m` | none | Inclusive bounds on the activity's own distance, **in metres**. SI at this boundary like every other quantity, so a client that renders kilometres converts on the way in and out. |
| `min_moving_time_s`, `max_moving_time_s` | none | Inclusive bounds **in seconds** on `activity_metrics.moving_time_s` - the same derived value the response shows under that name, never the canonical column of the same name. An activity with no derived layer has no moving time to compare and falls out of the filter rather than being coerced into passing it: that is 1637 of 1944 rows in the real store. |
| `q` | none | Substring of the activity name. A convenience only: names are Strava's Swedish defaults and collide freely, so `q` narrows a list and never identifies an activity. |
| `sort` | `start_time_utc` | Also `distance_m`, `elapsed_time_s`, `moving_time_s`, `avg_speed_mps` or `avg_hr_bpm`. `avg_speed_mps` is how a **pace** sort is expressed: no pace is stored anywhere (see CLAUDE.md, "Never store pace"), so a pace ordering is a speed ordering and the direction inverts - descending speed is ascending pace, which is why a client asking for "fastest first" sends `order=desc`. Naming a virtual `pace` key here would put a unit conversion in the query layer for the one column that has one. Anything else is a 422. `moving_time_s` sorts by `activity_metrics.moving_time_s`, the same derived value the response itself shows under that name (see "The contract" above) - never the canonical `activities` column of the same name, which is a byte-identical duplicate of `timer_time_s`. It is null for every activity the derived layer does not cover, which is 1637 of 1944 rows in the real store, and `NULLS LAST` applies regardless of `order` so those rows sort to the bottom rather than scattering through the page. |
| `order` | `desc` | |
| `limit` | 50 | Capped at 200. |
| `offset` | 0 | |

**`total` counts the same rows the page returns.**
It is taken over the same joined FROM clause, not over `activities` alone.
The moving-time and personal-record filters live on joined tables, so a total from the canonical table would have left the pager promising more results than the list could reach.

**The list is ordered by instant, not by local wall clock**, which are not the same order across an offset change.
Ordering by the instant keeps the list in the order the runs happened, at the cost that two adjacent rows can show times that look out of sequence when the athlete travelled.
`activity_id` breaks ties, so paging cannot show one activity twice while dropping another.

### `GET /api/activities/{id}`

`summary` and `laps` are present for any activity.
`laps` is served in `lap_index` order - `queries.laps` sorts with `ORDER BY lap_index` rather than leaving it to whatever order the store happens to hold, and `test_laps_are_served_in_lap_index_order_even_when_stored_out_of_order` pins it against a store with one activity's laps deliberately stored reversed, not just against the fixture store's own on-disk order, which already happens to agree and would not catch the `ORDER BY` being dropped.
This is a guarantee, not an incidental property, because the analysis layer's per-lap `rep_pattern` (see `ActivityTag`, below) is positional: one pattern character per lap in recorded order, so a client lining the two up needs to know which order it is holding.
The one known consumer does not take the guarantee on trust - `web/src/components/splitsMath.ts`'s `rolesFromPattern` sorts a defensive copy by `lap_index` before indexing the pattern against it - so nothing downstream would fail loudly if the `ORDER BY` were dropped, which is why the guarantee is pinned by a test of its own here rather than left to a consumer to notice.
`derived` is `null` when the activity has no derived layer, paired with `derived_absent_reason` saying **which** absence it is, decided from `sport` and `recorded_sport` rather than assumed:

| sport | recorded_sport | reason |
| --- | --- | --- |
| not `running` | not `running` | the derived layer covers running only, which is why this activity has none. The normal case: 335 grids against 2903 activities on 2026-10-06. |
| not `running` | `running` | recorded as a run but counted as a walk, its moving pace being slower than 9:00/km. 10 of 345 recorded runs on 2026-10-06. |
| `running` | `running` | this run has none, so `recompute` has not been run since it was ingested, or the rebuild skipped or failed on it. |

`reclassification` is null except in the second case, where it carries `recorded_sport`, `sport`, the `avg_speed_mps` the run was judged on and the `threshold_mps` it fell below, both in m/s; the frontend formats them as pace.
The stream endpoint's 404 for such an activity carries the same reason.

The second case is real. `recompute` skips a run whose canonical stream is empty and records a per-activity failure without aborting, and both leave a running activity with no metrics row; a run ingested but not yet recomputed is the third path to the same state.
The message stops there rather than guessing between them, because the store does not record which one happened.

The block is explicitly null rather than omitted so the frontend can say what is missing instead of rendering a page of empty panels.

`summary.sport` is the sport the activity is counted as, which every list, filter and count in the API uses, and `summary.recorded_sport` is what the device wrote.
They differ only for a run `recompute` counted as a walk; see `docs/reference/derived-layer.md`, "Sport reclassification".

`summary.pr_distance_keys` names the distances this activity holds a record at, ordered by the distance itself rather than by the key's spelling - `10k` sorts before `1k` alphabetically and after it in metres, and a badge built from it reads wrong either way round if the order is a coincidence.
It is an empty list, never null, for the 275 of 307 real runs that hold none: "this run set no records" is a fact, and a null would make the client guess.
Read from the `pr` tags rather than re-derived, for the reasons under `GET /api/records`.

`derived.metrics` carries where the activity started: `locality`, `country_code`, `country` and `locality_distance_m`, all four null together for an activity with no position at all - every treadmill run among them, 86 of the 307 real ones.
Resolved offline at recompute time, and `locality_distance_m` is served rather than hidden because a nearest-place match is not always close: the worst on the real history is a start abroad whose nearest place in the table is 27.9 km away.
A client that wants to show only the country for a distant match needs that number to decide, and deciding it in the derived layer would throw away the evidence.
See `docs/reference/derived-layer.md`, "Where an activity happened".

The derived layer's flags are nullable, like the measurements beside them: `is_indoor`, `has_hr`, `has_gps` and `is_gpx_sourced` on the metrics, `contains_pause`, `contains_outage`, `contains_jump` and `distance_trusted` on a best effort, and `is_aerobic_long_run` on a trend point.

Each best effort also carries `speed_distance_m`, the metres the measured speed accounts for over its window, and the progression chart's own `is_eligible` and `ineligible_reason` for that effort, from the same SQL fragments, so an activity and the chart say one thing about it.
`is_eligible` is never null: an effort nobody could verify is not eligible, and `ineligible_reason` says which fact was missing.
The activity view turns those two into a sentence under the header naming the distances that do not count and why, or that some count only because the measured speed confirmed a jump.
A derived file written before a column existed carries no value for it, which is what an `ANALYSIS_VERSION` bump leaves behind until `recompute` rewrites the store, and `store/db.py` projects that as a typed null rather than raising.
A null flag therefore means not known, and it is never coalesced to false, which would assert a fact about an activity nobody looked at.

`derived.tags` is the automatic tags computed by `analysis/tags.py`, one row per tag.
Each has a `kind`, `effort` or `flag`.
`effort` is the exclusive session classification, and at most one row carries it.
`flag` is an additive fact, such as a personal record, and an activity can carry any number of them.
`distance_key` is the best-effort distance a `pr` row fired at, and null on every tag that is not about one distance.
It exists because one run records at several distances at once: a breakthrough 5 km sets records at every extracted distance it covers, eight of them since 2026-09-12, so eight rows arrive with the same `tag`, and telling them apart must not require parsing `reason`.
`rep_count` is the number of reps an `intervals` row fired at, and null on every tag that is not `intervals`, for the same reason: a client that wants the count is not meant to parse it out of `reason`.
`rep_pattern` (added `ANALYSIS_VERSION` 4) is the raw per-lap `R`/`W`/`-` string the classifier produced for an `intervals` row, one character per recorded lap in recorded order, and null on every tag that is not `intervals`.
It exists so a client can tell a recovery lap from a rep without recomputing `analysis.tags`'s own cadence-and-pace rule: a client-side rule built from lap speed or cadence mismatched the analysis layer's own count on the real interval sessions; `docs/reference/math/tags.md` has the measurement.
Null on a row written before this column existed, the same as the other nullable derived flags.
Tags arrive with the `effort` row first, then the flags by `tag`, and `pr` rows within a tag by distance ascending rather than by the text of the key, so "400m" comes before "3k".
Every tag's `reason` is always populated: the numbers that fired it, not just its name.
`reason` is prose meant for display, and it is the one place in this API where a formatted unit appears: a personal record reads its time as minutes and seconds, and a long run reads its distance in kilometres, rather than the raw seconds and metres every other field in this document holds.
Structured data belongs in the other fields.
`reason` exists to show a reader why the tag fired, not to be parsed.
A run that could not be classified serves `tags` as an empty list, never null.
Null stays reserved for the whole `derived` block being absent, which already has its own meaning and its own `derived_absent_reason`.
See `docs/reference/math/tags.md` for the rules themselves.
Measured over the real store: 9 of 307 runs classify as Intervals, and 86 carry no effort tag.
84 of those have no recorded heart rate at all, and two more have heart rate and a complete zone distribution but no maximum HR in the athlete profile interval covering them, a gap not handled yet.

`derived.decoupling` is the run's aerobic decoupling, `decoupling_pct`, with the mean speed and heart rate of each of the two halves it compares, `first_half_speed_mps`, `second_half_speed_mps`, `first_half_hr_bpm` and `second_half_hr_bpm`, which reproduce the percentage.
It also carries `is_aerobic_long_run` and `outside_population_reason`, which is null on a run in the population the 5% line is read over and otherwise says why this run's number is not a durability reading.
When the run has no value, `derived.decoupling` is null and `derived.decoupling_absent_reason` names the first stored fact that explains it: indoors, an intervals session, no heart rate, under 10 minutes of moving time, a walking pace, or, failing all of those, too few seconds carrying both channels.
Exactly one of the two is null whenever `derived` is not.
Both reasons are prose for display, chosen in `api/routers/activities.py` from stored columns.
A stored value that is not finite serves no value rather than a NaN.
A store written before the half columns existed, `ANALYSIS_VERSION` 11 or older, stores the percentage without its halves; such a run serves no value and the reason says the halves are not known until `recompute` rewrites the store, tested before every other fact so a run that has a value is not given a false cause.

### `GET /api/activities/{id}/streams`

Column-major, ten named channels, full 1 Hz resolution:

```
t_s  distance_m  speed_mps  hr_bpm  cadence_spm
altitude_m  lat_deg  lon_deg  paused  outage
```

Column-major because it is what uPlot consumes, and because a row-major array of objects repeats each field name once per sample.

404 when there is no grid to serve, with a body naming which absence it is: an id the canonical layer does not know at all, or a known activity, which then carries the same checked `derived_absent_reason` wording the detail view uses.
Raw `records` are deliberately not served in its place: the grid is where pauses and outages are flagged and where distance is guaranteed monotonic.

A grid file written before a channel was added reads as nulls in that channel rather than raising, which is the tolerance the `streams_1hz` view gets from `union_by_name`.
Recompute rewrites the grid one activity at a time, so a partly rebuilt directory is the normal intermediate state of an `ANALYSIS_VERSION` bump, and reading one file directly must not answer differently from reading the view.
Every sensor and position channel degrades this way, `paused` and `outage` included: not paused and not known are different facts, and neither is ever coalesced into the other on the way out.
`t_s` is the exception and is not nullable. It is the grid's index, generated by the resampler rather than read from a device, so a file lacking it is not a grid at all; typing it `float | None` would buy nothing and put a null check on the frontend's x axis.

Measured over the running server against the real store:

| activity | JSON | gzipped |
| --- | --- | --- |
| median run | 267 KiB | 67 KiB |
| 12 hours, scaled from the median run's bytes per row | about 4.8 MiB | about 1.2 MiB |

The grid has no length cap; the second row scales the measured one to a 12 hour ultra.

Responses over 4 KiB are gzipped by Starlette's middleware, which is what makes full resolution defensible.

The route reads the activity's own Parquet file through `store.db.read_grid` rather than filtering the `streams_1hz` glob.
Filtering the glob by `activity_id` costs 18.6 ms, because the column lives inside the files and every file's footer is opened to answer it; the file read costs 2.7 ms.
It is a lookup by primary key, where the primary key is the filename, and it stays in `store/db.py` so the router still does not know where the data directory is.

### `GET /api/overview`

Weekly and monthly buckets key on the **local date**, not the instant: a run belongs to the week the athlete ran it in.
Weeks are ISO weeks, Monday to Sunday, and `date_trunc('week', ...)` in DuckDB agrees with `analysis.consistency.week_start`.

**The weekly and monthly series are dense.**
One bucket per period from the first run's period through the period holding today's date, zeros included, so a consumer can treat the array as a series and index it by position.
`runs` is 0 and both totals are 0.0 in a period with no run: a real period with no training, not a placeholder.

**The series ends at the current period, which is not the same date as the window's end.**
The window ends on the current week's Sunday, and for up to six days at the end of most months that Sunday falls in the next calendar month: on 2026-08-31 it is 2026-09-06.
Bounding the monthly series on it emitted a `months` bucket for a month that had not started, with `runs` 0 and both totals 0.0, which a bar chart draws as "no training in September" during August and a client reading the last element as "this month" reads as 0.
The weekly series is identical either way, because the current week's Sunday and today truncate to the same Monday.

The series does still run to the last period a counted run falls in, when that is later.
A device clock can be wrong, so a run can be stamped later in the current week than today is, and such a run is inside the window: densifying may add empty periods, but it must never drop a run.

Before 2026-08-30 the weekly series held only weeks containing a run, which was 132 buckets across a 147-week span, and a client drawing them index by index closed the 15 missing weeks and showed a training history with no weeks off in it.
The monthly series had no gaps in the real store, so the same fault was invisible there.

`moving_time_s` is summed from the **derived** layer, `activity_metrics.moving_time_s`, so it is the same definition `/api/activities/{id}` reports and the two endpoints cannot disagree under one field name.
The canonical column of that name is the device's timer time, which counts the device's own auto-pause rather than this project's 15 s and 0.5 m/s rule; renaming or recomputing it is not done yet.
The join is a LEFT JOIN, so a run that has been ingested but not yet recomputed still contributes its distance and its count instead of vanishing from the chart.

`zones` reports seconds per zone index over that same window, and **no boundaries**.
Boundaries are time-versioned per athlete, so a sum across a period during which the maximum heart rate changed has no single pair, and inventing one would present a guess as a measurement.
`zone_boundaries_bpm` carries the currently configured boundaries separately, labelled as such.

Streak and consistency are derived in `analysis/consistency.py`.
See `docs/reference/math/consistency.md` for why the unit is the week, why an unfinished week cannot count against a streak, and why the most recent of several tying longest streaks is the one named.

`last_activity_local_date` is the local date of the latest activity of **any sport**, where `first_run_local_date` and `last_run_local_date` count runs alone.
It says where the store's history ends: a week after it is one the store knows nothing about, because the export it was built from ends there, rather than a week off.
The Full history chart's trend line stops there; see "The weekly distance trend" in `docs/reference/math/consistency.md`.
It obeys the same window as every other field.

**Every field of this response describes one window: runs up to the end of the current week.**
A device clock can be wrong, so a store can hold an activity stamped in the future.
Dropping those weeks from the streak but not from the buckets would put a distance in a week nobody has run beside a streak that ignores it, under one roof.
The bound is one `through` date computed from `analysis.consistency.week_end` and passed into every overview query, so it cannot drift from what the streak uses.
`zone_time` carries no date of its own, so the zone totals reach the bound by joining the activity their rows belong to; that join exists for the window and nothing else.

### `GET /api/records`

One row per extracted distance, ordered by distance ascending so the list reads as a ladder.
A distance with no eligible effort is **absent** rather than present and null: there is nothing to say about it, and a null row would look like a record of unknown value.
The ladder therefore holds a distance only once an activity has covered one.
Measured on the real store that is nineteen of the twenty-two extracted distances; 30 km, 35 km and the marathon are absent because the athlete has never run 30 km, and each will appear the day something longer is run.

`elapsed_time_s` is elapsed and spans its pauses, per CLAUDE.md's "Best efforts are elapsed time and span pauses".
`effort_count` counts the **eligible** efforts at that distance - the number this one is the best of - so an ineligible effort is not counted among the attempts either, having never been comparable.

**Eligibility is the analysis layer's rule, restated here rather than invented.**
`docs/reference/derived-layer.md` states it: a treadmill effort's distance comes from an uncalibrated footpod, and an effort whose `distance_trusted` is not true holds a jump in the recorded distance that the measured speed does not confirm.
Both are excluded on *both* sides of the comparison, so an ineligible effort neither sets a record nor becomes a baseline - excluding only the candidate side leaves an uncalibrated effort standing as the time to beat, suppressing a genuine record for as long as nobody beats a number that was never real.
`is_indoor` must be explicitly false and `distance_trusted` explicitly true: a null means "not known", and a record is the one consumer for which an unverified effort is worse than no effort.
`api/queries.py`'s `_EFFORT_ELIGIBLE_SQL` is that rule, and the records, progression, predictions and activity queries all read it rather than restating it.

That rule is not decoration.
Measured on the real store, the five fastest 400 m efforts all carry `contains_jump`, the quickest 29.7 s - an implied 13.45 m/s, faster than the peak of the 100 m world record - and their recorded distance runs 56% to 447% ahead of the measured speed, so none is trusted.
The fastest trusted 400 m takes three times as long.
A records endpoint that ignored the flag would lead with the jump.
The flag alone was too blunt the other way: a half marathon was kept out by one second in which the odometer alone gained 15.16 m, although over the whole effort it agrees with the measured speed to 0.20%, and it is now the record.

The result agrees with the `pr` tags at every distance: the activity holding the minimum eligible time is the activity carrying the most recent `pr` tag for that distance.
These are two independent paths to one fact - the query against the derived tables, and `analysis/tags.py`'s `TagHistory` against the efforts in time order - and a disagreement would mean one of them is wrong.
`tests/test_api_records.py` asserts the identity on a synthetic store, running the real tagger over efforts that include a faster jump and a faster treadmill time carrying no tag, so a records query that dropped its eligibility filter would disagree with the tags and fail.

That includes a distance with exactly one eligible effort.
Until 2026-09-05 that was the documented exception: a `pr` tag meant "beat a previous best" and the tagger tagged nothing for an effort that beat nothing, while this list meant "your best", which exists as soon as there is one effort.
The progression chart forced the question, because a first point must either be marked or not, and the decision is that the first eligible effort at a distance is a record.
The tagger now fires on it, with a reason that says it was the first rather than that it beat anything, so a sole effort is served here, carries a `pr` tag, shows a badge in the list and matches `?has_pr=true`.
The identity test covers that case with a distance that has one eligible effort beside a faster treadmill one, since a test that still exempted it would pass whether or not the rule had changed.

### `GET /api/trends`

One `TrendPoint` per activity the efficiency pass fitted, oldest first, with the shared fit beside them.
A projection of `activity_efficiency` joined to `activities` for the instant and the offset, and of the single `athlete_fit` row; see `docs/reference/math/efficiency.md` for what the columns mean and `docs/reference/derived-layer.md` for the tables.

`references` are the three reference paces as speeds in m/s, because pace is a presentation of speed and everything at this boundary is SI.
`hr_slope_shared_bpm_per_mps` and `cadence_slope_shared_spm_per_mps` are the whole-history slopes the per-activity ones are shrunk toward; they drift as history grows, so a chart can state which fit its points were measured against.

Each channel is nullable on its own.
A run with no heart rate still has its cadence values.
On 2026-09-12 that was 84 runs of the real history; on the 2026-10-16 store all 335 runs carry heart rate.
`effort_tag` is the session classification the row was fitted under, so a client can narrow the trend to easy runs without a second request.

**The six `*_smoothed_*` fields are what a trend chart plots**, and they are computed in the analysis layer rather than by the client.
They are trailing 42-day means of the six raw reference values beside them.
The raw ones are not readable as three series: measured on 2026-10-16, the median gap between the fast and slow heart rate lines is 0.30 times the median difference between one run and the next, so the three plotted raw are one jagged band.
Smoothed, the same gap is 3.44 times the run-to-run step.
Both forms are served because the raw value is the one the activity view shows for that activity, and the smoothed value is not a property of that activity at all.

**`decoupling_pct` needs `is_aerobic_long_run` to be read honestly.**
Across every session type decoupling measures the shape of the session rather than the athlete: measured over the real history on 2026-10-16, all-out reads 10.37%, steady 8.00% and easy 8.70%, under two points apart against an interquartile range over nine points wide.
`is_aerobic_long_run` marks the 46 of 227 rows the metric is interpretable over, an `easy` or `steady` run of at least 40 fitted minutes, and `decoupling_smoothed_pct` is a trailing 90-day mean over exactly those rows, null on all the others.
A client plotting `decoupling_pct` over every point is plotting the training calendar.

On a store where the efficiency pass produced nothing, both tables are written empty and the response is an empty list with every reference and shared slope null.
That is a real state rather than an error.

### `GET /api/distributions`

Every running activity, one `DistributionRun` each, oldest first, with every value the Distributions view buckets: identity and timing, the canonical distance, the derived layer's moving and elapsed time and average speed, heart rate and cadence, climb per kilometre, the two reference-pace efficiency values, decoupling, and `days_since_previous_run`.

**No query parameters, unlike every other list endpoint in this API.**
The view needs every run at once: to fix the axis over the whole history before any variable is drawn, to switch which variable is plotted without a round trip, and to list the runs behind a clicked bucket.
A `from`/`to` or a `limit` here would just move that aggregation into a second request per interaction.
Measured on 2026-09-28 at 324 runs and 17 fields, the response is 151 KB of JSON and 26 KB as served, through the app's gzip middleware, which is what makes serving the whole table defensible.

**The query is a join over `activity_metrics`, `activities` and `activity_efficiency`, and adds no aggregation of its own** - the same rule every other endpoint in this file keeps.
`activity_metrics` is joined to `activities` with an inner join: a run with no derived layer, which is every non-running activity and a running one `recompute` has not reached yet, has none of the values this view buckets and is therefore not a run to distribute.
`activity_efficiency` is joined with a `LEFT JOIN`, so a run the efficiency pass has not fitted still appears with every field but `hr_at_median_bpm`, `cadence_at_median_spm`, `decoupling_pct` and `is_aerobic_long_run` null, rather than vanishing from every distribution but the two efficiency ones.

**`distance_m` is the canonical `activities.distance_m`, never `activity_metrics`'s own column of the same name.**
The derived layer's `distance_m` is the 1 Hz grid's odometer, and on an indoor run that is a footpod estimate rather than a measurement; the session total on `activities` is authoritative there (the maintainer's ruling of 2026-09-12, restated from `docs/reference/math/units.md`).
A distributions view built on the grid's figure would show a different treadmill distance than the activity view built on the canonical one.

`references.median_mps` is the latest `athlete_fit` row's `ref_median_mps`, the same number and the same table `ReferencePacesOut.median_mps` on `/api/trends` reads, and named to match it.
It is null when `athlete_fit` is empty, which is the state before the efficiency pass has run, and the two pace-at-reference variables in the frontend then show their own absence state rather than a wrong pace.

On an empty store the response is `{"references": {"median_mps": null}, "runs": []}`, a real state rather than an error, the same as `/api/trends`.

### `GET /api/fitness`

One `FitnessPoint` per activity that produced at least one VO2max estimate, oldest first.
A projection of `fitness_series`, written by `analysis/fitness.py`; the two estimators, every constant behind them and the smoothing are derived in `docs/reference/math/vo2max.md`.

`hr_vo2max_smoothed` is the reported number, a trailing 42-day mean of `hr_vo2max`, and the raw column is what a chart draws faintly underneath it.
`vdot` is the best Daniels VDOT among the activity's **eligible** best efforts at one of `VDOT_DISTANCES_M`, the nine of `analysis/best_efforts.py`'s twenty-two targets the project started with, and `vdot_distance_key` says which distance it came from so a peak from a kilometre can be told from one from a half marathon.
Eligibility is the same rule as `/api/records`, but the candidate set is deliberately narrower than that ladder's: a maximum moves when the set it is taken over moves, so sharing one set would let adding a rung to the ladder change every stored `vdot`.
`docs/reference/math/vo2max.md` argues it.
Either estimate may be null on its own: the heart rate method needs a qualifying intensity and a known maximum heart rate, VDOT needs an eligible best effort, and those are different sets of runs.
A null is a run that did not qualify for that method, never a zero.
`qualifying_segments` is the number of 30 s segments behind `hr_vo2max`, so an estimate from 10 minutes of data can be told from one from an hour.

**The level is a model output and only the trend is defensible.**
The heart rate series sits about 60% above VDOT on the real history and scales directly with a configured maximum heart rate that is a device setting.
A client showing the number must say so; the derivation document has the measurements.

`device` is Garmin's own running VO2max, one entry per calendar day, oldest first, projected from the canonical `device_vo2max` table that `ingest` writes from a Garmin export's MaxMet files.
Each entry carries `calendar_date`, the day as the device recorded it, `vo2max`, which is `maxMet` × 3.5 unrounded, and `vo2max_reported`, the whole number the watch shows.
It is an empty list, never absent, when no Garmin export has been ingested.
It is a reference beside the two estimates, not a third estimate: Garmin's number is a model of the same family as the heart rate method, and `docs/reference/math/vo2max.md`, "Against Garmin's own", compares the three.
The field is `calendar_date` rather than `date` because a pydantic field named after its own type does not resolve.

### `GET /api/predictions`

Every model's prediction at each of the `VDOT_DISTANCES_M` from a kilometre up - the same nine `vdot` reads, not all twenty-two the extractor knows - or an explicit statement of why there are none.

**The models are evaluated when asked rather than stored.**
The derived layer declares no predictions table.
The models are closed forms over a handful of numbers, every one of which is read from the derived layer under the eligibility rule `/api/records` uses, and "recent" is measured against the history, which a stored row would freeze at recompute time.
The maths is `analysis.fitness.race_predictions`; the router only validates what it returns.
This is the one endpoint that computes anything, and it computes nothing that is not a function of stored numbers.

The window is the 90 days ending at **the most recent run in the store**, not today, so the answer is a function of the store alone and an athlete who stopped running still sees the prediction their last block of training supports.
Inside it, the best eligible effort at each of those distances feeds the best-effort models, and the latest `hr_vo2max_smoothed` feeds the ordinary-run one.

Each `Prediction` carries a list of `RaceModel`, each named by `model` and `source`:

| model | source | how |
| --- | --- | --- |
| `riegel` | `best_efforts` | from the recent eligible effort with the highest VDOT |
| `cameron` | `best_efforts` | the same effort |
| `ordinary_runs` | `ordinary_runs` | the calibrated prediction from the smoothed heart-rate VO2max, with `low_s` and `high_s` |

The two best-effort models are read together as a range and carry no band of their own.
**The ordinary-run prediction always carries `low_s` and `high_s`**; the response model refuses one without them, because a prediction from runs that were never races is about 5% wide on a 5 km and is misleading without its band.
Where a recent eligible best effort exists, the best-effort models are the better prediction; this one reads what typical training supports, so after a breakthrough effort it sits slower than they do by design.

`insufficient_data` is true whenever either source could not produce a model, and `reason` says which and why, so an absence in `models` is never silent.
A model present at one distance is present at all of them.
There is no critical-speed model: it was removed on 2026-10-06, and `predictions.md` records why.
On a store with no eligible effort in the window and no smoothed estimate, `items` is empty and `reason` says so.
Efforts under a kilometre are neither a source nor a target: the Daniels and Riegel curves were fitted to race distances, and a 400 m window is short enough that one bad second dominates it.
`docs/reference/math/predictions.md` derives the models, measures the ordinary-run prediction's lag after a breakthrough effort, and records the removed critical-speed fit.

### `GET /api/progression/{distance_key}`

Every effort at one distance, oldest first, with whether it was eligible and whether it set a record when it happened.
`/api/records` names the current holder; this is how the athlete got there.

`distance_key` is one of the analysis layer's keys.
**404 for a key the extractor does not know, and 404 for a distance with no efforts.**
A distance with no effort is absent, never present and empty, matching `/api/records`; on the real store `30k`, `35k` and `marathon` are that case, because the athlete has never run 30 km, and each stays a 404 until something longer is run.

`is_eligible` is the records rule, `_EFFORT_ELIGIBLE_SQL`: `is_indoor` explicitly false and `distance_trusted` explicitly true, with a missing metrics row a null `is_indoor` and therefore not known.
`ineligible_reason` is `treadmill` when `is_indoor` is explicitly true, `not known to be outdoors` when it is null, `not known to be free of distance jumps` when `distance_trusted` is null, `a jump in the recorded distance, with no measured speed to check it against` when it is false and `speed_distance_m` is null, `a jump in the recorded distance that the measured speed does not confirm` when it is false otherwise, and null when eligible, so the chart can say why a faster point did not count rather than leaving it to be read as a bug.
`contains_jump` is served beside them, so an eligible point that holds a jump the measured speed confirmed can say so rather than look like any clean one; the chart's readout adds "Counted: the recorded distance jumped, but the measured speed confirms it".
The jump strings name the distance channel rather than the GPS because that is what the flag measures: it compares the odometer's implied speed against `IMPLAUSIBLE_SPEED_MPS`, and on one half marathon the position advances steadily through the flagged second, about 12% faster than the speed channel, which holds level, while the distance channel alone gains 15.2 m, nearly five times what the speed channel accounts for.
They are prose in a `str` field that nothing parses, so a client must render them and never match on them.
The `is_indoor` cases come first because they are a fact about the whole activity, and each flag's null case is kept separate so the chart never tells the athlete an outdoor run was a treadmill run, or that a jump nobody looked for was detected.
Both null cases are a shape guarantee rather than ones the real store meets once it is recomputed: measured on 2026-09-07 over every activity carrying a best effort, 223 are explicitly outdoor and 80 explicitly indoor, and none is unknown, and `analysis/best_efforts.py` writes `contains_jump` and `distance_trusted` as bools for every effort it extracts.
A store written before `ANALYSIS_VERSION` 10 is the exception: it has no `distance_trusted` column, so every effort reads as not known and `/api/records` is empty until `recompute`, which `/api/health`'s version check names.
Ineligible efforts are served, not hidden: they are real runs and a third of the 5 km efforts on the real history, and dropping them would misrepresent training volume.

**`is_record` is the staircase, computed in the query as a running minimum over eligible efforts in time order, not read from the `pr` tags.**
An effort is a record when it is eligible and strictly faster than every earlier eligible effort, or when it is the first eligible effort at the distance.
Ineligible efforts sit outside the minimum on both sides, so a faster treadmill effort neither sets a record nor becomes the baseline.
The tags and this query are two independent paths to one fact, the same arrangement `/api/records` has, and `tests/test_api_progression.py` runs the real tagger over the same efforts to hold them together.

`effort_count`, `eligible_count` and `record_count` are sums over `items`, evaluated in the router so they cannot disagree with the list they describe.
Measured on the real store on 2026-09-05, the 5 km has 225 efforts, 155 eligible and 9 records.

### `GET /api/routes` and `GET /api/routes/{route_id}`

A route is a group of runs `analysis.routes` decided followed the same path, computed in `recompute` from the resampled 1 Hz grid: see `docs/reference/math/routes.md` for the grouping rule and `docs/reference/derived-layer.md` for the two tables, `routes` and `route_runs`.
**This router computes nothing.** Every field is a stored column, or the `rank = 1` row of `route_runs` joined in, the same split every other endpoint in this file keeps.

`GET /api/routes` lists every route, most runs first and then by name.
`GET /api/routes/{route_id}` names one route's runs oldest first, which is how the athlete built the route rather than how it stands today, alongside `reference_activity_id`: the medoid run drawn on the map.
404 for an id the store does not know.

**The record is the `rank = 1` run, joined in rather than recomputed**, and it can be absent.
`record_speed_mps`, `record_activity_id`, `record_start_time_utc` and `record_utc_offset_s` are all null together when every run on the route is ineligible: there is no rank 1 row to join, and a route can exist with no record.
Inventing one from an ineligible run would be exactly the mistake `GET /api/records` refuses to make.
`record_utc_offset_s` is the record run's own `activities.utc_offset_s`, for its local wall clock; also null when that run recorded no offset, though a GPX-sourced run - the usual case of one - is never eligible and so never rank 1.

**Eligibility is the records rule, restated for a whole run rather than one effort.**
A GPX-sourced run is ineligible, and so is a run carrying any best effort whose `distance_trusted` is not true, or a jump elsewhere on its 1 Hz grid that the run's measured speed does not confirm, found by the same rule applied to the whole run.
An ineligible run stays on the route and in the response, marked `eligible: false` with `ineligible_reason` set, but it neither sets the record nor becomes the pace a later run has to beat: `rank` is null on it, the same absence `GET /api/progression/{distance_key}` gives an ineligible effort.

`direction` is `forward` or `reverse` against the route's earliest run, the one whose id is `route_id`, never against a compass bearing, so it reads relative to that run's trace; every run of an out-and-back is `forward`.

`GET /api/activities/{id}` gains a `route` field for a running activity `analysis.routes` grouped: `route_id`, `name`, `run_count`, this run's own `rank` (null when ineligible) and `direction`.
Null for a run in no route and for a non-running activity, the same two cases `derived` collapses, and for the same reason: `analysis.routes` only ever considers an outdoor GPS running activity, so neither case has a row to project.
Explicitly null rather than omitted, like `derived`, so the frontend can tell "no route" from a field it forgot to ask for.

### `GET /api/territory`

The ground every outdoor run that closed a loop has claimed, computed in `recompute` by `analysis.territory`: see `docs/reference/math/territory.md` for the rules and `docs/reference/derived-layer.md` for the three tables, `territory_claims`, `territory_regions` and `territory_parts`.
**This router computes nothing.** The total and the counts are aggregates DuckDB evaluates over the stored tables, and each part's outline is the stored GeoJSON text, parsed and served unchanged.

| field | serves |
| --- | --- |
| `total_area_m2` | The area of the union, `sum(territory_regions.area_m2)`. Not the sum of each run's ground, which counts every overlap again |
| `closure_max_m`, `sliver_radius_m` | The two rules the tables were built with, 200 m and 15 m, so a view can state them without restating a constant |
| `counts` | `outdoor_runs` considered, `loop_runs` that closed within `closure_max_m`, `claiming_runs` that enclosed ground once slivers were removed, and the number of `regions` and `parts` |
| `regions` | Largest first: id, name, locality, country, area, part and claim counts, first and last claim, and the box as `west`, `south`, `east`, `north` in degrees, the shape `GET /api/basemap` gives an area |
| `territory` | A GeoJSON `FeatureCollection`, one feature per part, `[lon, lat]` rings with holes after the exterior, and `region_id`, `part_index` and `area_m2` as properties. Ordered by region area, then part. A feature's geometry is a `Polygon`, or a `MultiPolygon` when the 6 decimal grid cuts a neck of the part; every one is valid GeoJSON on the served coordinates |
| `growth` | One point per claiming run, oldest first: `activity_id`, `start_time_utc`, `utc_offset_s`, `name`, `region_id`, `enclosed_m2`, `new_m2` and `cumulative_m2`. A run whose ground was all claimed before has `new_m2` 0 and still a point |

`territory` is ready to hand to a map as a source, and its features carry `region_id` so a view can filter one region without a second request.
The last `growth` point's `cumulative_m2` is `total_area_m2`.
A point's local date is `start_time_utc + utc_offset_s`, as everywhere else in this API.
`area_m2` on a feature is the part's true area; the outline is simplified at 1 m, so an area measured from the served coordinates reads up to 2.9% low, on one small part.

An empty store, or one recomputed before the territory tables existed, serves zeros and empty lists rather than a 404.

Measured over the real store on 2026-10-03: 11 regions, 33 parts, 5,018 outline vertices and 176 growth points make 159,748 B of JSON, 44,495 B gzipped as served, in 15 to 35 ms warm.

### `GET /api/basemap`

The manifest's areas - each an id and its box in degrees - plus the OpenStreetMap attribution text every served map must carry.
An empty list, not a 404, when `data/basemap/` or its manifest does not exist: nobody has run `activity-analysis tiles` yet, which is a real state rather than an error.
A manifest that exists but does not parse - corrupt JSON, or an entry missing a field - is refused rather than guessed at: 503, with `detail` naming the manifest's path and saying to delete it and rerun `activity-analysis tiles`.
`tiles` refuses the same manifest with the same message rather than overwrite it, and with the file gone it plans every area afresh and fetches the assets again.

### `GET /api/basemap/areas/{area_id}.pmtiles`

The area's own `.pmtiles` archive, from `data/basemap/areas/<id>.pmtiles`, served whole or by byte range - which is what lets the frontend's `pmtiles` reader take one tile out of an archive without downloading the rest of it.
Measured against a 16 KiB archive: a `Range: bytes=100-4199` request answers `206 Partial Content`, a `Content-Range` naming the archive's real length, and exactly the requested bytes back.
`GZipMiddleware` skips a response whenever its status is 206, whatever its size or content type, which is why a range request comes back uncompressed; the frontend's `pmtiles` reader only ever sends `Range`, so every response it reads is 206 and never gzipped.
A whole-file request with no `Range` header is not: it is a plain 200 over the 4 KiB `minimum_size`, `application/vnd.pmtiles` is not in `GZipMiddleware`'s excluded content types, and Starlette compresses it like any other large body.
That is harmless, since nothing reads an archive that way today, but it is a trap of its own, below.
404 for an `area_id` the manifest does not list, so a request can never resolve to a file the manifest never named, and 404 again for a listed area whose file is missing.
Excluded from the OpenAPI schema (`include_in_schema=False`), like the assets route below: the frontend's `pmtiles` reader fetches this directly rather than through the generated `openapi-fetch` client, so there is no client type to keep in sync.
A malformed manifest is 503 here too, the same check and the same message as `GET /api/basemap` above.

### `GET /api/basemap/assets/{path}`

One glyph range or sprite file from `data/basemap/assets/`, the directory `activity-analysis tiles` fetches into.
`path` is resolved against that directory and checked with `is_relative_to` before anything is read, which closes both a literal `..` segment and one that only appears after normalisation; `tests/test_api_basemap.py` tries `../../secret.txt`, `..%2F..%2Fsecret.txt` and `fonts/../../../secret.txt`, all 404.
404 too for a path inside the directory that does not exist, since the two failures look identical to a caller: nothing worth serving is at that path.
Excluded from the OpenAPI schema for the same reason as the archive route: MapLibre fetches glyphs and sprites directly, never through the typed client.

## Connection model

One DuckDB connection is opened in the lifespan and every request takes a `cursor()` from it.

`connect()` costs 46 ms against the real store, because it describes every Parquet schema to build the views, while the queries behind these endpoints cost single-digit milliseconds.
A connection per request would spend nine tenths of every request rebuilding views over files that did not change.
Cursors from one connection share the catalog and run concurrently, which is what FastAPI's threadpool needs for synchronous endpoints.

**The consequence is that the server holds the store as it was at startup.**
A `recompute` while it runs is not picked up, and the symptom is a number that does not move, which reads exactly like a bug in the metric that was just changed.
`serve` says so on the way up. Picking up a rebuild without a restart is not built yet; it is known, not an oversight.

Measured against the real store, 1944 activities and 817089 grid rows:

| endpoint | time |
| --- | --- |
| `/api/sports` | 5 ms |
| `/api/activities?limit=50` | 8 ms |
| `/api/activities/{id}` | 12 ms |
| `/api/activities/{id}/streams` | 20 ms uncompressed, 145 ms gzipped |
| `/api/overview` | 15 ms |
| `/api/health` | 136 ms |

`/api/health` is the outlier because it counts the canonical `streams` view, which is 1.46 million rows across 1944 files.
That count is the point of the endpoint, so it stays: health is for diagnosing a store, and it is called once when the page loads.

## Errors

| status | when |
| --- | --- |
| 404 | no such activity, or an activity with no 1 Hz grid. Also an `activity_id` that is not a hex digest, which is refused before it can become a filename. |
| 422 | a parameter the schema rejects: a limit over 200, an unsortable column. |
| 503 | the store raised. The body is DuckDB's own message, which names the `ingest --force` or `recompute` that fixes it. |

**Every error body is `{"detail": ...}`, but `detail` is a different shape depending on the status.**
A 404 or 503 is FastAPI's own `HTTPException` default: `detail` is a single string, the message quoted in the table above.
A 422 is Pydantic's own validation error instead: `detail` is an array, one entry per rejected field, each shaped `{loc, msg, type, input, ctx}`.
`loc` names the field, for example `["query", "limit"]`; `msg` is the one line meant for display, for example `"Input should be less than or equal to 200"`.
A client rendering an error message reads `detail` as a string in the 404/503 case and joins the `msg` of each entry in the 422 case; treating `detail` as always a string, or always an array, is wrong for the other status.
`web/src/api/errors.ts`'s `describeApiError` is the frontend's one implementation of this, and it is tested against both shapes.

**An empty store is not an error.**
Every list endpoint returns an empty page with a total of zero, and `/api/health` is where the reason appears.
The frontend distinguishes no data from no matching data by the filters it sent, not by a status code.

**A stale store is not the API's decision.**
`store/db.py` already decides, per view, whether a column missing from the stored Parquet reads as null or raises, and it decides that on whether a null there would be honest.
The API's only addition is the status code.

## Traps

These have each cost real time in this project.

**`fetchall()` on a `TIMESTAMPTZ` column makes DuckDB import `pytz`, which is not a dependency here.**
The failure is an unrelated-looking `ModuleNotFoundError`.
Read results with `to_arrow_table()`.

**DuckDB renders a `TIMESTAMPTZ` in the session timezone.**
`AT TIME ZONE 'UTC'` is mandatory wherever one becomes a date or a wall clock in SQL, or the expression is right only on a machine set to UTC.
`queries.LOCAL_DATE_SQL` and `cli.LOCAL_START_SQL` are the two places this matters.

**A `DATE` bound against a `TIMESTAMPTZ` column is cast using the session timezone too.**
A bare `start_time_utc >= ?` with a Python `date` therefore selects a different set depending on where the server runs, silently and with no expression to inspect.
The `from` and `to` filters compare `queries.LOCAL_DATE_SQL` against the bound date instead, so both sides are a `DATE` and no timezone enters.

**The same applies on the way out.**
A `TIMESTAMPTZ` reaches Python already converted to the session timezone, so serialising it verbatim would make the payload depend on where the server is, under a field name that says UTC.
`models.UtcInstant` pins it.
This is invisible on a UTC machine, which is why `test_the_instant_is_serialised_as_utc_whatever_the_server_timezone_is` constructs the model directly rather than going through the API.

**A view built over `con.register`'s Arrow table is unusable from a cursor.**
A registered relation lives in the registering connection's own temporary catalog, and `con.cursor()` does not inherit it.
It bit only on an empty store, which is the state a new user is in.
`store/db.py` builds empty views from typed NULL literals for this reason.

**`GZipMiddleware` skips a 206 response outright, which is the only reason a `.pmtiles` archive survives it uncompressed.**
`starlette.middleware.gzip.IdentityResponder.send_with_compression` sets `self.partial_response = message["status"] == 206` and passes such a response's body through unmodified, whatever its size or content type; `application/vnd.pmtiles` is not on `GZipMiddleware`'s own excluded-content-type list, so nothing about the media type itself keeps it from being gzipped.
The frontend's `pmtiles` reader only ever sends `Range`, so every response it reads is 206 and takes that path.
A whole-file request with no `Range` header is a plain 200 over the 4 KiB `minimum_size` and is compressed like any other large body - harmless today, since nothing requests an archive that way, but a body a future middleware compresses again would double-encode it, and a 206 whose body a future middleware rewrites would falsify its own `Content-Range`.
`tests/test_api_basemap.py`'s range test pins the 206 case: gzip stays off it even when `Accept-Encoding: gzip` is sent.

## Testing

`tests/test_api_*.py`, driven through `TestClient` against the running application rather than by calling router functions directly.
A router function returning the right dictionary proves nothing about the route it is mounted on or the parameters FastAPI parses for it.

Fixtures in `tests/conftest.py` build a store by running the real `ingest` and the real `recompute` over the committed sample activities.
Two store states are covered by fixtures, `ingested_store` and an empty one, because each has produced a different class of bug here.
The states the five committed runs do not come in are built by mutating that store rather than by adding fixture files:

| state | built by | pins |
| --- | --- | --- |
| a run with no derived layer | dropping its row from `activity_metrics.parquet` and unlinking its grid | the `recompute` branch of `derived_absent_reason`, on the detail view and the stream 404 |
| an activity that is not a run | rewriting one row's `sport` and re-running `recompute` | the running-only branch of the same |
| an activity with no recorded sport | ingesting the committed reference GPX, which records none | that the null bucket `/api/sports` reports is selectable as `sport=unknown` |
| a store written before a column existed | dropping a column from a stored derived Parquet file | that a missing flag is served as null rather than as false, on the grid and on the derived tables alike |

Both branches of `derived_absent_reason` are asserted in both directions, because each message is wrong for the other's case and a one-sided assertion would not notice the swap.

`TestClient` must be used as a context manager. That is what runs the lifespan, and without it `app.state.con` never exists.
