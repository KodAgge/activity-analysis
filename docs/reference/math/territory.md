# Territory

Implemented in `src/activity_analysis/analysis/territory.py`.
Tested in `tests/test_territory.py` against synthetic loops with analytic areas, and in `tests/test_territory_pipeline.py` for which runs `recompute` hands it.
Every real-store figure below was measured on 2026-10-02 over the 238 outdoor running activities with a position, the store holding 324 runs.

## What is being computed

A run claims ground when it closes a loop, and the ground it claims is what its track encloses.
The territory is the union of every run's ground, so ground claimed twice counts once.
For each run, in start-time order, the pass records the ground the run enclosed, the part of it no earlier run had claimed, and the total claimed so far.

On the real store 185 runs close a loop, 176 of them enclose ground once slivers are removed, and the union is 11 regions.
The runs' own areas sum to 3.92 times the union, because the athlete runs the same ground repeatedly.

## The closure rule

A run closes a loop when its last finite position is at most `CLOSURE_MAX_M` = 200 m from its first, and the loop is then closed with a straight segment from the end back to the start.
The maintainer set the threshold from this count over the 238 runs:

| Closure within | Runs |
| --- | --- |
| 50 m | 109 |
| 100 m | 153 |
| 200 m | 185 |
| 300 m | 188 |
| 1 km | 216 |

The median closure among the 185 loops is 42.9 m.

### The closure distance

`ellipsoidal_distance_m` measures it on the local plane at the mean latitude $\bar\varphi$, scaled by the ellipsoid's two principal radii of curvature:

$$M = \frac{a(1-e^2)}{(1-e^2\sin^2\bar\varphi)^{3/2}}, \qquad N = \frac{a}{\sqrt{1-e^2\sin^2\bar\varphi}},$$

$$d = \sqrt{\left(N\cos\bar\varphi\,\Delta\lambda\right)^2 + \left(M\,\Delta\varphi\right)^2}.$$

$M$ is the radius of the meridian and $N\cos\bar\varphi$ the radius of the parallel, so each term is an arc length on the ellipsoid to first order.
$a$ = 6,378,137 m and $f$ = 1/298.257223563 are WGS84's, the ellipsoid GPS positions are given on, with $e^2 = f(2-f)$.

Measured against `pyproj`'s WGS84 geodesic at 200 m, in every direction at every latitude from 80 S to 80 N, the two agree to $3 \times 10^{-8}$ m.
The sphere [geodesy.md](geodesy.md) uses for haversine is off by up to 0.56% at the same distance, 1.1 m, which is wider than the 1 m the 199 m and 201 m tests are apart.
On the real store the choice moves no run across the line: 184 runs close within 199 m and 185 within 201 m under either.

## The ground a loop encloses

`faces` closes the track, nodes it, and takes the union of every bounded face:

1. The positions, projected to a plane (below), as a line string closed with the segment back to the start.
2. `unary_union` of that line nodes it: every point where the track crosses itself becomes a vertex of both strands.
3. `polygonize` returns every bounded face of the noded line, no two overlapping; `bounded_faces` returns this list.
4. Their union is the ground enclosed.

A point is enclosed when the track separates it from infinity, whichever way and however many times the track went round it.

### Why not the shoelace area

The shoelace formula $A = \frac12\sum_i (x_i y_{i+1} - x_{i+1} y_i)$ gives the signed area of a simple ring, positive when the run went round it anticlockwise and negative when clockwise.
On a self-crossing ring it gives the sum of each face's area weighted by its winding number, which is not ground.
179 of the 185 real loops cross their own track.

The tests construct the three cases that separate the two, each run anticlockwise:

| Track | Shoelace | Ground enclosed |
| --- | --- | --- |
| A figure of eight, the lemniscate of Gerono $x = a\cos t$, $y = a \sin t \cos t$ | 0, the two lobes have opposite windings | $\frac43 a^2$ |
| An alpha: a square of side $L$ entered across its bottom edge and left down its left edge, closing a right triangle of legs $a$ at the crossing | $L^2 - \frac12 a^2$, the triangle winds the other way | $L^2 + \frac12 a^2$, with no hole |
| A square loop run twice | $2L^2$ | $L^2$ |

