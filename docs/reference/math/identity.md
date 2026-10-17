# Activity identity and deduplication

Implemented in `src/activity_analysis/identity.py`, tested in `tests/test_identity.py`.

## The problem

One run can arrive several times.
A Garmin watch writes a FIT file, Garmin Connect exports it, Strava re-renders the same activity as its own FIT, and Strava will also export it as GPX.
Re-dropping an archive must not duplicate anything, and adding a second export of a run already in the store must not either.

So the store needs an answer to "is this the same run as that one", and the only honest answer available is a probabilistic one, because the copies disagree.
This document is about where the disagreement is small enough to hash and where it has to be absorbed by a tolerance.

## What cannot be an identifier

**Source IDs.**
There is no shared one.
A Garmin activity ID and a Strava activity ID for the same run are unrelated integers, and a GPX file carries neither.

**Filenames.**
The fixture set settles this.
Strava names a file downloaded on its own after its activity, so two different runs two days apart arrived as `Löpning_på_eftermiddagen.fit` and `Löpning_på_eftermiddagen (1).fit`, the `(1)` a browser download-collision artifact, so the same run's suffix depends on what order somebody clicked things.

**Activity names.**
"Löpning på kvällen" is Strava's default Swedish name for an evening run.
Three of the five fixtures were exported under that name pattern.
Names collide freely and carry no information.

**Measured quantities, hashed.**
This is the interesting failure, because it looks like it should work.

## Why hashing a measured quantity fails

The scheme that was tried and abandoned was to bucket a measured quantity, typically distance, and hash the bucket index.
The reasoning is that different exports of one run agree to within a metre, so a 10 m bucket should absorb the disagreement.

The flaw is that any fixed grid has edges, and absorbing disagreement is not what a bucket does.
A bucket maps a continuous value to a discrete one, and two values differ in bucket index precisely when an edge falls between them.
For a disagreement of $\delta$ and a bucket width $w$, with the underlying value equally likely to fall anywhere within a bucket, the probability that an edge separates two copies is

$$P(\text{split}) = \min\!\left(\frac{\delta}{w},\, 1\right).$$

Widening the bucket reduces that probability without ever eliminating it, and widening it enough to make the probability negligible makes the bucket so coarse that genuinely different runs share it.
There is no width that works, only a trade between splitting one run and merging two.

The reference fixture disagrees by 1.21 m: the FIT reports 7456.06 m, and haversine summation over the GPX gives 7454.85 m.
Working through the arithmetic:

| Bucket width | Flooring | Nearest | $P(\text{split}) = \delta/w$ |
| --- | --- | --- | --- |
| 1 m | 7456 vs 7454, **split** | 7456 vs 7455, **split** | 1.00 |
| 5 m | 1491 vs 1490, **split** | 1491 vs 1491, same | 0.242 |
| 10 m | 745 vs 745, same | 746 vs 745, **split** | 0.121 |
| 25 m | 298 vs 298, same | 298 vs 298, same | 0.048 |
| 50 m | 149 vs 149, same | 149 vs 149, same | 0.024 |

The 10 m case is the one recorded in `CLAUDE.md` as having split this fixture, and it does, but only under round-to-nearest bucketing, where the edge sits at 7455.0 m and the two values straddle it at 745.485 and 745.606.
Under flooring the same pair survives, and a 5 m bucket splits it instead.
The specific width that bites depends on the rounding mode, which is precisely the point: the failure is a property of gridding a noisy quantity, not of one unlucky constant, and reasoning about it by trying candidate widths against one fixture will always produce a width that appears to work.

Note also from [geodesy.md](geodesy.md) that the 1.21 m figure is not the real bound on disagreement.
Coordinate-integrated distance carries a systematic uncertainty of a few tenths of a percent, around 20 m on this activity, from the choice of Earth radius alone.
A pair of exports could easily disagree by far more than 1.21 m.

## Stage 1: a provisional identity from the start time

Only one quantity is taken verbatim from the device by every source: when the recording started.
It is not measured with error, it is read from a clock, and every export format preserves it.

$$\text{activity id} = \operatorname{SHA256}\Big( \text{athlete id} \ \| \ \big\lfloor t_{\text{start}} / 60 \big\rfloor \Big)_{[0\,:\,16]}$$

