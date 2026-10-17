import { useQuery } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { Component, Fragment, Suspense, lazy, useEffect, useRef, type ReactNode } from 'react'
import { describeApiError } from '../api/errors'
import { queries } from '../api/queries'
import type { components } from '../api/schema'
import { validateTerritorySearch } from '../api/territorySearch'
import { TerritoryGrowth } from '../charts/TerritoryGrowth'
import { chosenRegion, regionClaimSpan } from '../charts/territoryMath'
import { Absent } from '../components/Absent'
import { Section } from '../components/Section'
import { TerritoryReadout, TerritoryRules } from '../components/TerritoryReadout'
import { area, areaMeasure, metresLabel, runCount, shortLocalDate } from '../format'
import styles from './Territory.module.css'
import { DESKTOP_LAYOUT_QUERY, useMediaQuery } from './useMediaQuery'

type Territory = components['schemas']['Territory']
type TerritoryRegion = components['schemas']['TerritoryRegion']
type TerritoryGrowthPoint = components['schemas']['TerritoryGrowthPoint']

/** MapLibre is a lazy chunk here as on the route hero: it should arrive with the map, not with every view. */
const TerritoryMap = lazy(() => import('../charts/TerritoryMap'))

/** A chunk that fails to load throws during render, which `Suspense` alone does not catch. */
class MapErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    return this.state.failed ? (
      <Absent label="No map" reason="The map could not be loaded. Reloading the page may bring it back." />
    ) : (
      this.props.children
    )
  }
}

/**
 * Every outdoor run that closed a loop claims the ground it enclosed, and
 * this is all of it: the total, the map of it, its places and how it grew.
 *
 * On a desktop it is the activity view's two columns: the map on the
 * left, as tall as the window leaves under the growth chart, and the
 * title, the total and the list of places on the right, so the ground,
 * how much of it there is, where it lies and when it was claimed are on
 * one screen. Choosing a place fits the map to it and marks its runs on
 * the growth chart; clicking a step on the chart chooses its place. On a
 * phone the map leads instead, as the activity view's route hero does,
 * and takes most of the screen; the total and the growth follow it.
 *
 * Nothing here is computed: the ground, its areas and its regions are
 * `analysis/territory.py`'s, read through `GET /api/territory`, and only
 * converted to km² for display.
 */
export function Territory() {
  const rawSearch = useSearch({ strict: false })
  const { region: regionId } = validateTerritorySearch(rawSearch as Record<string, unknown>)
  const territory = useQuery(queries.territory())
  const navigate = useNavigate()
  const wide = useMediaQuery(DESKTOP_LAYOUT_QUERY)

  if (territory.isPending) {
    return (
      <div className={styles.territory}>
        <h1>Territory</h1>
        <p className={styles.status}>Loading the territory…</p>
      </div>
    )
  }

  if (territory.isError) {
    return (
      <div className={styles.territory}>
        <h1>Territory</h1>
        <p role="alert" className={styles.status}>
          Could not load the territory: {describeApiError(territory.error)}
        </p>
      </div>
    )
  }

  const data = territory.data
  const region = chosenRegion(data.regions, regionId)

  if (region === undefined) {
    return (
      <div className={styles.territory}>
        <h1>Territory</h1>
        <Absent
          label="No ground claimed yet"
          reason={
            `A run claims the ground it encloses when it ends within ${metresLabel(data.closure_max_m)} ` +
            `of where it started. ${noClaimReason(data)}`
          }
        />
      </div>
    )
  }

  // The choice lives in the URL as `?region=`, replacing the history entry
  // rather than pushing one, the way the other views' controls do, so a
  // place can be linked to and the back button leaves the view.
  const choose = (id: string) => {
    void navigate({ to: '/territory', search: { region: id }, replace: true })
  }

  const readout = (
    <TerritoryReadout
      totalM2={data.total_area_m2}
      counts={data.counts}
      closureMaxM={data.closure_max_m}
      sliverRadiusM={data.sliver_radius_m}
      growth={data.growth}
    />
  )
  const growth = (
    <TerritoryGrowth growth={data.growth} regions={data.regions} markedRegionId={region.region_id} onSelectRegion={choose} />
  )
  // One title, note and key for the chart at both widths.
  const growthNote = `The claimed ground after each of the ${runCount(data.counts.claiming_runs)} that enclosed some, since ${firstClaimDay(data)}.`
  const marks = data.regions.length > 1 ? <RunMarks region={region} /> : undefined

  if (wide) {
    // The title and the total come first in the document, as they read, and
    // the grid puts the map to their left, where the activity view has its
    // route.
    return (
      <div className={`${styles.territory} ${styles.desk}`}>
        <div className={styles.side}>
          <header className={styles.head}>
            <h1>Territory</h1>
            {readout}
          </header>
          {data.regions.length > 1 ? (
            <Section title="Places" note="Largest first, each with the ground it holds." divided>
              <PlacePicker regions={data.regions} region={region} growth={data.growth} onChoose={choose} wide />
            </Section>
          ) : (
            <Section title={placeTitle(region)} note={placeNote(data, region)} divided>
              {null}
            </Section>
          )}
        </div>
        <div className={styles.stage}>
          <MapFrame data={data} region={region} onChoose={choose} />
          {/* Undivided: it sits in the map's column, under the map's card,
              not under a section of its own column. */}
          <Section title="Growth" note={growthNote} aside={marks}>
            {growth}
          </Section>
        </div>
      </div>
    )
  }

  // On a phone the map leads, as the activity view's route hero does, and
  // the total and its stats follow it under a rule: what was claimed comes
  // first and gets most of the screen, how much is a scroll below.
  return (
    <div className={styles.territory}>
      <section className={styles.hero} aria-labelledby={PLACE_TITLE_ID}>
        <div className={styles.place}>
          {data.regions.length > 1 && (
            <PlacePicker regions={data.regions} region={region} growth={data.growth} onChoose={choose} wide={false} />
          )}
          <MapFrame data={data} region={region} onChoose={choose} />
        </div>
        <div className={styles.heroHead}>
          <div className={styles.heroName}>
            <h2 id={PLACE_TITLE_ID} className={styles.heroTitle}>
              {placeTitle(region)}
            </h2>
            <p className={styles.heroNote}>{placeClaims(data, region)}</p>
          </div>
          <PlaceGround data={data} region={region} />
        </div>
      </section>
      <header className={`${styles.head} ${styles.headUnderHero}`}>
        <h1>Territory</h1>
        {readout}
      </header>
      <Section title="Growth" note={growthNote} aside={marks} divided>
        {growth}
        <TerritoryRules closureMaxM={data.closure_max_m} sliverRadiusM={data.sliver_radius_m} />
      </Section>
    </div>
  )
}

