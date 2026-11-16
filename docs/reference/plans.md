# Training plans

A plan toward a race goal, written and revised by Claude Code from the store's history and drawn by the Plan view.
The code gathers the facts Claude plans from, checks the plan's shape, stores its versions and serves them read-only; it holds no training rules and never invokes `claude`.

Plans are written from a checkout, through the `training-plan` skill in `.claude/skills/training-plan/SKILL.md`.
The skill is not in the wheel: an installed copy of the app has the `plan` commands and the Plan view, and no skill to drive them.

## The flow

1. **Fresh runs in.** A revision is only as current as the store; see "Fresh runs" below.
2. **`/training-plan` in Claude Code.** The skill runs `plan context`, reads it, and starts a new goal, revises the active one, or closes one whose race has passed.
3. **A new goal.** Claude interviews the athlete one question at a time: distance, target time, race date, surface, runs a week, which days, track access, injuries and other sports.
4. **A revision.** Claude judges every past session against the runs around its day, records each as an outcome, and changes what the evidence supports, with a reason per change.
5. **Check and propose.** Claude writes a draft, runs `plan check` to see what `propose` would print, including the fitness, fatigue and form the plan is expected to reach, revises the draft until it holds, and runs `plan propose`, which checks it and stores it as the goal's proposed version.
6. **Accept or reject.** The athlete decides in the conversation, after looking at the proposal in the Plan view, and Claude runs `plan accept` or `plan reject`.

## The files

Plans live under `Paths.plans_dir`, `<root>/data/plans/`, which the `data/*` rule keeps out of git.
`recompute` never reads or writes it, and the HTTP server never writes to it.

```
data/plans/<goal_id>/index.json            the goal's status and each version's status
data/plans/<goal_id>/v001.json             a version: the draft plus the provenance propose stamped
data/plans/<goal_id>/v001.context.json     the context propose built, which the version's citations point into
```

A version file is written once and never rewritten; every status change is a rewrite of `index.json`.
Each write goes to a `.tmp` file beside its target and is renamed into place, and `propose` writes the index last, so a crash leaves at worst orphan version or context files that the index does not list.

**Version statuses** are `proposed`, `accepted`, `superseded`, `rejected` and `withdrawn`.
A goal has at most one `proposed` version: proposing again marks the pending one `withdrawn` and takes the next number.
Accepting marks the previous `accepted` version `superseded`.
Accepting a new goal's first version archives the active goal and marks that goal's `proposed` version, if it has one, `withdrawn`, since an archived goal takes no verdict.

**Goal statuses** are `proposed`, `active`, `archived` and `closed`.

| Event | Goal status |
| --- | --- |
| first `propose` of a new goal id | `proposed`, with v1 `proposed` |
| first `accept` of the goal | `active`; any other `active` goal becomes `archived` |
| `reject` of a version | unchanged; a goal whose v1 is rejected stays `proposed` |
| `accept` of a version with `result` set | `closed` |

At most one goal is active.
`accept` writes the accepted goal's index before it archives the others, so a crash between the two leaves two goals active, of which the store reads the newest as the active one, rather than none.
An `archived` or `closed` goal takes no new versions: `propose` refuses it, so another attempt at the same race takes a new goal id.
`accept` and `reject` refuse it too.
`index.json`'s `goal_id` matches the goal id pattern and names its own directory; an index naming another goal is refused as unreadable, naming the file.

## The schema

The pydantic models in `src/activity_analysis/plan/models.py` are the single definition: the CLI validates drafts against them, the API serves them, and `web/src/api/schema.d.ts` is generated from the API's OpenAPI document.
`uv run activity-analysis plan schema` prints `PlanDraft`'s JSON Schema, which is what Claude writes to.

Everything is SI with the unit in the field name: `distance_m`, `target_time_s`, `low_mps`, `high_bpm`.
No pace is stored; `plan propose` and `plan show` print paces derived from the speeds.
Every date is the athlete's local calendar date, since a session is planned for a day the athlete lives through.

