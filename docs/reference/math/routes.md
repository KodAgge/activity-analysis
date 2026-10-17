# Route grouping and route records

Implemented in `src/activity_analysis/analysis/routes.py`.
Tested in `tests/test_routes.py` against synthetic traces with known answers.
Every measurement below was taken on 2026-09-24, over the 221 outdoor running activities with GPS in the store on that day, except the direction and jump figures, taken on 2026-09-25.

## What is being computed

A best effort answers how fast an activity covered a distance.
A route record answers whether the athlete is getting faster on one loop run repeatedly, holding the hills and the surface fixed because the ground is the same one.
This document derives how two runs are recognised as the same route, what is compared once they are, and the eligibility and ranking rules that turn a group of runs into a record.

## The trace

A candidate run's trace is the derived 1 Hz grid's positions with a finite `distance_m`, `lat_deg` and `lon_deg`, ordered by `t_s`, resampled to `TRACE_POINTS` = 200 points evenly spaced by cumulative distance (`resample_trace`).
A run with fewer than `MIN_SAMPLES` = 10 usable seconds produces no trace and takes no further part in grouping.

Resampling by distance rather than by time is what makes two traces comparable point by point regardless of pace: point $k$ of one trace and point $k$ of another sit at the same fraction of each run's own distance, whatever the pace was that day.

## The per-pair projection, and why

Two traces are compared as points on a plane rather than on the sphere, because the comparison is a nearest-point search over 200 x 200 pairs per candidate, and a flat plane is cheap where a great-circle search is not.
A first pass fixed one plane for all 221 candidate runs, centred on one fixed latitude.
It stretched east-west distances in the city most of the runs were recorded in by about a quarter, because a plane's scale is only correct at its own centring latitude, and every run measured in that pass sits south of it.

Every figure in this document is from the projection that replaced it.
`pair_metrics` builds a separate equirectangular plane for each pair, tangent at the first trace's own start (`_project`):

$$x = (\lambda - \lambda_0)\,R\cos\varphi_0, \qquad y = (\varphi - \varphi_0)\,R,$$

so the scale is right wherever the pair happens to be, at the cost of one plane per pair rather than one plane for the whole store.
$R$ is `EARTH_RADIUS_M` = 6,371,000 m, the same mean radius [geodesy.md](geodesy.md) uses.

## The candidate filter

Comparing every pair of runs is quadratic in the number of runs, and almost all of it is wasted: two runs starting a kilometre apart are not the same route whatever their traces look like.
A pair becomes a candidate only when their starts are at most `CANDIDATE_START_M` = 300 m apart and their recorded distances are within `CANDIDATE_DISTANCE_FRACTION` = 15% of the longer one.

The 300 m check does not call `haversine_m`, the great-circle formula [geodesy.md](geodesy.md) derives and this project reserves that name for.
It projects the second run's start through `_project` onto the plane tangent at the first run's own start: $\Delta x = R\cos\varphi_0\,\Delta\lambda$, $\Delta y = R\,\Delta\varphi$, distance $= \sqrt{\Delta x^2 + \Delta y^2}$.
Measured against `haversine_m` over 20,000 random bearings 300 m from a point at the fixtures' latitude, 57.77 degrees north, the two agree to within 4.3 mm, a relative error of about 1.4 x 10⁻⁵, well under the metre-scale noise `best-efforts.md` already measures in a GPS-derived distance.

Over the 221 runs this leaves 1826 candidate pairs.

## The two pair measures

`pair_metrics` reduces a candidate pair to two numbers, both derived from the 200 x 200 table of distances between every point of one trace and every point of the other.

The **mean nearest-point distance**: for each of the 200 points of one trace, the distance to the nearest point of the other, averaged both ways over all 200 points.
Its histogram over the 1826 candidates peaks at 10 to 15 m.

The **worst point**: the largest of those same nearest-point distances, again both ways, but taken only over points `TRIM_POINTS` to `TRACE_POINTS - TRIM_POINTS - 1`, 10 to 189 of the 200, 5% trimmed from each end.