/**
 * The local day of a region's only claim, or its first and last, each day
 * held on one line: at 360 px the phone's note broke a day as `3 May / 2026`.
 */
function claimDays(first: TerritoryGrowthPoint, last: TerritoryGrowthPoint): string {
  const day = (point: TerritoryGrowthPoint) =>
    shortLocalDate(point.start_time_utc, point.utc_offset_s).replaceAll(' ', NO_BREAK_SPACE)
  if (first === last) return day(first)
  return `${day(first)} to ${day(last)}`
}

const NO_BREAK_SPACE = '\u00a0'

/** The local day of the first claim of all, held on one line. */
function firstClaimDay(data: Territory): string {
  const first = data.growth[0]
  return first === undefined ? '' : shortLocalDate(first.start_time_utc, first.utc_offset_s).replaceAll(' ', NO_BREAK_SPACE)
}

function placeTitle(region: TerritoryRegion): string {
  return region.country === null ? region.name : `${region.name}, ${region.country}`
}

/** The chosen place's runs and the local days of its first and last claim. */
function placeClaims(data: Territory, region: TerritoryRegion): string {
  const span = regionClaimSpan(data.growth, region.region_id)
  return runCount(region.claim_count) + (span === null ? '' : `, ${claimDays(span.first, span.last)}`)
}

/** Under the single place's title on a desktop: its ground, runs and days. */
function placeNote(data: Territory, region: TerritoryRegion): string {
  return `${area(region.area_m2)} from ${placeClaims(data, region)}`
}

/**
 * The chosen place's ground as the phone hero's figure, at the stat size
 * and set against its name as intvl's planner sets its `CAPTURE` against
 * the map, with the whole territory under it: the phone's first screen
 * otherwise says how much this place holds and not how much there is.
 */
function PlaceGround({ data, region }: { data: Territory; region: TerritoryRegion }) {
  const ground = areaMeasure(region.area_m2)
  return (
    <p className={styles.heroFigure}>
      <span className={styles.heroValue}>
        {ground.value}
        {ground.unit !== null && <span className={styles.heroUnit}> {ground.unit}</span>}
      </span>
      {data.regions.length > 1 && <span className={styles.heroOf}>of {area(data.total_area_m2)}</span>}
    </p>
  )
}

/** Why a store with outdoor runs has no ground, in the payload's own counts. */
function noClaimReason(data: Territory): string {
  const { outdoor_runs: outdoor, loop_runs: loops } = data.counts
  if (outdoor === 0) return 'This store has no outdoor run with a recorded position.'
  if (loops === 0) return `None of the ${String(outdoor)} outdoor runs did.`
  return `${runCount(loops)} did, but each enclosed only strips too thin to count.`
}

