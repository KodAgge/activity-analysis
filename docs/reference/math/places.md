# Where an activity happened

`analysis/places.py` turns one coordinate pair into a place name, entirely offline.

This is a nearest-neighbour search on a sphere, with a tie-break rule that exists because "nearest" turns out to be the wrong answer surprisingly often.
The search itself is three lines; the tie-break took three measurements to get right, and both are derived below.

## What is being computed

Given a start position $(\varphi_0, \lambda_0)$ and a table of $n$ known places $\{(\varphi_i, \lambda_i, p_i)\}$ with populations $p_i$, choose one place to name.

The obvious answer is the nearest:

$$
i^\star = \arg\min_i \; d(\varphi_0, \lambda_0, \varphi_i, \lambda_i)
$$

where $d$ is great-circle distance. That is the whole calculation, and it is measurably wrong for this purpose. The correction is in "Why nearest is the wrong answer" below.

## Which position

The **first fixed sample**, not a mean or a centroid.

A mean over a route is a point the athlete may never have been. On an out-and-back it lands in the middle of the trace, halfway along the outbound leg, which on a 15 km run is 3.75 km from where the run actually began, and on a loop it lands in the middle of the loop, which may be a lake.

The first sample is also the one a reader means. "Where was this run" is answered by where it started, not by where its coordinates average to.

Leading nulls are skipped: a GPS fix takes a few seconds, so a real grid opens with a run of nulls, and both coordinates must be present for a sample to be a position at all.

## The distance

Great-circle distance through the haversine formula, derived in [geodesy.md](geodesy.md) and shared with it - `geo.haversine_to_many_m` is the vectorised form of the same expression:

$$
a = \sin^2\!\left(\frac{\Delta\varphi}{2}\right) + \cos\varphi_0 \cos\varphi_i \sin^2\!\left(\frac{\Delta\lambda}{2}\right), \qquad
d = 2R\arcsin\!\sqrt{a}
$$

**Why not a planar distance.** A degree of longitude is $111.32\cos\varphi$ km, so at the fixtures' latitude of $57.77°$, Jönköping, it is

$$
111.32 \times \cos(57.77°) = 111.32 \times 0.5333 = 59.4 \text{ km}
$$

against $111.19$ km for a degree of latitude. Treating $\Delta\varphi$ and $\Delta\lambda$ as commensurable therefore overstates east-west separation by a factor of $1/\cos\varphi = 1.88$ here, and worse further north. A search on $\Delta\varphi^2 + \Delta\lambda^2$ would systematically prefer places to the north and south of the athlete over equally close ones to the east and west.

The sphere model's own error, bounded in [geodesy.md](geodesy.md) at about $0.5\%$, is irrelevant at this scale: the decision being made is which of two places is nearer, and they differ by kilometres.

**Why brute force.** $n = 170\,911$, and the search runs once per activity. A vectorised pass over the whole table measures at **5.7 ms**, so the 307 real runs cost 1.8 s of a recompute that already takes minutes. A k-d tree would turn that into microseconds and cost a dependency; the arithmetic here is one `numpy` expression the project already has.

## Why nearest is the wrong answer

GeoNames' `cities1000` extract contains every *populated place* over 1000 people, and that includes city districts. A district's centroid is frequently closer to a given point than its city's own centroid, so nearest-place answers with the district.

Measured over the athlete's three start clusters in the city most of the history was recorded in, nearest-place answers with a district on all three, 1.4 to 2.6 km away, and with the same district on two of them.
The same happens at any public point in a city whose districts are in the table:

| probe | nearest place | distance | population | what a reader wants |
| --- | --- | --- | --- | --- |
| Wien Westbahnhof | Neubau | 0.9 km | 31 521 | Vienna, 2.9 km |

Every one of those answers is *true*. None is the answer to the question.

### First correction: prefer population

Prefer the most populous place within a radius $r$:

$$
i^\star = \arg\max_{\{i \,:\, d_i \le r\}} p_i, \qquad r = 15\,000 \text{ m}
$$

falling back to $\arg\min_i d_i$ when the set is empty. That fixes all three of those clusters, naming the city at 2.3, 3.6 and 12.7 km respectively.

