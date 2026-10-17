# Geodesy: coordinates to distance

Implemented in `src/activity_analysis/geo.py`, tested in `tests/test_geo.py`.

## Why this exists, and why it is a fallback

A FIT file carries a `distance` field on every record and a `total_distance` on the session.
Those come from the watch, which fuses GPS with an accelerometer-derived stride estimate, and they are better than anything recoverable from the coordinates alone.
So the primary ingestion path never uses this module.

GPX carries coordinates and nothing else, so distance and therefore speed must be reconstructed.
On the reference fixture that reconstruction costs a factor of ten in sample-to-sample speed noise.
Both headline metrics in this project divide by speed, so that noise lands directly in the output.
This is the measured basis for treating GPX as a degraded path, and the numbers are at the bottom of this document.

## The sphere model

Model the Earth as a sphere of radius $R$.
A point at latitude $\varphi$ and longitude $\lambda$ sits at

$$\mathbf{u}(\varphi, \lambda) = (\cos\varphi\cos\lambda,\ \cos\varphi\sin\lambda,\ \sin\varphi)$$

on the unit sphere.
Two points subtend a central angle $\sigma$ at the centre, and the shortest path between them along the surface is a great-circle arc of length

$$d = R\,\sigma .$$

Everything below is about computing $\sigma$ from two coordinate pairs without losing precision.

## Deriving the haversine formula

Take the dot product of the two unit vectors:

$$\cos\sigma = \mathbf{u}_1 \cdot \mathbf{u}_2 = \sin\varphi_1\sin\varphi_2 + \cos\varphi_1\cos\varphi_2\cos\Delta\lambda .$$

That is the **spherical law of cosines**, and it is a complete solution.
It is also unusable in floating point at the segment lengths this project sees, for reasons in the next section.
The fix is to rearrange it into a form whose intermediate quantity is small rather than close to 1.

Start from the chord between the two points.
Its squared length is

$$|\mathbf{u}_1 - \mathbf{u}_2|^2 = 2 - 2\cos\sigma = 4\sin^2\tfrac{\sigma}{2},$$

so working with $\sin^2(\sigma/2)$ is the same as working with $1 - \cos\sigma$, scaled.
The quantity $\operatorname{hav}(\theta) = \sin^2(\theta/2) = (1 - \cos\theta)/2$ is the **haversine**, and it names the formula.

Now transform $1 - \cos\sigma$.
Add and subtract $\cos\varphi_1\cos\varphi_2$:

$$1 - \cos\sigma = 1 - \sin\varphi_1\sin\varphi_2 - \cos\varphi_1\cos\varphi_2 + \cos\varphi_1\cos\varphi_2 - \cos\varphi_1\cos\varphi_2\cos\Delta\lambda .$$

The first three terms contain the cosine difference identity, $\cos\Delta\varphi = \cos\varphi_1\cos\varphi_2 + \sin\varphi_1\sin\varphi_2$, so they collapse to $1 - \cos\Delta\varphi$.
The last two factor.
That leaves

$$1 - \cos\sigma = (1 - \cos\Delta\varphi) + \cos\varphi_1\cos\varphi_2\,(1 - \cos\Delta\lambda).$$

Halve both sides and apply $\operatorname{hav}(\theta) = (1-\cos\theta)/2$ three times:

$$\boxed{\ a \equiv \sin^2\frac{\Delta\varphi}{2} + \cos\varphi_1\cos\varphi_2\,\sin^2\frac{\Delta\lambda}{2}\ }$$

with $a = \sin^2(\sigma/2)$, and therefore

$$\sigma = 2\arcsin\sqrt{a}, \qquad d = 2R\arcsin\sqrt{a}.$$

That is exactly the code:

```python
a = np.sin(dphi / 2) ** 2 + np.cos(phi1) * np.cos(phi2) * np.sin(dlambda / 2) ** 2
return float(2 * EARTH_RADIUS_M * np.arcsin(np.sqrt(a)))
```

The transformation is algebraically an identity, so it changes nothing mathematically.
What it changes is the size of the number the computer has to hold, and that turns out to matter enormously.

## Why not the spherical law of cosines

Because $\arccos$ is asked to invert a value indistinguishable from 1.

For a segment of length $d$, the central angle is $\sigma = d/R$.
A 12 m segment, which is the median on the reference fixture, gives $\sigma \approx 1.85 \times 10^{-6}$ radians and

$$\cos\sigma \approx 1 - 1.7 \times 10^{-12}.$$

