---
name: training-plan
description: Write, revise or close the athlete's training plan toward a race goal, from the activity-analysis store through `uv run activity-analysis plan`. Use for /training-plan, or when asked to make, revise or check a training plan or a race goal in this checkout.
---

# Training plan

You write and revise the athlete's plan toward a race goal.
The code gathers the facts, checks the plan's shape and stores its versions; the coaching judgement is yours.
Explain your reasoning, and quote no figure about the athlete that you did not read from the context.

Run every command from the checkout root.
Each reads the store `ACTIVITY_ANALYSIS_HOME` names, else the platform's user data folder, where the installed app keeps it; `uv run activity-analysis info` prints which.
Add `--root .` to each command only when the athlete keeps the store in the checkout, under `./data`, and the variable is unset.
`docs/reference/plans.md` has the file format, every check `propose` runs and the traps.

## 1. Read the context

Run `uv run activity-analysis plan context` and read all of it before you ask or write anything.

If `freshness.days_since_newest_run` is over 3, or null, stop and ask the athlete to ingest their newer runs first:

1. Download each new run's "Export Original" zip from Garmin Connect, or copy its `.fit` file off the watch into a folder.
2. Run `uv run activity-analysis ingest <file.zip or folder> --archive-kind garmin`.
   The flag is required: a single zip or a plain folder has no Garmin export layout, and without the flag `ingest` exits 1.

Then run `plan context` again.
If the athlete says there are no newer runs, go on.

If `freshness.days_since_resting_hr` is over 28, or any of `recent_runs` has `rest_from_setting` true, ask the athlete for a full Garmin export as well, since a single run's export carries no resting heart rate:

1. In Garmin Connect, open Account, then Data Management, then Export Your Data, and request the export; Garmin emails a link to the zip.
2. Run `uv run activity-analysis ingest <export.zip>`, which recomputes afterwards.

Say why: TRIMP weighs every run against the resting heart rate, and without a fresh one it uses the newest measured rest up to 90 days old, then the watch's resting setting, which sits above the measured rest and reads the load low.
The export takes Garmin a while, so plan meanwhile if the athlete prefers, and say the load figures are weighed against an older rest or the setting.
When `days_since_resting_hr` is null the store has never held a measured rest, as with a Strava-only store: ask once whether the athlete has a Garmin account, and do not ask again if not.

### Heart-rate zones

The plans steer by five heart-rate zones estimated from the athlete's own hard efforts, not by the watch's default zones, which are percentages of a configured maximum.
Zone 1 is below 85% of the lactate threshold heart rate (LTHR), zone 2 from 85% to 90%, zone 3 from 90% to 95%, zone 4 from 95% to 100%, and zone 5 at the LTHR and above.
`docs/reference/math/threshold-and-load.md` has how the estimate is made; the plan only reads it.

Read `zones`:

- `zones.lthr_bpm` is the estimate, and `zones.boundaries_bpm` the upper edges of zones 1 to 4 in bpm.
  Round each to a whole bpm before you write it anywhere.
- The **easy ceiling** is the top of zone 2, `zones.boundaries_bpm[1]` rounded.
  Every easy and long run is run under it.
- `zones.trimp_per_minute` is what a minute in each zone has cost the athlete over the last 84 days, which turns planned zone minutes into a planned TRIMP; "Load" in step 6 uses it.
- Cite the LTHR and the ceiling in `assessment.citations`: `/zones/lthr_bpm` and `/zones/boundaries_bpm/1`.

The LTHR is due to the athlete, with how to set it on the watch, when any of these holds:

- The plan you write is the first with zones: `plan` is null, `plan.accepted` is null, or `plan.accepted.provenance.lthr_bpm` is null.
- `zones.lthr_bpm` differs from `plan.accepted.provenance.lthr_bpm` by 2 bpm or more.
- The athlete says the watch's zones are not the plan's.

Skip a repeat of the instructions when the athlete confirms the watch already shows these zones.

On a Garmin watch:

1. In Garmin Connect, open the watch's heart-rate zone settings for running.
2. Base the zones on %LTHR, and set the lactate threshold heart rate to the rounded `zones.lthr_bpm`.
3. Check that zones 1 to 4 on the watch end at the four rounded `zones.boundaries_bpm`, and edit them to those values if they do not.
   If the watch offers no %LTHR basis, set the zones in bpm to the same four values.