where $\|$ is concatenation with a `|` separator, $t_{\text{start}}$ is a Unix timestamp in seconds floored into 60-second buckets, and the hex digest is truncated to its first 16 characters.

On the reference fixture the FIT session start time and the GPX first track point time agree to 0.000 s, so the two copies hash identically and stage 2 never has to intervene.

### Why bucket at all, and why this bucket has an edge problem too

Flooring to the minute is itself a grid, and the argument above applies to it.
A two-second disagreement in reported start time splits the identity with probability $2/60 = 3.3\%$:

```python
>>> from datetime import datetime, timezone
>>> from activity_analysis.identity import compute_activity_id
>>> compute_activity_id("x", datetime(2026, 8, 28, 18, 19, 59, tzinfo=timezone.utc))
'2a45a1c9d5947b98'
>>> compute_activity_id("x", datetime(2026, 8, 28, 18, 20, 1, tzinfo=timezone.utc))
'd48246958d83ec9c'
```

The athlete id is part of the hashed string, so it has to be stated for the digests to be checkable; here it is the single character `x`.
The two calls are two seconds apart on the same run, and they land either side of the 18:20 bucket edge.

The bucket is kept anyway, for a reason the distance case does not have.
A start time disagreement is bounded and small, on the order of a second or two, arising from one source reporting the session start and another the first record timestamp.
So the failure probability is a few percent rather than a near-certainty, and, crucially, **stage 2 exists to catch exactly this case**.
The provisional identity is allowed to be occasionally wrong because it is a lookup key, not a decision.
That layering is the actual design: a cheap deterministic key, then a tolerant reconciliation that can override it.

A finer bucket would not help either.
Flooring to the second sets $w = 1$ s, and the same $P(\text{split}) = \min(\delta/w, 1)$ then gives $P = \delta / (1\,\text{s})$ while $\delta$ stays under a second, reaching $P = 1$ as soon as $\delta$ is a second or more.
The disagreements this section is about are exactly the one-to-two-second kind, so a one-second bucket would split them every time, where the 60-second bucket splits them a few percent of the time.
Going the other way, no bucketing at all makes the key useless as a key.

### Truncating the hash

Sixteen hex characters is 64 bits, a space of $1.84 \times 10^{19}$.
By the birthday bound, with $n$ distinct bucket keys the probability that any two collide is

$$P \approx 1 - \exp\!\left(\frac{-n(n-1)}{2 \cdot 2^{64}}\right).$$

| Activities | $P(\text{any collision})$ |
| --- | --- |
| 1000 | $2.7 \times 10^{-14}$ |
| 10000 | $2.7 \times 10^{-12}$ |
| 100000 | $2.7 \times 10^{-10}$ |

It would take roughly 6 million activities to reach a one-in-a-million chance.
A lifetime of daily running is around 20000.
Truncation is safe here, and the inputs are not adversarial, so the shortened id is chosen for readability in logs, filenames and URLs.

The cryptographic collision is not the collision to worry about.
The dominant mode is **deterministic**: two genuinely different activities by the same athlete starting in the same minute bucket produce the same key, with probability 1, and no amount of hash width helps.
That happens if a recording is stopped and immediately restarted, or if a watch and a phone both record and the two are treated as separate activities.
The reconciliation in stage 2 is what distinguishes those cases, and it does so on distance.

## Stage 2: reconciliation within a tolerance

Before writing, a candidate is compared against stored activities for the same athlete.
A stored activity is the same run if its start time is within `MATCH_WINDOW_S = 90` seconds and, when both distances are known, the distances agree within `MATCH_DISTANCE_TOLERANCE = 0.02`.
A match adopts the stored id, discarding the provisional one.

### The relative difference metric

The distance comparison is

$$\frac{|d_1 - d_2|}{\max\left(|d_1|,\, |d_2|,\, 1\right)} \leq 0.02 .$$

The denominator is doing two jobs, and both matter.

**Symmetry.**
The obvious form, $|d_1 - d_2| / d_1$, is asymmetric: dividing by one distance rather than the other gives different answers, so whether two activities match would depend on which one was already in the store.
Ingestion order would change the result, and re-ingesting the same archive in a different order could produce a different database.
Using $\max$ of the two makes the relation symmetric, which is the minimum a "is the same as" test should satisfy.

