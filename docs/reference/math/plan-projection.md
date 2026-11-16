# Expected fitness, fatigue and form in a training plan

`plan propose` stamps every version with what its planned load is expected to do to fitness (`ctl`), fatigue (`atl`) and form (`ctl - atl`), from the last measured day through the race.
The code is `src/activity_analysis/plan/projection.py`; the stamp is `provenance.expected_load`, described in `docs/reference/plans.md`.
The measured series it continues is derived in [threshold-and-load.md](threshold-and-load.md), "The daily series".

## The recursion

The projection runs the measured series' own recursion on planned TRIMP:

$$x_d = x_{d-1} + \alpha\,(T_d - x_{d-1}), \qquad \alpha = 1 - e^{-1/\tau}$$

with $\tau = 42$ days for `ctl` and $\tau = 7$ for `atl`, started from the context's last `load` day, $d_0$, rather than from zero.
`analysis/load.py`'s `carry_on` is that recursion with a starting value, the one `daily_series` calls from zero, so a projected day and a measured day are computed by one function.

$T_d$ for $d > d_0$ is the day's planned TRIMP.
A week's planned TRIMP is its zone minutes times the athlete's TRIMP per minute in each zone, $\sum_i m_i\,p_i$, `planned_trimp` in `plan/models.py`, with $p_i$ the context's `zones.trimp_per_minute`, which the same version stamps as `provenance.trimp_per_minute`.

With no planned load, $T_d = 0$, and both decay geometrically: $x_{d_0+n} = x_{d_0}\,e^{-n/\tau}$.
With a steady daily load $T$ and $x_{d_0} = T$, $x$ stays at $T$.
`tests/test_plan_projection.py` asserts both.

## Spreading a week over its days

TRIMP is planned per week, and the recursion needs it per day.

- **A week with running sessions** gives each session a share in proportion to its `planned_duration_s`, which check 18 requires on every future running session, so the share is the session's part of the week's running time.
  When any session lacks a duration, as on a version older than the check, the sessions share equally.
- **A week without running sessions**, an outline week, spreads its TRIMP evenly over the days of `constraints.run_days`, or over all seven days when the constraints name none.
- **A day on or before $d_0$ is measured**, so a session dated then keeps its share out of the projection rather than moving it onto a later day.
  The week's zone minutes include it, since check 19 compares them with the whole week's planned durations.

The week's split by intensity is not kept: a session's share is its time's share, so an interval session and an easy run of equal duration get equal TRIMP on their days.
The week's total is right; only its distribution across the week is approximate.

Measured on the real store's 5 km plan, spreading every week evenly over seven days instead of onto its session days moves race-morning form by 0.6% of fitness, and race-morning fitness by less than 0.1%.
`atl`'s seven-day time constant smooths a few days' placement away by the end of the week, and the race week, which check 5 makes detailed, is placed by its sessions.

## Race morning

`race_morning` is the end of the day before the race, the values the athlete carries into it.
The race's own planned TRIMP lands on the race day, so the end of that day would read the race as fatigue the athlete has not yet run.
When the race is the day after $d_0$, race morning is $d_0$ itself, the measured day.

## Weekly means

The stamp holds weekly means rather than daily values, for the reason [threshold-and-load.md](threshold-and-load.md), "Why weekly means", gives: at a few runs a week, daily `atl` and form are a sawtooth that reads as a signal when it is the model's arithmetic.
The weeks are computed by `weekly_series`, the function behind `training_load_weekly.parquet`, so an expected week and a measured week are the same statistic.

The projection's first week usually begins before $d_1 = d_0 + 1$.
Its mean is taken over the measured days of that week, from the context's `load`, and the projected days together, so it covers the whole week as a measured week does.
A mean over the projected days alone would start the expected line from a partial week that steps away from the measured one.

The last week ends at the race, so its `days` is the race's weekday plus one.

Each week also carries the values at its edges: `start`, at the end of the Sunday before it, and `end`, at the end of its Sunday, or in the race week at race morning.
They are daily values, the model as it is on that day, where the means are not; the week PDF prints them as where the week starts and is expected to end.
The first week's `start` is a measured day, read from the context's `load`, and every later week's `start` is the week before's `end`.
A race on a Monday makes the race week's `start` and `end` the same day, the Sunday before it.

## Before the plan's first week

A goal queued behind another starts after the other's race, often months after $d_0$.
Treating the days between as rest is wrong: on the real store, the 10 km goal queued behind the 5 km goal fell to 42% of the fitness the athlete had at $d_0$, and fatigue to under 1% of its value, by its own first week, because five weeks of planned training read as five weeks of rest.

So a day between $d_0$ and the draft's first Monday takes the planned TRIMP of another goal's plan whose span holds it: the goal's pending version, else its accepted one, for every goal that is `active` or `proposed`.
A plan's span is its first week's Monday through its race.
When two spans hold the day, the sooner race's plan is used, the order the goals will be run in.
A day no plan holds, such as the Sunday between one race and the next plan's first Monday, is a rest day.
Every plan is priced with the context's TRIMP per minute, the athlete's current cost of a minute in each zone, rather than the one its own version stamped.
`bridged_from` lists the goals whose plans supplied at least one day, and the Plan view and `plan show` name them.

The stamp is a snapshot: a later revision of the earlier goal's plan does not change it.
The later goal's next revision, normally written after the earlier race, projects again.

## When nothing is stamped

`expected_load` is null, and `propose` and `plan check` print why, when:

- the context has no `zones.trimp_per_minute`, as before the first threshold estimate;
- the context's `load` is empty, as when no run falls in its 84 days, so there is no measured day to start from;
- the race is on or before $d_0$;
- the version closes the goal, carrying a `result`;
- a week holding a day after $d_0$, in the draft or in a plan it runs before its first week, has no zone minutes or plans minutes in a zone with a null TRIMP per minute.

An empty `load` could be started from zero, but a run 85 days before still carries $e^{-85/42} \approx 13\%$ of its weight in `ctl`; a projection from zero would understate fitness without saying so.

## The error that survives

The projection is exact arithmetic on its inputs, so its error is theirs:

- **TRIMP per minute.** It is the last 84 days' cost of a minute in each zone.
  Measured on the real store's 5 km plan, pricing every zone 10% higher raises race-morning fitness by 5.4% and lowers race-morning form by 3.0% of fitness.
  As the athlete gets fitter, a minute in a zone defined by heart rate costs about the same TRIMP, since TRIMP is computed from heart rate; the factor moves with the zones' boundaries and the resting and maximum heart rate.
- **Planned against done.** The projection assumes every planned minute is run.
  The Plan view's weekly load card draws planned against run TRIMP per week; the fitness card draws the measured weekly means against the expected ones, so a gap between them is visible as the weeks pass.
- **The starting day.** $d_0$ is the newest run in the store.
  Days between it and the date the version is written are projected from the plan, so a run done but not yet ingested is counted as planned, and a rest day not yet followed by a run is counted as whatever the plan had on it.

## Deliberately not modelled

- **A target for race-morning form.** The stamp states the value; the `training-plan` skill tells Claude how to read it, and no check enforces a range.
- **Banister's performance model.** Form here is the plain difference of the two means with equal gains, as in the measured series; no performance is fitted to it, so the stamp predicts no race time.
- **Intensity within a week.** See "Spreading a week over its days" above.
- **Load from other sports.** `cross_training` sessions get no share, as the measured series counts running only.