Without that, the watch's zone numbers and the plan's disagree, and an easy run under the ceiling shows on the watch as a harder zone than the plan means.
Give the instructions at the hand-over, step 8.

When `zones` is null, the store holds too few qualifying hard efforts to estimate a threshold.
Tell the athlete so, and which efforts would give it one, from "Which efforts give a reading" in the math document.
Plan the quality sessions by pace as before, with no heart-rate ranges, and leave the LTHR instructions out.
Say which zones the athlete then sees: the watch's own, `profile.zone_boundaries_bpm`, percentages of the configured maximum, which do not match the plan's zone numbers.
`propose` still requires a heart-rate ceiling on every easy and long run and zone minutes for every week not yet ended, so ask the athlete what heart rate their easy runs stay under, record it in `constraints.notes` as `Athlete-reported:`, and use it as the easy ceiling.
Without zones `propose` stamps no TRIMP per minute, so the plan has no planned TRIMP: write the zone minutes by the zone each part of a session aims for, and bound the weeks by time and distance instead.

## 2. Decide what to do

Read `plan`:

- `null`: no goal is active or pending.
  Start a new goal at step 3.
- `pending` set: a version awaits the athlete's verdict.
  Show it with `uv run activity-analysis plan show <goal_id>` and ask whether to accept it, reject it or replace it.
  Proposing again withdraws it.
- `pending_new_goal` set: a new goal's first version awaits a verdict while `goal_id` is active.
  Accepting it archives the active goal.
- `accepted.goal.race_date` on or before `generated_for`: the race has passed.
  Race day itself counts once the race's run is in the store, `freshness.newest_run_local_date` being the race date.
  Ask for the result and write a closing version, step 5.
- Otherwise: revise the accepted version, step 5.

If the athlete asks for a new goal while one is active, start one at step 3 and tell them that accepting it archives the active goal.

## 3. A new goal: the interview

Ask one question at a time, and wait for each answer before the next:

1. The race distance.
2. The target time, and a result they would still be happy with if the target proves out of reach, such as "under 25:30".
   Record the second in `goal.note`, and use it when the plan says what a checkpoint's result means.
3. The race date.
4. The surface: track, road, trail or other.
5. How many runs a week.
   This is required, and the plan never schedules more.
6. Their weekly volume now, read from `weekly`, and whether they want it to change.
   Hold the recent level unless they ask otherwise, and give every week that drops below it a reason in its `focus`, such as the taper.
7. Which days they can run, and on which days they can reach a track.
8. Anything that could close a surface during the plan, such as snow on a track or a closed gym treadmill.
   Every session that needs that surface then says how to run it without.
9. Injuries or niggles, now or in recent months.
10. Other training and sports, and on which days.
    Schedule around them, and say in a session's description what to avoid the day before it, such as a heavy leg day before a track session or in race week.

Record the answers in `goal` and `constraints`; anything without a field of its own goes in `constraints.notes`.
Give the goal an id of lowercase letters, digits and hyphens, such as `5k-2027-03-13`.

## 4. The estimate

Before estimating, ask the athlete whether they have data of their own that the store lacks or gets wrong:

- Official race results and course distances.
  A watch can measure a course short, which makes every best effort the store extracts from that race slow.
- Recent races or time trials that are not in the store.
- How hard a recent effort really was.

Use what they give.
Record each fact the athlete reports in `constraints.notes`, starting it with `Athlete-reported:`.
In `estimate_reasoning`, say which figures came from the athlete and which from the store.

Then tell the athlete the goal-distance time you estimate they could run today, and the evidence for it.
From the store, base it on recent best efforts only:

- `predictions.recent_best_efforts`: the best effort at each prediction distance in the predictions' 90-day window, with its activity id and date.
  Efforts at or near the goal distance weigh most, and of those the most recent.
- `records`: each all-time record with `fitness_then`, to set against `fitness_now` when you judge how much an older record still says.

Do not base it on the `ordinary_runs` prediction or on `hr_vo2max_smoothed`.
The ordinary-run model reads slow after a breakthrough effort by design; `docs/reference/math/predictions.md`, "Why it runs slow after a breakthrough effort", explains why.

When the best effort nearest the goal distance was on different ground from the goal, such as a road race with climb against a flat track, say which way that moves the estimate, and do not put a number on it unless the athlete or the store supplies one.