Ground has no direction, so the comparison is on the shoelace area's magnitude: 38 of the 176 real loops that claim ground have a negative signed area.
On those 176, the magnitude is within 1% of the raw faces area, before the sliver rule, on 112 of them, and the ratio of the two ranges from 0.21 to 10.96.
Against the stored `enclosed_m2`, after the rule, it is within 1% on 119 and the ratio ranges from 0.22 to 10.98.

## Slivers

A stretch run out and back along one path leaves two nearly coincident lines, and GPS error separates them by a few metres.
Every gap between them is a bounded face, so the raw faces of an out-and-back are a chain of thin slivers along the path.
The question is whether they count as enclosed ground.

### The measurement

Over the 185 loops, `bounded_faces` on each run's own plane returns 10,261 faces.
The table bins them by mean width $w = 2A/P$, the width of a strip of area $A$ and perimeter $P$:

| Mean width | Faces | Share of the faces' area | Faces per metre of width |
| --- | --- | --- | --- |
| 0 to 1 m | 8759 | 0.012% | 8759 |
| 1 to 2 m | 516 | 0.022% | 516 |
| 2 to 3 m | 214 | 0.027% | 214 |
| 3 to 5 m | 186 | 0.048% | 93 |
| 5 to 7.5 m | 123 | 0.069% | 49 |
| 7.5 to 10 m | 69 | 0.056% | 28 |
| 10 to 15 m | 65 | 0.057% | 13 |
| 15 to 20 m | 22 | 0.067% | 4.4 |
| 20 to 30 m | 16 | 0.065% | 1.6 |
| 30 to 50 m | 30 | 0.249% | 1.5 |
| 50 to 100 m | 82 | 1.037% | 1.6 |
| over 100 m | 179 | 98.291% | |

The density of faces falls by three orders of magnitude up to a mean width of 20 m and is flat at about 1.5 faces per metre from there to 100 m.
The steep part is the sliver population and the flat part is genuine enclosed ground of every size, so the populations separate at a mean width of about 20 m.

Plots of the 29 loops that enclose under 6 ha at 5 m show the same split: the narrow faces lie along out-and-back stretches, and the wide ones are blocks, parks, a 400 m track and the loop at the end of a lollipop's stem.

### The rule

`open_slivers` applies a morphological opening of radius $r$ = `SLIVER_RADIUS_M` = 15 m: the ground is eroded by $r$, then dilated by $r$.
A point survives only where a disc of radius $r$ fits inside the ground and covers it, so a strip narrower than $2r$ = 30 m vanishes and a wider one grows back to its own outline.

The radius comes from the 20 m mean width through the shape of a sliver.
A sliver is a lens: two lines meeting at both ends, widest in the middle.
For a parabolic lens of length $L$ and greatest width $h$, $A = \frac23 hL$ and $P \approx 2L$, so the mean width is $2A/P = \frac23 h$.
A mean width of 20 m is a greatest width of 30 m, and a lens survives an opening of radius $r$ only if $h > 2r$, so $r$ = 15 m removes the lenses below the knee and keeps the faces above it.

The opening was measured at five radii over the whole history:

| Radius | Union, against radius 0 | Sum of runs, against radius 0 | Sliver area removed, share of the faces' area | Claiming runs | Regions | Parts |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 0 | 0 | 0 | 185 | 13 | 298 |
| 5 m | -0.125% | -0.161% | 0.163% | 182 | 12 | 66 |
| 10 m | -0.240% | -0.284% | 0.287% | 178 | 12 | 45 |
| **15 m** | **-0.345%** | **-0.381%** | **0.383%** | **176** | **11** | **33** |
| 25 m | -0.627% | -0.621% | 0.622% | 174 | 11 | 28 |

The rule changes the union by 0.35% and the parts from 298 to 33.

Of the 265 parts it removes, most are slivers along out-and-back stretches with no other ground near them.
At 5 m and 10 m, pure out-and-back runs still claim chains of specks: one run keeps 15 pieces at 5 m and 4 at 10 m, holding 8.2 and 2.7 times the ground of the one piece 15 m leaves it.
At 25 m, genuine loops start to lose ground they enclose: one narrow loop loses 46% of what it keeps at 15 m.