Immediately below 1.0, consecutive binary64 values are spaced $2^{-53} \approx 1.11 \times 10^{-16}$ apart, which is the unit roundoff $u = \varepsilon/2$.
The entire signal, the $1.7 \times 10^{-12}$ by which $\cos\sigma$ differs from 1, is therefore carried by only about 15000 representable steps.
A double normally holds around 16 significant decimal digits; here roughly 12 of them are consumed by the leading 1 that both points share, leaving about 4 for the answer.
Everything the formula computed before that point has already been rounded into those steps, and the information lost is not recoverable.

Propagate it.
With $d = R\arccos c$,

$$\frac{\mathrm{d}d}{\mathrm{d}c} = \frac{-R}{\sin\sigma} \approx \frac{-R}{\sigma} = \frac{-R^2}{d},$$

so a rounding error of one representable step, $\delta c \sim u = 2^{-53}$, becomes

$$|\delta d| \approx \frac{R^2 \cdot 2^{-53}}{d} = \frac{4.5 \times 10^{-3}\ \text{m}^2}{d} \quad\Longrightarrow\quad |\delta d| \approx \frac{4.5}{d\,[\text{m}]}\ \text{mm}.$$

Note the shape of that result.
The absolute error grows as segments get *shorter*, and the relative error grows as $1/d^2$.
Short segments are the normal case here, not an edge case: a runner at 3 m/s sampled at 1 Hz produces 3 m segments.

Measured against the same formula evaluated in 80-bit extended precision, over the 625 segments of the reference GPX track:

| Segment length | Count | Mean absolute error | Max | Mean relative error |
| --- | --- | --- | --- | --- |
| under 1 m | 3 | 5.99 mm | 13.29 mm | $1.0 \times 10^{-2}$ |
| 1 to 3 m | 86 | 0.99 mm | 3.88 mm | $4.3 \times 10^{-4}$ |
| 3 to 8 m | 152 | 0.44 mm | 2.17 mm | $9.1 \times 10^{-5}$ |
| 8 to 15 m | 142 | 0.21 mm | 0.77 mm | $1.9 \times 10^{-5}$ |
| 15 to 30 m | 242 | 0.11 mm | 0.42 mm | $5.9 \times 10^{-6}$ |

The predicted $1/d$ decay in absolute error holds across the whole table.
The bands have mean segment lengths of 0.664, 2.403, 5.679, 11.655 and 19.537 m, at which $4.5 / d$ predicts 6.78, 1.87, 0.79, 0.39 and 0.23 mm.
Against the observed means those overpredict by factors of 1.13, 1.90, 1.81, 1.82 and 2.06.
Overprediction is the expected relationship: the bound assumes a full representable step of error, while real rounding contributes about half a step and the errors from successive operations partly cancel.

The four bands that hold 622 of the 625 segments agree closely, spanning only 1.81 to 2.06 while $d$ varies eightfold.
The under-1 m band is the outlier at 1.13, and its mean is taken over three segments, so it is a three-sample estimate of a quantity whose per-segment values scatter widely.
Reading a different mechanism into it would be reading it into noise.

What the table supports is the weaker but sufficient claim: the ratio stays bounded between 1.1 and 2.1 while the segment length varies by a factor of 30, rather than drifting with $d$.
A $1/d$ law predicts exactly that, and a story fitted after the fact would not survive the same test across five bands.
The worst single segment is 0.52 m long and comes out 13.29 mm short, a **2.6% relative error on that segment**.

The haversine form, measured the same way, has a maximum relative error of $9.7 \times 10^{-10}$ and a maximum absolute error of $10^{-6}$ mm.
That is float64 noise, four to seven orders of magnitude better.

One tempting objection deserves an answer.
Summed over the whole track, the law of cosines gives 7454.841 m against the reference 7454.851 m, an error of only 11 mm in 7.5 km, because the per-segment errors are signed and largely cancel.
If the total were the only consumer, the formula would be fine.
It is not: segment lengths are divided by segment durations to produce the speed stream, and a 2.6% error on a single segment is a 2.6% error on that sample's speed.
Cancellation in the sum does not help the samples.

## Why not the equirectangular approximation

The flat-Earth approximation projects to a local tangent plane:

$$x = R\,\Delta\lambda\,\cos\varphi_m, \qquad y = R\,\Delta\varphi, \qquad d = \sqrt{x^2 + y^2}$$

with $\varphi_m$ the mean latitude of the segment.

It is worth being accurate about this one, because the usual claim is that it is inaccurate and at this scale that is simply false.
Measured over the reference track, summing all 625 segments with $\cos$ of each segment's mean latitude, it totals 7454.8512933138 m against haversine's 7454.8512933088 m.
That is a relative difference of $6.6 \times 10^{-13}$ between the two totals over 7.5 km.
Per segment the mean relative difference is $4.4 \times 10^{-13}$ and the largest absolute disagreement is 0.042 nm.
Both are float64 noise: the approximation is not measurably worse than haversine at this scale.
It is not rejected for accuracy.