If no effort in `recent_best_efforts` lies between half and twice the goal distance, give no estimate.
Set `assessment.estimate_s` to null, say why in `estimate_reasoning`, and schedule a `time_trial` session within two weeks of this version's start, named by an entry in `checkpoints`.
In a revision of an accepted version, the time trial must fall within the 14 days after `freshness.newest_run_local_date`; a trial on or before that date does not count.
No trial is needed when the race itself falls within those 14 days, or in a closing version, with `result` set.
The revision after the trial sets the estimate from its result.

Then give the verdict, `likely`, `possible` or `unlikely`, with your reasoning in `assessment.summary`, opening with the `Verdict:` block step 6 describes.

## 5. A revision, or closing a goal

Start from `plan.accepted`.
Judge every session dated on or before `freshness.newest_run_local_date` that has no outcome yet, against the runs in `recent_runs` on and around its day: `done`, `partial`, `missed`, `moved` or `replaced`, with the activity ids you matched and a note.
Keep the accepted version's outcomes unchanged, since the view reads outcomes from the version it shows: `propose` refuses a version that drops or edits one.
Leave every session dated on or before that date exactly as it is, and every week that has ended (its Sunday on or before that date) with its phase, focus and planned distance: `propose` refuses a version that changes one.
Give an ended week no zone minutes or expected values it did not have: a plan written after the week cannot say what it planned.

For a session with a heart-rate ceiling, the outcome's note says how much of the matched run stayed under it, from that run's `recent_runs[*].estimated_zone_s`, its seconds in zones 1 to 5: the seconds in the ceiling's zone and the zones below it, as a share of all five, such as "82% of the run in zones 1 and 2".
A run mostly above the ceiling was harder than the session asked, and the note says so.
The run's zones are the ones in force on its own date, so the share reads the ceiling as the top of its zone even if the estimate has moved by a bpm since; the Plan view's session dialog gives the exact share at the ceiling as written.
A run without heart rate has an empty `estimated_zone_s`, and its note says the share is unknown.

Change future sessions only where the evidence supports it, and give each change an entry in `changes` with its reason and the session ids it touches.
When the LTHR is due to the athlete because the estimate moved, move every future session's heart-rate targets with it, as one change listing those sessions.
A version accepted before the zones existed has no heart-rate targets and no load or outlook fields: give every future session and every week not yet ended the ones step 6 describes, as one change listing the sessions.
A new target time or race date goes first in `changes`, with `goal_change: true`.
If the estimate was waiting on a time trial, set it from the trial's result.

To close a goal after its race, ask for the result: the time, and whether the goal was achieved.
The race's run has to be in the store first, since `propose` refuses an outcome for a session dated after `freshness.newest_run_local_date`, and a `result` while that date is before the race.
Write a final version from the accepted one with `result` set and outcomes for the sessions still unjudged.
Accepting it closes the goal.

## 6. Write the draft

Read the schema with `uv run activity-analysis plan schema`, and write the draft as JSON to `data/plan-draft.json`, which the `data/*` rule keeps out of git.

- A version holds the whole plan, from the goal's first week to the race week.
- Weeks start on consecutive Mondays, and the last one holds the race date, with a session of kind `race` on it.
- Write sessions out in detail about three weeks ahead.
  Later weeks are outlines, `detailed: false` with phase, focus and planned distance and no sessions.
  The race week is always detailed.
- Every week that has not ended carries `planned_zone_minutes`, `expected_vdot` and, when `fitness_now.garmin_vo2max` is not null, `expected_garmin_vo2max`, from "Load" and "The VO2max outlook" below.
  A closing version, with `result` set, needs none of them.
- Every running session dated after `freshness.newest_run_local_date` in a detailed week has a `planned_duration_s`, warm-up and cool-down included: a quality session's from its steps' paces, an easy or long run's as "Heart-rate targets" below says, and the race's and a time trial's from the target time.
- A session keeps its `id` from one version to the next.
- No week holds more running sessions than `constraints.runs_per_week`.
  Every kind but `rest` and `cross_training` counts.
- Speeds are in m/s: `speed_mps = 1000 / pace_seconds_per_km`.
  Distances are in metres, durations in seconds, and dates are the athlete's local `YYYY-MM-DD`.