Nine of the 185 loops enclose nothing at 15 m, and two places have only such runs and drop out as regions.

The maintainer's brief for the feature gives the union for the same 185 loops, its value at each quarter's end, and the sum of the run areas.
Those are the radius 0 row measured on a sphere of radius 6,371 km, the one [geodesy.md](geodesy.md) and [routes.md](routes.md) use.
Measured so, with pyproj's geodesic area on that sphere, the radius 0 union and the run-area sum match the brief's to the precision it states, and all twelve quarter ends equal the brief's to the hundredth of a km².
That sphere reads areas low by an amount that depends on latitude, 0.51% at the fixtures' 57.77 degrees and 0.49% over the whole real union, so on WGS84 the raw union is 0.49% larger than the brief's.
The union served is within 0.13% of the brief's only because the sphere takes 0.49% off the raw union and the rule takes 0.35%.
The rule's cost is the 0.35% between the radius 0 and 15 m rows, both on WGS84; measured on the sphere the served union is the same 0.35% under the brief's.

### What the opening costs a real loop

The opening rounds every convex corner to radius $r$.
A corner of interior angle $\theta$ loses the area between its two sides and the inscribed arc,

$$\Delta A = r^2\left(\cot\frac\theta2 - \frac{\pi-\theta}{2}\right),$$

which is $(1-\frac\pi4)\,r^2$ = 48.3 m² at a right angle and $r$ = 15 m, and 278 m² at 45 degrees.
A 1 km square loses 193 m², 0.019% of its area.
The tests hold the opened square, the opened alpha and a strip 40 m wide to this formula within 5 m².

The buffers are polygonal, `BUFFER_QUAD_SEGMENTS` = 16 chords per quarter circle, so each rounded corner's arc is inscribed in the true circle and sits within $r(1 - \cos\frac\pi{64})$ = 1.8 cm of it.
The dilated outline is not intersected with the unopened ground afterwards, though in exact arithmetic an opening is always inside what it opens: the polygonal erosion can overshoot by that same 1.8 cm where it rounds a reflex corner, which over the real history adds $4.4 \times 10^{-7}$ to the union, and the intersection that would remove it cost 3.5 of the pass's 7.4 seconds.

## The projection

Every area is a planar area on an ellipsoidal Lambert azimuthal equal-area projection, implemented in `EqualArea` from Snyder (1987), *Map Projections: A Working Manual*, USGS Professional Paper 1395, pp. 182 to 190.
No library is involved: pyproj is not a dependency of this project, and the projection is thirty lines.

### Forward

With $q(\varphi) = (1-e^2)\left[\frac{\sin\varphi}{1-e^2\sin^2\varphi} - \frac1{2e}\ln\frac{1-e\sin\varphi}{1+e\sin\varphi}\right]$ (Snyder 3-12), $q_p = q(90°)$, the authalic latitude $\beta = \arcsin(q/q_p)$ (3-11) and the authalic radius $R_q = a\sqrt{q_p/2}$:

$$D = \frac{a\,m_1}{R_q\cos\beta_1}, \qquad m_1 = \frac{\cos\varphi_1}{\sqrt{1-e^2\sin^2\varphi_1}},$$

$$B = R_q\sqrt{\frac{2}{1+\sin\beta_1\sin\beta+\cos\beta_1\cos\beta\cos(\lambda-\lambda_0)}},$$

$$x = BD\cos\beta\sin(\lambda-\lambda_0), \qquad y = \frac BD\left[\cos\beta_1\sin\beta - \sin\beta_1\cos\beta\cos(\lambda-\lambda_0)\right],$$

about a centre $(\varphi_1, \lambda_0)$ (Snyder 24-13 to 24-17).
The authalic latitude maps the ellipsoid onto the sphere of radius $R_q$ preserving area, and the spherical Lambert azimuthal projection of that sphere preserves area, so the composite does.
$D$ rescales $x$ and $y$ in opposite senses so that the scale is true in every direction at the centre, which leaves areas unchanged.

### Inverse

