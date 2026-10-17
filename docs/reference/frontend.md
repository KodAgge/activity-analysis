# The frontend

Vite, React and TypeScript, over the generated client for the read-only HTTP API.
Phase 3b.

Develop it with:

```bash
uv run activity-analysis serve --root .   # the API over this checkout's store: http://127.0.0.1:8000
cd web && npm run dev                     # the frontend: http://localhost:5173, proxying /api to the server above
```

`--root .` is what the checkout's `.envrc` sets anyway; without it, outside direnv, `serve` reads the platform's user data directory.
`npm run build` writes `web/dist`, which `serve` mounts at `/` on the API's own port (`api/frontend.py`), so a built checkout runs as one process; the wheel carries the same build at `activity_analysis/web`, put there by `hatch_build.py`.
Under the mount, a path with no file behind it and no suffix gets `index.html`, so a reload on `/activities/<id>` reaches the router; a missing `.js` stays a 404, and so does anything under `/api`.
The dev server never reaches the mount: it serves the source itself and proxies only `/api`.

`npm run check` from `web/` runs lint, `tsc -b`, the schema-drift check and the Vitest suite - see "Generated types and drift" and "Testing" below for what each of those actually catches.

This file is the frontend's reference: what the views are, where the arithmetic lives and why, the token and type-generation contracts, and what is easy to get wrong.

## The views

Nine routes, `web/src/router.tsx`: `/` (`views/Overview.tsx`), `/activities` (`views/Activities.tsx`), `/activities/$activityId` (`views/ActivityDetail.tsx`), `/records` (`views/Records.tsx`), `/routes/$routeId` (`views/RouteDetail.tsx`), `/trends` (`views/Trends.tsx`), `/progression` (`views/Progression.tsx`), `/distributions` (`views/Distributions.tsx`) and `/territory` (`views/Territory.tsx`).
Trends and Progression are phase 4, built against the API contract while the endpoints behind it were filled in parallel.
All four of those endpoints now serve real payloads - `/api/trends`, `/api/fitness`, `/api/predictions` and `/api/progression/{distance_key}`, see `docs/reference/api.md` - so both views render data rather than their absence states.

**Overview** leads with `components/StatRail.tsx`: this week, the last four weeks, the current and longest streak, consistency as a count out of a count, never a percentage.
Then twelve weekly bars sized to read individual numbers, then the zone distribution, then the full weekly history as a context strip.
The strip carries a 9-week trailing average of weekly distance as a line, `VolumeBars`' `trend` prop, whose last point is the last finished week that is not after `last_activity_local_date`; the hover readout gives the average as its own row.
See "The weekly distance trend" in `docs/reference/math/consistency.md` for the window and why the line ends where it does.
That ordering is a design decision, that the overview leads with recent form, and is not this component's to reorder: the full history is 149 weeks on 2026-09-13 and grows by one a week, which at phone width is about four pixels a bar and cannot answer the question the application opens with.
The rail is not five cards: it composes `components/Stat.tsx`'s `Stat` and `StatGroup` into bare label-over-value pairs on the page, and the five sit as three thirds over two thirds and a third, which fills both rows on the same three columns.
A fixed three-wide grid leaves the sixth cell empty and reads as an empty quadrant rather than as a line of text ending early, and two halves on the second row fill it but abandon the first row's columns, so the block reads as two grids stacked.
The wide cell is the one whose caption needs it - "30 weeks through 28 August 2026" does not fit a third.
The screen carries no containers at all: title, stats, headings and charts all start at the page gutter and end at it, and the only chrome on the whole scroll is `components/Section.tsx`'s one full-bleed rule per section boundary.
The version this replaced put every stat in a `--panel` card and gave the chart four different left edges (gutter 48, gridlines 50, zero axis 54, card text 67); do not reintroduce either.
Both bar charts are `charts/VolumeBars.tsx`, and both pass it a `bucket` saying which calendar period one bar covers.
That prop is required rather than defaulted because the hover readout names the period - "Week of 18 August 2026", or "August 2026" for a monthly bar - and nothing in the data says which series it is: `period_start` is a bare date for a week and for a month alike.
Headed with the bare date, twenty kilometres over four runs read as one calendar day's training.
The two headings are shaped differently because a week has no name and a month does: "Week of" plus the start date is the best available for a week, while "Month of 1 August 2026" would carry back the very bare day the heading exists to remove, so a month gets `format.calendarMonth` instead.
The x-axis ticks stay the bare start date on the twelve-week chart, because a tick has no room for more and a reader looking at an axis is reading a sequence rather than one value.
The full-history strip takes `Aug 2026` instead, through `VolumeBars`' `axisLabel` prop and `format.shortCalendarMonth`.
Both series are weekly, so the form follows the span rather than the bucket: at 148 bars the bare day-and-month ticks repeat the same twelve month names over three years without ever saying which year one of them is.

**Activities** is `charts/`-free: a filterable, sortable, paged feed of cards, date-led rather than name-led (the 307 real runs hold exactly two distinct names, `Run` on 172 and `Treadmill` on 51, with no name at all on the other 84, so the name is not on the card at all).
One card is a headline - the run's local wall clock, which is what actually differs between two of this athlete's runs - a quiet meta line carrying the sport and any badges, and a 2x2 block of four `Stat`s: distance, moving time, pace, heart rate.
The sport is named there as a word beside a glyph, and it is the one field the old table never had: it is what tells a run from a walk once the sport filter is widened past running.
There are two glyphs, a runner and a clock, not one per sport - 1637 of the 1944 real activities are not runs across eleven sports, and eleven hand-drawn glyphs would each have to be decoded rather than recognised, while the word beside it says the sport either way.
Every filter, the sort and the page number live in the URL via the route's typed search params (`api/activitySearch.ts`), so the component holds none of that state itself.
One array, `FIELDS`, drives both the sort chips and the card's stat block, so a field cannot be sortable without being shown or shown without being sortable.
See "The validator that drops a key silently loses it" below for the one way this almost did not work.
The filters the reader works continuously rather than picks - the name box and the two range sliders - do not write to the URL on every change: each keeps a local draft through one hook, `useTypedFilter`, which commits it after `QUERY_DEBOUNCE_MS` with `replace: true`.
A push per keystroke stacked one history entry and one cached `/api/activities` request per character, which buried the page the reader arrived from; the filter still ends up in the URL, so a filtered view stays shareable.
The name box had this first and the numeric bounds shipped without it, which is why there is one hook rather than several copies of the mechanism: a filter that bypasses it is the bug reintroduced.
The hook is generic in its draft's type for that reason - a name is a string and a range is a pair of bounds - and a drag is the case that makes it matter most, since a slider fires a change per step rather than per character.
Distance and moving time are `components/RangeFilter.tsx`, two handles on one track built from two native range inputs and a `<datalist>`, replacing four numeric boxes; see "The top stop means and above" in Traps.

**The whole card is the link into `/activities/$activityId`**, and that reverses the rule the table had - see the first trap below for what was traded and what was kept.

The nine filter fields sit behind one disclosure, and the `<form>` carries the `hidden` attribute while closed, so they are out of the accessibility tree and out of the tab order rather than merely scrolled past.
It is hidden rather than unmounted because `useTypedFilter` holds an uncommitted draft a reader who closes the sheet mid-word would otherwise lose.
`[hidden]` has to be restated in the stylesheet, because a `display` declaration on the class beats the user agent's own `[hidden] { display: none }` and the panel would stay laid out while claiming to be hidden.
Two things come with a sheet, because hiding a filter hides the fact that it is filtering: a count on the control (`Filters 2`), and a chevron, which is what says open-or-closed to everyone not using a screen reader.
The count skips the endpoint's own default sport, or every unfiltered landing would claim one filter, and skips `all`, which widens rather than narrows; everything else present and non-empty counts, **including a key the function has never heard of**, the same construction `isUnfilteredSearch` uses and for the same reason - the five filters added after that check was written were not added to it and it went quietly wrong.

The sort moved out of the table header into a full-bleed, horizontally scrollable chip row under the title.
The one thing a table's death took with it is `aria-sort`, which only a `columnheader` can carry.
Two things from one `sortState` call replace it, so they cannot disagree: a drawn caret, `aria-hidden` because a caret read aloud is either silence or the name of a shape, and a visually hidden `ascending`/`descending` word that lands in the chip's accessible name, with `aria-pressed` on the active chip.
The caret is the same path as the Filters chevron, rotated, rather than the text characters `▲`/`▼`: a filled triangle beside a stroked caret is two icon vocabularies on one row of controls, and the glyph's vertical placement would be the font's decision rather than the layout's.
The pace field's inversion survives all of it - the chip reads ascending under `order=desc`, because descending speed is ascending pace.
**An accessible name is the concatenation of its parts with no spaces inserted**: `Filters` + `<span>2</span>` computes as `Filters2` and `Pace` + caret + `ascending` as `Paceascending`, so both need an explicit `{' '}`, which costs the layout nothing because a whitespace-only text node in a flex container is not rendered.

A card that set a record carries a PR badge beside the treadmill one, both `components/Badge.tsx`, titled with the distances from `pr_distance_keys`, because one real run set a 1k, a 1mi and a 3k record at once and a bare "PR" would hide that.

**Records** is the ladder: one row per extracted distance, with the time, the pace, the heart rate, a link to the run that set it and how many eligible efforts it is the best of.
It is a view rather than a filter on the browser because it answers a different question, and the maintainer asked for both on 2026-09-02: `/activities?has_pr=true` answers "which runs set records", which is a fact about runs, while this answers "what am I capable of at 5 k", which is a fact about the athlete.
Pace is beside each time because that is what makes the ladder readable - a column of durations growing more than seventyfold from 400 m to the longest rung the store holds says nothing about how the efforts compare, and one of paces beside it says everything.
It is a grouped inset list rather than a table, through `components/RowList.tsx`: the six-column table it replaced carried a `min-width: 38rem` inside an `overflow-x: auto` wrapper, so at phone width the heart rate column was off the right edge and had to be found by scrolling a box sideways.
The table semantics were replaced rather than dropped, because at that width a table can only be laid out as one by putting `display: block` on its cells, which strips the table roles out of the accessibility tree in every browser and has to be patched back with explicit `role` attributes.
What the table provided is provided instead by an `<ol>` - the order is data, and this view must never re-sort by time, which is a different sequence whenever an effort spans a long pause - by an `<h2>` over the list so the group is in the document outline, and by every value carrying its own unit in its own text, which is why the count reads `best of 214` rather than a bare 214 beside a bare 159.
The whole row is the link, which is what its chevron means: a row-height slot whose only hit target is a date string looks tappable and is not.
The page also states the eligibility rule in prose, because the numbers invite distrust otherwise: the record shown takes three times as long as the store's fastest 400 m effort, and a reader who discovers that deserves to know it is a flagged jump in the recorded distance rather than a bug.
The prose names the exception too, a jump the watch's measured speed confirms within 1%, because without it the half marathon record, a flagged effort since 2026-09-27, would contradict the sentence above it.
Under the ladder and its note, a second `RowList` group, **Routes**, lists every route from `/api/routes` in the endpoint's order, most runs first and then by name, and is not drawn when the store has none.
A row is the route's name, with the record pace from `record_speed_mps` as its value and, as its meta, the record's date in the record run's own wall clock (`record_utc_offset_s`) and the run count; the whole row links to `/routes/$routeId`.
A route whose every run is ineligible has no record, so its value is the no-value glyph and its date slot is empty.
The group renders whether or not the ladder has rows, because a route record needs no best effort at a standard distance, and a failed `/api/routes` is an alert under the ladder rather than the page's own failure.

**Trends** is the reason the project exists: heart rate and cadence at three fixed reference paces per run over the whole history, so a change in fitness is separable from how fast the athlete happened to run that day.
Every chart on it is `charts/TrendChart.tsx`, a uPlot line chart on a shared calendar axis, and every plotted or headlined number on it is a stored column from `activity_efficiency` or `fitness_series` - the view converts units, dates each point and filters, and computes nothing it draws (see "The frontend never recomputes a metric" below).
The one exception is the explanatory prose, whose figures describe the viewer's own history and are computed from the same two payloads by `charts/trendsFindings.ts`; see "The copy states the viewer's own figures" below.
The three reference paces are read from the payload's `references` block and formatted with `format.pace`, never pinned in the component: they are whole-history quantities that drift as history grows, and a label written here would go stale on the first recompute after a new run.
**The three series are drawn as an envelope: the median as the subject, the outer two as the band around it.**
Three near-identical absolute series on one axis cannot be separated and it is not a drawing problem - measured on the store, the swing along them is 8.7 times the span between them (4.9 for cadence), so they braid at any honest scale.
What makes the envelope faithful rather than lossy is that **the three are ordered at essentially every instant** - slow at or below median at or below fast, 224 of 227 smoothed instants for heart rate and 227 of 227 for cadence on 2026-10-16 - so they never cross and the band contains the middle series by construction. A set of series that did cross may not use it; `TrendSeries.edge` says so.
It is a rendering of stored data and not a computed metric: the fill's two boundaries are the two stored columns, drawn by hand in a `drawAxes` hook for the reason given below.
**The edges are not stroked at all**: the band is the mark and its boundaries are where the fill stops.
Stroking them faintly as well was tried and was the worst of both - faint enough not to compete reads as an artefact, strong enough to read rebuilds the braid.
It also settles a prominence inversion by construction: the ramp runs light to dark slow to fast, so the darkest stroke used to be the *fast* edge while the headline quotes the median. The subject stays on `--pace-2`, its own step, and is now the only stroke on the plot.
Two mechanics are worth knowing before touching this. **uPlot needs both edges to build paths** - it clips the band against the lower series' own path, so `paths: () => null` silently draws no band at all; `width: 0` keeps the geometry and draws no stroke.
And **uPlot's own `bands` may not be used**, because it fills while drawing the *upper* edge, which lands after the middle series and paints over the one line the chart is about. The envelope is drawn by hand in a `drawAxes` hook, which fires after the grid and before the series - over the furniture because it is data, under the subject because it is that subject's context.
The three weights are ordered by measurement, as deviation from `--page`: gridline 176, band 227, subject 453. A declared data series fainter than the furniture crossing it was the fault this corrected, at 95.
`tests/phase4.spec.ts`'s one-width test was re-pointed rather than weakened - it reads every trend legend on the page instead of the cadence one alone, so the claim that weight never encodes an ordering is now tested across five lines in four charts.
The three series are told apart by colour alone, on the sequential `--pace-1` to `--pace-3` ramp, light for the slow reference through dark for the fast.
**That one width is 1.8 CSS px, because the envelope leaves one stroked line per pace chart.**
It was cut to 1.2 while the three reference paces were three stroked lines, to buy clear air between them, and the envelope removed the problem that cut was solving, so the stroke went back to the weight that reads.
The measurement behind the cut is kept because it is why three stroked lines could not have worked at any width.
Adjacent reference-pace lines sit about a 67th of the raw scatter's whole spread apart while the heart rate chart's y scale has to cover that spread, because every mark must sit inside a labelled band, so the plot puts two neighbouring lines 7.8 device px apart at 412px.
At 1.8 px each line was 5.4 device px wide and ate nearly all of it: only 22.1% of the plot's columns showed three separate bands and 56.4% showed one fused band, which a blind critic read as a braided smear.
At 1.2 px it was 39.9% and 36.8%, and the cadence chart 62.9% and 5.0%.
Height was the obvious alternative and it was much weaker: eight extra rem of plot bought 31.1%/47.8%, less than six tenths of a millimetre off the stroke did, and cost it on every chart on the scroll.
1.0 px was the floor and was refused, because it is `RULE_WIDTH_PX` exactly and a data line may not be drawn at the weight of the grid it is read against.
So the best any stroke could do still left most of the heart rate plot showing fewer than three bands: the encoding was the fault, and the envelope replaced it.
Line weight was the old separator and it is gone - see "The reference-pace series carry their ordering in colour" in Traps.
An effort filter, one checkbox per tag the payload actually holds plus one for the untagged runs, scopes the *per-run points* on two charts - heart rate and cadence - because the heart rate fit includes `all_out` sessions that sit higher at the same speed by about 0.6 of the across-tag standard deviation and a reader must be able to see which points are which, and to take them out.
Per-run points means the raw scatter and nothing else.
It changes no plotted value on any chart on the page.
That is a statement about values rather than about pixels: the y scale is `axisScale` over every series including the scatter, so removing points can rescale the axis and redraw the same line at a different height.
The note on the page keeps the two apart for that reason, and names the rescaling as the gain it is - taking the `all_out` sessions out narrows the axis and separates the three lines better, on top of what it does for the scatter.
Every line on the page is a stored trailing mean - `hr_at_*_smoothed_bpm`, `cadence_at_*_smoothed_spm`, `decoupling_smoothed_pct`, `hr_vo2max_smoothed` and `vdot_smoothed` - which the analysis layer computes over the unfiltered history, so a filter applied to their inputs is not reflected in a smoothed value.
So `paceSeries` takes two item lists: the three smoothed lines are built from the unfiltered activities and only the scatter from the filtered ones.
The decoupling chart carries no per-run points at all and is built from the unfiltered items entirely.
The VO2max chart does carry one - `Heart rate based, per run`, the raw `hr_vo2max` its own lede advertises as drawn faintly beneath so the smoothing never hides its inputs - and is outside the filter's scope all the same, because its two plotted series are smoothed over a trailing calendar window and a filter applied to their inputs would not be reflected in a smoothed value.
Its points also come from `/api/fitness`, which carries no effort tag for the filter to key on.
**Do not write that the VO2max chart has no per-run points.** It has exactly the kind of scatter the filter was built for, and the exemption rests on the smoothing rather than on their absence.
**Filtering a trailing mean deletes samples of it rather than filtering it**, which is the rule behind all three.
`alignSeries` takes x from the union of the series it is handed, so a run the reader unticked leaves the axis and uPlot draws a straight chord over it: a stretch of consecutive unticked runs would be redrawn at values the analysis layer never computed, which is the claim the note makes and the one that has to hold.
**`alignSeries` then trims that axis to the first and last instant at which any series has a value**, and only the leading and trailing runs of all-null instants, never an interior one - an interior all-null instant is a run that produced no fit, and dropping it would join its neighbours with a straight segment through a value nobody measured.
So the trim can never remove a drawn value; by construction it only removes instants at which nothing is drawn.
It earns its keep on the heart rate chart when the oldest fitted runs carry no heart rate at all, as about a quarter of them did on the history it was developed against: untrimmed, **35.0% of that plot's width held no ink of any kind and its first ink fell 30.1% of the way across**, under a `2024` tick naming a year the chart never reached. Trimmed it is 6.2% and 1.4%.
The cadence chart is the control that shows this is the data rather than the drawing: cadence was recorded on every one of those runs, and its plot measured 0.0% blank either way.
The split gives the lines and the scatter different x positions, which `alignSeries` supports - at an instant the scatter no longer carries, its y is undefined, its cursor dot stays pinned to that instant through `TrendChart`'s `cursor.dataIdx` override, and the hover readout shows `NO_VALUE` there rather than a neighbour's value - and the readout's effort tag comes from the lines, so it still names the run at that date whether or not its point is shown.
`Trends.test.tsx` asserts the three line series are identical across a tick while the scatter loses points, and that the decoupling series is identical too.
One consequence worth knowing: unticking every tag no longer empties a pace chart, because its lines are the whole history, so neither chart's absent reason may blame a selection.
The filter's own note says both halves of that - which points it removes and whose values hold - rather than leaving a reader to infer it from a chart whose points thinned while its level held still.
The section order is a decision, not incidental: VO2max, race predictions, heart rate at the reference paces, cadence at the reference paces, aerobic decoupling, then the cadence slope, with `Trends.test.tsx` asserting the on-page order of the headings so a later edit cannot quietly reshuffle them.
This supersedes an earlier order, which put VO2max between the two reference-pace charts.
VO2max, race predictions and heart rate are the maintainer's stated order from the 2026-09-12 review; cadence follows heart rate because they are the same chart of the same fit and read as a pair, decoupling follows as the other aerobic signal, and the slope closes as a stated non-finding rather than opening with one.
The effort filter sits **inside** the heart rate section, under that section's title and under the headline number it refines, and its own note names both charts it scopes so that being in one of them is not read as driving only that one.
It is three lines: the group's name, the chips, and one summary line that states what the group is doing and opens the scope behind it.
It stood above the section title at eight lines, five of them a full-measure paragraph, and a blind critic read the apparatus as outweighing the chart it introduced.
It did, measured as ink: 5867k against the chart's 5313k, with the paragraph alone at 4220k, 79% of the whole chart and 2.8 times the stat block it pushed down the page.
Rebuilt it is 2474k against 4430k.
**Every included chip is marked, in every state**, and the marking is neutral: both states share a `--panel` fill and an `--ink-dim` label, and an excluded chip adds an outline in `--border-strong` that an included one does not have.
Marking them in the accent was tried and measured as mean CIELAB chroma over each block's box: the chip row came out at 9.54 against 3.67 for the plot it filters, so the control was 2.6 times more saturated than the data it is furniture for. Neutral it is 2.32.
**The fill is lighter than the page rather than darker**, which is what keeps the chroma fix from undoing the ink one: ink counts how far a pixel falls below the page, so a white pill adds none of it and the filter went from 2470k to 2103k rather than up.
The group's state is no longer also stated in words - `All 4 efforts shown` was right while the chips said nothing, and a control that states in a sentence what its own marks already say asks to be read twice.
**Two numbers govern the chips and both are measured**: the row's ink density must sit below the plot's, and no chip element may be darker than the trace it scopes.
As mean deviation from `--page`, measured at 412px on the heart rate section, the resting row is 26.8 against the plot's 25.3, and its darkest element 376 against the primary's 453 - it was 84.1 and 602. For scale, the section's own `<h2>` is 106.5 by the same metric.
**The first number is not currently met.** The row was 26.8 against 27.0 when the chips were settled; the envelope then took ink out of the plot and the resting row now sits 1.5 above it.
With `All out` excluded the row is 30.3 against 25.0, and with every chip excluded 41.5 against 32.7. The second number holds in every state.
The gap is accepted for now.
That is what rules out `--ink` labels, pure-white fills and an outline on a filled chip, and it is why an included chip is `--panel` with no border while an excluded one adds an outline in `--border-strong`.
An excluded chip's label is `--ink-dim` rather than `--border-strong`, which was 2.99:1 on the page and too faint for the label of a control a reader can switch back on.
It sits on `--panel` rather than on the page for the same reason: `--ink-dim` is 4.39:1 on `--page`, under the 4.5:1 a 12px label needs, and 4.68:1 on `--panel`.
The fill costs the row 2.5 with one chip excluded and 10.5 with all four against an unfilled outline, and nothing at rest, where every chip is included.
A tick was tried and removed: it needs no neighbour, which was the right argument, but it is ink spent on a row whose whole problem was how much it was spending.
A collapsed resting control was considered and rejected, because it defers the ambiguity rather than removing it - opening it shows four identical chips again, one click later and with the control now hidden.
Marking nothing until something is excluded was tried and failed: three separate blind critics read the resting control as "four identical outline pills with no selected/unselected marking anywhere", because an exclusion filter's default has no unselected neighbour to read a marked chip against.
A solid accent fill with reversed text is the other end of that and is refused, because four crimson slabs inside a section whose subject is a chart spend a contrast budget chrome does not get.
The VO2max section draws both smoothed estimates with the raw per-run heart rate points faintly beneath, and carries a caveat that is required rather than decorative - see "The VO2max chart's caveat" in Traps.
When `/api/fitness` carries a non-empty `device` list, the chart adds a line labelled `Garmin (watch)`, the readout row adds a third stat, `Garmin`, showing the latest day's whole number with the detail `as the watch shows it`, the section note becomes "Two estimates, and the watch's own", and the About disclosure gains a paragraph comparing both estimates with Garmin's, over the viewer's own runs.
The line's `paletteSlot` is set to 3 explicitly, because its position after the per-run scatter would otherwise default it to slot 4.
Each Garmin point sits at the start of its calendar day, through `format.calendarDayOfDate`, since a day carries no instant and no offset.
The series sets `holdsLastForReadout`, so hovering a run reads Garmin's value as of that day, its last update at or before it, beside the two estimates.
The two 42-day means set it too: Garmin's days rarely fall on a run's instant, so hovering one would otherwise read both estimates as missing while their lines run straight through it.
The raw per-run points do not, because each is one run's value rather than a level.
Its days almost never share an instant with a run, so `trendChartMath.alignSeries` leaves a series undefined at an instant it has no point at, which uPlot draws through, and keeps null only for a point of its own with no value, which breaks the line; with a null for every missing instant, the first render drew all three lines as dashes.
With an empty `device` the section is exactly as before, and with empty fitness `items` it shows its absent state whatever `device` holds, because Garmin's line alone is not this project's VO2max.
It is the one chart drawn at `height="tall"`: two smoothed series that can sit far apart, the heart rate based one well above VDOT on the history it was developed against, with raw points beneath them read as one band at the standard height rather than as a trend.
`TrendChart`'s `height` prop moves `options.height` and the container's own CSS height together, which it must - see the unbounded-growth trap below.
The decoupling section keeps its *population* in the open - it is the only series on the page sampled on a population of its own, so a null there means "not defined" rather than "not recorded" and `tests/phase4.spec.ts` asserts the phrase is visible - and folds the reading of the level, the median over the population and over its runs of an hour or more, into the disclosure, because the headline stat already gives the current value and the chart's key already names the 5% rule.
Left open it measured 5536k of ink against its own chart's 2737k, the same fault the effort filter was found guilty of one section above; it is now 2509k.
The cadence slope section states its finding in the open as a measurement over the viewer's own history, not a metric: the ordinary least squares trend over time in each run's shrunk slope, as a multiple of its own standard error, read at the one decimal the page prints as not distinguishable from zero under 2 and as rising or falling at or above it.
When every run carries the shared slope exactly, because `cadence_slope_tau` was floored at zero, the series is constant, no trend can be fitted, and the section says that every run takes the shared slope.
It is never labelled an improvement in either direction, because a lower slope describes running style rather than fitness.
**It has no chart, deliberately.**
A chart of a quantity that does not trend, in a unit as abstract as steps per minute per metre per second, is what the maintainer read as not making sense on 2026-09-12; the readable form is the cadence-at-reference-paces chart above it, whose level the disclosure reads the same way, as the trend in each run's raw `cadence_at_median_spm` against its own standard error.
The shared-slope readout stays.
`docs/reference/math/efficiency.md`'s "The cadence slope as its own metric" defines the test; the figures it records are the maintainer's store, and the view never quotes them.