- Every figure about the athlete that the assessment or a change's reason quotes gets an entry in `assessment.citations`: a label, and a JSON Pointer into the context such as `/predictions/recent_best_efforts/2/elapsed_time_s`.
  A figure you cannot point at stays out of the plan, unless the athlete reported it in step 1 or 4 and `constraints.notes` records it.

Every session's `description` is read on a phone, before and during the run:

- Say how the session should feel, as an effort out of 10 and in words.
- Spell out the warm-up for every fast session and for the race.
- Explain a drill or a term the first time the plan uses it, such as strides.
- When the athlete's constraints mention a surface that may be unavailable, say how to run the session without it, for example on a treadmill at 1% incline with the speeds in km/h, `km_per_h = 3.6 * speed_mps`.
- Put each step's own effort in that step's `note`, such as `7-8/10`.
- Write strides as their own step with role `strides`, a duration of 15-20 s and a repeat count, such as `{"role": "strides", "repeat": 4, "duration_s": 20}`.
  The recoveries between strides need no step.

Write each description, `assessment.summary`, `assessment.estimate_reasoning` and each change's `reason` as short labelled blocks, which the plan view sets out as headed lists:

- A label is a line of its own ending in `:`, such as `Warm-up:`, `Main set:`, `Feel:`, `If snow closes the track:` or `Cool-down:`.
- Under a label, each line starting `- ` is one item, and holds one instruction.
- A blank line separates one block from the next.
- Any other line is a paragraph.

For example:

```text
Warm-up:
- 2 km easy jog
- 4 strides: short accelerations to near top speed, never a sprint

Main set:
- 5 x 1 km at 4:40-4:45/km
- 2 min easy jog between

Heart rate:
- The last two reps reach 180-190
- Past 190 before then: run the rest at 4:45/km

Feel:
- 7/10, hard but controlled

If snow closes the track:
- Treadmill at 1% incline
- Reps at 12.6-12.9 km/h

Cool-down:
- 2 km very easy
```

Open `assessment.summary` with a block labelled `Verdict:` of one or two items: the verdict on the target in a line, and the one figure it turns on.
The plan view shows that block alone under the feasibility badge, and folds the rest of the summary, `estimate_reasoning` and the citations under "Why this verdict".
For example:

```text
Verdict:
- 41:00 is possible; under 42:00 is likely
- 41:00 is about 3% faster than today's estimate

Why it can work:
- ...
```

A checkpoint, such as a time trial, replaces a quality session of its week rather than adding a run, and its description says so and says what each range of results means for the target and the second goal.

On a track, efforts are timed by laps and a stopwatch, because GPS misreads a track's distance: say so in every track trial and race, with the lap count and the target per 400 m.

### Heart-rate targets

Heart rate steers the easy running, where overtraining happens, and checks the quality work; it does not steer work it cannot follow, since heart rate takes one to two minutes to answer a change of pace.
`propose` checks the easy and long runs' part of this, and the durations, in every session of a detailed week dated after `freshness.newest_run_local_date`, which it stamps as `data_through`: checks 17 to 19 in `plans.md`.
The quality sessions' ranges are yours to keep.

- **Easy and long runs** are run by the easy ceiling, with no pace target.
  Every step but strides carries `"heart_rate": {"high_bpm": <ceiling>}`, a range without `low_bpm`, which is a ceiling, and no step carries a `speed`, strides included.
  Write the session by distance, and give it a `planned_duration_s` estimated from the pace of the athlete's recent runs held under the ceiling: runs in `recent_runs` tagged `easy` or `steady` whose `estimated_zone_s` lies mostly in zones 1 and 2.
  Lean slower: those runs were not all run under the ceiling the whole way, and a run held under it is slower than one that drifted above it.
  The description gives the time as an estimate, such as "8 km, about 50 min", and says the time follows from the heart rate, not the other way round.
- **Tempo, threshold and repetitions of 3 minutes or more** keep their `speed` range and add a `heart_rate` range on the work step: the range of the zone the final repetitions should reach.
  That is zone 3, `zones.boundaries_bpm[1]` to `[2]`, for tempo, zone 4, `[2]` to `[3]`, for threshold, and zone 5, from the LTHR to 106% of it, for repetitions at 5 km pace or faster.
  The range is a check that the session is not harder than intended, not a target to chase: the description says that if heart rate passes the range before the final repetitions, the pace is too fast, and to run the rest at the slow end of the pace range.
