# Streaks and consistency

How often the athlete ran, reduced to two numbers that the overview can show.

This is the only metric the API introduces, and it lives in `analysis/` with the rest of them rather than in a router, because two implementations of the same metric drift, and the one the user sees would be the one without tests behind it.

Implemented in `src/activity_analysis/analysis/consistency.py`.
Tested in `tests/test_consistency.py` against synthetic weeks with known answers.

## What is being counted

A **week** is an ISO week, Monday to Sunday.
Weeks are identified by their Monday, so a week is a `date` and arithmetic on weeks is arithmetic on dates:

$$w(d) = d - \text{weekday}(d)\ \text{days}$$

where $\text{weekday}$ is 0 on Monday and 6 on Sunday.

A week **counts** when it holds at least one run.
A **streak** is a maximal set of consecutive counting weeks.
**Consistency** over a span is how many of the last $N$ weeks count, reported as a count out of a count.

Every quantity the overview reports is measured over $W \cap \{ w \le w_0 \}$, the counting weeks up to and including the current one - the streak and consistency defined here, and equally the weekly and monthly volume buckets, the zone totals, and the first and last run dates that `/api/overview` serves beside them.
A store can hold an activity stamped in the future, because a device clock can be wrong, and a week that has not happened yet is not training the athlete has done.
Left unbounded it would do real damage in both places: in consistency it would be counted inside a window it is not in, and in the longest streak it would bridge two separate runs of weeks into one and then name a week nobody has run in yet as the week that ended it.
The bound is applied once per reader of $W$ - at the top of each function here, and as a single `through` date the API passes into each of its overview queries - so no two fields of one response describe different stretches of the athlete's history.

## Why the week and not the day

A daily streak counts rest days as failures.
Rest days are training: they are when adaptation happens, and a plan without them is a worse plan.
A metric that penalises them would be measuring compliance with a rule nobody should follow.

This was rejected on that ground alone, without measurement.
There is no experiment that would make a daily streak the right shape for this number.

The weekly streak has the property that matters instead: it distinguishes an athlete who trains most weeks from one who trains in bursts, and it is indifferent to which days within a week those runs land on.

## Why the bucket key is the local date

A run belongs to the week the athlete ran it in, not the week UTC was in at the time.
The bucket key is therefore

$$d_{\text{local}} = \left\lfloor t_{\text{utc}} + \Delta_{\text{utc}} \right\rfloor_{\text{date}}$$

with $\Delta_{\text{utc}}$ the offset the watch was set to, stored per activity as `utc_offset_s`, and zero substituted when it is unknown, which is the GPX case.

Measured over the real export on 2026-08-30: 15 of 307 runs were recorded outside the two offsets the athlete usually runs at, one per side of daylight saving, and assuming those would render 21 of the 307 at the wrong hour.
The same measurement found **no run changing calendar day** between the two renderings, so weekly bucketing is currently unaffected by this choice.

It is still made this way.
The next trip is not guaranteed to be as kind, an early-morning or late-evening run under a large offset is exactly the case that moves, and the correction costs one addition.
An offset is stored rather than a timezone name because FIT records the offset the watch was set to and not the zone the athlete was in, and a zone guessed from the coordinates would be an inferred value stored in the canonical layer beside recorded ones.

## The week in progress

The rule that needs deriving is what to do about the week that has not finished.

Let $W$ be the set of counting weeks and $w_0 = w(\text{today})$ the current week.
The naive definition walks back from $w_0$ while weeks are in $W$:

$$L_{\text{naive}} = \max \{ n : w_0 - k \in W \ \text{for all}\ 0 \le k < n \}$$

This is wrong at the start of every week.
If $w_0 \notin W$ because it is Monday morning and the athlete has not run yet, $L_{\text{naive}} = 0$ regardless of how many weeks preceded it.
A nine-week streak reports zero at Monday 00:00 and nine again on the first run of the week.