It also breaks two other real starts, a small town and a coastal city, each 0.1 to 0.4 km from its own centroid: each is renamed after a neighbour 13.5 or 14.2 km away that is only 1.09 and 1.20 times as populous.
The same happens to any town with a slightly larger neighbour inside the radius:

| probe | nearest | population | chosen instead | population | ratio |
| --- | --- | --- | --- | --- | --- |
| Skillingaryd centroid | Skillingaryd, 0.0 km | 3 965 | Vaggeryd, 8.2 km | 5 122 | 1.29 |
| Huskvarna centroid | Huskvarna, 0.0 km | 21 500 | Jönköping, 8.7 km | 112 766 | 5.24 |

All of these are wrong for the same reason: the alternative is a *different town*, not the place the nearest match is a district of. A bare population comparison cannot distinguish those two situations, because in both of them the alternative is simply larger.

### Second correction: gate the preference on a ratio

The distinguishing feature is that the case worth overriding is **lopsided**. A city dwarfs its own district; a neighbouring town does not.

$$
i^\star =
\begin{cases}
c & \text{if } p_m > 0 \text{ and } p_c \ge k \cdot p_m \\
c & \text{if } p_m = 0 \text{ and } p_c \ge F \\
m & \text{otherwise}
\end{cases}
\qquad
m = \arg\min_i d_i, \quad
c = \arg\max_{\{i \,:\, d_i \le r\}} p_i
$$

with $k = 10$. The measured ratios separate cleanly:

| case | ratio $p_c / p_m$ | gate at $k=10$ |
| --- | --- | --- |
| real start, city over its district | 25.9 | override |
| real start, city over its district | 63.0 | override |
| real start, city over its parish | 23.0 | override |
| real start, neighbouring town | 1.09 | keep nearest |
| real start, neighbouring city | 1.20 | keep nearest |
| probe, Vienna over Neubau | $1\,691\,468 / 31\,521 = 53.7$ | override |
| probe, Vaggeryd over Skillingaryd | $5\,122 / 3\,965 = 1.29$ | keep nearest |
| probe, Jönköping over Huskvarna | $112\,766 / 21\,500 = 5.24$ | keep nearest |

Two orders of magnitude of separation between the groups of real starts, which is why the constant is not delicate: every value of $k$ from about 2 to 20 gives the same answers on all 14 real start locations. $k = 10$ and $k = 5$ are indistinguishable on this history, and the more conservative one is taken, because the cost of setting it too low is attaching a metropolis to a town that is genuinely its own place: at $k = 5$ Huskvarna, a town of its own 8.7 km from Jönköping, would be named Jönköping.

### The second branch: an unknown nearest population

GeoNames records $p = 0$ for a place whose population it does not know, and it does so for 11 893 of the 170 911 bundled places, mostly administrative seats under 1 000 people. Lopsidedness cannot be judged against an unknown: $p_c / 0$ is undefined, and the first version of this rule clamped the denominator to 1, which set the threshold at ten people and made the gate maximally permissive exactly where it had no information. Measured on a random sample of 400 zero-population places, 208 were renamed when queried at their own centroid; standing at Tuburan in the Philippines was labelled Lunas, 12.6 km away.

So when $p_m = 0$ the question changes from "how many times larger is the alternative" to "is the alternative unambiguously a city", and $c$ wins only at or above an absolute floor $F = 15\,000$. That is the `cities15000` threshold the next section reasons about as the line between a city and a village, so it is a figure this document can defend rather than a new one.

Both other readings of the fault were simulated on the real history before this one was taken. Skipping the override whenever $p_m = 0$ changes one real label, a capital back to the name of one of its own comunas - the district-naming problem the gate exists to solve, reintroduced in the one place the branch fires. Applying $F$ alongside the ratio for a *known* $p_m$ as well changes nothing on this history, but it would stop a hamlet of 200 resolving to the town of 5 000 beside it, where the town is the better answer.

