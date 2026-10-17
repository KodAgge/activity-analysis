# Unit normalisation

Implemented in `src/activity_analysis/units.py`, tested in `tests/test_units.py`.

Three conversions stand between what a device writes and what this project stores.
Each is applied exactly once, at the ingestion boundary, because a conversion applied twice is silent and a conversion applied zero times is often plausible-looking.
None of them is a judgement call: all three are exact, and the reasoning below is about what they are and what resolution survives them, not about which of several options to pick.

Everything downstream is SI: metres, seconds, m/s, bpm, spm.

## Semicircles to degrees

### What the encoding is

FIT stores latitude and longitude as **semicircles**, a signed 32-bit fixed-point angle where the full circle is $2^{32}$ counts.
So a half circle, 180 degrees, is $2^{31}$ counts, and

$$\text{degrees} = \text{semicircles} \times \frac{180}{2^{31}}.$$

The constant is exact in binary floating point, since $180/2^{31}$ is $45 \times 2^{-29}$: a small integer times a power of two, representable with no rounding at all.

The choice is a good one, and worth understanding rather than just converting away from.
An `int32` spans $-2^{31}$ to $2^{31}-1$, which maps to exactly $-180$ to just under $+180$ degrees.
The encoding therefore uses its full range with no wasted values, wraps naturally at the antimeridian because integer overflow and angular wraparound are the same operation, and spaces its representable positions uniformly over the globe.
A float32 storing degrees would do worse on every count: it wastes most of its exponent range, and its precision varies with the magnitude of the value, so positions near the prime meridian would be recorded more precisely than positions near 180 degrees.

### The resolution it delivers

One count is

$$\frac{180}{2^{31}} = 8.381903171539307 \times 10^{-8}\ \text{degrees},$$

or equivalently 11930464.7 counts per degree.

Converting that to a ground distance needs the radii of curvature from [geodesy.md](geodesy.md), and gives a result that is **anisotropic**, because a degree of longitude shrinks with latitude while a degree of latitude does not:

| Latitude | North-south quantum | East-west quantum |
| --- | --- | --- |
| 0 degrees | 9.268 mm | 9.331 mm |
| 57.78 degrees, the fixture | 9.335 mm | 4.987 mm |

At the fixture's latitude the east-west grid is nearly twice as fine as the north-south one, because $\cos(57.78^\circ) = 0.5332$.

The number that matters is the comparison: consumer GPS position error is on the order of metres, so quantisation sits two to three orders of magnitude below the noise floor.
It is never the limiting factor in anything this project computes, and no analysis needs to account for it.

### Verified against the fixture

The first record of the reference activity holds the raw integers 689233540 and 169210061:

$$689233540 \times \frac{180}{2^{31}} = 57.770887948572636, \qquad 169210061 \times \frac{180}{2^{31}} = 14.183023469522595,$$

matching the golden values of 57.7708879 and 14.1830235 in `docs/reference/test-fixtures.md`.

The function returns `None` for a `None` input rather than raising or substituting zero.
This is not defensive padding: GPS samples genuinely go missing mid-activity when signal drops, and zero is a real coordinate in the Gulf of Guinea, so coercing a missing fix to zero would put a Swedish run 6600 km off the coast of Africa.

## Cadence: single-foot rpm to steps per minute

### The factor of two

FIT records running cadence as `cadence`, in revolutions per minute, where a revolution is a full gait cycle of **one** foot.
The field is shared with cycling, where crank rpm is the natural unit, which is where the convention comes from.

A runner's gait cycle takes one step with each foot, so one revolution is two steps and

$$\text{cadence}_{\text{spm}} = 2 \times \left(\text{cadence} + \text{fractional cadence}\right).$$

The factor 2 is a definitional identity about bipedal gait, not a calibration or an approximation.
Getting it wrong halves every cadence in the database, and the failure is insidious because 81 spm and 162 spm are both numbers a person might believe: 81 is implausibly low for running but is exactly what a cycling cadence should look like, so the mistake reads as reasonable data.

Garmin's GPX extension uses the same single-foot rpm convention, so the same conversion applies on that path.

### What fractional_cadence actually buys

`fractional_cadence` is a separate field carrying sub-rpm resolution.
The FIT profile defines it with scale 128, so its quantum is $1/128$ rpm, which is $1/64 = 0.015625$ spm.

Measurement on the reference fixture shows that this resolution is not uniformly used, and the distinction is worth recording because it changes what a cadence stream can support:

- **Record level:** across all 626 records, `fractional_cadence` takes only the values $\{0.0, 0.5\}$. The effective per-sample quantum is therefore $0.5$ rpm, giving **1 spm** resolution on the instantaneous cadence stream.
- **Lap and session level:** the averages use the full $1/128$ rpm grid.
  The eight lap values are $\{0.0546875,\ 0.2578125,\ 0.375,\ 0.1484375,\ 0.828125,\ 0.0078125,\ 0.8828125,\ 0.59375\}$, which multiplied by 128 give exactly $\{7, 33, 48, 19, 106, 1, 113, 76\}$.
  Integral to the last bit, which confirms the scale-128 encoding.