/**
 * The key to the ticks `TerritoryGrowth` draws under its line: one tick
 * per run of the chosen place, drawn the same way here, on the Growth
 * heading's line as the activity view's Pace heading carries its average.
 */
function RunMarks({ region }: { region: TerritoryRegion }) {
  return (
    <span className={styles.marks}>
      <span className={styles.markSwatch} aria-hidden="true" />
      {runCount(region.claim_count)} in {region.name}
    </span>
  )
}

interface PlacePickerProps {
  regions: readonly TerritoryRegion[]
  region: TerritoryRegion
  growth: readonly TerritoryGrowthPoint[]
  onChoose: (regionId: string) => void
  wide: boolean
}

/**
 * A radio per place, largest first, composed from the Progression view's
 * distance picker so the two pickers stay one control.
 *
 * On a phone it is a row of pills floating over the map's top edge. On a
 * desktop it is the list beside the map: one row per place with a bar of
 * its ground against the largest, the shape of the zone rows on the
 * Overview, and its km², so where the ground lies is read at a glance; the
 * chosen row, in the navigation rail's accent tint, adds its country, its
 * runs and the days of its first and last claim.
 *
 * The group's `Place` legend is spoken but not shown: on a desktop the
 * section title says it, and on a phone the place's name under the map.
 */
function PlacePicker({ regions, region, growth, onChoose, wide }: PlacePickerProps) {
  const chosenPillRef = useRef<HTMLLabelElement | null>(null)
  const largest = Math.max(...regions.map((r) => r.area_m2))

  // Bring the chosen place into view in a row that scrolls on a phone, as
  // the Progression view does for its distance.
  useEffect(() => {
    const pill = chosenPillRef.current
    if (pill === null || typeof pill.scrollIntoView !== 'function') return
    pill.scrollIntoView({ block: 'nearest', inline: 'center' })
  }, [region.region_id])

  return (
    <fieldset className={styles.picker}>
      <legend className={styles.srOnly}>Place</legend>
      <div className={styles.pills}>
        {regions.map((r) => {
          const chosen = r.region_id === region.region_id
          return (
            <label key={r.region_id} className={styles.pill} ref={chosen ? chosenPillRef : null}>
              <input
                className={styles.pillInput}
                type="radio"
                name="territory-region"
                value={r.region_id}
                checked={chosen}
                onChange={() => onChoose(r.region_id)}
              />
              <span className={styles.pillBody}>
                <span className={styles.pillName}>{r.name}</span>{' '}
                {wide && (
                  <span className={styles.pillBar} aria-hidden="true">
                    <span
                      className={styles.pillBarFill}
                      style={{ width: `${String(largest > 0 ? (100 * r.area_m2) / largest : 0)}%` }}
                    />
                  </span>
                )}
                <span className={styles.pillArea}>{area(r.area_m2)}</span>
                {wide && chosen && (
                  <>
                    {' '}
                    <PlaceDetail region={r} growth={growth} />
                  </>
                )}
              </span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}

/** The chosen row's second line: country, runs, and the days of its claims. */
function PlaceDetail({ region, growth }: { region: TerritoryRegion; growth: readonly TerritoryGrowthPoint[] }) {
  const span = regionClaimSpan(growth, region.region_id)
  const parts = [
    region.country,
    runCount(region.claim_count),
    span === null ? null : claimDays(span.first, span.last),
  ].filter((part): part is string => part !== null)
  // Flat siblings, so the spaces either side of each hidden dot are text
  // in the line itself, and what a screen reader hears between the parts.
  return (
    <span className={styles.pillDetail}>
      {parts.map((part, index) => (
        <Fragment key={part}>
          {index > 0 && (
            <>
              {' '}
              <span aria-hidden="true">·</span>{' '}
            </>
          )}
          {part}
        </Fragment>
      ))}
    </span>
  )
}

/** The map's frame, the basemap manifest it waits on, and the lazy map in it. */
function MapFrame({ data, region, onChoose }: { data: Territory; region: TerritoryRegion; onChoose: (id: string) => void }) {
  const basemap = useQuery(queries.basemap())
  return (
    <div className={styles.mapFrame}>
      {basemap.isPending ? (
        <p className={styles.mapPending}>Loading the map…</p>
      ) : (
        <MapErrorBoundary>
          <Suspense fallback={<p className={styles.mapPending}>Loading the map…</p>}>
            <TerritoryMap
              territory={data.territory}
              region={region}
              regions={data.regions}
              onSelectRegion={onChoose}
              // A failed manifest leaves the ground on plain background
              // rather than no map at all.
              areas={basemap.data?.areas ?? []}
              attribution={basemap.data?.attribution ?? ''}
            />
          </Suspense>
        </MapErrorBoundary>
      )}
    </div>
  )
}

/** The phone hero's heading, which names its section. */
const PLACE_TITLE_ID = 'territory-place'