- **Strides and repetitions shorter than 3 minutes** carry no heart rate, since it never settles within them.
- Warm-up and cool-down steps of a quality session carry the easy ceiling and no speed.

Every description with a ceiling says what to do when heart rate passes it: slow down until it is back under, and on a hill, walk briefly.
Write it under a label of its own, such as:

```text
Run:
- 8 km easy, about 50 min
- Keep heart rate under 150

If heart rate passes 150:
- Slow down until it is back under
- On a hill, walk for a few seconds

Feel:
- 3/10, conversational the whole way
```

### Load

The plan's load is Banister's TRIMP, the heart-rate training impulse `recompute` computes for every run; `docs/reference/math/threshold-and-load.md` has how.
A week's planned TRIMP is `sum(planned_zone_minutes[i] * trimp_per_minute[i])` over zones 1 to 5, with `zones.trimp_per_minute`, which `propose` stamps on the version; cite it as `/zones/trimp_per_minute`.

- Give every week that has not ended `planned_zone_minutes`, outline weeks included.
- In a detailed week, split each running session's `planned_duration_s` across the zones its steps aim for: easy and long running, warm-ups and cool-downs in zones 1 and 2, in the proportion the recent runs under the ceiling show, recoveries in zones 1 and 2, and each work step in the zone of its heart-rate range, or for short repetitions the zone their pace reaches.
  The week's five numbers then add up to its running sessions' durations, in minutes; `propose` refuses more than 10% apart in a week with no past session.
  A week with past sessions counts them at the minutes they were planned to take.
  A past session from a version written before durations existed has none; estimate it the way you would plan it, or leave the week's total as your best figure, since check 19 skips a week that holds a past session.
- In an outline week, split its expected running time the same way, by the sessions its phase would hold.
- Start from the load the athlete is used to.
  `load[*].ctl`, fitness, is the 42-day exponential mean of the daily TRIMP, and settles near a seventh of a steady weekly TRIMP, so seven times the last entry's `ctl` is the weekly TRIMP the athlete's fitness is built on.
  Cite it as `/load/<last index>/ctl`, and set it beside `weekly[*].trimp` for the recent weeks.
  `atl`, fatigue, is the 7-day mean, and `form` is `ctl - atl`; at a few runs a week both zigzag from day to day, so read them over the last week rather than on one day.
  The series ends at the newest run's day, which may be before `generated_for`.
- Raise planned weekly TRIMP gradually, by about 10% a week at most, with a recovery week about a quarter lower every third or fourth week and the taper falling into the race.
  Give any week that rises faster, or falls without being a recovery week or the taper, a reason in its `focus`.
  TRIMP counts intensity as well as time, so a week that keeps its distance and adds a threshold session rises too.
- A zone with planned minutes and a null `trimp_per_minute`, which no run reached in the 84 days, leaves the week without a planned TRIMP; judge that week's rise by its minutes, and say so at the hand-over.
- Watch distance separately: TRIMP measures the heart, distance the legs, and a heart that has grown fitter can absorb a jump in distance that tendons cannot.
  `load[*].distance_7d_m` is the running distance over the 7 days ending each day.
  When a week raises its planned distance above the recent level, cite the last entry's `distance_7d_m` and keep the rise to about 10% a week, whatever the TRIMP says.

### Fitness, fatigue and form

`plan check` and `plan propose` run the planned TRIMP through the same recursion as the measured `ctl` and `atl`, from the last `load` day to the race, and print the result; `docs/reference/math/plan-projection.md` has how.
They print `Expected from <day> to race morning: fitness 40.0 -> 41.2, fatigue 52.5 -> 35.0, form -12.5 -> +6.2`, and after each week's TRIMP its expected means, `week means fitness 41, fatigue 44, form -3`.
Read both before proposing, and change the draft until they hold:

- **The build raises fitness.** Across the build weeks the fitness means rise, and a recovery week dips them only a little.
  Fitness flat or falling through a build means the planned TRIMP sits at or below seven times the current `ctl`; raise it within the 10% rule above, or give the reason in the weeks' `focus`.
- **Form is positive on race morning.** The taper turns fatigue into form: race-morning form below zero means the athlete starts the race still carrying training, so make the taper longer or cut more of its volume.
  The taper literature (Mujika and Padilla, 2003) puts an effective taper at 8 to 14 days, volume cut by about 40 to 60%, with the intensity and the number of sessions kept; a 5 km or 10 km needs the short end, a marathon the long end.