Measured over all 221 placed runs on 2026-09-04 with the two-branch rule: 0 labels change. The nearest place carries an unknown population on two of them - one with nothing inside the radius, and the comuna above, which still resolves to its capital because the capital clears the floor. Tuburan resolves to Tuburan.

## Which extract

The table size is a straight accuracy-for-bytes trade, measured against this athlete's 21 distinct start-location clusters:

| extract | places | parquet | median error | p90 | worst |
| --- | --- | --- | --- | --- | --- |
| `cities15000` | 34 129 | 0.81 MB | 6.5 km | 33.2 km | 82.4 km |
| `cities5000` | 69 685 | 1.57 MB | 2.8 km | 32.0 km | 52.0 km |
| `cities1000` | 170 911 | 3.53 MB | 2.2 km | 18.0 km | 27.9 km |

The **worst case** decides it rather than the median. At `cities15000` one remote start resolves to a town 82 km away and across a mountain range. At `cities1000` the worst remaining answer is 27.9 km, and it is a different start, as remote. Each is a genuinely remote start where the nearest place in the table really is that far.

Note that the table's figures are for the nearest-place rule at cluster resolution. With the ratio gate and exact coordinates, on the real store, that start resolves to a town 11.4 km away, because that town is in the table at `cities1000` and absent at `cities15000`, and the furthest match on the whole history is the other remote start, at 27.9 km. The tail past 10 km is sixteen rows from seven start areas, four of them holding four runs each, and they are the same sixteen as "205 of 221 within 10 km" in `docs/reference/derived-layer.md`.

## What the answer does not claim

The distance is stored alongside the name, and that is the honest part of this calculation.

A nearest-place match is usually within a couple of kilometres and sometimes is not. Suppressing the number would present a 28 km guess with the same confidence as a 200 m one. Keeping it lets each consumer decide: `views/ActivityDetail.tsx` says `near X` past 10 km, and could as easily name only the country.

This is the same shape as `contains_jump` in the best-efforts table, and for the same stated reason - flag it, and let the reader of the number choose. See `docs/reference/derived-layer.md`, "Three flags say what an effort's window crossed".

## Reproducing the numbers

```python
from activity_analysis.analysis.places import nearest_place

for lat, lon, label in [
    (57.7709, 14.1830, "fixture 854fd775d479ca9f"),
    (48.1967, 16.3378, "Wien Westbahnhof"),
    (57.4304, 14.0938, "Skillingaryd"),
    (57.7860, 14.3021, "Huskvarna"),
    (39.0, 83.0, "Taklamakan interior"),
    (10.7273, 123.8257, "Tuburan, PH (unknown pop.)"),
]:
    place = nearest_place(lat, lon)
    print(f"{label:28} -> {place.locality}, {place.country} ({place.distance_m / 1000:.1f} km)")
```

This prints Jönköping at 2.0 km, Vienna at 2.9 km, Skillingaryd at 0.0 km, Huskvarna at 0.0 km, Darya Boyi, China at 110.6 km and Tuburan, Philippines at 0.0 km.
The first probe is the reference fixture's first fixed position, whose nearest place is the city itself, so the gate has nothing to decide.
The Tuburan probe is the GeoNames centroid of a place whose population the table does not know, with Lunas (5 789) 12.6 km away: under the clamped ratio it printed Lunas, and under the absolute floor it keeps its own name.
The Taklamakan probe is a rounded coordinate in the interior of a desert, and it is there to show what an empty region does to the lookup: the nearest place in the table is 111 km away, and nothing populous is within 15 km to override it.
The real-store distances quoted above are measured from the real starts in the derived store, whose coordinates are not printed here, so reproduce them on a store of your own by reading `locality_distance_m` from `activity_metrics.parquet` after a recompute.

The extract comparison is reproduced by `scripts/build_places.py`, which records the download URLs; point it at `cities5000` or `cities15000` and re-measure.

## Data source and licence

GeoNames `cities1000` and `countryInfo`, from <https://download.geonames.org/export/dump/>, licensed **CC BY 4.0**.
The bundled file is `src/activity_analysis/data/places.parquet`, built by `scripts/build_places.py`, which is committed so the binary in the tree has a stated provenance.
