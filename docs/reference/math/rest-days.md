# Days since the previous run

How many days off the athlete took before this run.

Implemented in `src/activity_analysis/analysis/rest_days.py`.
Tested in `tests/test_rest_days.py` against synthetic run sequences with known answers.

## Definition

For a run with local date $d$, and $d_{\text{prev}}$ the local date of the run immediately before it in the running history:

$$\text{days\_since\_previous\_run} = d - d_{\text{prev}}$$

null when there is no previous run.

Local date is the same quantity `consistency.py`'s week key and the API's `LOCAL_DATE_SQL` both use:

$$d = \left\lfloor t_{\text{utc}} + \Delta_{\text{utc}} \right\rfloor_{\text{date}}$$

with $\Delta_{\text{utc}}$ the recorded `utc_offset_s`, and zero substituted where it is unknown, which is the GPX case.
"Previous" is decided by instant, `start_time_utc`, not by whatever order the rows happen to arrive in.
A run whose local date falls before the previous run's, which flying west between them can do, is clamped to 0, since no day off came between the two.

## Why calendar days and not elapsed hours

The question this answers is how many days off the athlete took, and a day is the unit that question is asked in.
A 07:00 run following a 21:00 run the evening before is ten hours apart.
Measured in elapsed time that is 0.4 days.
Measured in calendar days it is one, an ordinary night between two sessions on consecutive days.
The elapsed-time answer would tell the athlete they barely rested after a run that ended their day and started the next one on schedule.

## Why runs only

Every other view in this project is about running.
A hike or a ride slotted between two runs would shorten the reported gap between them under an all-sports history.
This column is the rest before a run, not the rest before any activity.

## Why whole-history, not per filter

The column is computed once, over every running activity, in the pipeline rather than in the API or the browser.
Every running activity means every one in the canonical layer, including one with no streams or one whose 1 Hz grid failed.
Such a run gets no `activity_metrics` row of its own, but it still happened, so it is still the next run's previous run.
A filtered view - a period, a weekday split, a treadmill toggle - must still report the gap to the previous run in the *history*, not to the previous run left in the filter.
Filtering first would make a Monday run's gap read as the days since the last Monday run in the filter, not the days since the athlete's last run.
That reported gap would then change whenever the filter changed, even on a week where the athlete's training did not.

## Null on the first run

The earliest run in the history has no previous run to measure from, so it is null rather than zero or the span to some assumed starting point.
Zero would claim the athlete rested no days before their first recorded run, which is not a fact this store has.

## Measured on the real store

Measured on 2026-09-28 over the real store, 324 runs, after a `recompute` at `ANALYSIS_VERSION` 9.
The column is null on exactly one run, the first, and set on the other 323.

| Days since the previous run | Runs | Share of the 323 |
| --- | ---: | ---: |
| 0, a second run on the same local day | 16 | 5.0% |
| 1 | 19 | 5.9% |
| 2 | 140 | 43.3% |
| 3 | 68 | 21.1% |
| 4 to 6 | 53 | 16.4% |
| 7 or more | 27 | 8.4% |

The median is 2 days and the mean 3.25.
The longest gap is 23 days.

Two days is also the mode, at 140 runs, twice the 68 at three days.
Measured by elapsed time instead, the same history has a median of 2.4 days.

```sql
SELECT days_since_previous_run, count(*)
FROM activity_metrics
WHERE days_since_previous_run IS NOT NULL
GROUP BY 1 ORDER BY 1
```

## Deliberately not modelled

- **A minimum training age.** The first run's null is permanent for that run; it is never backfilled once enough history exists to guess at a typical gap.
- **Multi-sport rest.** A day spent cycling is not credited against the next run's gap.
  See "Why runs only" above.