So the session's 81 rpm plus 0.375 rpm is 162.75 spm, and lap 1's 81 plus 0.0546875 is 162.109375 spm.

Two practical consequences.
Ignoring `fractional_cadence` gives 162 spm where the answer is 162.75, an error of 0.46%, about a seventh of the yearly rise in cadence at the reference pace that the trend analysis measures on the real store.
And the aggregate values carry genuinely finer resolution than the stream they summarise, so a lap average is not reconstructible from the records it covers, and should be read from the lap message rather than recomputed.

Measurement gives 1 spm per record and $1/64$ spm on lap and session aggregates.

## Enhanced speed and enhanced altitude

FIT defines two variants of several fields.
The legacy ones are 16-bit, the enhanced ones 32-bit, with the same scale and offset:

| Field | Type | Scale | Offset | Range | Step |
| --- | --- | --- | --- | --- | --- |
| `speed` | uint16 | 1000 | 0 | 0 to 65.534 m/s | 0.001 m/s |
| `enhanced_speed` | uint32 | 1000 | 0 | effectively unbounded | 0.001 m/s |
| `altitude` | uint16 | 5 | 500 | -500 to 12606.8 m | 0.2 m |
| `enhanced_altitude` | uint32 | 5 | 500 | effectively unbounded | 0.2 m |

The two uint16 ceilings stop one quantum below the naive maximum, because the FIT profile reserves the all-ones raw value 65535 as that base type's invalid marker.
The largest value a uint16 field can actually carry is therefore raw 65534, giving 65.534 m/s and $65534/5 - 500 = 12606.8$ m.

The enhanced variants exist to lift the range ceiling, which the legacy 16-bit fields hit for aviation and high-altitude use.
Note that the *step* is identical in both variants, so preferring the enhanced field buys range, not precision, contrary to a common assumption.

Measured on the reference fixture, every `enhanced_speed` value times 1000 is an integer, every `enhanced_altitude` times 5 is an integer, and every record `distance` times 100 is an integer, confirming all three encodings.

The more useful finding is about the legacy fields:

```
enhanced_speed     n= 626   x1000 integral: True
enhanced_altitude  n= 626   x5    integral: True
distance           n= 626   x100  integral: True
legacy 'speed' present: 0 records
```

The Venu 2 Plus writes **no** legacy `speed` field at all.
On this device, preferring `enhanced_speed` is not an optimisation, it is the only way to get a speed value.
A reader that looked for `speed` first and fell back to `enhanced_speed` would work; one that looked only for `speed` would silently produce an activity with no speed stream, and the parse would not fail.

## Pace is never stored

Pace is the reciprocal of speed, presented as minutes and seconds per kilometre:

$$\text{pace [s/km]} = \frac{1000}{v}.$$

It is a presentation format, computed at the API boundary or in the frontend, and never a stored column.
Reciprocals are the reason.
Averaging pace over samples is not the same operation as averaging speed and then converting, because the mean of reciprocals is not the reciprocal of the mean.
For any varying speed, Jensen's inequality gives

$$\overline{\left(\frac{1}{v}\right)} \geq \frac{1}{\overline{v}},$$

so a mean pace computed from per-sample paces is always slower than the pace corresponding to the mean speed, with the gap growing with variance.
Storing only speed makes that class of error impossible to commit by accident.
The same argument makes speed, not pace, the correct independent variable for the regression fits in stage 7.

### The average speed a pace is rendered from

There are two average speeds in the store and they are not the same quantity.

`activities.avg_speed_mps` is canonical, read from the device's own session message.
`activity_metrics.avg_speed_mps` is derived, and is the **canonical** $\text{distance\_m}$ over the derived $\text{moving\_time\_s}$.
The API serves the derived one and falls back to the canonical average where the derived layer produced none.

Note which distance that is.
The derived column mixes the canonical numerator with this project's own denominator, rather than taking both from the 1 Hz grid, and the two subsections below are the two halves of why.

**Coverage.** Before `INGEST_VERSION` 3 the canonical column was null on 224 of the 307 runs, and a Pace column rendered from it was empty on 73% of the browser.
That was read at the time as the device beginning to write the field partway through the history, and it was not.
The Strava export's FIT copy of every activity before that apparent start that records a speed, and every activity file in the Garmin Connect export, carries `enhanced_avg_speed` twice in its session message, the value and then None, and `fit_reader` kept the None; see CLAUDE.md, "`fitdecode` can yield one field name twice in a message", and `fit_reader.field_values`.
A re-ingest under `INGEST_VERSION` 3 fills the column wherever the device recorded a speed: measured on 2026-10-16 after the forced re-ingest, it is set on all 335 runs.

**Agreement, and where it deliberately ends.**
Measured on 2026-09-12 over the 83 runs carrying both:

| Population | Runs | Median difference | What explains the spread |
| --- | --- | --- | --- |
| outdoor | 67 | 0.025% | identical distance on both sides; 59 of the 67 agree to within 0.4% |
| outdoor, the 8 that differ by more than 0.5% | 8 | - | the device divided by its own auto-paused timer, this divides by elapsed minus this project's paused seconds; largest on a run whose paused seconds are 6.8% of its elapsed time, which moves its pace by 6.8% |
| treadmill | 16 | 9.06% | the session distance was rewritten after recording and the record stream was not |