The worst point is where two runs of one route actually differ, and that is mostly at the start and the finish.
On the main loop, a 100 m worst-point test with no trimming keeps 21 of its 27 runs together.
Of the 6 it splits off, 4 stay within 8 to 25 m of the combined path of the rest for the whole route and differ from particular single runs only near the start or finish.
The other 2 differ from that combined path only at their very start, by 84 m and 113 m, and stay within 42 m of it beyond the first and last 5%: the watch was started at a different spot, not a different route.
Trimming the ends before taking the worst point is what keeps those two in.

## The link, and the grouping thresholds

A pair links when its mean is at most `MAX_MEAN_M` = 20 m and its trimmed worst point is at most `MAX_WORST_M` = 150 m.
Three combinations were measured over the 1826 candidates:

| Worst point | Ends trimmed | Runs in routes of 2+ | Routes of 3+ (runs) | Routes of 5+ (runs) | Main loop |
| --- | --- | --- | --- | --- | --- |
| 100 m | no | 82 | 10 (50) | 2 (26) | 21 |
| 100 m | 5% | 89 | 10 (65) | 4 (45) | 26 |
| 150 m | 5% | 95 | 9 (67) | 6 (57) | 27 |

The chosen row is `MAX_WORST_M` and `TRIM_POINTS` in the code.
It groups 95 runs into routes of two or more, and 67 runs into nine routes of three or more, of 27 runs (the main loop), 9, 6, 5, 5, 5, 4, 3 and 3.
This document calls them route 1 to route 9 in that order, the three of five runs and the two of three in ascending order of median distance.
The decision page that chose this rule showed the first pass's figure for it, 65 runs across the same 9 routes; the per-pair projection that replaced that pass adds two runs to route 2.

`MIN_RUNS` = 3 is the count at which a cluster becomes a route rather than an uncounted pair or triple: "a route counts at 3 runs", decided on the same page.

## Complete linkage, and why a chain is refused

`_complete_linkage` repeatedly merges the two clusters whose worst cross-pair mean distance is smallest, so long as every pair across the two clusters links at all, and stops when no two clusters satisfy that; clusters of `MIN_RUNS` or more are kept as routes.

"Every cross pair links" is complete linkage rather than single linkage.
Single linkage would let run A join a cluster because it links to run B, when B already sits in a cluster with run C and A never links to C directly, chaining separate routes together through one run that barely overlaps each.
Complete linkage refuses that: a candidate merge is checked against every member of the cluster it would join, not only the nearest one, so A only joins if it also links to C.

Ties are broken deterministically: clusters start as singletons in ascending order of `start_time_utc` then `activity_id`, and a merge candidate needs a strictly smaller worst-case distance to displace an earlier one, so the result does not depend on the order the runs were read in.

## The medoid, and direction

A route's reference run is its medoid, the member with the smallest sum of mean distances to every other member, ties broken by the earlier `start_time_utc` then `activity_id`.
It is the run drawn on the map.
Each run's `mean_distance_m` and `worst_distance_m` are the two measures of its link to the medoid, as `_links` measured them on the plane of whichever of the pair started earlier; the medoid's own are zero.
Complete linkage put every pair in a route through the link test, so that link always exists.

Direction is measured against a different run: the route's earliest, whose `activity_id` is the `route_id`.
The medoid can move when a later run joins, and a direction measured against it would flip every run's label when it moved onto a run of the other direction; the earliest run never changes.

`direction` compares two traces index by index, point $k$ of one with point $k$ of the other, which the resampling by distance makes comparable, rather than by the nearest-point search the grouping uses.
With $e_k$ the earliest run's points and $r_k$ the run's, both projected on the plane tangent at the earliest run's start,

$$F = \frac{1}{200}\sum_k \lvert e_k - r_k \rvert, \qquad B = \frac{1}{200}\sum_k \lvert e_{199-k} - r_k \rvert,$$