The display outline has to go back to degrees.
$\rho = \sqrt{(x/D)^2 + (Dy)^2}$, $c = 2\arcsin\frac{\rho}{2R_q}$, $\beta = \arcsin\left(\cos c\sin\beta_1 + \frac{Dy\sin c\cos\beta_1}{\rho}\right)$ and $\lambda = \lambda_0 + \arctan\frac{x\sin c}{D\cos\beta_1\cos c\,\rho - D^2 y\sin\beta_1\sin c}$ (24-18 to 24-21).
Latitude comes back from $\beta$ by Snyder's series 3-18 to $e^6$, which alone leaves up to a millimetre, followed by two Newton steps on $q$ (3-16), after which a forward and inverse round trip returns every point to within $6 \times 10^{-8}$ m at latitudes up to 85 degrees.

### Why areas on it are ellipsoidal areas

A projection is equal-area when its Jacobian determinant is 1 everywhere, so the area of any region of the plane equals the area of its preimage on the ellipsoid.
The one approximation is that each edge of the polygon is a straight chord on the plane, where the track between two samples is a short curve on the ellipsoid either way; at 1 Hz the samples are 3 m apart, and the difference in area is far below the 0.1% the module is held to.

The test `test_a_planar_area_on_the_projection_is_the_ellipsoidal_area` checks this against an analytic answer.
A quadrangle between parallels $\varphi_1, \varphi_2$ and meridians $\Delta\lambda$ apart has area

$$A = \frac{a^2\,\Delta\lambda}{2}\left|q(\varphi_2) - q(\varphi_1)\right|,$$

since the zone from the equator to $\varphi$ is $\pi a^2 q(\varphi)$ over the full circle of longitude.
`quadrangle_area_m2(-90, 90, 360)` returns 510,065,621.7 km², the WGS84 surface area, which checks $q$ independently of the projection.
Quadrangles of 1, 11 and 33 km at 0, 45 and 59 degrees, drawn with 400 points a side on planes centred off their middle, match the formula to $10^{-6}$.

On the real store, every run's enclosed ground, re-read in degrees and passed to `pyproj`'s geodesic polygon area (`Geod(ellps="WGS84").geometry_area_perimeter`), agrees with the planar area to $4.6 \times 10^{-8}$, and every part of the union to $3.1 \times 10^{-8}$.
pyproj was used for that check through `uv run --with pyproj` only.

### Where the planes are centred, and why

Each run's track is projected on a plane centred on its own box, where its own `enclosed_m2` is read.
Each region's union is taken on one plane centred on the box of that region's runs, which the run's ground is moved onto with `EqualArea.geometry_from`, inverse on one plane and forward on the other.

The area does not need this.
Projecting every part of the real union onto one plane centred on the largest region moves no region's area by more than $4.0 \times 10^{-9}$, the farthest region included, more than 100 degrees away.

The opening does.
An equal-area projection trades scale between directions away from its centre: at angular distance $c$, the Lambert azimuthal scale is $\sec\frac c2$ along one axis and $\cos\frac c2$ across it.
At 80 degrees that is 1.31 and 0.77, so a 15 m disc on the plane is an ellipse of 19.6 by 11.5 m on the ground, and the sliver rule would no longer be 30 m.
Within one region the largest extent is a few tens of kilometres, where both factors are 1 to $10^{-5}$.

## The union, in start-time order

Runs are taken in order of `start_time_utc`, ties broken by `activity_id`.
Each claiming run's ground is added to its region's union, and its new ground is the increase in the union's area,

$$\text{new}_k = |U_{k-1} \cup G_k| - |U_{k-1}|,$$

which equals $|G_k \setminus U_{k-1}|$ without a second set operation, except for the thin holes below, which $U_k$ fills.
`cumulative_m2` is the sum of `new_m2` over every region up to and including the run, so the last value is the total.
The stored total, the sum of the regions' areas, and the last cumulative value agree to $3.8 \times 10^{-14}$ on the real store, rounding in the order of the sums.

### Holes

Where two claims meet, their tracks rarely draw the shared edge in the same place, and wherever one falls short of the other by a few centimetres the union is left with a hole between them.
These holes are not unclaimed ground any more than a sliver is claimed ground, and once the outline is rounded to the served grid they cross their own rings, which is invalid GeoJSON.