**The copy states the viewer's own figures, or none.**
The page is read by any runner whose history it draws, so a figure measured on the maintainer's store is false for everyone else, and every figure in the prose is computed from `/api/trends` and `/api/fitness` by `charts/trendsFindings.ts`.
Each function there answers one sentence's question and returns null when the payload cannot carry the claim, and the view then drops the sentence or keeps only the part that holds on any history:

| Sentence | What it computes | Shown when |
| --- | --- | --- |
| Heart rate About, the late start | fitted runs with no raw `hr_at_*_bpm`, and how many precede the first that has one | at least one run without heart rate comes before the first with it |
| Heart rate About, the raw step | median run-to-run step of `hr_at_median_bpm` over the median `hr_at_fast_bpm - hr_at_slow_bpm` | 10 runs with heart rate and a step larger than the gap at one decimal |
| VO2max About, the offset to VDOT | median of `hr_vo2max_smoothed / vdot_smoothed` and that ratio's sample standard deviation | 10 runs carrying both |
| VO2max About, against Garmin | each run paired with Garmin's value for its local day or the latest day before it; mean percentage offset of each smoothed estimate, and Pearson's r for the heart rate one | 10 pairs per estimate, 20 for r |
| Decoupling About, by session | median `decoupling_pct` of `all_out` and of `easy` runs, and how far apart | 10 runs per tag |
| Decoupling About, the level | median `decoupling_pct` over `is_aerobic_long_run` runs, and over those with `fit_seconds` of 3600 or more, each against the 5% line at one decimal | 10 runs per median |
| Cadence slope finding | OLS trend over time in `cadence_slope_shrunk_spm_per_mps`, as a multiple of its standard error | 20 runs, else a sentence naming the minimum; a sentence of its own when every run has the same slope |
| Cadence slope About, the level | the same trend in `cadence_at_median_spm` | 20 runs, not all at one value |

Each threshold is a named constant in the module with its one-line reason, and each verdict is decided on the figure as printed, so the number a sentence shows never contradicts its verdict.
Two claims the copy used to make are gone rather than computed: the 5 km time the heart rate estimate's level implies, which needs the VDOT tables the backend owns, and the seasonal swing in the gap to Garmin, which `vo2max.md` rests on one winter and leaves unexplained.
A trend is fitted on the raw per-run column rather than its smoothed twin, because a trailing mean's neighbours share most of their runs and its residuals are nothing like independent.
None of these is a metric the analysis layer owns: each is a summary of stored columns for one sentence, the line through stored values that `efficiency.md` assigns to the frontend, and none is plotted or headlined.
`Trends.test.tsx` asserts each sentence from synthetic payloads, and its absence when the payload is too thin.
Race predictions are a table, one row per distance, or the endpoint's own `reason` through `Absent` when `items` is empty.
Above it is a definition list explaining each of the three models, every claim in it sourced from `docs/reference/math/predictions.md`: what the model is, what it was fitted to, and where it goes wrong here.
Three model names in a table with nothing saying why they disagree is what the same review read as unexplained, and a figure or a claim in that list which the document does not carry is a defect rather than a simplification.
An empty `items` is the only absence: `insufficient_data` is set whenever either source could not produce a model, so a window with best efforts but no heart-rate estimate still has every best-effort prediction.
A partial insufficiency therefore renders the table with `reason` shown as a note beside it rather than in place of it, and a distance that lost every model renders a row of no-value glyphs.
Treating the flag itself as an absence would have discarded predictions the analysis layer computed fine.
It is still a `<table>`, because it is one and because the row is the unit both the tests and a screen reader address it by; what went is the chrome - the border, the radius, the fill, the per-cell rules and the `min-width: 38rem` that made it scroll sideways at phone width.
Its values are sans at 700 with `font-variant-numeric: tabular-nums`, not `.mono`, because `tabular-nums` is the only part of `.mono` a column of times needs.
The row's distance label is set at that same `--text-body`, the way the reference's own best-efforts list sets a distance and its time at one size, which is also what took the panel from seven distinct size-and-weight pairs to five - a critic counted the seven and noted five of them sat inside a 5px band, which is noise rather than steps.
**The exact metres appear only where the label does not already state them**, which is `format.distanceKeyStatesTheDistance` - the same test the records ladder uses, shared rather than copied, because the key set belongs to `analysis/best_efforts.py` and the frontend must not hold a second copy of it. Five of the nine rows were printing `1 km` over `1.00 km`.
**A range may wrap and the break falls before the connector, never after it.** Three of the nine rows cannot hold a range of two `h:mm:ss` times on one line at 412px: with the range refusing to break the table's min-content is 78 + 174 + 127 = 379 px against 364 available at 412 and 342 at the 390 px `tests/phase4.spec.ts` pins against sideways scroll, and the range would have to fall to 12 px - smaller than the table's own caption - before 390 came within 6 px of fitting. So `format.RANGE_JOIN` makes the space after the `to` non-breaking, and a wrapped range reads `h:mm:ss` over `to h:mm:ss` rather than dangling its conjunction at a line end. It is whitespace, so every whitespace-normalising matcher still sees `A to B`.
Each model and its time sit on two straight edges inside the cell rather than as a right-aligned pair, which gave three ragged left edges per row nine times down the table; the model name stays a bare text node, because `Trends.test.tsx` finds it with `getByText(/Riegel/)` and wrapping it would make both it and its parent match.
**Neither repository path is in the rendered copy any more.** A path is a developer artefact and it dragged a monospace face into a panel that already had too many sizes; the pointer to the owning document belongs in a code comment, and both are there. `docs/reference/math/predictions.md` is still rendered inside that section's disclosure, because `Trends.test.tsx` asserts the section carries it and that file may not be edited.
The per-model paces are gone; the range and the two model times are not.
Several times and paces in one narrow column is the dense-table fault this screen exists to remove, the range is the reading, and nothing requires a pace per model - the ordinary-runs prediction keeps its pace and its band, because it is a single estimate rather than a spread and the band is its own fit's.
The two best-effort models are reported as **one range** rather than two point estimates, with each model named beneath it.
That is the contract on both sides rather than a layout choice: `RaceModel`'s own validator in `api/models.py` lets a best-effort model omit its band because "their spread is the range across the two models, shown by the caller".
**The ordinary-runs prediction is set in the detail ink at medium weight**, `.secondaryValue`, not in the range's bold ink, because it reads typical training and sits slower than the best efforts after a breakthrough run; at the same weight it read as a second race prediction that contradicted the first.
The section carries a caveat saying so, for the same reason the VO2max chart does - see the trap below.

**Every section on the screen is the same object**, and that is what makes a screen with no counterpart in the reference still read like the reference.
A `components/Section` title, its one caption line, a `components/Stat` block set the way the Overview sets its own, any prose the number beside it needs to be honest, the chart, and a `What this measures` disclosure holding the explanation.
That is the reference's own section - `This week`, three stats, `Past 12 weeks`, a chart - and the disclosure is the same affordance `components/AppShell.tsx` gives the staleness strip: marker off, summary at caption size in dim ink, the affordance carried by an underline rather than a colour.
**What may not fold into a disclosure is anything that makes the number beside it honest**: the VO2max caveat, the prediction range's caveat, the decoupling population, the cadence slope's dated measurement and the effort filter's stated scope all stay in the open, and `tests/phase4.spec.ts` asserts two of them - the VO2max caveat and the decoupling population - are *visible* rather than merely present.
**A caveat is one line at the subtitle's size and grey, on the page gutter, directly under the subtitle it qualifies**, and its supporting evidence folds with the rest of the teaching.
It was a `--panel` card with a bold lead-in, and measured on the predictions section that came out as 14762k of ink against 25460k for the whole nine-row table beneath it, at a darkest-200 mean of 33.3 - identical to the table's and the title's, so nothing about it was subordinate - and with its ink starting at x 40.3 against a 24px gutter, the card's own padding making it the one block of text on the page off the edge every other line starts at.
It is now 864k, a darkest-200 mean of 108.9 (the section subtitle's own grey, against the title's 32.3) and x 24.3.
The claim stays and the evidence folds: which sentence is which is the test, not the length.
What folds is the teaching.
Each headline stat is `latestWith`, the most recent stored row carrying that column, ordered by the UTC instant rather than by array position because nothing in the payload's contract promises an order.
It is selection, never arithmetic: a "change since last year" would be a computation over two stored values and is exactly what that helper must not become.
The reference-pace sections carry one stat rather than three, at the median reference, because the three series are too close to report as three numbers: the median gap between the fast and slow smoothed series on one run is a small fraction of the heart rate itself, which `docs/reference/math/efficiency.md` measures, and three near-identical numbers under three different labels read as noise rather than as three findings.
The other two paces are named in the chart's key, where they label lines rather than claim to be different readings.
The view's own `--text-stat` override to `--text-stat-lg` is a seam, not the finished shape: `components/Stat.tsx` takes no size prop, and when it does the override goes.

`TrendChart` is registered exactly the way `charts/VolumeBars.tsx` registers the Overview's bars, so the two screens are one chart language: zero horizontal uPlot padding so the plot's left edge is the chart element's left edge is the page gutter, the ladder on `side: 1` with `align: 2`, `alignTo: 2` and `gap: 0` so its labels' right edges stack on the page's right gutter, horizontal rules only in `--chart-rule`, and no tick marks, axis borders or axis titles anywhere.
The unit rides on every rung instead - `150 bpm`, the way the reference's own `40 km / 20 km / 0 km` does - which is what let the rotated `bpm` and `Date` titles go; `TrendChart.test.tsx` asserts the title is *absent* rather than merely unasserted.
Measured on a 412 px render at 3x: the plot's ink starts at x 72, which is the gutter, and the ladder's own right ink ends at 1161 against a right gutter of 1164.
**The y bounds are the y ticks**, solved together in `trendChartMath.axisScale`, and that is a bug fix rather than a tidy-up.
The version before it returned a *range* - the data's band padded a tenth either side - and left the ticks to uPlot, which places nice increments **inside** a range: covering a range and fitting inside one are different questions and the two answers diverged.
Measured on the heart rate chart, 159 device px of data sat below the lowest labelled rule with no rule and no label beneath it, while the topmost rule floated 20 px above the highest mark naming a value nothing reached.
`axisScale` floors the minimum to a whole increment and ceils the maximum to one, so every mark is inside a labelled band and a rule is drawn at both ends by construction; `axisRange` then adds a 6% overhang **to the scale only, never to the ticks**, so an extreme mark is not half-clipped by the canvas edge.
**The outermost labels therefore name values the data does not reach, and that is the trade rather than a fault** - two reviewers have now read it as one, so it is written at `axisScale` with the instruction not to "fix" it by cropping the ladder to the data. Containment and every-label-reached are mutually exclusive unless the data lands on round numbers, and containment is the more important property: a mark outside its own axis is a chart lying about its data, where a label one increment clear of the extreme is a chart being careful.
What *is* a fault, and a different one, is an increment so coarse that the outer labels sit far from the data rather than one step from it; the answer to that is more intervals, not a tighter crop.
`trendChartMath.test.ts` runs every case through a `covers()` helper so no case can forget the invariant, and `tests/smoke.spec.ts`'s "a trend chart labels a band that contains every mark it draws" is the end-to-end statement of it, read off the canvas rather than off the source that produced it.
The x axis has the matching problem and `paddedDayRange` the matching fix: the pad is solved from the plot's own width because the clearance is a pixel measurement, and a fraction that clears a 10 px mark on a 308 px phone plot leaves ten times the dead space on a 920 px desktop one.
**A chart whose raw inputs would set an axis far wider than its subject needs splits into two bands.**
A `faint` scatter is the per-run input to the line above it, and drawing both against one scale is what shows that the line is the mean of those points - so the split has to buy more than it costs, and `TrendChart` takes it only when the combined extent is at least twice the subject's own.
Measured on the real store, that is the heart rate chart alone: its combined extent is 3.08 times the span of its three smoothed series, where cadence is 1.29x and VO2max 1.37x.
Left unsplit, the heart rate chart gave its three named series **24.9% of the plot**, with adjacent series resolving to under a pixel of clear air; split it is 53.6% at 2.1 times the pixels per bpm, and the clear air between lines goes from 3 to 9 device px.
`trendChartMath.bandRange` is how a band is placed: uPlot maps a scale across the whole plot box, so confining a series to part of it means widening its scale past its data by exactly the right amount.
**The widening never reaches a label** - `splits` still returns the band's own ticks, so every rule drawn and every number written belongs to the band's own ladder, and every mark still sits inside a labelled band, now its own one.
The strip's ladder is drawn by hand in a `drawAxes` hook rather than `draw`, because `drawAxes` fires before the series and a rule painted after them would sit on top of the marks it exists to measure.
**The strip is a chart, not a decoration**: `--chart-trend-strip` is *added* to the height the caller asked for rather than taken out of it, so the subject keeps the room it was sized for, and the strip gets 83 CSS px of its own.
It carries its own caption - the name of the series in it, read off that series' own label so the two cannot drift - and its ladder is **ticks at the right edge rather than full-width rules**.
That is deliberate and it is the answer to "the main plot has no x axis": the two bands share one date axis at the foot of the stack, and a shared axis only reads as shared if the pair reads as one object.
The gap between them cannot be closed to achieve that - it has to stay wider than a subject rung or the two ladders merge - so what went instead is the strip's claim to be a plot in its own right. A full-width rule per rung is a grid, and a grid is what a separate chart has; a tick beside its own number is a scale on an annex, and the subject band now owns the only grid on the canvas.
Duplicating the dates under the main plot is the alternative and is rejected: four labels repeated 128 px apart is redundant ink, and hiding uPlot's axis to draw one *between* the bands puts a time axis in the middle of a stack.
The first attempt gave it 27 px and a two-rung ladder of 100 and 200 with every mark between the two, and a critic read it as "not a chart yet", correctly.
Narrowing the axis and letting the scatter fall outside it is not available and must not be tried; neither is dropping the scatter, because `Trends.test.tsx` pins it into the same chart call and the effort filter's only visible effect is scoping those points.
A series may opt into `markLatest`, which draws its most recent observation as a solid dot inside a translucent halo - the reference's own current-week mark - so the headline stat and the chart are one statement rather than two.
It is opt-in for the reason `VolumeBars` refuses the same mark: a component handed an arbitrary series cannot know its last point is *current* rather than merely last.
**The halo is a knockout before it is a tint.** At 22% over a `--chart-rule` at 1.83:1 the composite is 78% rule, and a rule ran through the one mark the headline names at 66 of 70 pixels of pure rule colour; filling the disc with the page's own colour first stops the rule at the marker's edge.
Measured after, on the one chart whose rule actually crosses its marker - the heart rate chart, marker centre 8.9 device px from the nearest rule against a 33 px knockout radius - 0 of the 67 pixels along that rule inside the marker's width are rule colour, against 26 of 67 on the same rule elsewhere, and 247 pace-line pixels survive on that rule row, so the grid sits behind the data rather than over it.