The shipped definition steps over an empty current week rather than treating it as a break:

$$s = \begin{cases} w_0 & w_0 \in W \\ w_0 - 1 & \text{otherwise} \end{cases} \qquad L = \max \{ n : s - k \in W \ \text{for all}\ 0 \le k < n \}$$

So the current week counts towards the length only once it holds a run, and only a *completed* empty week breaks a streak.

### Demonstrated on the fixtures

The five committed activities in `data/examples/` fall on these local dates, all at UTC+2:

| local date | day | week (Monday) |
| --- | --- | --- |
| 2026-08-21 | Fri | 2026-08-17 |
| 2026-08-23 | Sun | 2026-08-17 |
| 2026-08-25 | Tue | 2026-08-24 |
| 2026-08-26 | Wed | 2026-08-24 |
| 2026-08-28 | Fri | 2026-08-24 |

Two counting weeks, consecutive. The two definitions diverge exactly where predicted:

| evaluated on | day | $L_{\text{naive}}$ | $L$ shipped |
| --- | --- | --- | --- |
| 2026-08-30 | Sun | 2 | 2 |
| 2026-08-31 | Mon | **0** | **2** |
| 2026-09-07 | Mon | 0 | 0 |

The last row is the check that the grace rule does not simply refuse to end streaks: by 2026-09-07 the week of 2026-08-31 has completed with no run in it, so the streak is broken under both definitions.

Reproduce with:

```bash
uv run pytest tests/test_consistency.py -v
```

`test_a_streak_survives_a_monday_morning_with_no_run_yet` and `test_a_completed_empty_week_still_breaks_the_streak` are the two rows that differ.

## The longest streak

Found by scanning $W$ rather than by walking back from today, since the longest streak is usually not the current one:

$$L_{\max} = \max_{\substack{s \in W \\ s - 1 \notin W}} \ \max \{ n : s + k \in W \ \text{for all}\ 0 \le k < n \}$$

The outer maximum ranges only over weeks that begin a run, which is what `s - WEEK not in counted` tests, so each maximal run is measured once. The cost is linear in $|W|$.

Note that $W$ here is already bounded above at $w_0$, per "What is being counted".
`test_the_longest_streak_is_measured_over_completed_weeks_only` is what holds that: without the bound, a single future week bridges two four-week streaks into a five-week one.

The week that ended the longest streak is reported alongside it, because a long streak that ended a year ago means something different from one that ended yesterday.

When several streaks tie for $L_{\max}$, the **most recent** is named. Both are equally long and equally correct, and which one it was is precisely the part the reader cannot reconstruct from the number; naming the recent one also answers whether the athlete is in their best streak right now.
The scan runs in ascending order and keeps a run of equal length, which is what `test_the_most_recent_of_two_equally_long_streaks_is_the_one_named` pins.

## Consistency

$$C = \left| \{ w \in W : w_0 - (N-1) \le w \le w_0 \} \right| \quad \text{out of} \quad N, \qquad N = 52$$

Reported as both numbers rather than as their ratio.
30 of 52 is a fact; 58% is a rounding of it, and a percentage invites comparison against a target that nobody set.

The upper bound $w \le w_0$ is the module-wide one described under "What is being counted"; it is written into the filter here rather than applied separately, since this filter is two-sided anyway.
`test_consistency_ignores_a_week_in_the_future` is its test.

## The weekly distance trend

The overview's Full history chart draws weekly distance as bars and, over them, a trailing average of the same series, so a change in training volume reads as a change in one line's level rather than as a shift in the texture of 150 bars.
It is volume, so it is not part of consistency; it lives here because it is built on the same week, the same dense weekly series and the same window.

Implemented in `web/src/charts/volumeBarsMath.ts` as `trailingMean` and `trendLastIndex`.
Tested in `web/src/charts/volumeBarsMath.test.ts` against short synthetic series with known answers.
It is computed in the frontend because it is a smoothing of a series the API already serves, and it changes no stored value.