- **The taper keeps most of the fitness.** Race-morning fitness is within about a tenth of the highest weekly mean before the taper; a taper that costs more is longer or deeper than the race needs.
- **Form is not a target in numbers.** TRIMP's scale is not the TSS scale that published form targets are quoted in, so read the sign of race-morning form and how much fitness the taper gives up, not a number from elsewhere.

When it prints `No expected fitness and fatigue: <reason>`, fix the draft if the reason names a week without a planned TRIMP; for any other reason say at the hand-over that the plan has no projection, and why.
A goal queued behind another prints `Before this plan's first week it runs the plan of <goal>`: the projection runs that goal's plan until this one starts, so check it names the goal the athlete will run first.
Quote the race-morning form and fitness in `estimate_reasoning` or the taper week's `focus` when they shaped the taper; the figures are not in the context, so there is nothing to cite.

Every detailed week that has not ended carries a `load_note`: one or two sentences, to the athlete, on how to run the week given its load, which opens the week's PDF beside the start and end figures.
`plan check` prints each week's `Fitness 40.0 -> 41.2, fatigue 52.5 -> 35.0, form -12.5 -> +6.2 over the week`, even while it lists problems such as a missing note; write the note from that line and the week's sessions.
Say what the numbers mean for the runs: which sessions carry the week and which to hold back on so they land, what to do when fatigue shows, and in the taper why the volume falls.
Do not restate the numbers, which the PDF prints beside it; `propose` refuses a detailed week without one (check 20).

### Long runs and decoupling

Long runs progress on a schedule, and decoupling is a brake on it, not a gate.

- Lengthen the long run by about 1-2 km, or about 10%, every one to two weeks, with the recovery weeks' cutbacks, toward the longest run the race needs.
  For a marathon that is 30-32 km, 3 to 5 weeks before the race.
- A long run that is part marathon pace or a progression has a pace target, which check 17 refuses on a session of kind `long`.
  Write it as kind `tempo`, titled as the week's long run, such as "Long run with 8 km at marathon pace", with the easy part under the ceiling and the marathon-pace block carrying its `speed` and a `heart_rate` range.
  It counts as the week's long run.

Aerobic decoupling is how much heart rate drifts up against pace from a run's first half to its second.
Under 5% is the conventional mark of durability over the distance, and 5-10% is common in a build.
It is read only on long aerobic runs, which the trends mark, and only from those that mostly stayed under the ceiling, since a run spent in zones 3 to 5 drifts for that reason alone:

- `trends.items[*].is_aerobic_long_run` marks the runs it is defined on, and `trends.items[*].decoupling_smoothed_pct` is the trailing mean over them, the trend to read.
- Of those runs, count only the ones whose `estimated_zone_s` in `recent_runs`, matched by `activity_id`, lies mostly in zones 1 and 2.
- A single long run's figure swings by several points with heat, hills and fuelling, so one high value is no signal.

The brake applies only to a step beyond the longest recent long run, and holds the distance for one week, when the last two such long runs both exceed about 10% or the smoothed series rises clearly.
With fewer than two such runs, read the smoothed series alone.
Quote the smoothed figure in the week's `focus` or a change's reason, and cite it in `assessment.citations` as `/trends/items/<index>/decoupling_smoothed_pct`.
Then give the way forward in the session's description: repeat the distance once at a lower effort, under the ceiling the whole way; check the heat, the hills and the fuelling of the runs that drifted; and then take a smaller step.

### The VO2max outlook

Every week that has not ended carries `expected_vdot` and `expected_garmin_vo2max`, the values you expect at the end of that week, and the race week's at the race; the second only when there is a Garmin value to start from.