A draft holds:

- `goal`: `goal_id`, `distance_m`, `target_time_s`, `race_date`, `surface` (`track`, `road`, `trail` or `other`) and an optional `note`.
- `constraints`: `runs_per_week`, required, 1 to 14; optional `run_days`, `track_days` and `notes`.
- `assessment`: `summary`, `estimate_s`, `estimate_reasoning`, `verdict` (`likely`, `possible` or `unlikely`) and `citations`, each a `label` and a JSON Pointer into the context.
  `estimate_s` is null when no recent effort supports an estimate; check 11 below then requires a time trial.
- `weeks`: each with `start_date`, `phase`, `focus`, `planned_distance_m`, `detailed` and `sessions`, and three optional outlook fields: `planned_zone_minutes`, exactly five non-negative minutes in heart-rate zones 1 to 5, `expected_vdot` and `expected_garmin_vo2max`, both positive.
  `expected_vdot` is the value the best-efforts prediction series is expected to have at the end of the week, not Claude's race estimate: it starts at the series' value at `data_through` and trails the training: a held rise is all in after 45 days and a steady rise shows about 23 days late, as `docs/reference/math/predictions.md`, "The lag", measures.
  Versions stored before 2026-11-16 started it from `estimate_vdot` and keep that curve.
  A week may also carry `load_note`, one or two sentences on how to run the week given its expected fitness and fatigue, which the week PDF and the copied week print; check 20 requires it on a detailed week that has not ended.
  The week's planned TRIMP is `sum(minutes[i] * trimp_per_minute[i])`, `planned_trimp` in `models.py`, with the athlete's TRIMP per minute in each zone that `propose` stamps on the version as `provenance.trimp_per_minute`.
  It is null when a zone with planned minutes has no factor, and a version without the stamp has no planned TRIMP.
  The text render prints it as `TRIMP 512 (+8%)` after the week line, and the Plan view mirrors it.
- Sessions: `id`, `date`, `kind`, `title`, `description`, optional `planned_distance_m` and `planned_duration_s`, and `steps`.
  A `description`, `assessment.summary`, `assessment.estimate_reasoning` and a change's `reason` may be written as labelled blocks: a line ending in `:` on its own is a label, lines starting `- ` are its items, and a blank line ends a block; the plan view sets them out as headed lists, and one line reads as one paragraph.
  The kinds are `easy`, `long`, `intervals`, `tempo`, `threshold`, `strides`, `time_trial`, `race`, `rest` and `cross_training`; every kind but the last two is a running session.
- Steps: `role` (`warmup`, `work`, `recovery`, `cooldown` or `strides`), `repeat`, exactly one of `distance_m` and `duration_s`, an optional `speed` range in m/s or `heart_rate` range in bpm, and a `note`.
  A `heart_rate` range may leave out `low_bpm`, which makes it a ceiling, printed as `up to 161 bpm (Z2)`; the zone is that of the range's top, and is printed only when the version carries zone boundaries.
  Strides are their own role rather than `work`, so the intensity mix, the target paces and a time trial's distance never read a few 20 s pickups as the session's quality; the recoveries between them are not written as steps.
- `changes`, on a revision: `title`, `reason`, `session_ids` and `goal_change`.
- `outcomes`, on a revision: `session_id`, `verdict` (`done`, `partial`, `missed`, `moved` or `replaced`), `activity_ids` and a `note`.
- `checkpoints`: `session_id`, `description` and an optional `target_time_s`.
- `result`, on the version that closes a goal: `time_s`, `achieved` and a `note`.

Goal and session ids match `^[a-z0-9][a-z0-9-]{0,99}$`, at most 100 characters, so an id always makes a valid file name.
Every distance, duration, speed, heart rate and time is positive, except a week's `planned_distance_m`, which may be 0.
Every model forbids fields it does not declare, so a misspelt field is refused rather than dropped.

A stored version adds `provenance`, which `propose` fills and Claude never writes:

- `number`, and `revises`, the number of the accepted version it was checked against, or null.
- `created_at`, in UTC.
- `data_through`, the newest run's local date on or before the day it was proposed, from the context's `freshness`.
- `snapshot`, one row per distance and model of the context's `predictions.items`, which the trajectory chart draws across versions.
- `lthr_bpm`, `zone_boundaries_bpm`, the four upper edges of zones 1 to 4, and `trimp_per_minute`, the five values the week's planned TRIMP multiplies by, from the context's `zones` key, and `target_vdot` and `estimate_vdot`, the VDOT of the goal's target time and of `assessment.estimate_s`.
  All five are null when their source is missing, and null on every version stored before they existed.
- `expected_load`, what the planned load is expected to do to fitness, fatigue and form, from the context's last `load` day through the race: `start`, that day's measured `ctl`, `atl` and `form`; `race_morning`, the values at the end of the day before the race; `weeks`, the weekly means as `training_load_weekly` holds them, from the week holding the day after `start` through the race week, each with `start`, the values at the end of the Sunday before it, and `end`, at the end of its Sunday or, in the race week, race morning; and `bridged_from`, the goals whose plans supplied the planned load between `start` and this plan's first week.
  Null when it cannot be projected, and on every version stored before it existed; `propose` and `check` print why.
  `docs/reference/math/plan-projection.md` derives it.

## What `propose` checks

The schema refuses a malformed file.
`check_draft` in `src/activity_analysis/plan/validate.py` then refuses a well-formed plan that contradicts itself, the athlete's constraints or the history it revises, with one sentence per problem:

1. Every week starts on a Monday, seven days after the week before it.
2. The race date falls inside the last week.
   A plan with no weeks is refused.
3. Every session is dated inside its week, and no two sessions share an id.
4. A detailed week has at least one session, and an outline week has none.
5. The race week is detailed, and a session of kind `race` is dated on the race date.
6. No week holds more running sessions than `constraints.runs_per_week`.
7. Every citation's pointer resolves in the context `propose` built.
8. Against the accepted version, every session dated on or before `data_through` is unchanged: not edited, added or removed.
   Past sessions are frozen, and a revision adds outcomes for them instead.
9. Every outcome names a session in the draft dated on or before `data_through`.
10. Against the accepted version, the goal id is the same, and a goal that differs in any field needs `changes[0].goal_change` set.
11. With `estimate_s` null, the draft holds a `time_trial` session dated within two weeks of the version's start, from that start to 13 days after it, and a checkpoint naming it.
   The start is the first week's start, or in a revision of an accepted version, with `data_through`, the day after it when that is later: two weeks after the newest stored run, so a trial on or before that run's date, missed or frozen, does not count.
   A closing version, one with a `result`, schedules nothing and is exempt, and so is a draft whose race date falls inside the window, since the race itself gives the time and a trial would cost the taper.
12. Every checkpoint's `session_id` names a session in the draft, and every id in a change's `session_ids` names a session in the draft or one the accepted version had and the draft removes.
13. Against the accepted version, every outcome it had is in the draft unchanged: earlier outcomes are kept.
14. Against the accepted version, every week that has ended, meaning its start date plus 6 days is on or before `data_through`, keeps its `phase`, `focus` and `planned_distance_m`, and no such week is added or removed: past weeks are frozen, as their sessions are by check 8.
15. A `result` needs `data_through` on or after the race date.
16. Every week that has not ended, meaning its start date plus 6 days is after `data_through` (every week when it is null), has `planned_zone_minutes` and `expected_vdot`, and `expected_garmin_vo2max` when the context's `fitness_now.garmin_vo2max` is not null.
    A store without Garmin's VO2max, such as a Strava-only one, has no value for that curve to start from.
    Ended weeks are exempt, since check 14 freezes them.