`fill_thin_holes` applies the sliver rule to unclaimed ground: after each union, a hole is filled when the same opening of radius $r$ = 15 m would erase it entirely, that is when no disc of radius 15 m fits anywhere in it.
The ground a hole holds, its pocket, is the hole less the filled outline of every other part of the union inside it, an island.
The outline and not the island itself, because an island's own holes are judged as holes of the island: subtracting the island alone would leave its courtyard in the pocket, so a 2 m moat round an island with a 150 m courtyard would test as 150 m wide and be kept.
A thin pocket is filled by adding it to the union, $U \cup P$, so a narrow moat around an island is filled, the island merges with the part around it, and the island's courtyards stay.
Rebuilding the outer part without the hole instead would paint over every courtyard inside it.
The test cases are a 500 m frame of four loops with a 300 m hole, and four more loops 2 m inside it ringing a 150 m courtyard: the result is one part with the courtyard as its one hole and an area of $500^2 - 150^2$ less the frame's four outer corners, the island's own corners lying in the filled moat.
A second case nests three rings, each 2 m inside the hole of the one around it, and fills both moats, leaving only the innermost courtyard.
An island touching the hole's ring at points cuts the pocket into pieces, and each piece is judged on its own, since each is a separate stretch of unclaimed ground.
Judged together, one piece a disc fits in would keep every thin piece beside it.
The test case is a quadrilateral island touching a 300 m hole at one point on each side, cutting it into four right triangles: the two with a 20 m leg, inradii 9.3 m and 9.6 m, are filled, and the two of inradii 43.9 m and 56.2 m stay as holes.
A piece a disc does fit in is kept whole, exactly as the tracks drew it, and is served as a clockwise ring.

$U_k$ is therefore $U_{k-1} \cup G_k$ with its thin holes filled, and the run whose ground closed a hole off claims it in its `new_m2`, so the accounting still sums to the union served.
The test case is two 500 m square loops sharing an edge the second draws at 499 m at its ends and 500.02 m halfway: unfilled, the 0.098 m² triangle between them is a hole 2 cm wide.

On the real store 58 holes are filled over the whole history, $2.5 \times 10^{-4}$ of the final union in all.
The largest is $4.0 \times 10^{-5}$ of it, and the widest has a largest inscribed circle of radius 13.3 m, under the 15 m that would keep it.
No hole at any point of the history fits the disc, so the final union has none, and none of the 58 has an island in it, so neither the outline rule nor the piece rule changes any area or count on the real store.
They do change the served outlines.
Filling by $U \cup P$ instead of rebuilding the part without the hole leaves the final union the same point set with the same vertices, every area and `new_m2` within $10^{-6}$ m², but starts the rings of 11 of the 33 parts at a different vertex.
Douglas-Peucker keeps each ring's first vertex and simplifies from it, so those 11 outlines simplify differently: 5,018 vertices at 1 m where the rebuilt parts gave 5,017.
Against the union with every hole left open, the rule adds $4.5 \times 10^{-5}$ to the total, all in the two largest regions, and changes `new_m2` for 22 runs.
The largest change is a pair: one run gains $1.3 \times 10^{-4}$ of the final union by filling holes, and a run three weeks later loses the same amount, which it would otherwise have claimed.

How the total grew, as a share of the final union at each quarter's end:

| Quarter | Share | | Quarter | Share |
| --- | --- | --- | --- | --- |
| 1st | 0.5% | | 7th | 18.8% |
| 2nd | 6.3% | | 8th | 27.9% |
| 3rd | 9.6% | | 9th | 36.2% |
| 4th | 10.6% | | 10th | 72.9% |
| 5th | 13.7% | | 11th | 75.6% |
| 6th | 14.6% | | 12th | 100% |

The three runs that claimed most new ground claimed 18.3%, 16.6% and 8.8% of the final union.

## Regions