**A floor at 1.**
An activity with zero recorded distance is real: a treadmill run with no GPS, or a recording that captured heart rate only.
Without the floor the denominator is zero and the comparison is undefined.
With it, two zero-distance activities compare as identical, and a zero-distance activity is never confused with a real one.

On the reference pair the relative difference is 0.000162 against a tolerance of 0.02, a margin of 123x.
The tolerance is deliberately far looser than that measurement suggests, because the measurement is the best case: both copies here derive from the same watch on the same day.
[geodesy.md](geodesy.md) shows the modelling bias in coordinate-integrated distance is around 0.26%, and a Strava re-render may apply its own smoothing, so 2% leaves an order of magnitude of headroom over the largest known systematic error.

### The property this relation does not have

Tolerance matching is reflexive and symmetric but **not transitive**.
Three activities can chain, with each adjacent pair inside the tolerance and the ends outside it:

| | Distance | Relative to previous | Relative to $d_0$ | Matches $d_0$? |
| --- | --- | --- | --- | --- |
| $d_0$ | 10000.00 m | | 0 | yes |
| $d_1$ | 10196.08 m | 0.0192 | 0.0192 | yes |
| $d_2$ | 10396.00 m | 0.0192 | 0.0381 | **no** |

So "is the same run as" is not an equivalence relation, and there is no well-defined partition of activities into runs.
This is inherent to tolerance matching, not a bug in this implementation, and it has two consequences worth knowing about.

**The result can depend on ingestion order.** Whether $d_1$ and $d_2$ end up sharing an id depends on which arrived first and what was already stored.

**The code takes the first candidate, not the nearest.**
`find_matching_activity` filters to compatible candidates and returns `candidates.iloc[0]`, which is the first matching row rather than the closest match.
When at most one candidate matches, which is the case on all real data seen so far, the two are the same thing.
If the pathological chain above ever occurs in practice, choosing the nearest candidate by combined time and distance difference would be the fix.

### What the 90 second window costs

The window is generous relative to the disagreement it needs to absorb, which is a second or two.
The cost is at the other end: two genuinely distinct activities starting within 90 seconds of each other, with distances within 2%, will be merged into one.

That is not purely hypothetical.
Stopping a recording at the end of a warmup and starting a new one immediately afterwards produces exactly this shape, and if the warmup and the first segment happen to be similar distances they will reconcile as the same activity.
Distance is what protects against it in most cases, since a warmup is usually much shorter than the run that follows.
The window is kept because the alternative failure, splitting one run into two activities, corrupts every trend that run contributes to, while an occasional wrong merge is visible in the activity list and can be handled if it ever appears.

## Deciding which copy survives

When two files reconcile to the same activity, source priority decides which one's data is stored:

| Source | Priority |
| --- | --- |
| Garmin FIT | 3 |
| Strava FIT | 2 |
| GPX | 1 |

```python
def wins(candidate_source: str, incumbent_source: str) -> bool:
    return SOURCE_PRIORITY.get(candidate_source, 0) > SOURCE_PRIORITY.get(incumbent_source, 0)
```

Two properties, both deliberate.

The comparison is **strict**, so a tie keeps the incumbent.
That is what makes re-ingesting an identical file inert rather than a rewrite, and it is one of the two mechanisms behind idempotency, the other being the SHA-256 content-hash ledger that skips unchanged files before they are ever parsed.

An unknown source maps to 0, so it loses to everything known and never displaces good data.

Garmin FIT outranks Strava FIT because Strava re-renders on import rather than passing the original through, and the original device file is closer to the sensor.
GPX ranks last for the reasons measured in [geodesy.md](geodesy.md): ten times the speed noise, no laps, no zones, no athlete profile.

## What is deliberately not handled

**Partial overlap.**
A run recorded as two consecutive activities, because the watch was stopped mid-run, is stored as two activities.
Detecting and stitching them would need overlap analysis on the coordinate streams, and the case is rare enough to be left to manual correction.

**Cross-athlete matching.**
Reconciliation is scoped to a single `athlete_id` before any comparison happens.
Two people running together produce two activities with near-identical start times and distances, and they are correctly kept separate.

**Timezone ambiguity.**
All comparison happens on timezone-aware UTC timestamps, so a run during a daylight-saving transition compares correctly.
Local time is a presentation concern and never enters identity.