and the run is `reverse` when $B < $ `REVERSE_FRACTION` $\cdot F$, with `REVERSE_FRACTION` = 0.5, and `forward` otherwise.
A run the other way round a loop has $B$ near its GPS noise and $F$ near the loop's mean chord, so it clears the half by a wide margin; the half keeps a near tie `forward`.

`is_out_and_back` applies the same $B$ to the earliest run against itself.
When it is at most `MAX_MEAN_M` = 20 m, the route doubles back along its own path, running it the other way visits nearly the same points in nearly the same order, and every run on it is `forward`.

The rule it replaced called a run `reverse` whenever $B < F$ against the medoid, and on the real store that was noise.
On route 9 the medoid read backwards is 63 m from itself, and the one run it marked `reverse` read 79 m forward and 76 m backward.
On route 5 the medoid read backwards is 15 m from itself, and its four other runs read 34, 51, 24 and 16 m forward against 36, 62, 31 and 23 m backward.

Measured against each route's earliest run on 2026-09-25:

| Route | Earliest run read backwards, from itself | Smallest $B / F$ over its runs |
| --- | --- | --- |
| route 1 | 448.1 m | 2.74 |
| route 2 | 299.4 m | 2.39 |
| route 3 | 471.0 m | 3.09 |
| route 4 | 282.5 m | 2.54 |
| route 5 | 57.9 m | 0.53 |
| route 6 | 431.8 m | 7.66 |
| route 7 | 244.9 m | 1.82 |
| route 8 | 1179.3 m | 15.81 |
| route 9 | 65.6 m | 0.83 |

No route is an out-and-back by the 20 m rule, and no run is `reverse`: four runs read closer backwards, 0.53 and 0.57 of $F$ on route 5 and 0.83 and 0.95 on route 9, and none is under half.

## Naming

A route's name is its most common `locality` among its members, ties broken alphabetically, followed by its median distance to 0.1 km: a route of runs like the 7456 m reference fixture, mostly started in Jönköping with a median of 7.5 km, would be `Jönköping 7.5 km`.

**When no run in a route has a locality, the name uses `Route` in its place**, for example `Route 7.5 km`: the fallback is `locality or 'Route'`, so a route with no locality names itself the same way whether none of its runs recorded a position or every one of them did but resolved to nothing.

Two routes that would otherwise share a name take the suffixes ` A` and ` B`, assigned in decreasing order of run count, ties broken by the activity id of the earliest run in the route.

## Why pace, not time

Runs of one route still differ in recorded length: on the main loop the longest is 7.9% longer than the shortest.
The longest is the loop plus about 4% of its length at the end, which the trimmed worst point tolerates.
On 7 of the 9 routes, elapsed time rises with recorded distance, correlation 0.38 to 0.99, so a route's total time partly measures where the watch was started and stopped rather than how the run went.
Pace, elapsed time over recorded distance, cancels that: two runs of different recorded length still cover the same hills at the same rate, because the route is the same.

## Speed, not pace

`speed_mps` is `distance_m` over `elapsed_time_s`, both read from `activity_metrics`: the same two quantities and the same elapsed-time convention [best-efforts.md](best-efforts.md) derives, so the window spans any pause inside the run and a route record is never won by stopping.
The derived layer stores speed, never pace, the project-wide SI rule.
The frontend renders it as pace, as it already does for `avg_speed_mps`.
Rank and record both order by speed, fastest first, the same ordering as pace, fastest first, since one is the reciprocal of the other times a constant.

## Eligibility

Route records follow the rule best efforts and distance records already state: an ineligible run stays in its route and on its chart, but neither sets the record nor becomes the baseline a later run has to beat.

`_ineligible_reason` returns `None`, eligible, only when a run is explicitly not GPX-sourced, its whole 1 Hz grid is trusted, and every one of its rows in `best_efforts` has `distance_trusted` explicitly `True`.
Trusted is `best-efforts.md`'s "The speed-agreement check": no jump, or a recorded distance within 1% of what the measured speed accounts for.