- `expected_vdot` is the value you expect the best-efforts prediction series to have at the end of the week, the series the Trends view draws as its solid line.
  It starts at `fitness_now.best_efforts_vdot`, cited as `/fitness_now/best_efforts_vdot`, whether or not `estimate_s` is null.
  `propose` refuses a draft whose first week that has not ended sits more than `EXPECTED_VDOT_START_TOLERANCE` (1.9 VDOT units) from it (check 21), so the dotted line begins where the solid one ends.
  When `fitness_now.best_efforts_vdot` is null, start from the VDOT of `assessment.estimate_s`, which `propose` stamps as `provenance.estimate_vdot`, and say so.
  Compute that VDOT with the same function: `uv run python -c "from activity_analysis.analysis.fitness import vdot; print(vdot(<goal distance_m>, <estimate_s>))"`.
  Each day's raw value is the mean VDOT of the three best runs in the 90 days up to it, and the series averages that value over the 42 days up to the day, so it trails the fitness the training builds.
  With a run every second day, a rise held from one day is half in after 22 days and all in after 45, and a steady rise shows about 23 days late.
  A fall shows nothing for 84 days, while the old best runs stay in the 90 days, and is all in after 129.
  One breakthrough run among unchanged ones lifts the series by a third of its step, after 41 days; it takes three runs at a new level to reach it.
  `docs/reference/math/predictions.md`, "The lag", has the measurement.
  The race week's `expected_vdot` is the series value expected on race day, which trails race-day fitness by that lag.
  The `likely`, `possible` or `unlikely` verdict rests on your race-day estimate, `assessment.estimate_s` against the target, not on where the curve ends.
  Let the curve trail accordingly: it keeps rising through a taper.
  It is not `fitness_now.vdot`, which is one run's VDOT, easy runs included, and reads far below race fitness.
- `expected_garmin_vo2max` starts at `fitness_now.garmin_vo2max`, cited as `/fitness_now/garmin_vo2max`.
  When that is null, as on a store without Garmin's VO2max, leave `expected_garmin_vo2max` out: there is nothing to start from, and `propose` does not ask for it.
  The value is unrounded, so write each week's `expected_garmin_vo2max` to one decimal.
  The watch shows it as a whole number that moves slowly, a point or two over a block of training, so expect little change.
- Neither curve is a straight line: each flattens in base weeks and recovery weeks and rises through the quality blocks.
  Through the taper they differ: `expected_vdot` keeps rising, because the efforts of the block before it are still entering the 42-day mean, while `expected_garmin_vo2max` holds.
  Say in `estimate_reasoning` why the curves have the shape they have.
- With `estimate_s` null, `expected_vdot` still starts at `fitness_now.best_efforts_vdot`; say so, and reset the curve from the time trial's result in the revision after it.

Before proposing, read every description back and split any line that holds more than one instruction.

## 7. Propose

Run `uv run activity-analysis plan check data/plan-draft.json` first.
It runs every check `propose` runs and prints what `propose` would, storing nothing, so a fix costs no version number: every `propose` takes the next one and withdraws the version pending before it.
It prints the plan and its expected load even when the draft fails a check, then lists one sentence per problem and exits 1; fix each one and check again.
When it passes and its output holds up against "Load" and "Fitness, fatigue and form" above, run `uv run activity-analysis plan propose data/plan-draft.json`.
On success it prints the plan back in paces and local dates; check every pace against the one you meant.
It also prints each week's planned TRIMP with its change from the week before, such as `TRIMP 512 (+8%)`, and each step steered by heart rate alone with its zone, such as `up to 150 bpm (Z2)`; a step with a pace prints the pace only.
Check every rise against "Load" above, the expected fitness and form against "Fitness, fatigue and form", and every ceiling against the zone you meant, and fix the draft before handing it over.
The first week prints no change, so check it against seven times the last `ctl` yourself.

`propose` builds the context again and resolves your pointers in that copy.
An ingest or a change of date between `plan context` and `propose` can move what a pointer names, so after either, run `plan context` again and check your pointers.

## 8. Hand over

Tell the athlete to open the Plan view at `/plan` in the app, and summarise the plan or the changes, with the form and fitness it expects on race morning.
When step 1 says the LTHR is due, give the athlete its value and the watch instructions here, before the verdict.
`serve` serves the frontend from `web/dist`, which a checkout builds by hand, so tell them to run `cd web && npm run build` first and then `uv run activity-analysis serve`.
A `web/dist` built before the Plan view existed has no `/plan`.
Alternatively, `cd web && npm run dev` beside `uv run activity-analysis serve` serves the current frontend at `http://localhost:5173/plan` without a build.
Wait for their verdict, then run `uv run activity-analysis plan accept <goal_id>` or `uv run activity-analysis plan reject <goal_id>`.
Do not accept a version without their word.