The outdoor rows are the case for the moving time: the distance is identical on both sides of every one of them, and the residual disagreement is exactly this project's pause rule differing from the device's auto-pause.
That is the same reason `SUMMARY_SELECT` already takes `moving_time_s` from the derived layer rather than from the canonical row, and taking the pace from one definition and the moving time beside it from the other is what would actually be wrong.

**The treadmill rows are why the numerator is the canonical distance and not the grid's.**
On a treadmill there is no satellite fix, so the stream's distance is a footpod or an estimated figure rather than a measurement of ground covered, and it drifts.
The session total Strava carries is the authoritative number there, and the grid's odometer is the approximation.
Mixing the two sources inside one derived column is deliberate and has a precedent in the same function: `ascent_per_km_m` already divides the device's own barometric ascent by the grid's distance, because for ascent the device's number is the better one.

The evidence is visible in the shape of the two: fourteen of the sixteen canonical distances are round to 10 m, while the grid's own odometer readings for the same runs carry no such pattern.
A round number there is the corrected total, not a corruption of one.
The two disagree by a median of 7.78% and by up to 13.32% over the sixteen treadmill runs carrying both.

That is a large enough gap to be visible in the browser.
A pace computed from the grid's odometer and rendered beside the canonical distance would not multiply out: on the run where the two disagree by 13.32%, the pace would read 12% quicker than the Distance and Moving time beside it divide to.
Hence the numerator: the row's Distance, Moving time and Pace all come from one distance, on all 307 runs rather than only the 225 outdoor ones.

The derived table's own `distance_m` stays the grid's odometer, because that column answers a different question: how far the recorded stream got, which is what every per-second analysis in this project is computed over.
So `avg_speed_mps` and `distance_m` in `activity_metrics` are deliberately not a matched pair, and a reader must not divide one by the other and expect the stored speed back.

**The fallback, and what it costs.**
The derived layer covers running only, so `activity_metrics` has no row at all for a ride or a walk.
Serving the derived column alone would therefore empty the Pace column for every non-running activity, which is not a statement about pace but about which sports this project analyses.
So the API serves

```sql
coalesce(activity_metrics.avg_speed_mps, activities.avg_speed_mps)
```

and on the real store that fallback carries 2,562 of the 2,568 non-running rows, measured on 2026-10-16 after the forced re-ingest under `INGEST_VERSION` 3.
Most are walks, then strength sessions and rides; the six without one record no distance.
Before that re-ingest it carried 286, all from the apparent start described under "Coverage" above onward, a bound set by the repeated-field bug rather than by the sports.
It also catches the degenerate running rows: the stored value is null unless the distance and the moving time are both strictly positive, because a zero there would render as an infinite pace, and a fully paused grid reaches that.

Those fallback rows carry the device's definition of an average speed rather than this project's, which is the honest answer for a sport nothing here derives anything for.

**A reader of the response cannot tell which of the two definitions a row carries.**
No served field distinguishes them, and none of the obvious candidates works: a present `moving_time_s` does not imply the derived value, because a running activity whose distance or moving time is not positive has a metrics row and still falls through to the device's average.
This is the cost of the fallback and it is accepted.
How far apart the two can be is the measured table above, which is the answer and is not restated here in summary form: three attempts at a one-sentence rule for when they agree have each been wrong in a different way.
Answering the question properly would mean serving a provenance flag, which the API does not do.

The stored column has two consumers that compute with it, and the activity header shows it as the run's Pace.

The **browser's Pace column** is the one the numerator was chosen for, above.
The **efficiency fit** reads it to tell a walk from a run, against `MIN_FIT_MOVING_SPEED_MPS`, so the same division decides both what the Pace column shows and which activities enter the reference-pace fit.
That is one definition serving two readers rather than two definitions that could drift, and the canonical numerator costs nothing there: treadmill runs are excluded from the fit before the threshold is reached, and on outdoor runs the two distances are identical.

The **activity detail's pace stream panel** drew this value as its reference line until 2026-10-04, across `streams.speed_mps`, and the two are different measurements: the column is a distance over a moving time, the stream is the watch's speed reading.
Measured that day, the speed reading adds up over the moving time to a median 2.0% less ground than the distance on the 242 outdoor runs, up to 16.3%, and 235 of them read slower than the column.
The raw records show the same median of −2.0% between their speed and their odometer, so the device writes the gap and the 1 Hz resampling does not add it.
On the 82 treadmill runs the stream agrees with its own odometer and the column takes Strava's session total, which differs from it by a median of 1.3% and up to 17.6%; that median includes the 32 runs whose session total matches the stream to within a metre, against 2 of the sixteen above.
So the panel now draws the mean of its own trace, and a sentence under it quotes this value as the header's pace and names both distances when the two paces differ.
Which of the watch's speed and its distance is right outdoors is not established; every per-second analysis reads the speed trace, and every distance-based figure reads the odometer.