A region is a set of claiming runs linked by single linkage: two runs are in one region when their tracks' bounding boxes come within `REGION_GAP_M` = 50 km of each other, directly or through other runs.
The box gap is the distance between the boxes' nearest points.
When the boxes are apart in latitude those are the facing corners, and the distance is read on the local plane at the middle of the latitude gap, as `ellipsoidal_distance_m` reads any short distance.
When their latitudes overlap the nearest points lie on one parallel, the end of the overlap farther from the equator, where a degree of longitude is shortest.
Measured against the WGS84 geodesic between the true nearest points, minimised over both boundaries with GeographicLib through pyproj, on 1,500 random box pairs 40 to 60 km apart, sides 0.005 to 0.3 degrees: within 0.0005% up to 30 degrees, 0.004% up to 60 and 0.010% up to 70.
What remains is the geodesic bowing poleward of the parallel and of the planar diagonal, which the plane cannot follow.
Reading the parallel scale at the upper box's bottom edge, or at the middle of an overlap, was off by up to 0.40% on the same pairs.

On the real store the minimum spanning tree over the 176 claiming runs' boxes has its 10 longest edges at 128.2 km and above, then 15.6 km, then 5.3 km and less.
The geodesics between the same nearest points are 128.15, 15.55 and 5.33 km.
The 15.6 km link joins two runs at opposite ends of one metropolitan area, and the 128.2 km gap separates two regions in one country.
The 5.3 km link joins a run from the centre of the largest region to one from its outskirts.
Any threshold between 15.6 and 128.2 km gives the same 11 regions, and 50 km has a factor of 3.2 to spare below and 2.6 above.

A region's id is its earliest claiming run's `activity_id`, so it holds when later runs join it.
Its name is the `locality` most of its runs started in, from `activity_metrics`, which the offline place lookup in [places.md](places.md) resolved; ties go to the alphabetically first.
When none of its runs has a locality it takes `nearest_place` at the centre of its box, and `Region` when that finds nothing.
Two regions that would share a name take ` A` and ` B` by area, the convention route names follow.

On the real store the 11 regions are, by area:

| Region | Share of the union | Parts | Claiming runs |
| --- | --- | --- | --- |
| 1 | 66.55% | 15 | 143 |
| 2 | 23.39% | 2 | 19 |
| 3 | 4.12% | 1 | 1 |
| 4 | 2.14% | 3 | 3 |
| 5 | 1.80% | 1 | 3 |
| 6 | 0.81% | 2 | 2 |
| 7 | 0.49% | 1 | 1 |
| 8 | 0.30% | 1 | 1 |
| 9 | 0.19% | 4 | 1 |
| 10 | 0.17% | 1 | 1 |
| 11 | 0.03% | 2 | 1 |

## The display outline

Each part of the union is stored twice over in effect: its true area, read on the unsimplified union, and an outline for the map.
`display_outline` builds the outline in three steps:

1. Douglas-Peucker at `DISPLAY_TOLERANCE_M` = 1 m on the region's plane, with shapely's `preserve_topology`.
2. The inverse projection, back to `[lon, lat]` degrees.
3. `shapely.set_precision` on the grid of 6 decimal places, $10^{-6}$ degrees, 0.11 m of latitude.

The third step is GEOS's precision reducer, not rounding each coordinate on its own.
Rounding vertex by vertex moves two edges closer than a grid step independently, so they can cross, and a ring thinner than a step collapses to a line with zero area; that is how a seam hole became a self-crossing ring.
The precision reducer snap-rounds the whole geometry together and returns a valid one: collapsed rings are dropped, and a neck of the part thinner than a step is cut, which splits the part's outline into a MultiPolygon.
No real part has such a neck, so on the real store every outline is a Polygon; the test that builds a dumbbell joined by a 5 cm strip gets the two squares back as a valid MultiPolygon.
Every exterior is then wound anticlockwise and every hole clockwise, as RFC 7946 asks, and the tests check validity, closure, winding and the grid on the served `[lon, lat]` coordinates themselves.

Thin holes are already filled before this step, so the outline never has to drop a hole the union kept.
A thin inlet, unclaimed ground narrower than 30 m that opens to the outside of a part, is not a hole and is kept as drawn.

The basemap is fetched to zoom 15.
MapLibre draws 512-pixel tiles, so a CSS pixel at zoom $z$ is $40{,}075{,}017\cos\varphi / (512 \cdot 2^z)$ m, 1.27 m at the fixtures' latitude at zoom 15, and less further from the equator.
A 1 m tolerance therefore moves no edge by a pixel at the deepest zoom the basemap has.