17. In such a week, if it is detailed, in every session dated after `data_through`, every step of an `easy` or `long` session whose role is not `strides` has a `heart_rate`, and no step of one has a `speed`.
18. In such a detailed week, every running session dated after `data_through` has `planned_duration_s`.
19. In such a detailed week that holds no session dated on or before `data_through`, `sum(planned_zone_minutes)` is within 10% (`ZONE_MINUTES_TOLERANCE`) of the running sessions' `planned_duration_s` summed, in minutes.
    Checks 17 to 19 skip sessions check 8 has frozen, and 19 skips a week holding one, whose total cannot be checked against durations nobody can change.
20. In such a detailed week, `load_note` is set and not blank.
21. The first such week's `expected_vdot` is within `EXPECTED_VDOT_START_TOLERANCE` (1.9 VDOT units) of the context's `fitness_now.best_efforts_vdot`, the prediction series' value at `data_through`.
    The tolerance is the largest 7 day change of that value over a year of the real store, measured 2026-11-16, which is how far the series can move before the week ends.
    The check is skipped when the context holds no series value.
    A closing version, one with a `result`, is exempt from checks 16 to 21.

Checks 8, 10, 13 and 14 compare against the goal's `accepted` version, and check 11's window and check 12's allowance for a removed session depend on it, so they do not apply to a goal never accepted, and a pending version is never the reference.

## The CLI

| Command | Does |
| --- | --- |
| `plan context [--today D]` | Prints the context as indented JSON. |
| `plan schema` | Prints the draft's JSON Schema. |
| `plan check FILE [--today D]` | Does everything `propose` does except store: validates the draft, builds the context, runs the checks, and prints the plan as `propose` would, with the expected load. It prints the plan even when checks fail, then lists every problem and exits 1; a draft that does not validate, or a finished goal, fails before anything is printed. |
| `plan propose FILE [--today D]` | Validates the draft, builds the context, runs the checks, stores the version and its context, and prints the plan in paces and local dates. |
| `plan accept [GOAL_ID]` | Accepts the goal's pending version. |
| `plan reject [GOAL_ID]` | Rejects the goal's pending version. |
| `plan list` | One line per goal, newest first: id, status, accepted and pending version, race date. |
| `plan show [GOAL_ID] [--version N]` | Prints a version: the pending one, else the newest accepted, else the newest. |

Every command takes `--root`; `plan schema` accepts it and ignores it, since the schema does not depend on the store.
`--today` sets the date the context's windows are measured from, and defaults to the machine's date.
Without a goal id, `accept` and `reject` act on the one goal with a pending version and fail when there is none or more than one; `show` picks that goal, else the active one, else the newest.
Every expected failure, a refused draft or an unreadable file under `data/plans/` among them, is one message on stderr naming the file or the problems, and exit code 1.

## The endpoints

`GET /api/plans` lists the goals, newest first, each with its status, its distance, target time and race date, and its accepted and pending version numbers.
The goal's figures come from its pending version, else its accepted one, else its newest, `PlanStore.current`, so a rejected revision does not speak for the goal; `plan list` takes the race date from the same version.
`GET /api/plans/{goal_id}` serves the goal and every version, oldest first, each with its status, its plan and `expected_prediction`, the time at the goal distance each week's `expected_vdot` implies, dated its Sunday or the race date.
Both read the files and never DuckDB, like the basemap; the context files are not served.
An id that does not match the goal id pattern, or a directory without `index.json`, is 404, and a file that does not validate is 503 naming it.
`docs/reference/api.md` has the response shapes.

## Fresh runs

A revision needs each run in the store soon after it is run, and a bulk export takes days to arrive.
Single activities go in through `ingest` with the Garmin reader named explicitly:

```bash
uv run activity-analysis ingest <folder of .fit files> --archive-kind garmin
uv run activity-analysis ingest <activity>.zip --archive-kind garmin
```

The folder holds `.fit` files copied off the watch; the zip is one activity's "Export Original" download from Garmin Connect, which `ingest` unpacks under `data/raw/`.
`--archive-kind garmin` is required, because a plain folder or a single zip has no `DI_CONNECT` directory, and the default `auto` exits 1 asking for the kind.
`ingest` recomputes afterwards when it ingested something, and a file already ingested is skipped by its content hash.
The folder route was verified on 2026-11-14 with a real activity file, against a copy of the real store and an empty one, and `tests/test_cli.py` tests both routes.