**Progression** is one distance at a time, every effort at it over time, records marked and joined by the running-best staircase.
The distance is a validated URL search param (`api/progressionSearch.ts`, defaulting to `5k`), with the same `validateSearch` plus `beforeLoad` redirect pair `/activities` uses, so a bare `/progression` becomes `/progression?distance=5k` and a view of the 10 km ladder is a shareable link.
The picker is driven by `/api/records`, which lists every distance with an eligible effort, shortest first; the three the athlete has never covered, 30 km, 35 km and the marathon, are absent from it rather than present and empty, and a URL that names one renders the endpoint's 404 through `Absent`.
A URL naming a distance the picker does not list still gets a chip for it, appended to the row, because otherwise the control and the address bar disagree about what the screen is showing.
It is a `<fieldset>` of radio chips rather than a `<select>`: one of a set is exactly what a distance is, native radios give arrow-key navigation, a group name and a checked state without a line of JavaScript, and unlike a `<select>` the options are on the screen rather than behind a tap.
The chosen chip is marked three ways - accent ink, an accent ring as an inset `box-shadow`, and an 8% accent tint - and neither the border width nor the font weight changes, because either would resize the chip and shunt the whole row sideways under the reader's finger.
The row is full bleed and scrolls sideways, and **the chosen chip is scrolled into view**, which is not a flourish: the store holds nineteen distance keys of `analysis/best_efforts.py`'s twenty-two, so the row is several screens wide at phone width and the default `5k` starts well off the right edge.
That effect keys on the option count as well as the chosen key, because on the first paint the row holds one chip - `/api/records` has not landed, and the only distance known is the URL's own - and scrolling then and never again parks the row on `400 m`.
Under the picker the record is the headline: its time at `--text-title`, then one dim line of pace, heart rate and date, all read from `/api/records` rather than from the chart's points, because picking the best effort out of the items would be the frontend deciding which effort is the best.
That line leads with the exact distance only where `format.distanceKeyStatesTheDistance` says the label does not already state it, so `Best 1 mile` carries `1.61 km` and `Best 5 km` carries nothing extra.
The chart is `charts/ProgressionScatter.tsx`, plain SVG rather than uPlot, with an inverted time axis - both are Traps below.
It takes one of two kinds.
The distance form, `points` and `distanceM`, plots elapsed time per effort, and its `kind` is optional so the call here names none; `kind: 'route'` with `runs` plots pace per run, `format.paceSecondsPerKm` over `speed_mps`, on the same inverted axis.
Both convert to one internal point at the top of the component, so layout, paint order, staircase and readout are one path for both; only the route form draws a reverse run as a diamond of the circle's area and renders a Forward/Reverse key under the panel.
Each point is a link whose accessible name ends in `, record` or `, not eligible: <reason>` when it is either, after the time or the pace and, on a route, the direction, because the hover readout is `aria-hidden` and the link is all a keyboard reader has.
**Its `viewBox` is the panel's own measured size, so one coordinate unit is one CSS pixel**, and it is watched with a `ResizeObserver` guarded the way `charts/UPlot.tsx` guards its own, because jsdom has none.
A fixed `viewBox` scaled to fit made every size in the file a lie: at a 412 px viewport the panel is 364 px wide, so an 800-unit box drew an 11 px axis label at 5 px, a 1 px gridline at 0.45 px and a 4-unit point radius at 1.8 px, while the same file on a desktop column drew all three half again too large.
The fallback when nothing is measured is per dimension rather than for the pair, because jsdom reports zero for both and a test that stubs one of them must not have its stubbed value thrown away with the other.
Records are painted last (`inPaintOrder` in `charts/progressionMath.ts`), because in payload order an ordinary effort from the following week covered one and there are nine records against 225 efforts - **paint order only**: `is_record` and `is_eligible` stay the analysis layer's flags and nothing re-decides either.
That also means **DOM order is not chart order**, which is a trap for anything selecting a point by position; `tests/phase4.spec.ts` takes the chart's extremes by measured x for exactly this reason.
The axis being inverted is the one fact a reader most needs and cannot guess, so it is said three independent ways: `SLOWER` above the top tick and `FASTER` below the bottom one, right-aligned in the ladder column, deliberately not a matched pair (`FASTER` at full ink and 700, `SLOWER` dim at 400, so a reader who takes in one word takes in the right one); in the section's caption, ahead of the counts; and by the accent staircase, which descends.
Eligibility and record status are the analysis layer's flags on each point; the view hands the items to the chart verbatim and never re-decides either.
Ineligible efforts are drawn by default in a distinct hollow, dashed style and can be hidden by a toggle: for 5 km they are 70 of 225 efforts, so hiding them by default would misrepresent training volume, and drawing them like the others would let a jump in the recorded distance look like a record.
That wording is shared with the API's own `ineligible_reason`, deliberately - see "The flag names no cause, and neither does the copy" in Traps.
An eligible point whose `contains_jump` is true counts only because the measured speed confirmed its distance, and its readout and accessible name say `Counted: the recorded distance jumped, but the measured speed confirms it`, the sentence `components/recordNotes.ts` exports as `CONFIRMED_JUMP_NOTE` for the activity view too; the half marathon record is the case.

**Distributions** is a histogram of the runs over one variable at a time, chosen from fifteen in a drop-down, from `/api/distributions`.
The API serves every run's values in SI and the frontend buckets them, so switching variable, period or comparison is no round trip.
Every control lives in the route's search params (`api/distributionSearch.ts`), validated and redirected the way `/activities` does it, and every change navigates with `replace`.
Two rules depend on the previous search and so cannot live in the validator: changing the variable clears `bucket`, and choosing `compare=periods` from all time sets `period=last_12_months`.
`applySearchChange` holds both, and also seeds a newly chosen custom range from the period it replaces, since the validator drops a bare `period=custom` back to all time and the select would refuse the choice.
A custom range's `to` stays exclusive in the URL, the `/api/activities` convention, while the "To" input and the label show the last day the range includes: `to=2026-02-01` reads as `1 January 2026 to 31 January 2026`.
The buckets are built from **every served run**, never the filtered set, so a filter or a comparison changes what is counted and never where the bucket edges sit.
Comparing draws two groups as an overlay, bars in `--ink` and a stepped `--accent` outline, or each calendar year as a compact small multiple on one shared `yMax`, and puts every y axis in share of its own group, because groups of 139 and 185 runs would otherwise compare their sizes rather than their shapes.
The caption states each group's count as `7 of 10 runs, 3 left out`, never a percentage and never dropped when nothing is missing, and the median run's value; a year's count heads its own multiple instead.
Under `compare=periods` or `years`, average and maximum heart rate and average cadence carry a one-line caveat that part of a shift can come from pace, linking to the same channel at the reference pace.
The median reference pace in those labels is read from the payload's `references.median_mps`, for the reason given under Trends.
Selecting a bar writes `bucket` and lists that bucket's runs under the chart as one `RowList` group per compared group, newest first, each row linking to its activity; selecting the same bar again clears it, and a `bucket` naming no bucket of the current axis selects nothing.
A list's heading names a category bucket through the variable's formatter, `All runs, 17:00` or `All runs, 7+ days`, and `histogramMath.bucketRowParts` keeps a row from saying one thing twice: under start hour, weekday and month, which the row's local start already names, the value is the run's distance, and under distance or pace the value leaves the meta.
Bars counting runs outside a comparison put the y axis's midpoint rule on a whole number, 3 rather than 2.5 runs, through `histogramMath.histogramScale`.
`charts/Histogram.tsx` rebuilds its uPlot instance whenever `buckets`, `series` or `formatValue` changes identity, so the view memoises the first two and takes the formatter from `histogramMath.barFormatter`, which returns one module-level function per choice; `Distributions.test.tsx` asserts all three keep their identity across a selection.
A selection repaints the same instance instead: the draw hook reads the selected bucket from a ref, and `Histogram` hands it to `UPlot` as `redrawKey`, which calls uPlot's `redraw`; `Histogram.test.tsx` asserts the instance survives a `selectedKey` change.
With two groups the chart carries a legend above it, a bar swatch in `--ink` and an outline swatch in `--accent`, each with its group's name, in the order of `series`.
A store with no runs, and a variable no run in the selection has a value for, render `Absent`, the second with the caption still above it.

**RouteDetail** is one route at `/routes/$routeId`, reached from the Records view's Routes section and from the route line on each of its runs.
It has the activity view's shape: the route's reference run as the hero through the shared `components/RouteHero.tsx`, with `BackControl` floating on it, then a title block, then the chart, with the plain, unpinned desktop split of hero left and title block right the activity view had before "The moment" below - not that view's own sticky hero and compact charts, which its `.pinned` and `.besideHero` classes keep to itself; see "The route view composes its layout classes..." below.
The way back falls back to Records, where the Routes list is, and the tab bar marks Records current on any `/routes/` path, since the route view is reached from that tab.
The reference run is the medoid, the run closest to all the others, so its trace is the route's; the title block links to it as `Map from the run on <day>`, because the map is one specific run's.
Direction is measured against the route's earliest run instead, whose id is the route's, so the footnote says Forward and Reverse are relative to the first run on the route.
The title is the route's name, the byline its run count and the days of its first and last run, and the two stats are the record pace, with the record run's day under it, and the median distance.
The chart is `ProgressionScatter` with `kind: 'route'`, handed `RouteDetail.runs` verbatim.
The chart draws its own Forward/Reverse key, and each mark's link names its direction and whether it is a record or ineligible, with the reason, since the readout is hidden from a screen reader; the view adds only the record, eligible and ineligible key and the `Show ineligible runs` toggle, both composed from `Progression.module.css`, and never a second direction key.
The ladder labels a route in bare `m:ss`, so the section's caption leads with `Pace per km.` before the direction of improvement and the counts, which count the analysis layer's flags over the runs on the chart.
An unknown id is a 404 from `queries.route` and renders `No such route` with a link back to Records, since a recompute that regroups the runs can retire an id a link still holds; any other failure is an alert.
When the reference run's grid 404s or fails there is no hero, and the absence or the alert stands in a Route section under the title, with the way back above the title, as on the activity view.

**ActivityDetail** is the deep view: the route trace as a full-bleed hero, then the title block, then the zone distribution, the aerobic decoupling section, four stream panels (pace, heart rate, cadence, elevation), and splits.
Its title is the run's local calendar day, with the time and the place on a quiet byline under it - the place from the derived `locality` and `country`, saying `near` once `locality_distance_m` passes `NEAR_THRESHOLD_M`; the threshold and the tail it exists for are on the constant in `views/ActivityDetail.tsx`, and the resolution itself is `docs/reference/math/places.md`'s.
A run in a route carries one more line under the byline, `Route: Jönköping 7.5 km · 27 runs · 4th fastest`, the whole line a link to the route view.
The name and run count come from the detail's `route` block and the rank is spelled by `format.fastestRankLabel`: `fastest` for rank 1, and nothing at all for an ineligible run, whose `rank` is null.
A run in no route, `route: null`, has no line.
Under the automatic tags and before the record note below, `components/ReclassificationNote.tsx` says when a run is counted as a walk, from the detail's `reclassification` block with both speeds formatted as pace: `Recorded as a run, counted as a walk: its moving pace of m:ss/km is slower than 9:00/km.`, with the run's own pace in place of `m:ss`.
It renders nothing for every other activity.
Under the automatic tags, `components/RecordNote.tsx` says which of the run's best efforts do not count towards records and why, in the dim small type of a tag's reason: `Not counted towards records at 400 m, 1 km: a jump in the recorded distance that the measured speed does not confirm.`
It groups the efforts by the API's own `ineligible_reason`, drops the distance list when one reason covers every effort, as on a treadmill, and adds a line for efforts that count only because the measured speed confirmed a jump, so a fast run missing from the ladder, or an unexpected record, explains itself on the run.
Nothing there decides eligibility: `is_eligible` and `ineligible_reason` are the columns the progression chart reads for the same effort, and the sentences are composed in `components/recordNotes.ts`, kept apart from the component for Fast Refresh.
**The decoupling section always shows the halves beside the number**, `components/Decoupling.tsx`, because the percentage rises when heart rate climbs and also when pace drops and cannot say which.
On a run in the population it reads the number against the 5% line and links to the Trends decoupling chart at `/trends#decoupling`, which the Trends view scrolls to once its three queries settle, since the charts above it load after the router has tried the hash; on any other run with a value the API's `outside_population_reason` replaces that reading as visible text, and on a run with no value the API's `decoupling_absent_reason` renders through `Absent`.
The 5% line is `components/decouplingMath.ts`'s `DURABILITY_REFERENCE_PCT`, which the Trends view imports too, and `durabilityReading` compares at the one decimal `formatDecoupling` displays, so `+5.0%` reads as on the line; it says "Above", "Below" or "On the 5% durability line", the words the Trends chart's key uses.
`charts/Route.tsx` sets its own `aspect-ratio` inline, clamped between square and 1.8:1, rather than taking a fixed 3:2, and that is what makes a hero possible at all: the letterbox *is* the wasted space, so following the route's own shape removes most of it, while the clamp keeps an out-and-back along a straight path from rendering a panel thousands of pixels tall.
Do not pin the hero to a fixed ratio.
A full-width panel at a fixed 3:2 letterboxed the trace and left the rest empty - measured at 1024 px wide, the panel rendered 1024x600 with the trace occupying 440x517, so 584 px sat unused beside it - and that emptiness is exactly what the route and the zone table used to share a row to fill.
They no longer do, as of the 2026-09-13 Strava-look rebuild: the hero has no hole in it, so the zones are their own section again.
The trace fills 79% of the panel's width and 93% of its height on the reference activity, measured at 412 px, against 43% of the width under the fixed ratio.
A run with no trace gets no hero at all - the absence is stated where the route section would be, under the title, rather than in a hero-sized box, because a hero-sized box saying "no GPS route recorded" spends the most valuable block on the screen on the absence of its own subject.
There are two predicates and they answer at different times.
`canHaveRoute` reads the derived layer's own `has_gps` and `is_indoor`, because the decision has to be made before the streams arrive; once they have, `charts/routeMath.ts`'s `hasRoute` decides, and `Route` renders its own `Absent` from **exactly** that predicate, so the view and the chart can never disagree about which state the activity is in.
While the grid is still in flight the hero holds its space as a square placeholder, so nothing reflows under the reader when the trace lands.
`toRuns` and `hasRoute` live in `routeMath.ts` rather than beside the component for the repo's usual reason, and for React Fast Refresh's: a file mixing a component export with plain function exports cannot be refreshed.
**The scale bar is an overlay in the panel's coordinates, not a mark in the trace's.**
It was drawn in user units, which is fine on a small panel and wrong on a hero: the same annotation whose label read at a sensible size in a column rendered at about 21 CSS px once the panel filled the screen.
Its length is still the trace's own scale - `scaleBarWidthFraction` converts a round number of metres into a percentage of the panel - so what it measures is unchanged and only what decides its weight has moved.
Moving it is also what let the hero layer have one gutter: `--hero-inset` is 16 px, the back control reads it directly and the scale bar through `Route.module.css`'s `--route-inset`, where before the control sat at 8 px and the bar at whatever the letterbox happened to be - 48 px on the reference activity, and different on every other route.
**`Route.module.css` carries no `max-height` and must not regain one**, because `scaleBarWidthFraction` assumes the rendered height is the width over the clamped ratio; a cap that bound would leave the bar silently over-stating the distance it names.