It is not used because it buys nothing.
It needs a reference latitude per segment, so it is not simpler.
It degrades once segments get long or approach a pole, where haversine does not, and it silently mishandles a track crossing the antimeridian.
Haversine has none of those failure modes and costs one extra trigonometric call.
When the accurate and the approximate cost the same, take the accurate one.

The genuine trap in this family is dropping $\cos\varphi_m$ altogether, which is an easy thing to do when treating degrees as if they were interchangeable.
At the fixture's latitude of 57.78 degrees, $\cos\varphi = 0.5332$: a degree of longitude is about half a degree of latitude.
Omitting the factor inflates the reference track from 7455 m to 11762 m, an error of **+58%**.

## Sphere versus ellipsoid, and the error that survives

The Earth is closer to an oblate ellipsoid.
WGS84, the datum GPS reports in, uses semi-major axis $a = 6378137.0$ m and flattening $f = 1/298.257223563$, giving first eccentricity squared $e^2 = 2f - f^2$.
Curvature on an ellipsoid depends on both latitude and direction of travel.
The two principal radii are the meridional (north-south) and the prime-vertical (east-west):

$$M(\varphi) = \frac{a(1-e^2)}{\left(1 - e^2\sin^2\varphi\right)^{3/2}}, \qquad N(\varphi) = \frac{a}{\sqrt{1 - e^2\sin^2\varphi}} .$$

This module uses a single $R = 6371000$ m, the conventional mean radius.
At the fixture's latitude that choice is systematically small:

| Radius | Value | Versus $R = 6371.0$ km |
| --- | --- | --- |
| $M$ at 57.78 degrees | 6381.2 km | +0.161% |
| $N$ at 57.78 degrees | 6393.5 km | +0.353% |
| $\sqrt{MN}$ at 57.78 degrees, the Gaussian mean | 6387.4 km | +0.257% |
| $M$ at the equator | 6335.4 km | -0.558% |
| $M$ at the pole | 6399.6 km | +0.449% |

So every GPX distance computed here is biased low by roughly 0.26% at the fixture's latitude.
That is a systematic bias, not random noise: it does not average out over an activity or over a season.

Now the awkward part, stated rather than hidden.
Substituting the better radius makes agreement with the device *worse*:

| Method | Total | Versus device total of 7456.06 m |
| --- | --- | --- |
| Haversine, $R = 6371.0$ km | 7454.85 m | -0.0162% |
| Haversine, $R = \sqrt{MN}$ at 57.78 degrees | 7473.99 m | +0.2405% |

The Gaussian mean radius is evaluated at the fixture's latitude of 57.78 degrees throughout this document, giving $\sqrt{MN} = 6387356.4$ m.
Distance is linear in $R$, so the second row is the first rescaled by $6387356.4 / 6371000$.

It would be convenient to conclude that the mean sphere is secretly right, or that GPS position noise inflates the polyline by an offsetting 0.26%, since jitter perpendicular to the direction of travel does lengthen a polyline.
Neither conclusion is supported.
Smoothing the coordinates to test the jitter hypothesis fails as an experiment, because a moving average also cuts genuine corners on a road route, and it removes far too much: a 3-sample centred moving average over the coordinates, evaluated over full windows only, totals 7339.18 m, which is 1.55% below the unsmoothed haversine total of 7454.85 m and dwarfs the 0.26% at issue.
The two effects are not separable this way.
The device total is also not ground truth; it is itself a sensor-fusion estimate.

The honest conclusion is the useful one.
Coordinate-integrated distance carries a systematic uncertainty of a few tenths of a percent that a better Earth model does not remove, because the error budget is dominated by the position noise and by the choice of what to compare against.
Two consequences follow, and both are already in the design:

- Prefer the device's own distance whenever a FIT file offers it, which is what `geo.py`'s docstring says and what the pipeline does.
- Do not set reconciliation tolerances tighter than this uncertainty.
  The 2% distance tolerance in [identity.md](identity.md) sits an order of magnitude above the 0.26% modelling bias for exactly this reason.

Refining the sphere to an ellipsoid, for instance with Vincenty's or Karney's geodesic algorithms, would remove a 0.26% bias from a quantity whose noise floor is larger than that, on the degraded ingestion path only.
It is not worth the dependency.

## Cumulative distance along a track

`cumulative_distance_m` vectorises the same formula over an array and prefixes a zero so the output aligns with the input samples:

$$D_0 = 0, \qquad D_k = \sum_{i=1}^{k} d(\mathbf{p}_{i-1}, \mathbf{p}_i).$$