The skill asks for this before planning when `freshness.days_since_newest_run` is over 3.
When `freshness.days_since_resting_hr` is over 28, or a recent run has `rest_from_setting` true, it also asks for a full Garmin export (Account, Data Management, Export Your Data) to ingest, since single-run exports carry no resting heart rate and TRIMP is otherwise weighed against an older rest or the device setting.
`ingest` recomputes after an export that brought only new resting heart rate days too.

## The context

`plan context` prints one JSON document, built by `build_context` in `src/activity_analysis/plan/context.py`.
It introduces no metric: every figure is read through the query and analysis functions the API calls, and the predictions, records and trends pass through the API's own response models, so a figure in the context and the same figure in the app cannot disagree.

| Key | Holds |
| --- | --- |
| `generated_for` | The date every window below is measured from, `--today`. |
| `freshness` | `newest_run_local_date`, the newest run on or before that date, and `days_since_newest_run`; `resting_hr_measured_through`, the newest day with a measured resting heart rate on or before that date, null without one, and `days_since_resting_hr`. Only a full Garmin export carries the resting series, so it ages while single-run exports keep the runs fresh. |
| `profile` | `max_hr_bpm` and `zone_boundaries_bpm` from the newest `athlete_profile` row. |
| `zones` | The threshold heart rate in force at the newest run: `lthr_bpm`, `boundaries_bpm` (the four upper edges of zones 1 to 4), `readings`, the efforts the estimate was taken from, and `trimp_per_minute`, five values for zones 1 to 5: each zone's summed TRIMP over its summed minutes across the runs of the last 84 days, counting only the minutes that carry a TRIMP, null for a zone with none. `propose` stamps it on the version. Null until three readings exist. |
| `load` | The daily training load series, `local_date`, `trimp`, `ctl`, `atl`, `form` and `distance_7d_m`, the rolling seven day distance, from 84 days before `generated_for` through it. The series ends at the newest run's day, so it may end before `generated_for`. |
| `recent_runs` | Every run from 84 days before `generated_for` through it, oldest first: activity id, local date, distance, moving time, average speed and heart rate, `indoor`, tags, time per zone, `decoupling_pct`, `trimp`, `rest_from_setting` and `estimated_zone_s`, seconds in the five estimated zones. `trimp` is null and `estimated_zone_s` empty for a run without heart rate. `rest_from_setting` is true when the run's rest came from the device's resting setting, because no measured rest was 90 days or less old, whether or not the run had heart rate to weigh. |
| `weekly` | 26 weeks of run count, distance and moving time, ending with the current week, each with `trimp` and `zone_minutes`, minutes in the five estimated zones. `trimp` is null for a week whose runs all lack heart rate, `zone_minutes` for a week whose runs all lack estimated zones (no heart rate, or before the first threshold estimate), and both are zero for a week without runs. |
| `predictions` | `/api/predictions`' payload, plus `recent_best_efforts`, the window's best effort at each prediction distance with its activity id and local date. |
| `records` | The all-time record at each prediction distance, as `/api/records` serves it, plus `local_date` and `fitness_then`. |
| `fitness_now` | `hr_vo2max_smoothed`, `best_efforts_vdot`, `vdot` and `garmin_vo2max` in force on `generated_for`. `best_efforts_vdot` is the prediction series' smoothed value, null when the series has none, and is where `expected_vdot` starts. `anchor` no longer exists: predictions are no longer converted from one effort. |
| `trends` | `/api/trends`' payload, with points from 84 days before `generated_for` through it. |
| `plan` | The active goal, else the newest goal with a pending version: `goal_id`, `accepted`, `pending`, and `pending_new_goal`, another goal's first version awaiting a verdict. Null when there is neither. |