**The hero draws `charts/RouteMap.tsx` over a self-hosted basemap for a covered route, and the bare `Route` trace for everything else.**
`components/RouteHero.tsx`, which the route view shares, asks `routeMath.coveringArea` for the one fetched `BasemapArea` from `queries.basemap()` whose box holds every non-null sample; there is no such area until `activity-analysis tiles` has been run at least once, so this is the bare trace for every activity on a store that has never fetched one.
`RouteMap` is a lazy chunk, `lazy(() => import('../charts/RouteMap'))`, because MapLibre is 302 kB gzipped, twice the rest of the app - it should arrive with the first covered route shown, not with every view.
**MapLibre's worker URL is set by hand, once per page and before the first map**, from `import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'` passed to `setWorkerUrl` (`ensureMapGlobals` in `charts/maplibreGlobals.ts`, shared by `RouteMap` and `TerritoryMap` so the protocol and the worker are set once whichever map comes first).
Left to itself, MapLibre 6.11 loads `maplibre-gl-worker.mjs` from beside its own module's `import.meta.url`.
Under `npm run dev` that is Vite's deps cache, which holds no worker and answers 404, and a production build emits no worker, so until 2026-09-24 every map failed before `load` with "Worker failed to load" and every covered route showed the bare trace.
MapLibre starts the worker with `type: 'module'`, so `vite.config.ts` sets `worker.format` to `es` to match, although the default `iife` also loaded the map in dev and in a build when measured on 2026-09-24.
The build emits the worker as `assets/maplibre-gl-worker-<hash>.js`, 509 kB, beside the 1075 kB `RouteMap` chunk, and `build.chunkSizeWarningLimit` is raised to 1200 kB for those two.
The bare trace is doing four jobs at once as a result, and draws identically for each: it is `Suspense`'s own fallback while the chunk loads, a small `RouteMapErrorBoundary`'s fallback if the chunk fails to load at all (a rejected dynamic import is an error thrown during render, which `Suspense` alone does not catch), what `basemap.data` being still pending or having failed falls back to before `RouteMap` is ever reached, and what `RouteMap` itself falls back to on a failed style, sprite or source before its first load, or on no WebGL at all - a single tile failing after that just leaves a hole in the map rather than reverting to the trace.
The Light/Grey switch is a `radiogroup` named `Map style`, appearing only once the map has loaded, and the flavour it remembers persists per browser under `localStorage`'s `activity-analysis:map-flavour` key (`charts/mapStylePreference.ts`), Light by default.
The scale bar reads from two unrelated sources depending on which panel is actually shown: the bare trace's own `scaleBarWidthFraction`, a fraction of the panel from the route's own projected box, and once the map has loaded, `routeMath.mapScaleBar`, a fraction from MapLibre's own metres-per-pixel at the panel's centre latitude and zoom - both feed the same shared `ScaleBar` component, so the two panels draw what looks like one annotation from two different pieces of arithmetic.

**The moment** is an index into the run's 1 Hz grid, or none, and it is the one piece of state the map and all four stream panels share.
It lives in `useMoment`'s own external store rather than component state, read with `useSyncExternalStore`, so a pointer move re-renders only the five components that read it - the four stream panels and the route hero - and never the splits table or the zone bar beside them on the same page.
It takes from two sources: a stream panel's own pointer, on a hover or a horizontal drag, and the replay's animation frame; the pointer wins while it is set, a panel clears it when the pointer leaves, and the moment then falls back to the replay's head if there is one.
`MomentProvider` is keyed on the activity id, because `ActivityDetail` itself does not remount when that id changes underneath it - confirmed by reading `router.tsx`'s route definition and the component's own hooks, neither of which forces a remount - so an unkeyed provider would carry one run's moment into the next.

**The route is coloured by pace**, `charts/paceColour.ts`: each grid second's speed maps to a position on a five-anchor ramp scaled to that run's own 5th-to-95th percentile of moving speed (`paceScaleEnds`/`rampPosition`), and consecutive seconds landing on the same one of 24 ramp steps are merged into one drawn piece (`pacePieces`), each at most `MAX_PIECE_SAMPLES` - 10 s, about 30 m at running pace - so a replay's drawn line never trails its dot by more than one piece.
A paused, an outage, or a speedless second draws in a neutral `--pace-map-stopped` rather than on the ramp.
`RouteMap` and the bare `Route` both take the same pieces from `RouteHero`, so the map and the trace always agree on which piece is which colour; a legend on the map states the ramp and the run's own `v05`/`v95` ends as a pace.

**Replay** plays the run's own moments forward from a button on the hero, at a fixed 60x, 120x or 240x.
`charts/replayTimeline.ts`'s pure `buildTimeline`/`replayTimes`/`headAt` turn the grid's elapsed time into replay seconds: a moving second takes `1 / (120 * k)` s, and a whole paused-or-outage stretch collapses to a flat `STOP_REPLAY_S`, 0.5 s, however long it lasted, so the longest recorded stop in the store, 2620 s, holds the replay still for half a second instead of 22; `headAt` finds a frame's head sample by binary search on the result.
The growing line is drawn on a 2D canvas overlay above the static map (`charts/replayCanvas.ts`).
The coloured route itself is a static GeoJSON source, `route-pace`, one feature per pace piece painted with `['get', 'colour']`, which no frame and no pointer move touches.
The replay was first built on MapLibre's per-piece `feature-state`, toggling each piece's `line-opacity` as the head passed it, on the strength of the measurement below, which was taken over a blank style.
With the real basemap loaded, every feature-state change repainted the whole map: 8.6-15 fps p5 on a production build under SwiftShader, where one repaint of this basemap costs about 50 ms.
The overlay draws only the pieces newly passed each frame, from points projected once per fit; the map's own coloured line is hidden once when a replay starts and restored once when it ends, so the map itself repaints twice a replay rather than every frame.
The bare `Route` trace gets the same treatment for the same reason: its moving dot and its own replay subset render on layers separate from the memoised static SVG, so a frame or a pointer move never re-renders all of the reference run's 1466 polylines.
The budgets below hold with the map loaded and on the bare trace.

**The measurement that first chose `feature-state`**, taken before any of this was built, over four candidates for a growing MapLibre line - headless Chromium, software-rendered (SwiftShader), against the longest real run, over a blank background style, the production build's figures:

| mode | median fps | p5 fps | longest frame |
|---|---|---|---|
| `state` (feature-state) | 59.9 | 59.9 | 650.0 ms |
| `filter` (`setFilter` by index) | 12.0 | 8.6 | 1866.6 ms |
| `setdata` (a growing source via `setData`) | 8.6 | 6.7 | 2483.2 ms |
| `gradient` (`line-gradient` paint property) | 10.0 | 5.5 | 2449.9 ms |

Only `state` reached the 50 fps budget, pinned at the rAF/vsync ceiling at the median and the 5th percentile, though its longest frame still ran 650 ms in the build and 1216.6 ms in the dev server; the other three held 12 fps median or less.
Over the real basemap that ranking stopped mattering, since any per-frame change to the map's own style cost a full repaint, and the replay moved to the canvas overlay described above.

**The budgets**, measured by `web/scripts/measure-moment.mjs` (its header has the commands) against one real outdoor run on a production build under SwiftShader, on 2026-09-28, the pointer and scroll rows over three runs:

| budget | measured | target |
|---|---|---|
| replay over the loaded map | p5 59.9 fps, longest frame 16.8 ms | p5 >= 50 fps |
| replay over the bare trace (`/api/basemap` failed) | p5 59.9 fps, longest frame 33.3 ms | p5 >= 50 fps |
| (a) a pointer move's own work, dispatch to DOM update complete | p90 5.2-9.4 ms | p90 <= 16 ms |
| (b) a real pointer sweep across the pace chart, at display rate | p5 59.5-59.9 fps | p5 >= 50 fps |
| phone scroll, 60 wheel steps down to the splits at 390x844 | p5 59.5 fps, median 59.9 fps | p5 >= 50 fps |

The phone scroll held p5 59.5 fps and median 59.9 fps on a second real run too, over three runs measured the same way outside the script.
Every budget also holds at ultra length: on 2026-10-16 the demo store's 12 hour run, 42 678 samples (`docs/reference/demo-store.md`), measured replay p5 59.9 fps over the map and 59.5 over the bare trace, (a) p90 7.3-8.9 ms, (b) p5 59.5-59.7 fps and phone scroll p5 59.5-59.9 fps, the same script and build served by `activity-analysis serve` with `MEASURE_BASE_URL` and `MEASURE_RUN`.
The replay is pressed once the page has settled: once the map has loaded, the network is idle and 60 frames in a row have each come within 34 ms.
Pressed sooner, the replay's window catches the page's own load: the map's first style, tile and paint work, frames of 633-1683 ms either side of the press, and on the bare trace one frame about 1.0 s after navigation, with no replay pressed at all.
That frame is Chrome's compositor teardown waiting on a SwiftShader GPU flush, and it predates this view: a production-build A/B of eight loads each measured it at 450-2100 ms with the activity moment and 317-1167 ms on `b4369e2` before it, about 200 ms longer with it.
Earlier runs of this script, which pressed Replay as soon as its button appeared, recorded single frames of 983 and 1033 ms at the replay's start; a replay on a settled page has no frame over 40 ms.
A same-script comparison against `e154de7`, the commit before the compact layout, the tag popover and the pinned hero, found no regression - if anything the per-move work came in slightly cheaper (p90 5.8-11.0 ms there) once the panels were shallower.
A CDP mouse-move-to-next-frame measurement was tried first and read 34-50 ms, which is Chrome's own input-to-`requestAnimationFrame` alignment plus a paint frame, about two frames on any page regardless of its own work; it is kept as informational context rather than a budget, since it does not isolate what this application does per move.

**Hovering a stream panel** reads the pointer from native `pointermove`/`pointerleave` events on `chart.over`, not uPlot's own `setCursor` hook - see the trap below - and a phone's press-and-drag reads the same way from `pointerdown`/`pointermove`/`pointerup`, with `touch-action: pan-y` keeping a vertical swipe scrolling the page.
A touch sets the moment only once its sideways travel from `pointerdown` exceeds its vertical travel by `TOUCH_SIDEWAYS_SLOP_PX` (4 px), so a plain tap picks nothing and a scroll swipe that starts on a chart neither sets the moment nor pauses a playing replay.
Each panel's heading swaps its average for the value at the moment, `stopped` for a paused or outage second and the no-value glyph for a null one outside a stop, all `aria-hidden` for the reason `VolumeBars`' own readout gives.
The heading row keeps one height whatever its legend holds, the average, a value or nothing (see `.legend` in `StreamPanel.module.css`): it stood 3.8 px taller showing the average, so a hover moved every chart below the hovered one, and a pointer near a plot's bottom edge crossed it and back on each move.
**A panel's dashed line is the mean of the trace it is drawn over**, `streamPanelMath.ts`'s `traceMean` over the seconds `maskSeries` leaves, not the summary's average beside the header.
On the pace panel the two differ on almost every run: the header's Pace is the run's distance over its moving time and the trace is the watch's speed reading, which adds up to a median 2.0% less ground outdoors, so the line and the trace's own mean formatted to different paces on 240 of 242 outdoor runs, a median 7.5 s/km apart, with the line the faster on 235.
`paceLineNote` builds the sentence under the pace panel that names both distances, shown only when the two paces format differently; it is visible text because it is what reconciles the two numbers on the page.
On the desktop stack the note's measured height (`useElementHeight`, `--pace-note-height`) comes out of the four plots' shared height, so the stack still fits one screen.
A pointer arriving on a chart pauses a playing replay at its head; one already resting on a chart when Replay is pressed from the keyboard does not, until it leaves and comes back.
A drag across a chart does nothing more than a hover: uPlot's default drag zoom is off (`cursor.drag`), since it zoomed the one chart dragged across while the stacked desktop charts share the bottom chart's time axis.

**Desktop layout, from 60rem wide:** the hero is `position: sticky` in a left column, capped at the viewport height less its own gutters (`--hero-max-height`), while the title block, the zones, the four stream panels and the splits scroll together in a right column, one flex column rather than each section in its own grid row - a `grid-row: 1 / span 20` was tried first and measured 416 px of blank page below the splits at 1280x800, thirteen empty implicit rows' worth of the grid's own row gap.
The four stream panels compact to fit beside the pinned hero on one screen, so hovering any one shows every channel and the dot at once: only the bottom charted panel draws a time axis and its `Elapsed time` title (`StreamPanel`'s `timeAxis` prop), the three above it keep their vertical grid but no axis space, and each plot is `(viewport height - gutters - 4 x 64px section furniture - 3 x 16px gaps - each chart's own non-plot space) / 4`, clamped between 40 and 120 px, the plot a full-height 200 px panel has.
Measured on a run of the athlete's most-run loop: 60, 80 and 105 px plots at 720, 800 and 900 px tall, reaching the 120 px ceiling from 960 px up, and 48, 68 and 93 px, reaching it from about 1010 px, once the pace panel's note (above) takes its 32 px and the section gap out of the shared height; the 40 px floor was set by checking that every one of the 324 running activities in the store keeps at least two pace labels from a 32 px plot up.
On a phone the hero stays `position: sticky` at the top and collapses from its natural height to about a third of the viewport as the page scrolls, scaled with a CSS transform rather than resized, so the map's own layout size never changes and it is never refitted; the height the picture loses is given back as the hero box's own margin, so the page's geometry never moves under the reader's scroll and the map style switch, itself counter-scaled, keeps its size and place in the hero's corner throughout.
The collapse counts from the hero's resting top in the document, not from the top of the page, since a notice above the hero puts it 60 px down: counted from the top, the hero shrank for those 60 px before it stuck, and the gap under it grew by as much.
`useHeroCollapse.ts` measures that top from the hero's parent, because a sticky box's own rectangle and `offsetTop` report where it is stuck, and only when the picture, the window or the document changes size.
The page's `scroll-padding-top` is the collapsed hero's height, a third of `100dvh`, so a control focused or scrolled to while it sits under the sticky hero is brought out below it (WCAG 2.4.11).
An activity with no hero, or the route view (see above), keeps the earlier single, unpinned layout.

**Every badge - the effort tag and each flag - now sits on one wrapping row** (`components/Tag.tsx`), rather than the effort's own line and a separate flag list beneath it.
Each badge's reason - previously a visible caption under it - stays in the DOM as a `role="tooltip"` popover, read at rest through `aria-describedby` and shown on a hover, on a keyboard `:focus-visible` focus (with a same-task self-expiring `pointerdown` fallback where the engine has no `:focus-visible` support to read at all, confirmed to answer differently in jsdom), or a tap on touch.
Hover follows `pointerenter`/`pointerleave` and ignores a touch pointer, because a touch browser's compatibility mouse events leave an emulated mouse over the badge after a tap, which held the popover open against a second tap.
A hover popover has to satisfy WCAG 1.4.13's Dismissible and Hoverable criteria: `Escape` hides a hover- or focus-shown popover without moving focus off its badge, and a `HOVER_CLOSE_GRACE_MS` (200 ms) grace period on the badge's and the popover's own `pointerleave` lets the pointer travel from one onto the other without the popover closing first.
`components/tagMath.ts`'s `clampPopoverLeft` keeps it inside the page gutter, read as `<main>`'s own resolved `paddingLeft` (`pageGutterPx`) rather than parsed off the declared `--gutter` custom property, which handed back the literal string `1.5rem` rather than a usable pixel value.
Measured on the reference activity, moving the reasoning off the visible page took the title block from 398 to 293 px on a phone and from 323 to 293 px on desktop.

**The hero reaches the top of the scroll when nothing is above it**, cancelling `AppShell`'s own `.main` top padding, and sits below the staleness strip when there is one - `main > *:first-child .detail > .hero:first-child` is that condition, since `AppShell` renders its notices and its content wrapper as siblings and only the wrapper contains a `.detail`.
The route view composes its layout classes from `ActivityDetail.module.css` rather than restating them, so its `.route` carries `.detail` and the rule, the hero's placement and the title block - but not `.pinned` or `.besideHero`, added for "The moment" above and reaching the activity view alone, so the route view keeps the plain, unpinned two-column grid this screen had before that work, its hero on the left scrolling away with the page rather than staying in view.
A blind critic reading this screen against the reference named the strip of page colour that used to sit above the hero as the one thing on it that read as a web page rather than an app.
The effort tag beneath the title carries no card, and the slot is where the reference draws one: its card is +27 of 255 off its own page and there are only 22 steps between `--page` and white, so the light-mode version measured a 3% fill delta - the same unseeable box the Overview's stat cards were deleted for.
The six stats are two rows of three thirds, which is the case `Stat`'s `share` prop was built for: no empty cell, both rows gutter to gutter, and the same arrangement `StatGroup` gives the Overview rather than a second one.
**A view does not get to re-lay out a shared primitive by accident**: `align-items: flex-start` on the header silently shrink-wrapped `StatGroup` and collapsed its six-track grid to the width of its own text, packing three stats into the left 45% of a desktop column, and it looked correct at phone width so it survived two rounds.
The header stretches now, and the two children that genuinely are their own size say so themselves.
The way back is `components/BackControl.tsx`, shared with the route view: a round icon control that floats over the hero, and the same control in the flow above the title when there is none.
Elevation is a panel rather than only a per-split column as of 2026-09-03, drawn as a filled area because what a reader wants off it is the shape of the ground.
Its axis is never zero-anchored - altitude is a position on a scale with an arbitrary origin, not a magnitude from zero, and the reference activity's 24.6 m band is a flat line on a sea-level axis.
**Nor is it ever narrower than `MIN_ELEVATION_BAND_M`**, which is a floor on the whole range rather than a special case for the run whose altitude never moves at all.
Guarding only the degenerate zero-width band left every merely-narrow one to round its own gridlines into the same number, because the non-pace axis renders a tick as `String(Math.round(s))`: three real activities have an altitude band under 3 m, and measured in Chromium at this panel's 142 CSS px plot height, one activity's 0.6 m band drew four labels of which three were the same whole number, while a 1.0 m band drew three labels of which two were.
Widening rather than formatting the ticks to more precision is the semantic choice as well as the cheaper one: a run whose altitude moved 0.6 m should *look* like a run whose altitude did not move, and spreading 0.6 m of barometric jitter over a full panel height would amplify noise into apparent terrain - the pace axis's zero-anchoring argument running the other way, crop to the data unless cropping misrepresents it.
The floor is taken as the wider of the padded band and itself, about the data's own midpoint, so nothing steps where the two meet: an 8.5 m band pads to 10.2 m and is returned untouched.

**A filled series states its own baseline, because uPlot's default one is the literal value 0 and no channel here measures from zero.**
`seriesFillTo` returns 0 for a linear scale with no band, so the elevation fill closed at the 0 m gridline rather than at the panel floor - and that is the same arbitrary-origin fact that keeps the axis from being zero-anchored, applied to the rendering instead of the range.
It is not an edge case: 122017 samples across 143 activities sit below sea level, one activity's whole range is below zero, and another's straddles it.
Measured in Chromium by sampling the painted column at 75% across the plot: under the default, the entirely-negative band painted 129 rows *above* the trace and none below - the sky filled instead of the ground, inverted terrain on a panel whose reason for existing is that a fill reads as terrain - and the straddling band painted 109 above.
With `fillTo` reading the y scale's own resolved minimum, both paint below the trace only.
A positive range was unaffected either way, which is why this went unseen: its baseline falls below the plot and is clipped to the floor, so the reference activity renders correctly by luck under both.
`fillTo` travels with the fill rather than being set for elevation by name, so the next channel to opt into one cannot inherit the default.
It is also the one panel with no average line: a mean altitude is not a quantity anybody trains against, and ascent is already in the stat rail.
The control is a `history.back()` named `Back` when `router.history.canGoBack()`, because that is the only affordance that restores the filtered list the reader came from, and a link named after its fallback otherwise: `Back to activities` here, `Back to Records` on the route view.
The history-back names no place because it goes wherever the reader came from, and an activity is also opened from Records, Progression and a route's chart.
The detail URL is plain and shareable, so on a fresh tab, a bookmark, a pasted link or a reload it is the first entry in the session and `back()` would either do nothing or leave the application.
`derived` and the 1 Hz grid are fetched independently and can each be absent on their own.
A non-running activity has no `derived` block at all, and a running one not yet recomputed has `derived` but 404s on `/streams`.
Every absence is stated in place via `components/Absent.tsx` rather than leaving a blank panel: absence is ordinary, since a treadmill run has no route, an early run may have no heart rate and even a run with heart rate has null samples, so it is stated rather than hidden.
Every chart primitive in `charts/` (`StreamPanel`, `ZoneBar`, `Route`) renders its own empty state through `Absent` too, for the same reason: one wording, one `role="note"`, rather than each chart inventing its own bordered-or-not, announced-or-not div.
Three states are deliberately outside `Absent`: `Activities.tsx`'s and `Overview.tsx`'s own "this store has no activities in it yet" landing states, and `Activities.tsx`'s "this page starts past the end of the results" state.
None is the absence of one panel's data - each speaks for the whole page - and each carries a call to action a generic `reason` string has no place for: the `ingest` command for the first two, a control back to page one for the third.

**Territory** is the ground every outdoor loop has claimed, at `/territory`, from `GET /api/territory`; the rules are `docs/reference/math/territory.md`'s and the view computes nothing but km² for display (`format.areaMeasure`).
On a desktop it is the activity view's two columns, on a phone the map leads (below); the total is `components/TerritoryReadout.tsx`: an eyebrow over the value at `--text-display`, the Progression view's personal-best shape, one sentence under it on how the total grew, and a `StatGroup` of three thirds for the claiming runs, the loops out of every outdoor run, and the places.
The sentence is what the last claim's local year added, the difference of two stored `cumulative_m2`, and the latest gain of at least 0.005 km², because the last real claim added a few square metres and would read `0.00 km²` (`charts/territoryGrowthMath.ts`).
On a desktop, `DESKTOP_LAYOUT_QUERY`, the map is the left three fifths, pinned as the activity view pins its route and as tall as the window less the Growth section under it, so at 1440x900 the map, the chart's date axis, the total and every place are on the first screen.
That section is the phone's own Growth `Section`, title, note and key alike, undivided because it sits in the map's column: the chart is titled one way at both widths, rather than under an uppercase eyebrow that repeated the total's.
The right column, first in the document, holds the title, the total with the "What counts, and why" rules under its counts, and a divided `Places` section: one radio row per region, largest first, with a bar of its ground against the largest's (the Overview's zone rows' track and fill) and its km², the chosen row in the navigation rail's accent tint with a second line of country, runs and the local days of its first and last claim.
A single region has no list; its section is titled with its name and notes its ground, runs and days.
On a phone the place is the screen's hero instead, the activity view's shape: the map first, full bleed and reaching the top of the scroll when no notice stands above it, as tall as the screen less the tab bar and 10rem, then the place's name with its runs and days, and its ground at `--text-stat-lg` beside them over the whole total (the place's km² over `of` and the total's km²), so the phone's first screen says how much there is; then the title and the total under a `Section` rule, with a spark of the growth in the room the number leaves, then a divided Growth section with the chart and the rules.
Under 430 px of figures the map had half the phone's height and the city part drew about 330 px wide; as the hero it is 716 px tall at 430x932 and the city part spans 400 px.
On a phone the pills, composed from the Progression view's distance picker with the `Place` legend visually hidden, float over the map's top edge, raised on the float shadow like the map's switch; `--map-overlay-top`, 60px on the map's frame, is the band they cover, and the map keeps its fitted ground and its Light/Grey switch below it.
The row's block padding is room for that shadow: the row scrolls and so clips, and a tighter row cut the shadow in a line across the map.
The chosen region is `?region=` in the URL (`api/territorySearch.ts`), written with `replace`; it is optional because the default, the largest, is known only from the payload, and an id a recompute retired falls back to the largest.
`charts/TerritoryGrowth.tsx` steps the total after each claiming run over local time, zero-anchored on `VolumeBars`' three-rule ladder, ends on a dot at the total, and names the hovered run's day and place; the readout moves to the plot's foot for a total in the upper half of the scale, where a readout at the head would cover the line.
The chosen place's runs are ticks at the plot's foot (`markedRegionId`, repainted through `UPlot`'s `redrawKey` rather than a rebuilt chart), keyed `143 runs in Jönköping` right-aligned on the Growth heading's line (`Section`'s `aside`), as the activity view's Pace heading carries its average, so choosing a smaller place shows its 19 runs, 18 of them in three short stretches; clicking the plot chooses the hovered run's place (`onSelectRegion`), and the place list is the keyboard's way to the same choice.
The rules, `TerritoryRules`, state the closure and sliver widths from the payload's own `closure_max_m` and `sliver_radius_m`.

`TerritoryMap` is a lazy chunk like `RouteMap`, and unlike it the reader can pan and zoom it, with cooperative gestures so a scrolling page is never caught by the map, and no rotation.
It opens on the region's core, `territoryLayers.claimCore`: the largest part's box, taking in every part within a quarter of the box's longer side that holds at least 5% of the ground already in it, growing as parts join, or the region's own box when the core holds under half the region's ground.
The 5% keeps the largest region's small outlying part, 1.9 km from the city part, from widening a 9 km box to 11 km.
A region's box runs to its farthest part: the largest region's is 19.9 by 13.4 km round a 9 by 8.4 km city part, and fitted whole the city drew under a 5 km scale bar on a phone, too small to tell a claimed street from an unclaimed one; its core opens under a 2 km bar.
Its control group is MapLibre's zoom buttons with a third under them that fits the whole of the chosen region, its outlying parts included, and every fit leaves that column clear on the right so a region's ground never lies under the buttons.
On a panel at least 1.25 times taller than wide, the phone's hero, a region is fitted by its width, so the fit clears the buttons and the attribution (148 px) below the ground and the switch (44 px) above it instead, with 3.5% of the width at the sides.
A region's box can span several fetched basemap areas, the largest region's spans two, so its style is `basemapStyle.buildAreasStyle`: one `pmtiles` source per area the box meets (`territoryMath.areasMeetingBox`), Protomaps' layers repeated per source and interleaved layer by layer, and `--panel` as the background wherever the map runs past every area.
With no area fetched the style is that background alone, and the ground still draws on it.
A fitted view runs past its areas' boxes, which left blocks of bare `--panel` in the largest region's frame, so `territoryLayers.withCoarseUnderlay` reads the same archives again as sources capped at zooms 0, 3, 6 and 9, land, water and main roads only, under every detailed layer: a low zoom tile is far larger than the box it was fetched for.
Those sources take the whole world as their bounds, because MapLibre 6 splits an overzoomed tile into tiles at the view's own zoom and checks each against the source's bounds, and an archive's own box would refuse every tile outside it.
A region needing other areas swaps the style with `diff: false`, as the Light/Grey switch does, and every `style.load` adds the territory again, placed by `territoryLayers.territoryAnchors`.
The map opens in the Light flavour, matching the route hero, and its flavour is remembered apart from the route hero's choice (`charts/territoryFlavour.ts`); Light as the default is decided (the maintainer, 2026-10-03).
In Light, saturated water and woods compete with the pink fill and its edge, and in Grey the accent is the only colour on the map.
The claimed ground is `--accent` at 44% over a `--raised` knockout at 88%, so it is one pink whatever land cover it lies on, and buildings, roads and names are drawn over it; the tint alone mixed to grey-brown over the light flavour's forest green.
In Grey the knockout and the tint are over the last detailed water (`territoryAnchors`' `tintBefore`), so a lake in the ground is the ground's one tone: with the knockout under the water it was a deeper pink patch, which a critic read as ground claimed twice.
In Light both are under the first water (`groundBefore`), so a lake keeps Light's cyan.
The unclaimed ground is veiled in `--raised` at 50% to 40% by zoom in Grey and 34% to 26% in Light, a MultiPolygon of the world less the parts with every unclaimed hole put back (`territoryLayers.unclaimedGround`), and the edge is a 1.75 to 3 px `--accent` line on a `--raised` casing; the veil and the edge sit under the first label.
Zoomed out until a place's ground is under 36 px, each place becomes a marker, a raised pill with its name and ground that chooses it, and a marker whose name would overlap a larger place's shows its dot alone (`territoryLayers.placeMarks`).

The phone tab bar shows four tabs and More, which opens a sheet over the bar holding Progression, Distributions and Territory; the desktop rail shows all seven.
Seven labels do not fit a 360 px bar at a readable size: six already needed 8 px side padding, `--text-tab` at 10 px and two columns widened past their share (`components/TabBar.module.css`).
The three links are one set at both widths, `display: none` on a phone until More opens them and `display: contents` in the rail, so the DOM order is the reading order everywhere.

## The shared primitives, and how a new screen uses them

Every screen uses at least one of the six small components in `components/` described here, and a new one should reach for these before writing markup of its own.
They exist because the same shape was being rebuilt per view: the badge had three copies before `Badge` and the stat block had one per screen before `Stat`.
Each of the first four has its own unit test, and none of the six formats anything - everything passed in has already been through `src/format`.

**`Stat` and `StatGroup` (`components/Stat.tsx`)** are a label over a value, and the grid they sit in.
`StatGroup` is the `<dl>`; `Stat` is one `<dt>` plus one or two `<dd>`s inside a wrapping `<div>`, which is the only shape a `<dl>` group may take, and a `<dd>` plus a `<p>` is not that - some browsers reparent or drop it.
A `Stat` must be a child of a `StatGroup`.
`share` decides the cell - `third` by default, then `two-thirds`, `half` and `full`.
**Thirds and halves do not share their interior edges**, only a row's outer ones, so a group that mixes them lands the same component on a different column in each row and reads as two grids stacked; `two-thirds` exists so a wide cell can fill a row beside a third while every cell stays on one of the three column edges the rest of the screen aligns to.
`value` takes either a `Measure` from `src/format`, which keeps the unit apart so it gets its own element, or a bare string for a value with no unit to separate; to add a formatter that feeds it, return a `Measure` and make the existing string formatter `measureText` over it, the way `distance` is `measureText(distanceMeasure(...))`, which keeps one implementation per conversion.
`detail` is the optional quiet third line.
**There is no card** - no fill, no border, no radius, no padding - and a screen that wants one changes this file rather than overriding it locally.
The value is set in `proportional-nums` on purpose: a stat value is a headline number rather than a column entry, and tabular figures buy alignment at the cost of fitting, which is the wrong trade when nothing is being aligned.
`.mono` in `theme/global.css` is still right for a column of times.
The caption line is reserved per *group*, not per stat: `StatGroup` looks at its own children for a `detail`, and where one has it every stat in that group holds the line open so two cells in a row stay the same object.
A group in which nothing carries a caption reserves nothing and sets its rows 16 px apart instead of 8, which is what the activity detail screen and the activity feed card both want.
Reserving per stat instead cost the detail screen 16 px on every row pitch and left 21 px of dead space above the rule under it, and made the feed card state its own spacing from `Activities.module.css`; that override is gone and **no screen overrides `Stat` locally now** - a screen that genuinely needs different spacing gets a prop on `Stat`, not a rule reaching into its element structure.

**`Section` (`components/Section.tsx`)** is a `<section>`, the `<h2>` the view needs anyway, an optional caption-sized `note`, and the children.
`note` is a caption rather than a heading; an `<h3>` there would put a caption into the document outline.
An optional `aside` is a key to what the block draws, right-aligned on the title's line and wrapping under it when the line is too narrow, `StreamPanel`'s heading row; Territory's Growth section keys its run ticks there.
An optional `id` is an anchor another page links into, set only where something does: the Trends decoupling section's `decoupling`, which the activity page links to.
`divided` draws the full-bleed rule **above** the section, so set it on every section after the first: the rule belongs to the section under it, and adding or removing a section then never makes a neighbour wrong.
The rule is a `::before` positioned to `--bleed` on both sides, so it reaches past the shell's gutter without the section's children having to add the gutter back.
`views/ActivityDetail.tsx` cannot use the component, because every section there is a named region carrying `aria-labelledby`, so it does `composes: divided from '../components/Section.module.css'` instead - share the rule rather than restating it.

**`RowList` and `Row` (`components/RowList.tsx`)** are a grouped list: `RowList` renders the `<section>`, the full-bleed uppercase band as its `<h2>`, and the `<ol>`; `Row` renders one `<li>` with a required `label` and `value`, and optional `meta`, `detail` and `link`.
`link` is TanStack's own `LinkProps` spread onto a `<Link>`, and without it the row renders as a `<span>` and draws **no chevron** - the chevron means the row goes somewhere, and a row that goes nowhere must not have one.
`meta` is a `ReactNode[]` rather than a string, because the component interleaves the `aria-hidden` middots itself so no caller composes punctuation into a value.
It is positional: slot two is the date on every row of a list, and a row with nothing to say in one slot passes `null` there rather than dropping the entry and shifting every later fragment left, so the desktop grid keeps the empty cell and the columns stay aligned down the page.
An empty slot draws no fragment and no separator on either side of itself; **`NO_VALUE` is not an empty slot**, because "– bpm" says the heart rate is missing, which is a fact about the effort and keeps its middots.
Two rules for a caller: keep `meta` to the same number of fragments on every row of one list, or the desktop columns will not line up, and keep each fragment short enough not to wrap at the width it is drawn at.
Above 60rem the row flattens to one line, but only `grid-template-areas` changes - the DOM order, the reading order and the accessible name are identical at both widths, which is what anything selecting inside a row can rely on.

**`Badge` (`components/Badge.tsx`)** is a token-only pill in one of two tones, and it replaced three copies of the same thing.
The tones split on meaning rather than on variety: `accent` for something to notice - a record, an effort tag - and `quiet` for a caveat about the data, such as a treadmill run having no GPS and an uncalibrated distance.
The record badge is `--accent` rather than `--series-5`, because spending an entry of a fixed-order, CVD-validated categorical palette on interface chrome is how that order stops meaning anything.
It uppercases nothing: the list it replaced had to fight its own `text-transform` back off with a local `text-transform: none` so that `400m` did not render as `400M`.

**`RouteHero` (`components/RouteHero.tsx`)** is a route as a screen's hero: the region, named from a visually hidden `Route` heading, the picture, and a square placeholder while `trace` is `null`.
The picture is `RouteMap` over a covering basemap area and the bare `Route` otherwise, with the lazy chunk, `Suspense` and the error boundary that make the bare trace every fallback.
It owns the band's surface - `--raised`, `overflow: hidden` and `--hero-inset` - and takes the screen's placement through `className`: the bleed, the desktop grid cell and the top reclaim depend on what else is on the screen.
`children` float over the picture, which is where both views put their way back.
The activity view and the route view both render it, and it is tested through those two views' tests rather than its own.
Its pending text is `Loading the map…`, apart from the route view's page-level `Loading the route…`, so a reader can tell which of the two is still in flight.

**`BackControl` (`components/BackControl.tsx`)** is the deep views' way back: a history-back named `Back` when there is history behind the view, and otherwise a link to `fallbackTo` named `fallbackLabel`.
`floating` sets it on `RouteHero`'s `--hero-inset`, and without it the control stands in the flow above the title.
Like `RouteHero`, it is tested through the activity view's and the route view's tests.

## Where the arithmetic lives, and why it lives there

Every SI-to-human conversion - pace, duration, distance, local wall clock - is `src/format/index.ts`, pure and independently unit-tested, and it is the only place any of those conversions happens.
A component never formats a *value it displays* inline; a view or a table cell calls into `format/` the same way it calls into the generated API client, because both are conversions across a boundary the component itself should not own.
The one standing exception is `ZoneBar.tsx`'s `edgesLabel`, which composes a zone's boundary pair inline: it describes a *range*, not a single displayed value, and `format/` has no range form yet, so there is nothing to call into.
The unit moved to that table's own column header when the bar became rows, so the label is now a bare `145-166` rather than three repetitions of ` bpm` down a column.

The chart-specific math is kept out of the chart components for the same reason `queries.ts` is kept out of the views.
`charts/streamPanelMath.ts` (pace axis placement, the zero-anchor decision, pause-band geometry, the trace mean a panel's line is drawn at and the pace note's sentence), `charts/volumeBarsMath.ts` (the hover readout's period heading and its clamp, and the Full history chart's trailing average and the week it ends on), `charts/trendChartMath.ts` (aligning several series onto one calendar axis, the never-zero y ladder whose bounds *are* its ticks, the x pad solved from the plot's own width, month, year and whole-day tick placement), `charts/progressionMath.ts` (the inverted time axis, the staircase, round time ticks, the hover readout's above-or-below flip, and the paint order that puts records last), `charts/routeMath.ts` (the runs a trace breaks into, whether there is a trace at all, and the scale bar's length as a fraction of the panel), `charts/distributionVariables.ts` (the fifteen Distributions variables: each one's reader from a run into bucket space, its bucket width and open edges, its labels, and the value formatter the caption and the bucket list use), `charts/histogramMath.ts` (buckets over every run, assignment with open edges, totals per bar measure, shares, medians and their tick positions, the captions, the bucket list's headings and rows, the whole-number y ladder for run counts, and the histogram's label thinning and outline geometry), `charts/paceColour.ts` (a run's own 5th-to-95th percentile speed ends, a second's position on the ramp, and merging consecutive seconds of one ramp step into one drawn piece), `charts/replayTimeline.ts` (the replay clock: a moving second's real time at each speed, a stop compressed to a flat half second however long it lasted, and the head lookup by binary search), `charts/trendsFindings.ts` (the figures the Trends prose states about the viewer's history: medians, a ratio and its spread, the pairing with Garmin's days, and least squares trends with their standard errors, each with its minimum sample), `components/decouplingMath.ts` (the 5% durability line and a run's reading against it) and `components/splitsMath.ts` (per-kilometre splits from the grid, lap role classification from `rep_pattern`, pace-bar scaling) are plain, pure modules a chart component imports rather than inlines.
`api/distributionSearch.ts` is not one of them: it is URL state, like `api/activitySearch.ts` and `api/progressionSearch.ts`, and the router and `views/Distributions.tsx` import it for the validator, the periods as half-open ranges of local dates, the compared groups, and the rules `applySearchChange` applies on top of the validator.
The over-time charts plot a *fractional local calendar day* on x (`format.localCalendarTime`, days since the epoch in the athlete's own wall clock, with the time of day as the fraction) rather than an epoch instant, so a run at 23:30 local lands on the day the athlete saw and the axis ticks are the same on every machine.
The fraction is what keeps two runs on one day as two points; `format.localCalendarDay` is the whole-day form, and `format.calendarDayLabel`, `monthYearLabel`, `dayMonthLabel` and `yearLabel` read a whole day number back, so a readout floors the coordinate before labelling it.
`format.raceModelLabel` and `format.formatPredictionSpan` belong to the prediction table.
`format.effortTagLabel` is the classifier's tag-to-word map, shared by the trends view's filter and `components/Tag.tsx`'s badge.
`charts/canvasPixels.ts` is the smallest of them and belongs to no one chart: it is the CSS-pixel-to-canvas-pixel conversion every hook that draws by hand needs, which is `StreamPanel`'s two dash patterns, `VolumeBars`' empty-period marker and `TrendChart`'s strip ladder, dashed reference line and latest-point marker today.
It sits beside `charts/cssVar.ts` for the reason that file exists - a canvas runs neither the CSS cascade nor uPlot's own internal `pxRatio` scaling, so anything expressed in CSS terms has to be resolved for it explicitly - and living there rather than inside one chart's math module is what stops the next hand-drawing chart importing from a neighbour's private module or copying it.
Two reasons, both load-bearing: a file mixing a component export with plain function exports cannot be Fast-Refreshed by Vite, and pure math is testable directly, with a synthetic fixture and a known analytic answer, the same discipline `CLAUDE.md` asks of the backend's `analysis/` layer.
`charts/UPlot.tsx` is deliberately the *only* file that constructs or destroys a uPlot instance: construct once per `options` identity, push data changes through `setData`, repaint through `redraw` when the caller's `redrawKey` changes, hand the instance out through `onChart`, and watch the container with a `ResizeObserver` uPlot does not provide itself.
Every other chart component hands it a data array and an options object, and optionally `redrawKey` and `onChart`; `StreamPanel` is the one that takes the instance, for `setCursor`, `valToPos`, `posToIdx` and its pointer listeners on `chart.over`.

## Tokens and palette

`theme/tokens.css` is the one file with colour values in it; everything else reads a `var(--token)`.
Two of those token groups are validated, not chosen by eye, and must not be reordered or re-derived from a screenshot:

- `--series-1` through `--series-5` are the categorical palette, in a **fixed order**. Reordering them is a real regression, because the order is part of what was checked for CVD separation - an earlier ordering failed deutan separation.
- `--zone-1` through `--zone-5` are a **sequential** ramp, not the categorical palette. Heart rate zones are ordinal, and using the categorical set for them was the original mistake this ramp replaced.
- `--pace-1` through `--pace-3` are a **sequential** ramp too, for the three reference paces, light for the slow reference through dark for the fast. Same argument: the paces are ordinal, and the categorical set was what made them the original mistake here.
- `--pace-map-1` through `--pace-map-5` are a third sequential ramp, for the route's own pace colouring on the map and the bare trace, unrelated to `--pace-1` through `--pace-3` despite the name.
  The maintainer chose Garmin's own scheme over two proposed alternatives: blue `#2563eb`, teal `#00799a`, green `#15803d`, gold `#b8860b`, red `#b91c1c`, with the steps between anchors interpolated in OKLab.

The first two were validated by measurement when they were chosen, not by eye.
The pace ramp is validated **in the repository**, by `src/theme/rampContrast.test.ts`, which reads `tokens.css` itself and checks the three properties the ramp exists to have: strictly decreasing luminance, at least 3:1 against **both** `--page` and `--panel`, and adjacent steps still separated under deutan and protan simulation.
A colour that fails one of those is changed; the thresholds are the point of the test and are not moved to fit a swatch.
The first candidate ramp failed the contrast bar at 1.99:1 and was darkened until it passed, which is the loop that file exists to force.
**Both surfaces, because measuring against one of them is how the bar came to pass while the property failed.**
The bar was first taken against `--panel` alone, and a trend chart is never drawn on `--panel`: `.chart`, `.section`, `.trends` and `AppShell`'s `.main` all paint no background, so the only surface in that ancestry is `body { background: var(--page) }`.
`--pace-1` measured 3.18:1 against the panel it was checked against and 2.98:1 against the page it was actually stroked on, so the test passed and the ramp failed; it was darkened from `#4d92ad` to `#478aa4`, which reads 3.30:1 and 3.53:1.
Checking both makes the bar independent of where the ramp is used next, which is the property that was missing, and `--page` is the darker of the two and so the binding one for a dark step.
A contributor who needs a sixth series or a finer zone gradient should read the validation method there rather than picking a colour that merely looks right next to its neighbours.

`--pace-map-1` through `--pace-map-5` are validated the same way, in the same file's own describe block, against the two properties that follow from where the route line is drawn rather than the reference ramp's three: at least 3:1 against `--raised`, the white casing under the line on the map and the band the bare trace sits on, and adjacent anchors still separated under deutan and protan simulation.
Garmin's own scheme is a real risk on the second property, because green and red are the pair deuteranopia merges: a plain blue-teal-green-red ramp, with green sitting straight next to red, separated its worst adjacent pair by 40.35 against the test's threshold of 40 - inside rounding of a real failure, not a margin anyone should ship on.
The gold step between green and red widens that to 54, which is why the ramp anchors on five colours rather than three.

`--chart-rule` is the gridline colour, separate from `--grid` because a rule inside a plot and a border between two pieces of interface are different jobs at different contrasts.
`VolumeBars`, `TrendChart` and `ProgressionScatter` read it.
`charts/StreamPanel.tsx` deliberately stays on `--grid`, and its own comment records why: it is the one chart here that draws a *lattice* rather than a ladder - verticals as well as horizontals - which is twice the ink at the same value, and raised to `--chart-rule` it stopped framing the trace and started caging it (captured side by side at 1.10, 1.57 and 1.83 against `--page`).
The fix recorded there is not a third grid colour but removing the verticals, which no reference screenshot draws and which `VolumeBars` has already dropped; once they go, that file should read `--chart-rule` like the rest.

## Generated types and drift

`src/api/schema.d.ts` is generated from the running application's own OpenAPI document, via `openapi-typescript` (`scripts/generate-api.sh`, `npm run generate:api`).
`api/client.ts` types every request and response off it, so a field the backend renames is a compile error in the frontend rather than an `undefined` reaching a chart.

Two independent things catch the schema drifting out from under the committed file, and they check it from opposite directions:

- `npm run check:api` (part of `npm run check`) regenerates the file and `git diff --exit-code`s it. This catches a backend change that was made without regenerating.
- `tests/test_cli_openapi.py::test_generated_typescript_matches_the_live_schema`, in the Python suite (`uv run pytest`), does the same check from the other side, which catches a backend change even in a change that never touches `web/` at all.

`api/activitySearch.ts`'s `ALL_SPORTS` and `UNKNOWN_SPORT` sentinels are the one exception to "read it from the schema": `sport` is typed as a plain `string` on both sides, not a closed enum, so those two values can only be read from the Python source (`api/queries.py`).
They cannot be pinned by a generated type the way `source`, `sort` and `order` are.

## Testing

Vitest and React Testing Library for units and components (`npm run test`, part of `npm run check`), Playwright for the end-to-end suites against a store ingested from the committed fixtures (every `web/tests/*.spec.ts`, `npm run test:e2e`, deliberately outside `npm run check`).
`npm run test` runs Vitest with `--passWithNoTests` and then `scripts/check-test-floor.mjs` over Vitest's own JSON report, which fails when fewer tests were collected than the floor that script names.
The flag is there because there is a commit on this branch where the suite does not exist yet, but on its own it would let `include` in `vite.config.ts` stop matching - a directory move or a naming change - and turn a total loss of coverage into a green gate.
The floor sits well below the current count: it is a tripwire for the suite vanishing, not a ratchet to bump with every test added.
It is outside that gate because it needs a real browser and two live servers rather than jsdom, which is not something the fast local loop should depend on.
The suites are typechecked inside it, though: `tsconfig.playwright.json` is the third reference in `tsconfig.json`, so `tsc -b` covers `web/tests/` and `playwright.config.ts`.
It extends `tsconfig.app.json` and adds the Node types, which `preconditions.setup.ts`, `e2eServers.ts` and the config need, and `DOM.Iterable`, which the specs' spreads of `querySelectorAll` need.

`web/tests/smoke.spec.ts` runs here as of 2026-09-02, when the missing system libraries that stopped Chromium launching were installed.
Its first real execution failed two assertions, and both were defects in the test rather than in the application - one locator looking in a `<dd>` for a detail rendered in a sibling `<p>`, and one canvas assertion double-counting a transient draw.
A third was found to have been passing by coincidence: the old canvas spy recorded both the transient 600x240 layout and the settled one, and the assertion survived only because y-axis tick *values* do not depend on canvas width.
That is the argument for running a browser suite rather than reasoning about one, and it is worth remembering before trusting an assertion here that has never been observed to fail.
Every assertion that depends on a figure which moves with the calendar (the weekly history's shape, the stat rail) fetches it from the running server first rather than hardcoding a measurement, for the same reason `docs/reference/api.md` captions its own figures as measurements rather than promises.
The few genuinely fixed figures - a fixture interval session's rep pattern and pace - are pinned directly, because they name a committed run that does not change.
What five runs cannot show is answered from synthetic data with `page.route` in the test file that needs it: a recurring route (`tests/syntheticRoute.ts`, three fixture runs served as one route by the backend's rules), a treadmill run, and Garmin's own VO2max series.
uPlot draws its charts on a `<canvas>` with no DOM fallback text, so reading what one of them actually drew, the two hardest-won assertions in the suite, means intercepting the canvas drawing calls themselves.
`web/tests/canvasSpy.ts` does this, and its header explains the mechanics, including how it copes with `StrictMode` mounting a chart twice in development.
At least one test per detail-view concern reaches `/activities/$activityId` by clicking the activity's own card rather than by `page.goto`ing the URL - see "The activity browser is the only route to the detail view" below for the defect that rule exists for.
`openActivityDetailByClicking` is that route, and it is what keeps the card link covered.

**This suite is outside `npm run check`, which means the markup can change underneath it and it goes green by absence.**
That is exactly what happened in the 2026-09-13 rebuild: every view was rebuilt, `npm run check` stayed green, and nine tests in `smoke.spec.ts` plus five in `phase4.spec.ts` were selecting markup that no longer existed - `tbody tr`, `thead th`, `td:nth-child(n)`, `getByLabel('Records')`, `getByLabel('Distance')`.
Every one of those is positional or keyed to a tag rather than to a name, and that is the lesson rather than the count: a selector written as a role and an accessible name survives a screen being rebuilt around it, because a name is the part of the markup that has to stay in order for the screen to stay usable.
So the suite locates the feed's cards through `getByRole('list', { name: 'Activities' }).getByRole('listitem')`, a card's stat by the label over it, the records ladder through the section its band names, and the sort chip by its own accessible name - which, since the caret and the spoken direction word come from one `sortState` call and one attribute, is now a stronger assertion than reading the glyph ever was.
Run it after any change to a view, not only after a change to a test.
The chart tests added on 2026-09-03 navigate directly, deliberately: what they assert is what a canvas drew, and routing each of them through a click would add wall-clock time without adding coverage the click-through tests do not already provide.

`web/tests/phase4.spec.ts` covers `/trends` and `/progression` against the fixture store, with all four endpoints serving rows.
One test still skips itself by name - the one asserting the absence states, which needs a store with no phase 4 rows - and the rest run.
Each test that measures geometry navigates through its own `openSettled` helper rather than `page.goto`, because `AppShell`'s store-stale banner is rendered from the `/api/health` response and so arrives after the first paint: measured in Chromium at 390 px, the chart's first point moved down 140 px when it appeared, which slid the point out from under a pointer already placed on it and left the hover-only readout never appearing at all.
That is the same trap `smoke.spec.ts` records for its own overflow test, in a form that only appears on a store the server reports as stale.
The row-dependent tests still guard themselves, through `emptyEndpoints`, on exactly the endpoints their own assertions read, and a skip names which of those was empty.
That guard earns its keep on a store that has not been recomputed: `/api/trends` and `/api/fitness` are filled by different modules, so a test counting five canvases and looking for the VO2max caveat would fail rather than skip if it guarded only on the former.

`web/tests/distributions.spec.ts` covers `/distributions` and skips, naming the endpoint, while `/api/distributions` serves no runs.
At 360 and 412 px it loads each of the fifteen variables and each comparison, and asserts that the page does not scroll sideways and that the Bars and Days segments share one top edge, so neither control wraps onto a second line.
At 360, 390 and 412 px it asserts that the phone bar shows Overview, Activities, Records, Trends and More, and that no label is cut short, `scrollWidth` at most `clientWidth`, with Distributions and then Progression current, so More is the bold tab.
It selects a bucket with a touchscreen tap at the middle of that bucket's slot, the fullest bucket read from the chart's visually hidden options, and asserts one row per run in it, each linking to `/activities/<id>`.
It also asserts one chart per local year under `compare=years`, and that a state set through the controls survives a reload unchanged.

`web/tests/routeMap.spec.ts` checks that the map reaches MapLibre's `load` in Chromium with nothing read from the store's basemap.
It answers `/api/basemap` with one synthetic area around the reference activity, serves that area's archive by byte range from `web/tests/fixtures/basemap-z0.pmtiles`, and serves an empty sprite index, a 1 x 1 sprite sheet and empty glyph ranges for the assets.
The archive is the single zoom 0 tile of an extract over a box around the fixtures, 68132 bytes, and `web/tests/fixtures/README.md` records the command that cut it and its OpenStreetMap attribution.
The test asserts that the "Map style" switch appears, which happens only after `load`, and that it stays after a switch to Grey; it failed before the worker URL was set, and every request to a host other than the dev server is aborted.
`web/tests/basemap.spec.ts` covers the same map through the API's own byte-range serving, over the stand-in area `scripts/e2e-api-server.mjs` installs in the fixture store from that archive.
It picks a covered run with `coveringArea` over the manifest and each run's streams before opening it, because `locator.isVisible` ignores its `timeout` in Playwright 1.62 and returns at once, so a loop that opened runs until one showed a map never waited for any of them.

`web/tests/activityMoment.spec.ts` covers the moment, the layout it now lives in, and the effort tag popover.
It runs on fixture `174c6a0e5af5c4b4`, whose phone hero takes at least a third of the screen, so the pinned hero's collapse has something to measure; the reference run's wide route draws a hero too short to collapse.
Hovering the pace panel scrolls it into view first - the title block above the compact stream stack can be taller than an 800px viewport, so a pointer move to a point below the fold hits nothing at all - then asserts a pace and marks the dot on the map; the two hovered-value locators are scoped to the panel's own `[aria-hidden="true"]` span rather than a bare text match, because the always-visible average uses the same formatter and would satisfy an unscoped one whether or not the hover ever fired.
Pressing Replay asserts the moment label moves on with `expect.poll`, not a fixed wait.
Tabbing a real `Tab` keypress (not a programmatic `.focus()`, which Chromium does not treat as `:focus-visible` arrival) to the effort badge shows its reason, and `Escape` hides it without moving focus; a mouse click's reason hides once the pointer leaves and `HOVER_CLOSE_GRACE_MS` has passed - two tests rather than one, because folding them together left a click's own `dismissed` state suppress the very next hover it was compared against.
Both tag tests fail with a named message through `requireEffortTag` when the run's `derived.tags` carries no effort tag, since on the fixture store that is a regression rather than a store that happens to differ.
The layout tests measure the desktop pinned hero staying in view, the four compact charts fitting one screen, and the phone hero staying pinned as the page scrolls past it.

`playwright.config.ts` starts both servers itself, so `npm run test:e2e` is the whole command, and outside CI it reuses a server already listening rather than paying the API's startup cost again.
`scripts/e2e-api-server.mjs` deletes and re-ingests `data/examples` into a store under the OS temporary directory, keyed by the checkout's path, on every start, then serves it.
The suite's ports are 8100 for the API and 5180 for Vite, overridden by `E2E_API_PORT` and `E2E_WEB_PORT`, so it never adopts a developer's own servers on 8000 and 5173; Vite reaches the suite's API through `ACTIVITY_ANALYSIS_API_URL`, which `vite.config.ts` reads for its proxy target.
That reuse is decided by nothing more than whether something answers on the port, so `web/tests/preconditions.setup.ts` runs first, as a setup project the browser project depends on, and refuses the suite when the suite's API is not serving the current checkout over the fixture store.
It compares the whole OpenAPI document, live against `activity-analysis openapi`; the two are byte-identical once keys are sorted, so any difference at all means the process on the port is other code.
It then reads `/api/health` through the dev server and requires its `root` to be the fixture store and `stale` to be false.
See its header for the run that made it necessary, in which a server left over from the previous branch failed 21 of 27 tests on selectors, canvas pixels and URLs while six passed.

## Traps

These have each cost real time on this branch.

**The activity browser is the only route to the detail view, and nothing enforces that it stays one.**
`views/Activities.tsx`'s `COLUMNS` array once rendered every cell as plain text, `activity_id` used only as a React `key` - no `<Link>`, no `onClick`, anywhere in the table.
`components/AppShell.tsx`'s nav only ever linked `/` and `/activities`, so `/activities/$activityId` - the deepest view in the application - was reachable only by typing or pasting a URL.
The end-to-end suite did not catch it, because every one of its tests reached the detail view with `page.goto` rather than a click, which is exactly what a missing link cannot fail.
`web/tests/smoke.spec.ts`'s `openActivityDetailByClicking` is the fix for that half, and it is not optional: it reaches the detail view by locating and clicking the activity's own `<a>`, so a regression here fails the suite again the way it should have the first time.
`Activities.test.tsx` pins the same thing at the unit level: the link exists, has the right `href`, and clicking it actually navigates.

**The rule about *what* carries that link was reversed on 2026-09-13, deliberately.**
It used to be the date cell alone, so that the other cells' text stayed selectable, and that was right for a table row where the date was most of the row's width anyway.
It is wrong for a card: a reader who taps the middle of one and gets nothing has been told the wrong thing about what a card is, and on a phone the card *is* the affordance.
So the whole card opens the activity now, and the same holds for a row of the records ladder.

**What it is not is a synthetic `onClick`, and that distinction is the whole reason this is safe.**
It is the same single `<a>` with a real `href` it always was, stretched over the card by a `::after` overlay at `inset: 0`, so the browser's own "open in new tab", a screen reader's link list and keyboard navigation all still work - which was the other half of the original reason and the half worth keeping.
What it costs is dragging to select a number out of the feed, because the overlay is what the pointer hits; the detail view, one tap away, is where a run's numbers are read from anyway.
Two things the overlay makes necessary.
The card is the `position: relative` containing block, so nothing else inside it may be positioned without deciding which of the two wins.
And `.link:focus-visible { outline: none }` sits alongside the `::after` ring, because without it a focused card carries **two** rings, the browser's tight around the date and ours around the card - suppressing an outline is only safe where something replaces it, and the replacement is two lines below it in the stylesheet.

**Pace is a reciprocal; the panel is linear in speed and only the tick labels are pace.**
Plotting pace directly wastes most of a panel's height on a run's slow seconds.
Measured on the 2026-08-25 activity, a full-range pace axis puts the 5th-to-95th-percentile band in 21.9% of the panel height against 55.8% on a linear speed axis.
So `StreamPanel.tsx` plots `speed_mps`, and only `charts/streamPanelMath.ts`'s `paceTick`/`paceAxisSplits` convert the *axis labels* to pace, choosing round pace steps and converting each back to its (uneven) speed position rather than the reverse.
The y-axis itself is not unconditionally zero-anchored either: it reaches down to 0 only when the run actually shows a near-zero speed - a pause, an outage, or a raw sample below the stop threshold, `containsNearZeroSpeed` - and otherwise crops to a padded band around the visible data, because forcing zero on an evenly-paced run wastes height the same way plotting raw pace did (measured: about 4% of the panel).
The tick *step* on a cropped axis is the pace difference across one tick's worth of the displayed speed range, measured at the fast end, not the pace difference between the range's two ends.
Pace diverges as speed falls, so a range whose bottom is a walked recovery is dominated by its slow end: a 0.8-4.5 m/s run took the largest available step and put every gridline below 1.7 m/s, with none in the band the running happened in.
This is the same failure the zero-anchored branch had before it, one branch further down, and it is why the step is now derived from the range being displayed rather than from a divergent pace span.
The raw step is rounded *up* onto a ladder of round pace values, so that ladder has to reach further down than the narrowest band worth drawing: with a 15 s/km floor, any band narrower than that - a near-constant-pace 2.78-2.80 m/s run spans 3.1 s/km - had every candidate pushed out below the range, and the axis came back with no gridlines and no labels at all, silently.
The ladder now starts at 1 s/km, and a range narrower than that, or a degenerate one whose ends are equal, falls back to a single gridline at its own midpoint.
`paceAxisSplits` now returns a non-empty set inside `[scaleMin, scaleMax]` for a range of any width above the point where pace stops being a usable unit at all (`MIN_SCALE_MAX_FOR_PACE_TICKS_MPS`, below which only the stop tick appears), which `StreamPanel.test.tsx` asserts across widths rather than on one instance.

Choosing a good step is still not enough to stop the *labels* colliding, and that is the reciprocal again rather than a defect in the step.
Equal pace steps map to shrinking speed intervals as the athlete slows, so the labels converge towards the bottom of the axis however well the step is chosen.
Measured on the reference activity, whose axis spans 1.132-3.002 m/s over a 140 px plot: the round-minute labels from 6:00 down to 11:00 sit at successive gaps of 29.7, 22.3, 17.3, 13.8 and 11.4 px - a 2.6x compression down a single axis - and the bottom two touch at uPlot's default 12 px axis font.
`paceAxisSplits` therefore takes the plot's own height, passed by `StreamPanel`, and thins the ladder to the finest *uniform* stride whose tightest gap still clears one label height.
That height is in **CSS** pixels, and getting there is one line of `StreamPanel`'s pace-axis `splits` callback that is worth knowing about.
uPlot reports `bbox` in *canvas* pixels - it scales the plot's CSS height by the device pixel ratio when it computes it, which is also why `backgroundHook` pairs `bbox` with `valToPos(..., true)` - while the separation the thinning tests against is one em box of uPlot's 12 px axis font.
Compared raw, every gap on a ratio-2 display measures double, all of them clear the threshold, and nothing is thinned at all: the labels overlap on screen while both the unit tests and the browser suite pass, because each ran at ratio 1.
So the callback divides the ratio out and `paceAxisSplits` works in CSS pixels throughout.
`StreamPanel.test.tsx` pins the unit by asserting the same range at the same CSS height thins identically at ratio 1 and 2, and the browser suite has a `deviceScaleFactor: 2` describe block that measures the drawn gaps in CSS pixels.
Uniform is the load-bearing word.
Dropping whichever labels collide also stops the overlap, and on that same run it keeps 6:00, 7:00, 8:00, 9:00 and 11:00 - every label true, and a ladder that skips 10:00 for no reason a reader can see.
An axis whose labels step 1, 1, 1, 2 reads as an error; taking every *n*-th rung gives 6:00, 8:00, 10:00 instead.
The height parameter is optional and thinning is opt-in, so the pure two-argument form every other test uses is unchanged.

**A uPlot chart whose container has no definite CSS height grows without bound, one legend-height per resize observation.**
uPlot renders its legend as a `<table>` that is a *sibling* of the plot's own wrapping element, both inside the single root node `charts/UPlot.tsx` hands to its `ResizeObserver`.
`setSize` writes the height it is given onto the inner wrapping element only; it knows nothing about a legend below it.
So if the root's height is decided by its content rather than imposed from outside, every observation reports back the wrapping element's height *plus* the legend's, `setSize` grows the wrapping element by that much, and the next observation reads the sum again: unbounded growth, forever, at one legend-height per tick.
This cost the previous run's test step a 30-minute timeout rather than a visible layout bug, which is why it is worth knowing before writing a new chart rather than after.
Two invariants hold it shut, and a new chart has to keep both.
`UPlot.tsx` builds with `legend: { show: false }` unless the caller passes its own `legend`, and a caller that opts in takes over responsibility for sizing around the legend it asked for.
Every container carries a real fixed height matching that chart's own `options.height`, never a percentage and never content-driven: `StreamPanel.module.css`'s `.panel` is `calc(var(--stream-plot-height, 7.5rem) + var(--stream-chart-furniture))`, 12.5rem (200px) against `options.height`'s constructed 200 everywhere outside the activity view's desktop `.pinned` layout - where `--stream-plot-height` becomes the compact clamp and `--stream-chart-furniture` moves with whichever panel carries the time axis, see "Desktop layout" above - and `VolumeBars.module.css` the `--chart-height` token, 11rem, against 176, or `--chart-strip`, 7rem, against 112 for the compact strip.
`VolumeBars.test.tsx` reads both tokens from `theme/tokens.css` and pins `options.height` to them.
`UPlot.test.tsx`'s "does not grow the container without bound across repeated observations" pins it by modelling the sibling legend explicitly, so removing the default fails that test rather than a wall clock.

**A chart is built at its container's size, not at its options' placeholder.**
Every caller passes `width: 600`, and the `ResizeObserver` reports the real size a frame or more after construction, so a chart used to draw its first frame 600 px wide: at 360 px the Distributions page measured 624 px, and under the full suite's load `distributions.spec.ts` caught that frame.
`UPlot.tsx` now reads the still-empty container's `clientWidth` and `clientHeight` and builds at those when both are positive, keeping the options' size otherwise, as in jsdom.
`tests/chartFirstSize.spec.ts` holds every observation back and measures the page at 360 px.

**Anything a chart wants to render *beside* itself inherits this constraint.**
Two such things exist now and both had to be placed with it in mind.
`StreamPanel`'s heading and its average legend are siblings of `.panel`, outside the observed box entirely - which is safe because `.panel` carries the externally imposed height, so its content cannot move it.
`VolumeBars`' hover readout is `position: absolute` *inside* `.chart`, out of normal flow, contributing zero layout height whatever it says.
A readout in normal flow beside the observed box is this trap rebuilt by hand, and the same 30-minute timeout with it.
Being out of flow brings its own two obligations, and both were initially missed.
`u.cursor.left` is measured from uPlot's *plotting area* (`u.over`), which it insets from the chart's left edge by the y-axis gutter, while the readout is positioned against `.chart`; passed through unshifted it sat about 50 px - most of a bar at twelve bars across - to the left of the bar it was describing, so `VolumeBars` adds `u.over.offsetLeft` at the point it captures the offset.
And an out-of-flow box centred on the pointer hangs half its width past the panel at either end of the chart, into a `.chart` that sets no `overflow`, so `volumeBarsMath.ts`'s `clampReadoutLeft` holds its centre a half-width inside the panel - measured from the rendered element, because what the readout says is what decides how wide it is.
jsdom applies no CSS module styles, so `getComputedStyle` there reports `static` whatever the stylesheet says: the out-of-flow half of that contract is asserted in the Playwright suite instead, by sweeping the pointer across the chart and measuring that its height has not moved.

**The canvas box is not the plot box, and this branch got that wrong three times.**
Once in the application - the readout offset above - and twice in tests written to guard it: a clamp test hovered 4 px inside the *canvas* to reach the extremes, and the phone-width hover guard positioned the pointer at 2% and 98% of the canvas width.
uPlot insets its plot area by the y-axis gutter and by whatever `padding` the chart passes.
When those tests were written `VolumeBars` had its ladder on the left at uPlot's default 50 CSS px and a `[16, 8, 0, 0]` padding, so on a 390 px viewport the plot spanned roughly `[50, width - 8]` of a canvas under 400 px wide, and both of those fractions fell outside it - where `cursor.idx` is null, `VolumeBars` clears its hover state, and there is deliberately no readout at all.
The ladder is on the right now, `Y_AXIS_SIZE_PX` wide, so the plot spans `[0, width - 40]` and the inset moved sides without going away.
A hover positioned against the canvas therefore asserts nothing while looking like it does: the clamp assertions passed with the clamp removed.
`tests/smoke.spec.ts` now has one `plotArea` helper that every pointer position in the suite is taken from, plus an `alongPlot` for the fractions, so a fourth instance cannot be written one test at a time.

**A `drawAxes` hook inherits the canvas state uPlot left on the context, `ctx.save()` included.**
`save` preserves state; it does not reset it.
uPlot draws each axis's grid with `roundDec(grid.width * pxRatio, 3)` as the line width and fires `drawAxes` immediately afterwards, and `grid.width` defaults to 2, so `streamPanelMath.ts`'s `backgroundHook` was stroking both the pause boundaries and the average reference line at 2 CSS px - heavier than the 1.5 px series it annotates, and ratio-correct only because uPlot had multiplied its own constant rather than because this project chose anything.
Every property a hand-drawing hook depends on has to be set inside it: `ANNOTATION_LINE_WIDTH_PX` is now stated in CSS pixels and scaled through `cssPixelRatio()` exactly as the dash patterns are, and `StreamPanel.test.tsx` seeds its mock context with uPlot's own inherited width so an unset `lineWidth` fails rather than passing silently.

**A `draw` hook is not clipped to the plot box either, so anything it strokes at a fixed value has to check the value is on the chart.**
uPlot fires `draw` after its draw order rather than inside the per-series save/clip/restore, and `TrendChart`'s y scale is `axisScale` over the data, which knows nothing about a reference value.
The decoupling chart is the case that matters: the population's median is 7.65% on the 2026-10-16 store against a 5% durability rule, so a history that stays above the line resolves `valToPos(5)` below the plot box and the dashed rule would be painted across the x-axis label strip while the legend still named it, and an x-zoom into any stretch above 5% does the same on any data.
`TrendChart` returns from the hook when the resolved y falls outside `[bbox.top, bbox.top + bbox.height]`; the legend entry stays either way, because it says what the rule marks rather than that a rule is visible.
`streamPanelMath.ts`'s `backgroundHook` needs no such guard only because the value it draws is the mean of the data it draws over, which is why the precedent did not carry.

**The weekly and monthly series from `/api/overview` are dense and must never be filtered.**
Before 2026-08-30 the weekly series held only weeks with a run, and a chart drawing it by array index closed the gaps and showed a training history with no weeks off in it.
See `docs/reference/api.md`'s own account of that bug.
`charts/VolumeBars.tsx`'s `periods` prop is documented as dense on the same grounds, and its `markEmpty` mode marks every period whose `runs` is 0, positioned by that period's own index.
The fix has to stay index-aligned, since re-filtering the array before drawing would silently reintroduce exactly the bug it exists to show.

**That mark is an open ring resting on the baseline, not a bar of zero height**, and the distinction is the point of it.
A zero-height bar with a tick over it and a bar too short to see are the same picture, so a week off has to be drawn as something a bar never is: `volumeBarsMath.ts`'s `emptyMarkGeometry` sizes the ring off the bar width and clamps it at both ends, and `barGeometry` still returns `null` for a period of exactly zero, so no zero is ever promoted into a floor-height bar.
At the 3px floor the stroke clamps to the radius and the ring resolves into a solid dot, which is what the full-history strip needs: at 149 weeks on 2026-09-13 one slot there is about 2 CSS px, and the strip only gets denser.
Every size is stated in CSS pixels and scaled through `charts/canvasPixels.ts`: an unscaled size arrives unchanged at a device pixel ratio of 2 and renders at half what it claims, and this mark exists precisely so that a week off reads as deliberate - which it stops doing at half size, on exactly the displays most people have.
It is `ctx.arc` plus `ctx.stroke` where it used to be `ctx.fillRect`, so a test reading the canvas has to record arcs; `tests/canvasSpy.ts` does, and the bars themselves are `arcTo` corners on a filled path while the zero rule is the one remaining `fillRect`, which is what makes every recorded `arc` on that canvas an empty-period mark and nothing else.

**A missing channel is the no-value glyph, never a zero.**
`format.NO_VALUE` (`–`, U+2013, an en dash) is what every formatter in `src/format/index.ts` returns for a `null` or non-finite input, and it is the one glyph for "not recorded" across the whole frontend.
A table cell or a stat never falls back to `0` for a missing heart rate, cadence or ascent, because a real recorded zero and an absent measurement are different facts - see `docs/reference/api.md`'s own nullability rules for why the backend never coalesces one into the other either.
This bug - format the number, then staple a unit onto it, which renders `– km` for a missing distance instead of the bare glyph - was found five separate times across this branch, not once or twice: three byte-identical `paceCell` functions and three different distance-guard idioms, two of which had no guard at all.
Naming it once as a pattern rather than five one-offs is why `format/index.ts` owns the unit-bearing forms directly - `pace(speedMps)` and `distance(metres, digits)`, both returning the glyph or the unit-bearing string and nothing in between - rather than leaving each caller to compose a bare `paceFromSpeed`/`distanceKm` with its own copy of the guard.

**`localWallClock` returns a `Date` whose *UTC* fields hold the local wall clock; read it with `getUTC*`, never `getHours`/`getDate`/etc.**
`format.localWallClock` computes `start_time_utc + utc_offset_s` and hands back a real `Date`, but deliberately stores the *shifted* instant in that `Date`'s UTC fields rather than constructing something whose local-timezone getters would return it.
A local `Date` would make the displayed time depend on the machine's own timezone, and this has to render the same activity the same way on a CI box in another zone as on the athlete's own laptop.
`formatLocal` and every caller of `localWallClock` read it with `getUTCDay`/`getUTCDate`/`getUTCHours`/etc for this reason.
Reaching for the non-UTC getters on that `Date` silently reintroduces the machine-timezone dependency this function exists to remove.

**Recorded laps lead on an interval session, and the *trigger* does not identify a rep.**
Which of the two splits tabs leads is decided, in `ActivityDetail.tsx`, from a single input: whether `derived.tags` carries a `kind: "effort", tag: "intervals"` row.
It is never decided from counting manual laps, which was the original, rejected rule.
On the real interval sessions the reps themselves are usually `distance`-triggered auto-laps and the *recoveries* are the manual presses, so a manual-lap count measures the wrong half of the session.
See "The per-lap role comes from `rep_pattern`, never from lap speed or cadence" below for the same principle applied one level down, to which lap is which.

**That leading tab must be re-decided on every activity, not picked once at mount.**
`components/Splits.tsx` used to pick its leading tab in a `useState` initialiser, which React runs exactly once per mounted instance.
`ActivityDetail` renders `Splits` at a fixed position with no `key`, and the query client holds `staleTime: Infinity` (`main.tsx`), so revisiting an already-cached activity resolves from cache with no pending state in between - the component never unmounts, and the previous activity's tab choice survives onto the new one.
An interval session revisited a second time could load with "Per km" leading, reversing the rule above silently.
`Splits` now tracks which `activityId` its current tab selection was made for and resets to the correct leading tab the moment that id changes, which is also what lets a reader who switches tabs and then gets some unrelated re-render for the *same* activity keep their own choice.

**The per-lap role - rep, recovery, or plain - comes from the analysis layer's `rep_pattern`, read positionally, and must never be re-derived in the frontend.**
`components/splitsMath.ts`'s `rolesFromPattern` reads `ActivityTag.rep_pattern` (added at `ANALYSIS_VERSION` 4), the backend's own per-lap `R`/`W`/`-` string, one character per recorded lap, sorted by `lap_index` first and matched positionally.
An earlier version of this function re-derived the classification from `avg_speed_mps` and `avg_cadence_spm` instead, taking the tag's `rep_count` fastest laps as the reps.
That worked on the one activity it was checked against and failed on the wider real store: five of the nine real interval sessions then carried no `avg_speed_mps` on any lap, so a speed-based heuristic could not even attempt those five; `docs/reference/math/tags.md` has why.
`rep_count` is not simply "how many laps were fast" either, since the backend's own `interval_reps` only counts an `R` lap that sits beside a `W` - one real session has nine laps that read fast but a `rep_count` of 7.
No frontend-side tuning of that heuristic closes the gap; reading the pattern directly is the only way to agree with the backend's own count.
**The frontend never recomputes a metric the analysis layer already owns.**
That rule is this file's to state - it is the frontend's instance of the layering `CLAUDE.md`'s Architecture section imposes one layer down, where "do not collapse these layers or add compute-on-read shortcuts in the API" says the same thing about the API.
`rolesFromPattern` mirrors that adjacency rule rather than numbering every `R`, so the numbered rows are exactly the set `rep_count` names and an `R` the analysis layer did not count reads as a plain lap.
Numbering every `R` rendered "Rep 1" through "Rep 9" under a tab header reading "Laps - 7 reps" on one real session, which is the frontend contradicting a metric it does not own rather than reporting it.

**A splits table's pace bars are scaled to the range of paces in the whole table, and the lap roles are deliberately not consulted.**
Zero-anchoring was the original and it is what the maintainer reported as "the bars are too even": on `854fd775d479ca9f`, eight laps from 6:16 to 6:57 per kilometre span 90.1% to 100.0% of their cell, a 9.9-point spread the eye cannot separate.
`splitsMath.ts`'s `paceBarScale` takes the slowest and fastest pace anywhere in the table instead, and `paceBarWidthPercent` maps that range onto `MIN_PACE_BAR_PERCENT` to 100.
An interval session is bimodal, so one range does spend most of its span separating the reps from the recoveries: on `6116b2e90f551a6c` the five reps land at 89.4 to 100.0%, a 10.6-point spread about as tight as the complaint.
**That compression is inherent to a bimodal table rather than a fault in the scale, and it was measured against every alternative on that fixture before being accepted.**
Scaling to the reps alone was tried on this branch and reverted: it puts all nine non-rep laps below the range's floor, so each draws at exactly `MIN_PACE_BAR_PERCENT` - one bar width across 1.477 to 2.882 m/s, with the 11:17/km walked recovery and the 5:47/km cool-down pixel-identical.
It buys rep separation by destroying nine rows of fourteen.
Scaling per role group makes a bar comparable only with the bars of its own role, which removes the one thing a single visual column is for, and a logarithmic scale over every row gives the reps about 7 of the 88 points the floor leaves - no better than linear, because no single linear or log scale can spread two clusters internally at once.
What the all-rows range does give is the session's dominant structure, legibly: all fourteen laps get a distinct width, the reps reading near 90-100%, the recoveries near 20-24%, and the warm-up and cool-down in between.
That is what the Laps tab of an interval session is asked - were the reps consistent, and was there a recovery - while the finer rep-to-rep question, 4:12 against 4:33, is answered exactly by the Pace column beside it.
A bar is for relative comparison across the table; it is not a substitute for the number.

**A validator that drops an unknown search key by omitting it from its return value does not actually clean the URL, because TanStack Router merges the validated search back over the raw one.**
`api/activitySearch.ts`'s `validateActivitySearch` narrows and defaults `/activities`'s search params, but the *type* narrowing it buys does not mean the address bar agrees.
TanStack Router computes a matched route's `search` as the raw, entirely unvalidated parent search overlaid with the validator's own return value - confirmed by reading `matchRoutesInternal` in `@tanstack/router-core`, not assumed from its types - so a key the validator *drops entirely* (an unrecognised param, a non-numeric `limit`, an invalid enum) resurfaces unchanged on the object a component's `useSearch()` reads back.
The router's own merge already self-corrects a key the validator sets to a *different valid* value on its own; a clamped `limit=9999` already reads back as `200`.
That is exactly what makes the dropped case easy to miss.
`router.tsx`'s `activitiesRoute` closes the gap with a `beforeLoad` that redirects to the validated search, but only when it differs, and it compares against `location.search`, the raw URL, rather than `beforeLoad`'s own `search` argument - that argument has *already* gone through the same merge and would show a clamped value as already clean, missing exactly the case (a dropped key) this exists to catch.

**React Testing Library's automatic `afterEach` cleanup does not register on its own here, because this project's Vitest config has `test.globals` unset.**
Without an explicit `afterEach(cleanup)` in `src/test-setup.ts`, every test's rendered tree stays in the document after the test ends, so a later test in the same file silently queries a `body` holding several stacked copies of the app, and every `getByRole`/`getByText` throws on the ambiguity instead of testing what that test actually rendered.
The same file also polyfills `window.matchMedia`, which jsdom does not implement at all: uPlot calls it unconditionally at *module import time*, before any chart is constructed.
So any test that pulls in the real `uplot` package fails at import rather than at the point that would explain why - not just a chart test, `router.test.tsx` hit this first by rendering the real route tree.
It also raises Testing Library's `asyncUtilTimeout` from 1 s to 4 s, because the first test in a view file pays that file's cold render, and with one jsdom worker per core that crossed 1 s often enough to fail some file's first test on five of seven full runs on 2026-09-25.

**`preserveAspectRatio="none"` on an SVG that contains text distorts the text, and it is not obvious from the source that it will.**
`charts/ZoneBar.tsx` used to draw one stacked bar as an SVG with a `0 0 101.5 10` viewBox and `preserveAspectRatio="none"`, rendered by CSS at `1024 x 32`.
That is a 10.09x horizontal scale against a 3.2x vertical one, so every glyph inside it came out stretched 3.15x wider than it should be - which is what "the time in zone graph is ugly" turned out to mean when it was measured rather than eyeballed.
The bar also spent the page's full width carrying five zone numbers, and showed no durations, boundaries or shares at all.
It is a table of rows now: plain HTML and CSS with no viewBox to distort, and every number present.
The general rule is that `preserveAspectRatio="none"` and text do not mix - if an SVG has to be non-uniformly scaled, nothing inside it can be a glyph.
`charts/Route.tsx` keeps `xMidYMid meet`, which scales both axes by one factor and is why its scale bar and label stay true.

**The band above the last configured boundary is not drawn, and that is not the same rule as hiding an empty zone.**
The device's boundaries are 104, 124, 145, 166, 186 and 207 against a configured maximum of 207, so the seventh zone means "above your own maximum": it holds 0 seconds across all 223 activities with zone data and always will.
An empty zone 5 on an easy run is a different fact entirely and still renders as `0:00` - the real activity `854fd775d479ca9f` has both, 0 s in zone 5 and 0 s in zone 6, and only the second disappears.
`ZoneBar.isAboveConfiguredRange` owns the rule: a floor and no ceiling, which is what "everything at or above the last boundary" looks like in a bucket, and it keys on the missing *ceiling* rather than on an index, because zone 0 is open-ended at the other end and holds 7152 s of real running.
**It uses the last boundary as a proxy for the configured maximum, which the API does not serve.**
That is exact on this device and on every one of the five stored profile intervals; a profile that set its top boundary below the maximum would make the band genuinely reachable, so the rule also refuses to drop a band with any seconds in it, and measured time is never hidden by a rule about configuration.
Serving the real `max_hr_bpm` from `/api/overview` and the derived block would let this key on the maximum itself; that was chosen against on 2026-09-12 in favour of shipping, and such a rule would also have to answer for a profile interval with no maximum.
The padding that used to extend the index range up to the device's seven is gone with it: its whole stated reason was that the empty top band is still information.

**An empty measurement is a zero; an unmeasured activity is an absence. The zone table has to say both, differently.**
A zone with no seconds in it reads `0:00` and `0%` - the maintainer's explicit instruction, and the honest rendering, since the device did measure that zone and found nothing in it.
An activity with no `zone_time` rows at all is a different fact: 84 of 307 real runs have no heart rate, so no distribution was ever recorded, and rendering seven `0:00` rows there would claim a measurement that does not exist.
That case still routes through `Absent`.
`ZoneBar.test.tsx` pins the two separately, because the tempting simplification - treat an all-zero bucket list as seven zeros - collapses them.

**A `nowrap` flex row with `nowrap` children has an intrinsic minimum width, and it forces the whole document wider.**
`components/AppShell.tsx`'s header, before the 2026-09-13 rebuild replaced it with `components/TabBar.tsx`, was `display: flex` with no `flex-wrap`, a `white-space: nowrap` brand, a `white-space: nowrap` status, and a `flex: 1` nav with a gap of its own.
Nothing in it could shrink or break, so its min-content width was the sum of all three plus the gaps: a 606 px floor, measured overflowing at 360, 390, 420, 440, 460, 480, 520 and 600 px - every phone in portrait, on every page.
The overflow was on the header; the symptom was the whole page sliding sideways, which is why it was not obvious where to look.
`flex-wrap: wrap` on the row plus `min-width: 0` on the nav fixes it: a flex item's default `min-width: auto` is its content's intrinsic minimum, so allowing the row to wrap is not enough on its own if an item inside it still refuses to narrow.
The Playwright suite has a viewport test for this now, and it distinguishes the two cases that look alike: an element that overflows *inside* something that scrolls it is fine - the wide splits table is meant to scroll in its own wrapper - while an element escaping to the viewport is not.
**Both halves of that test have to be written to see this particular defect, and the obvious forms of each cannot.**
The per-element sweep has to query the whole document rather than `main *`, because `AppShell` renders its chrome as a *sibling* of `<main>`: the header's brand, nav and status - the three children whose nowrap sum was the 606 px floor - were not inside `main` at all, and neither is the `TabBar` `<nav>` that replaced them, so a query rooted there matches none of it.
And the page-level check has to read `document.documentElement.scrollWidth` against its `clientWidth`, not any element's own box.
`body` is a block with `width: auto` and `.shell`/`.header` are block-level flex containers, so each of those boxes stays at the width available while its *items* overflow.
Reproduced in Chromium at a 390 px viewport against the pre-fix header rules: `scrollWidth` runs out to the header's own intrinsic floor while `document.body.getBoundingClientRect().right` reads 390 in the healthy state and the broken one alike.
A `body`-box assertion is a constant, not a check.

**A pace sort is a speed sort, and the mark has to say what the reader sees rather than what the query asked for.**
No pace is stored anywhere (CLAUDE.md, "Never store pace"), so `views/Activities.tsx`'s Pace field carries `sortKey: 'avg_speed_mps'`.
`toggleSort` asks for `desc` on a field's first click, which in speed means the fastest run first - the maintainer's choice, and the same "biggest number first" behaviour every other field has.
The consequence is that the *indicator* inverts: descending speed is ascending pace, so a caret pointing down beside "Pace" would tell the reader the slowest run is on top while the fastest one is.
That is what `indicatorInverted` on the field and `sortState` exist for, and Pace is the only place either is used.
`sortState` returns one direction, and both the drawn caret's rotation and the visually hidden word in the chip's accessible name come from it, so what a screen reader announces and what a sighted reader sees cannot disagree; the first version inverted only the arrow and announced "descending" over an up-arrow.
Every other field sorts by the unit it displays and needs neither.

**The Pace stat used to be empty on most cards, and what fixed it was a metric definition rather than a rendering change.**
Measured on 2026-09-03: only 83 of 307 runs carried a canonical `avg_speed_mps`, every one of them from 2026, because of an ingestion bug rather than the device; see `docs/reference/math/units.md`, "Coverage".
The stat rendered the no-value glyph on 73% of the list and the pace sort ordered 83 cards with 224 below them.
The information was never missing from the store, since all 224 had a derived `distance_m` and `moving_time_s`, but deriving the stat changes what the 83 populated cards mean, so it went to the maintainer as a decision rather than being fixed silently.
It was taken on 2026-09-12: `ANALYSIS_VERSION` 7 stores `activity_metrics.avg_speed_mps` and the API serves it, so the stat is now populated for every run.
The cards that still fall back to the device's own value are the non-running ones, which the derived layer does not cover, and the running cards whose canonical distance or derived moving time is not positive, which the derived column is null on.
`docs/reference/math/units.md` argues which distance the derived value divides and why a card cannot say which of the two it carries.

**The progression chart is SVG rather than uPlot, and the reason is per-point hit testing.**
Every point on it has a hover readout of its own and is a link to its activity, and uPlot draws to a canvas where that would need a hit-test layer of our own on top of a cursor that snaps to the nearest x rather than to a point.
An SVG `<circle>` is its own hit target, and TanStack's `Link` renders an `<a>` around it that the browser already understands - modifier-click opens a new tab with no code here.
`charts/Route.tsx` is SVG for a related reason.
The cost is that uPlot's conveniences have to be rebuilt: `progressionMath.ts` owns the axis placement, and the hover readout's position is derived from the viewBox, which only works because `ProgressionScatter.module.css` imposes the viewBox's own aspect ratio on the panel so the SVG fills it exactly.
Only its `top` is still a plain percentage of that box, though.
Its `left` and its above-or-below flip are decided in real panel pixels from the component's own measurements of the panel and of the readout, the horizontal one through the same `volumeBarsMath.clampReadoutLeft` the uPlot readouts use, because a percentage of the viewBox is not comparable with a box whose width and height are CSS pixels: unclamped, the rightmost point's half measurably widened the document to 644px in a 606px viewport, and a viewBox fraction of the height let a point near the top edge overflow the panel above at phone width.
The same "adds no layout height" rule applies to that readout as to every uPlot readout - see the resize-loop trap above - even though there is no uPlot underneath.

**The progression chart's time axis is inverted on purpose: a faster effort sits lower.**
SVG y grows downward, so `progressionMath.scatterLayout` maps a *smaller* elapsed time to a *greater* y, and the tests assert exactly that.
It is a design choice, that faster efforts sit lower and improvement descends, so the records ladder walks down the page and the staircase steps downward.
A reader who "fixes" it to the conventional orientation puts every record at the top and makes improvement climb, which is the opposite of what the page says in its own caption.
It is also one continuous linear axis, never broken or clipped, so the chart never misrepresents the size of a gap; it is merely not anchored at zero, for the same reason no trend axis here is.

**The race-prediction caveat is required for the same reason: it says which column is the prediction.**
The best-effort range is the prediction; the ordinary-runs column reads what typical training supports, because its calibration was fitted against the best 5 km inside six weeks of training rather than against races.
On 2026-10-06 it put the 10 km 3.5% slower than the best-effort range, whose near end was the window's own best 10 km, which read as a bug until the caveat said why.
`docs/reference/math/predictions.md` measures the lag and records why the column is not hidden whenever a best effort exists: over the history that rule would never have shown it.
A critical-speed model used to sit in the range and set its far end; it was removed on 2026-10-06, and that document records why.
So the frontend must keep the ordinary-runs column visually secondary and keep the caveat in the open; promoting it to the range's weight, or folding it into the range, would show two disagreeing predictions with nothing saying which to read.

**The VO2max chart's caveat that the level is a model output is required, not decorative.**
On the history it was developed against, the heart rate based estimate sits well above VDOT with a small spread in that ratio, and it reads above what the athlete's own performances support.
The level also scales directly with the configured maximum heart rate, a device setting rather than a measurement.
`docs/reference/math/vo2max.md` measures both, and the page states the viewer's own offset and spread through `charts/trendsFindings.ts` rather than that document's figures.
The decision recorded there is to report the raw model output and *state on the chart* that only the trend is defensible, rather than calibrate the series onto the VDOT scale, which would invent precision from two of our own models with no external reference.
Removing the sentence to tidy the page removes the one thing that makes the number honest; `Trends.test.tsx` asserts it is rendered.
Garmin's line does not lift the caveat: Garmin's number reads heart rate against running speed too, so it is a model of the same family, and on the history it was developed against the smoothed heart rate estimate sits above it, with a gap that swings rather than holding constant.

**The reference-pace series carry their ordering in colour, and in colour only.**
They were told apart by line weight, slow lightest at 1 px and fast heaviest at 2.4 px, in palette entries 1 to 3.
Two things were wrong with that and only one of them was the weight.
Three shades of weight read as three chart elements of different importance rather than as three positions on one ordinal scale, so the slow reference looked unimportant rather than slow; and the categorical palette is for unordered things, which is the same mistake the zone ramp was created to fix one level down.
So `TrendSeries.emphasis` is gone, every line is `LINE_WIDTH_PX`, and a series names the custom property it is stroked with through `colorVar`, which is what lets the three paces take `--pace-1` to `--pace-3` while every other chart keeps the palette in its fixed order.

**Plotting the raw per-run reference-pace values is what made the three lines one band, and no presentation change fixes it.**
Measured over the real store on 2026-10-16, across the 227 activities that enter the fit: the median difference between the fast and slow heart rate series on the same run is 0.30 times the median difference between one run and the next at the median reference pace, whose 95th percentile is 13.5 times that gap.
The noise is 3.4 times the separation.
That is why the charts plot the analysis layer's stored smoothed columns, on a trailing 42-day window that brings the run-to-run step to 0.085 of its raw median while the gap holds at 0.98 of its own.
Stated as one ratio: raw, the gap is 0.30 times the run-to-run step, and smoothed it is 3.44 times it.
Take both from `docs/reference/math/efficiency.md`'s smoothed-series table rather than recomputing them here, which is how 2.88 was once written down as 2.8.
The raw values stay only as one faint scatter behind the median line - the VO2max chart's own rule that smoothing must not hide its inputs, without three scatters behind three lines.

**That scatter costs about two thirds of the separation the smoothing bought, and the trade is deliberate rather than unnoticed.**
Measured on 2026-09-12 over the 208 fitted runs: the raw median-reference values span 3.1 times what the three smoothed lines do, and the shared axis has to cover them, so the lines occupy 32% of the panel height.
The median gap between the fast and slow lines therefore renders as 3.5% of that height rather than the 10.8% it would get on an axis fitted to the lines alone.
This is the same shape as the pace-axis trap above, where a full-range pace axis put the visible band in 21.9% of the panel against 55.8%.
It is kept because the alternatives are worse: dropping the scatter breaks the rule that smoothing must not hide its inputs, and fitting the axis to the lines while still drawing the scatter would clip real measurements off the top and bottom of the panel, which is a chart that lies about its own inputs rather than one that crowds them.
A taller panel does not help, since it scales both spans equally.
Anyone revisiting this should change it only with a measurement, and should read `docs/reference/math/efficiency.md`'s smoothed-series table first.
The smoothing is the analysis layer's, never this layer's: see "The frontend never recomputes a metric" above.

**The flag names no cause, and neither does the copy.**
The maintainer questioned a half marathon the progression chart then marked ineligible, and the copy then called it a GPS jump.
It is eligible, and the record, since `ANALYSIS_VERSION` 10 on 2026-09-27; see `docs/reference/math/best-efforts.md`, "The speed-agreement check".
Examined on the 1 Hz grid, that run's position advances steadily through the flagged moment, about 12% faster than the speed channel, which holds level, while the distance channel alone gains 15.2 m in one second, nearly five times what the speed channel accounts for.
The flag is correct under its own rule, which tests the odometer's implied speed against 12.5 m/s; the words were not, so the copy now says a jump in the recorded distance.
**Do not replace the old claim with its opposite.**
What causes these is genuinely open - the clean channels above point one way, and the fact that the jumps appear on outdoor runs and never on treadmill ones, which use no GPS at all, points the other - so a hedged "nothing jumped in the GPS" is a stronger claim than the evidence supports while reading as scrupulous.
Every site names what `contains_jump` is defined on and stops there; `views/Records.tsx`, which discusses the question, carries the evidence on both sides.
The API's own `ineligible_reason` reads the same words and is displayed verbatim, because it is the analysis layer's prose and this layer does not parse or rewrite it; `ProgressionScatter.test.tsx` asserts the verbatim display rather than the wording, so the string stays the analysis layer's to change.

**The trend charts' x axis is a day number with hand-placed ticks, not uPlot's time scale.**
uPlot's `time: true` scale places its ticks at *machine-local* midnights and formats them with local getters, so the same store would tick differently on a laptop in another timezone, and its formatter is not the `MONTHS` table every other date in the application comes from.
`trendChartMath.dateAxisSplits` places month or year starts at a uniform stride instead, and `dateTickLabels` drops the month once every tick is a 1 January.
Uniform matters for the reason `streamPanelMath.paceAxisSplits` records: a ladder stepping 1, 1, 1, 2 months reads as an error even though every label on it is true.
A range holding no first-of-month gets a uniform *whole-day* ladder instead, labelled `D Mon` by `format.dayMonthLabel`, without the year because such a range only ever covers one month.
That is not a corner case: the progression chart pads a distance's history by 14 days either side, so a distance with a single mid-March effort spans 2 to 30 March and drew no date ticks at all before the fallback existed.
An empty month ladder is retried at finer strides from `MONTH_STRIDES` before the day ladder is reached, because anchoring can step over every month start in a range that holds plenty of them - a four-year span on a narrow panel picks the 60-month stride, whose multiples are one January in five - and answering that with whole days gave 106 unyeared `D Mon` ticks on a four-year axis.

**The two range filters cross a unit boundary, and `views/Activities.tsx` is where they cross it.**
The URL and the API carry metres and seconds like every other quantity in this project; a reader thinks in kilometres and minutes.
So the control renders the converted value and writes back the SI one, and nothing downstream ever sees a kilometre - which also means a shared link and an API request say the same thing.
A bound at a stop is `undefined`, which removes the filter, rather than a number: at the bottom, 0 would be a filter that happens to match everything, and the difference shows up the moment a reader clears a filter expecting it to go away, or shares the URL afterwards.
That rule belongs to the end that can reach the stop, which is why `Activities.tsx` has a `lowerAsSi` and an `upperAsSi` rather than one conversion applied twice.
The top stop is reported by the control itself, as `undefined`; a zero arriving from the *upper* handle is the bottom of its travel and a real ceiling that matches nothing, so it goes to the URL as `max_distance_m=0`.
Coercing that one away too dropped the filter while the readout still read "0 km to 0 km", which is the single state where the control contradicts the table beneath it.

**The top stop means "and above", not the number on it.**
Six of the 307 real runs are longer than 20 km and eight are longer than 2 hours, so a slider that capped at its top stop would hide real runs from a reader who had asked for none to be hidden.
`RangeFilter` reports `undefined` there and the caller drops the key, and the label reads `20 km+` and `2h+` at that stop so the behaviour is visible rather than inferred.
The bottom stop is deliberately not symmetric with it: `0 km` is a true statement about the bottom of the range and a no-op filter, while `20 km` at the top would be a false ceiling.
A bound from outside the slider's own range is reachable - a hand-edited URL, or a link shared before a stop moved - and the handle clamps to the track for it while the readout keeps saying what the filter actually is, because a control that silently renamed a 999 km floor as 20 km would leave a reader staring at an empty table with no way to see why.
Two native `<input type="range">` elements over one track is the whole implementation, with the ticks a `<datalist>` already draws; no package was added.
`pointer-events: none` on the input with `auto` on the thumb is load-bearing rather than cosmetic: without it the upper input swallows every press aimed at the lower handle, which is unreachable by pointer while the keyboard still works - the kind of half-broken that passes a unit test.
Their stacking order is the other half of that: two absolutely positioned inputs stack in DOM order, so the maximum takes every press where the two thumbs coincide, and at the top stop that is a dead end rather than an inconvenience - the upper handle is already clamped there and cannot be dragged away to uncover the other one, leaving the filter frozen at "20 km to 20 km+" for a pointer user.
The component raises the minimum input in front exactly there, where it is the only handle with room to move, and leaves the maximum in front everywhere else, where coinciding is recoverable by dragging it to the right.

**Checking a rendered map needs the maintainer's Windows browser, not headless Chromium run from inside WSL.**
A headless Chromium launched from WSL reached `127.0.0.1:8787` while the maintainer's Windows browser on the same machine, pointed at the same dev server, did not, so a map can only be confirmed by hand in the Windows browser rather than trusted from a WSL-side headless run.
Tiles are still served from the app's own origin either way: `charts/basemapStyle.ts`'s `buildStyle` builds every URL - the `pmtiles` source, the glyphs and the sprite - from `window.location.origin`, so the mismatch is in what each of the two browsers can reach on this machine's network, not in where the application looks.

**The fonts are self-hosted (`theme/fonts/`) rather than fetched from Google Fonts, for the same reason the basemap is self-hosted too: this application is offline and private.**
Both would add a network dependency an otherwise fully local application does not otherwise have, and viewing the map makes no request that leaves the machine at all - the archive is fetched once, by `activity-analysis tiles`, and every tile, glyph and sprite the page then asks for comes back from the app's own origin rather than a public tile provider that would see the athlete's home coordinates on every page load.

**A placed cursor still passes `false` to `setCursor`, and it should keep doing that even though nothing in `StreamPanel.tsx` reads a hook it might loop back through any more.**
`StreamPanel`'s `placeCursorAt` writes `chart.setCursor({...}, false)` for the reason `charts/VolumeBars.tsx` and `charts/TrendChart.tsx`'s own hover readouts already state for their own, unrelated `setCursor` hooks: passing `true` fires uPlot's `setCursor` hook, and a hook listening there cannot tell a placement the store itself asked for from a fresh pointer move.
`StreamPanel` no longer wires a `setCursor` hook at all - three rounds of trying to guard it against uPlot's own non-interactive replays (construction, `setData`, a scale change, and a stale `cursor.event` object reused on one of those) each fixed one shape of the bug and left or reintroduced another, so the moment is read from native `pointer*` events on `chart.over` instead, and cursor placement is deferred to uPlot's own `ready` hook, which fires once per chart right after its first commit gives the x scale a range - calling `setCursor` any earlier, while `chart.status` is still `0`, is what uPlot then draws at the plot's right edge, since `valToPos` returns `Infinity` until then.
`false` on `placeCursorAt`'s own call stays regardless, because a `setCursor` hook wired back into this chart in the future - the way `VolumeBars` and `TrendChart` still have their own - would otherwise read every placement as a new interaction.

**uPlot hides a chart's cursor on `mouseleave`, which a browser fires after `pointerleave`.**
`StreamPanel` clears the pointer on `pointerleave`, and the placement that follows puts every chart's cursor at whatever moment is left, a paused replay's head among them; uPlot's own `mouseleave` listener then hid the cursor of the chart just left, so that chart was the one without a line.
`onChart` adds a `mouseleave` listener of its own after uPlot's, on the same element, so it runs second, and it places the cursor again straight from the store, since a pointer that left on the head's own sample changes no moment and reruns no effect.

**A flavour switch drops every custom source and layer on the map, `route-pace` included, and fires a fresh `style.load` on the same map instance.**
`RouteMap` keeps the run's current pace pieces in a ref (`paceFeaturesRef`) for exactly that reason, so `style.load` can rebuild `route-pace` from whatever pace the panel currently holds rather than from whatever it held when the map was first built.
The replay's own reveal used to ride the same mechanism, a per-piece `line-opacity` feature-state toggled as the head advanced; it is gone now; see "Replay" above for why, and for what a flavour switch means for a replay in progress today - `style.load` only needs to re-hide the coloured line and show the outline again, gated by `styleReady`, while the growing line itself lives on `ReplayCanvas`, entirely off the map's own style.

**`touch-action: pan-y` is scoped to uPlot's own overlay element, `.u-over`, not to the panel around it.**
`StreamPanel.module.css` puts it there because `.u-over` is what actually receives the pointer events a touch drag reads the moment from, and touch's default action is decided per element: `pan-y` keeps a vertical swipe scrolling the page, and only the horizontal drag that picks the moment is this element's to take.