| Condition | `ineligible_reason` |
| --- | --- |
| `is_gpx_sourced` is not explicitly `False` (GPX-sourced, or not known) | `"GPX-sourced"` |
| `grid_jump_reason` returns a reason for the whole grid | that reason |
| Any best effort's `distance_trusted` is false and its `speed_distance_m` present | `"a jump in the recorded distance that the measured speed does not confirm"` |
| Any best effort's `distance_trusted` is false and its `speed_distance_m` null | `"a jump in the recorded distance, with no measured speed to check it against"` |
| Any best effort's `distance_trusted` is null (not known) | `"not known to be free of distance jumps"` |
| Otherwise | eligible |

**The whole grid is judged, not only the best-effort windows.**
`best_efforts.grid_jump_reason` runs `implausible_advance`, the rule that sets `contains_jump`, over every second of the run's grid during the routes pass: a second whose implied speed exceeds `IMPLAUSIBLE_SPEED_MPS` = 12.5 m/s.
A grid with such a second is still trusted when its covered distance is within 1% of its measured speed's, the test a best-effort window gets; as of 2026-09-27 that readmits none of the 13 runs below.
A best effort is flagged only when a jump falls inside its own window, and a run's fastest windows can all miss one: a route run's pace is distance over elapsed time for the whole run, so a jump anywhere inflates it.
On the real store 3 runs marked eligible before the scan had advances no window caught, all within their first 84 m: two on route 1, of 12.6 m and 39.8 m in one second, and one of 50.5 m across three seconds on route 4, where it ranked second.
The scan makes all three ineligible; with the 10 the best-effort flags already caught, 13 of the 67 route runs are, every one for a jump.

**A run with no best-effort rows at all is eligible.**
The rule checked is `best_efforts.jump_reasons` over the run's own rows in `best_efforts`, which is empty over an empty selection, so the rule "every best effort has `distance_trusted` explicitly true" holds vacuously and the run is eligible.
No real run reaches this today, since the shortest standard distance is 400 m, but the code carries no special case for it.

GPX is checked ahead of the jump columns because it is a fact about the whole activity rather than about one effort, the same ordering `progression`'s `is_indoor` check uses in `api/queries.py`.
Unlike that check, a route run is never excluded for being indoors: the input to `group_routes` is already every activity with `has_gps` and not `is_indoor`, so a treadmill or GPS-less run never reaches grouping, and its route membership is absent rather than marked ineligible.

## Rank and the record staircase

Within a route, eligible runs are ordered fastest first, ties broken by the earlier `start_time_utc` then `activity_id`; `rank` is that position, 1 for the fastest, and null on an ineligible run.

`is_record` is a running maximum over `speed_mps` in time order, restricted to eligible runs: a run is a record when its speed strictly exceeds every earlier eligible run's, including the first eligible run in the route, which records having nothing earlier to beat.
This is the same "the first eligible effort is a record" rule [tags.md](tags.md) derives for distance personal records.

## Rejected alternatives

- **One plane for the whole store.** Rejected on the measurement above: a plane centred on one fixed latitude stretches east-west distances by about a quarter in the city most candidate runs sit in, all of them south of that centring latitude.
- **A start-and-distance proxy**, same start within about 100 m and same distance to the nearest kilometre. Two readings of that rule over the same data gave 125 runs in 29 groups and 164 runs in 28 groups; neither reproduces, and both split 147 pairs the trajectory comparison here calls the same route, because their recorded distances round to different kilometres.
- **A 100 m worst point with no trimming.** Splits 6 of the main loop's 27 runs off for a start or finish that differs by up to 113 m, while the rest of the route agrees to within 25 m over the middle.
- **Adding scipy for the clustering.** Rejected because the linkage is small enough to implement directly over the candidate pairs, without a new dependency.

## The error that survives