`fitness_then` and `fitness_now` hold the latest `fitness_series` row's `hr_vo2max_smoothed` and `vdot` on or before the date, `vdot` being that run's own and null when it held no eligible effort, and `garmin_vo2max`, Garmin's value on the latest day on or before it, unrounded, where the watch shows it as a whole number.

Measured on the real store on 2026-11-15: 115635 bytes as compact JSON, with 42 recent runs.
The stored plans account for about 50 KB of that, and the zones, load and new per-run and per-week fields for about 15 to 20 KB, so the figure is not growth from the load fields alone.

## The Plan view

`/plan` opens on the goal with a version awaiting a decision, else the active goal, else the newest, and `/plan/$goalId` on one goal.
Of that goal it shows the version `?version=N` names, else the pending one, else the accepted one, else the newest.
It draws the goal and Claude's estimate, a pending version's changes, the assessment, the next session, a calendar of the sessions beside the runs done each day, each session as a workout profile, weekly distance planned against run, measured and expected fitness, fatigue and form, the best-effort prediction across versions, and the version history.
It is read-only: where it asks for a decision, it names `/training-plan` or `plan accept`.
It prints as a PDF of the page, of the page with every session, or of the next week's sessions alone, and copies the next week as plain text, for taking the week along after a Sunday revision.
`docs/reference/frontend.md`, "The views", has each section and why it is drawn as it is.

## Traps

**A version stored before the load fields has none of them.**
Every new field is optional in the schema, so older versions still validate and `plan show` prints them without load lines or zones; only `propose` demands them, through checks 16 to 20.

**The expected load is a snapshot of the other goals' plans too.**
A queued goal's `expected_load` runs the earlier goal's plan, as it stood when the queued version was proposed, up to the queued plan's first week.
A later revision of the earlier plan does not change it; the queued goal's next revision projects again.

**The expected load counts the days since the newest run as planned.**
The projection starts at the newest run's day, so a run done since but not yet ingested counts as whatever the plan had on its day.
Ingest first, as "Fresh runs" says, and the start moves up to the newest run.

**A pointer can resolve to a different figure than the one Claude read.**
`propose` builds the context again and resolves the citations in that copy, checking only that each pointer resolves.
`recent_runs` starts 84 days before `--today`, so a day later its indices shift, and an ingest between `plan context` and `propose` moves the newest run, the predictions and the records.
Run `plan context` again after either before writing pointers.

**A change entry has no citations of its own.**
A figure a change's reason quotes is cited in `assessment.citations`, which is the only list `propose` resolves.

**The predictions' 90-day window ends at the newest run, not at `--today`.**
On a stale store, `recent_best_efforts` describes the 90 days before the newest run, while `recent_runs` and `trends` count back from `--today` and may be empty.

**Frozen means unchanged against the accepted version.**
A draft that replaces a pending revision still has to keep the accepted version's past sessions, whatever the pending one did to them.

**A goal change includes the note.**
Check 10 compares the whole `goal`, so editing only `goal.note` needs `changes[0].goal_change` too.

**The race's outcome needs the race run ingested.**
Check 9 refuses an outcome for a session dated after `data_through`, and check 15 a result before the race date, so a closing version waits for the race's activity to be in the store.

**A goal whose v1 was rejected drops out of the context.**
It stays `proposed` with no pending version, so the context's `plan` leaves it out; proposing again under the same id makes v2 its pending version.

**One unreadable file fails the whole list.**
`GET /api/plans` and `plan list` read every goal's first version and the one `PlanStore.current` picks, so a truncated or hand-edited file under `data/plans/` makes both fail, naming it, until the file is fixed or moved out.

**Session ids are kept across versions by the skill's instruction alone.**
Only check 8 compares ids with the accepted version's, and only for sessions dated on or before `data_through`, where a renamed session reads as one removed and another added.
A future session given a new id passes every check, and the Plan view then marks it changed whatever its content, since it compares a proposal's sessions with the accepted version's by id.