A cumulative axis rather than per-segment lengths is the right output shape because the consumers need monotonicity.
Best-effort extraction slides a window over $D$ looking for the smallest $t$ such that $D_{j} - D_{i} \geq$ target, which only works on a monotone non-decreasing array.

Rounding growth in the sum is not a concern at this length.
The worst-case bound for a naive summation of $n$ terms is $n\varepsilon$ relative, with $\varepsilon = 2^{-52}$ the machine epsilon, which for $n = 625$ is $1.4 \times 10^{-13}$, or one nanometre over 7.5 km.
Measured against an 80-bit accumulation, the float64 `cumsum` on the reference track differs by 0 nm.
No compensated summation is needed, and adding Kahan summation here would be a pure complexity cost.

The empty-input case returns an empty array rather than raising, because an activity with no position samples is a real thing: indoor treadmill runs have heart rate and cadence and no coordinates at all.

## What is deliberately not modelled

**Altitude.**
The formula returns ground-track distance, ignoring the vertical component, so the true slope path is longer.
For a segment with horizontal length $\Delta s$ and rise $\Delta z$, the slope length is $\sqrt{\Delta s^2 + \Delta z^2} = \Delta s\sqrt{1 + g^2}$ with $g = \Delta z / \Delta s$, so for small $g$ the correction is second order:

$$\frac{\text{slope}}{\text{ground}} - 1 \approx \frac{g^2}{2}.$$

On the reference fixture the median absolute gradient is 2.07% and the 95th percentile is 10.12%, giving a predicted inflation of 0.0685% by that formula against a measured 0.0681%, or +5.08 m on 7455 m.
Agreement to three significant figures is a good sign that both the model and the implementation are right.

The omission is deliberate.
Every distance-based comparison in the sport, including every race distance and every published pace, is a ground-track distance, so adding the vertical component would make this project's numbers disagree with every other source by 0.07% for no gain.
Gradient matters for *metabolic cost*, which is stage 9, not for distance.

**Geoid versus ellipsoid altitude.**
GPX altitudes are heights above the WGS84 ellipsoid, which differ from height above mean sea level by tens of metres depending on location.
Irrelevant here because only altitude *differences* are ever used, and the geoid offset is locally constant over a running route.

**GPS position error itself.**
Nothing in this module attempts to filter it.
The 1 Hz resampling stage is where smoothing decisions belong, and they are made there against the speed stream rather than against coordinates, because smoothing coordinates cuts corners.

## The FIT versus GPX measurement

Both formats of the 2026-08-28 reference activity, decoded and compared.
Same run, same 626 points, same start time to the millisecond.

| Property | FIT | GPX |
| --- | --- | --- |
| Total distance | 7456.06 m, device | 7454.85 m, haversine sum |
| Speed | native `enhanced_speed` | derived from coordinates |
| Mean absolute sample-to-sample speed change | 0.030 m/s | 0.305 m/s |
| Max speed over the 626-sample stream | 2.846 m/s, plausible | 3.991 m/s, a GPS artifact |
| Laps, HR zones, athlete profile | present | absent |

The max speed row is the largest value in each format's 626-sample speed stream, so the two columns are compared like for like.
It is not the FIT session summary field `enhanced_max_speed`, which reports 2.855 m/s for this activity and is the value recorded in [test-fixtures.md](../test-fixtures.md).

The often-quoted 10.2x noise ratio is the ratio of those mean absolute differences, $0.3050 / 0.0300 = 10.17$.
The metric matters: on standard deviation of the same differences the ratio is 7.2x, and on standard deviation of the speed *level* it is only 1.9x, because the level is dominated by the genuine variation of the run.
Mean absolute successive difference is the right choice for a jitter measure, since it responds to sample-to-sample roughness rather than to the spread of the underlying signal.

Reproduce with:

```python
from pathlib import Path

import numpy as np

from activity_analysis.geo import cumulative_distance_m
from activity_analysis.ingest.gpx_reader import read_gpx

gpx = read_gpx(Path("data/examples/run-2026-08-28.gpx"))
lat = np.array([p["lat_deg"] for p in gpx.records])
lon = np.array([p["lon_deg"] for p in gpx.records])
t = np.array([p["timestamp"].timestamp() for p in gpx.records])
v = np.diff(cumulative_distance_m(lat, lon)) / np.diff(t)
print(np.mean(np.abs(np.diff(v))))   # 0.3050 m/s
```

The 3.991 m/s derived maximum is worth dwelling on, because it is what noise does to a divided quantity.
That is 4:11 per kilometre, a speed the athlete did not run, produced by a single position sample landing a few metres off over a short interval.
Dividing by a small $\Delta t$ amplifies a fixed position error without bound, which is the whole argument for preferring a device-measured speed and for flagging GPX-sourced activities so trend analyses can exclude them.