- **A detour under the worst-point threshold is invisible to grouping.** `MAX_WORST_M` catches a mid-route detour once it exceeds 150 m at a trimmed point; a smaller one links two traces that are not, in fact, the same path everywhere.
- **A route's name rounds distance to 0.1 km.** Two routes whose true lengths differ by less than that would print the same figure if they also shared a locality; none do on the real store, at nine routes today.
- **Route records inherit the undetected jumps `best-efforts.md` measures.** The whole-grid scan catches every advance over `IMPLAUSIBLE_SPEED_MPS`, inside a best-effort window or not, but an advance under 12.5 m/s passes it.
  460 samples across 124 of 307 runs exceed the athlete's own demonstrated best, and only 50 of them, in 31 runs, reach that threshold, so an eligible run's speed can still be inflated by an odometer error the rule does not see.
- **Direction is only as good as the earliest run's trace.** A route whose first run was an unusual variant measures every later run against that variant. On the real store the runs nearest the threshold are the four route 5 and route 9 runs above, at 0.53 to 0.95 of $F$; the other two on route 5 read 1.06 and 2.51, and every run on the other seven routes 1.82 or more.

## What is deliberately not modelled

- **Timing between two fixed points on a route.** The most direct comparison, and it would count a longer run that contains the route, but it needs a canonical route line and passage detection, neither of which exists. Pace over the whole run needs neither, so a run that extends past the loop is measured over its extra ground too.
- **Renaming a route.** The API is read-only; a name the athlete chooses needs a write path, and a rule for surviving `recompute`, which rewrites `routes.parquet` from scratch.
- **Other sports.** The input is running activities only, like every other analysis stage in this pipeline.
- **Gradient, weather and footwear.** A route holds terrain fixed by construction, not the conditions on the day; route records narrow the comparison to the ground, not to everything else that varies run to run.

## Constants

| Constant | Value | Meaning |
| --- | --- | --- |
| `TRACE_POINTS` | 200 | Points each trace is resampled to |
| `TRIM_POINTS` | 10 | Points set aside at each end before the worst point, 5% of `TRACE_POINTS` |
| `MIN_SAMPLES` | 10 | Fewer usable positions than this is no trace |
| `CANDIDATE_START_M` | 300 m | Maximum start separation for a candidate pair |
| `CANDIDATE_DISTANCE_FRACTION` | 0.15 | Maximum recorded-distance difference for a candidate pair, as a fraction of the longer |
| `MAX_MEAN_M` | 20 m | Maximum mean nearest-point distance for a link |
| `MAX_WORST_M` | 150 m | Maximum trimmed worst-point distance for a link |
| `MIN_RUNS` | 3 | Runs needed for a cluster to become a route |
| `REVERSE_FRACTION` | 0.5 | A run is `reverse` only when its backward distance to the earliest run is under this fraction of its forward one |
| `EARTH_RADIUS_M` | 6,371,000 m | Sphere radius for every projection and the candidate-start check |

## Reproduced against the real store

Measured on 2026-09-25 over the 221 outdoor running activities with GPS in the export, which is not committed.

```bash
uv run activity-analysis recompute
uv run python - <<'PY'
import pandas as pd

routes = pd.read_parquet("data/derived/routes.parquet")
runs = pd.read_parquet("data/derived/route_runs.parquet")
print(len(routes), "routes,", len(runs), "runs across them")
print(routes[["name", "run_count"]].sort_values("run_count", ascending=False).to_string(index=False))
print("reverse:", runs.loc[runs["direction"] == "reverse", "activity_id"].tolist())
print(runs.loc[~runs["eligible"], "ineligible_reason"].value_counts().to_string())
PY
```

On 2026-09-24 it printed 9 routes and 67 runs, the nine names and counts above, no `reverse` run, and 13 runs ineligible for a jump in the recorded distance.
Re-run on 2026-09-27, after that day's export added 51 activities and `ANALYSIS_VERSION` 10 added the speed-agreement check, it prints 11 routes and 73 runs, still no `reverse` run, and the same 13 ineligible, every one for `a jump in the recorded distance that the measured speed does not confirm`.