| Tolerance | Vertices | GeoJSON | Outline area minus true area |
| --- | --- | --- | --- |
| none, snapped only | 70,958 | 1,524 KiB | $4.3 \times 10^{-7}$ |
| 0.5 m | 7,216 | 156 KiB | $-7.5 \times 10^{-5}$ |
| **1 m** | **5,018** | **109 KiB** | $-1.4 \times 10^{-4}$ |
| 2 m | 3,301 | 72 KiB | $-2.5 \times 10^{-4}$ |
| 5 m | 1,843 | 41 KiB | $-4.9 \times 10^{-4}$ |

At 1 m the whole response of `GET /api/territory` is 159,748 B of JSON and 44,495 B gzipped as served.
The served area is always the true one and the outline is for drawing; the two differ most on one of the smallest parts, by 2.9%.

## Reproducing the figures

```bash
uv run activity-analysis recompute
uv run python -c "
from activity_analysis.store.db import connect
from activity_analysis.config import default_paths
con = connect(default_paths())
print(con.sql('select count(*), count(*) filter (where closes_loop), '
              'count(*) filter (where region_id is not null), '
              'sum(enclosed_m2) / 1e6, max(cumulative_m2) / 1e6 from territory_claims'))
print(con.sql('select name, area_m2 / 1e6, part_count, claim_count '
              'from territory_regions order by area_m2 desc'))
"
```

The width census is `bounded_faces` on each loop's positions projected with `EqualArea(*box_centre(box))`, the plane `claim_territory` centres on the run's own box, each face binned by `2 * face.area / face.length`.
The shoelace comparison is the absolute value of the signed ring area of the same projected positions, closed back to the start (the shoelace area with the direction the run went round dropped), divided by the area of `faces` on them and by the stored `enclosed_m2`, over the 176 runs with `enclosed_m2 > 0`; without the absolute value the 38 runs with a negative signed area give negative ratios.
The sliver table needs `claim_territory(tracks, radius_m=r)` over the outdoor tracks for each radius, the hole figures the same call with `fill_thin_holes` replaced by the identity, and the pyproj check `uv run --with pyproj`; none of them is part of the project.
The comparison with the brief is the same call at `radius_m=0` and `tolerance_m=0`, each part measured with `pyproj.Geod(a=6371000, f=0)`, and each quarter end that call over the tracks that started by the quarter's end.
The tolerance table is the same call with `tolerance_m=t` for each tolerance, each part's served outline measured with pyproj's geodesic area.
The vertex counts depend on where each ring starts, so a change to how the union is built can move them with every area unchanged; rerun the table after any such change.
The region figures are a minimum spanning tree over the claiming runs' boxes weighted by `_box_gap_m`, each long edge checked against the geodesic between its boxes' nearest points, found by minimising pyproj's `Geod.inv` over both boundaries; the box-gap accuracy is the same minimisation over random box pairs.
The response sizes are `curl` against `activity-analysis serve` after `recompute`, the gzipped one with `Accept-Encoding: gzip`, read from `Content-Length`.

## What is not modelled

- **GPS error in the outline.** The ground follows the recorded track, which wanders a few metres either side of the path, so every edge of the territory is that uncertain.
- **The closing segment.** It is a straight line from end to start, up to 200 m long, which can cross buildings or water the athlete went around.
- **Hexagon cells.** intvl's Claim screen quantises claimed ground into hexagons; this keeps the exact outline, which is what the area is measured on. A cell grid would add its own rules, a cell size and a coverage threshold for a partly covered cell, and change no reported number.
- **Decay or rivals.** Ground stays claimed forever and nobody can take it back.
- **Thin inlets.** Unclaimed ground narrower than 30 m stays unclaimed when it opens to the outside of a part; only enclosed holes are filled.
  The same holds inside a hole: a thin lobe joined to a wide hole, even by a neck of centimetres, is part of that hole and is kept with it.
- **The antimeridian.** A region straddling 180 degrees would get a box spanning the globe; no run in the store is within 6,000 km of it.