### Definition

With $d_i$ the distance run in week $i$ of the dense weekly series and $n = 9$:

$$\bar d_i = \frac{1}{n} \sum_{j = i - n + 1}^{i} d_j \qquad \text{for } n - 1 \le i \le L$$

and no value elsewhere.
A week with no run has $d_j = 0$ and counts as such, because the series is dense for the reason `/api/overview` gives: a week off is a fact about the training, and an average that skipped it would say the athlete ran more than they did.
The line starts once the window is full, so its first point is an average of nine weeks rather than of however many exist.

$L$ is the last week the store knows about: the latest week that is both **finished**, meaning today has reached the Monday after it, and **not after the latest activity of any sport**, which `/api/overview` serves as `last_activity_local_date`.

- The week in progress is left out because its total is a partial week's and always reads low.
- A week after the latest activity is left out because the store is built from an export, and a week after the export ends is one nothing is known about rather than a week off.
- The bound is any sport rather than running, so that an athlete who stops running and keeps cycling gets a line that falls, which is what happened to their running.

Measured on 2026-09-27, four weeks after the export the real store was built from ends: counting those weeks as zeros cut the 9-week average at the end of the line by 40%, and a 4-week average to 0.

### Why nine weeks

The maintainer chose two months, 8.7 weeks rounded to 9, from one, two and three months on 2026-09-27.
Measured over the 147 weeks from the first run to the last, where weekly distance has a standard deviation of 0.69 of its mean:

| window | swings over 3 km per year | lag behind a change |
| --- | --- | --- |
| 4 weeks, one month | 11.2 | 1.5 weeks |
| 9 weeks, two months | 4.5 | 4 weeks |
| 13 weeks, three months | 1.9 | 6 weeks |

A **swing** is a reversal of the average's direction after it has moved at least 3 km, counted by a zigzag filter with that threshold, so it counts the build-ups and breaks a reader would name and not the week-to-week wobble.
Four weeks follows the bars closely enough to add little to them; thirteen shows only the year-scale climb, in which the mean week of 2026 is 2.7 times that of 2023, and shows a step up in training six weeks late.

### The error that survives

A trailing average lags.
A step change in weekly distance reaches half its new level after $(n - 1) / 2 = 4$ weeks and the whole of it after 8, so the line's end describes the last two months and not the last week.
A centred average has no lag but has no value for the last four weeks, which are what a reader looks at to see where they are now, so it was not used.

To reproduce the table, take `weeks` from `/api/overview` up to the week of `last_run_local_date`, and for each window apply a trailing mean and count reversals of at least 3 km.
The committed fixtures span two weeks and cannot fill a 9-week window, so these figures come from the real store, like the figures in the section below.

## What these numbers say on the real history

Measured 2026-08-30 over the 307 runs in the real export:

| quantity | value |
| --- | --- |
| weeks holding at least one run | 132 |
| weeks spanned, first run to last | 147 |
| current streak | 8 weeks |
| longest streak | 30 weeks |
| consistency over the last 52 weeks | 49 of 52 |

These are given for scale, not as a test: the tests assert against synthetic weeks with known answers, because real data has no independent ground truth.

## Deliberately not modelled

- **Distance, duration and intensity.** A week with one 3 km jog counts the same as a week with 60 km. This metric answers whether the athlete trained, and volume is already the overview's weekly chart. Merging the two would produce a number that means neither.
- **Planned weeks.** A deliberate down week and a missed week are indistinguishable here, because nothing in the store records intent. Adding a training plan would change that, and would change this metric.
- **Sports other than running.** `W` is built from runs alone, so a week of cycling does not count. That follows the derived layer, which covers running only.
- **Partial weeks at the start of history.** The first week the athlete ever ran is treated like any other. It is not scaled by the fraction of it that had elapsed.
