import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { components } from '../api/schema'
import { TerritoryReadout, TerritoryRules } from './TerritoryReadout'

type TerritoryGrowthPoint = components['schemas']['TerritoryGrowthPoint']

const counts = { outdoor_runs: 40, loop_runs: 25, claiming_runs: 20, regions: 4, parts: 9 }

function point(start: string, newM2: number, cumulative: number): TerritoryGrowthPoint {
  return {
    activity_id: start,
    start_time_utc: start,
    utc_offset_s: 7200,
    name: 'Run',
    region_id: 'r',
    enclosed_m2: newM2,
    new_m2: newM2,
    cumulative_m2: cumulative,
  }
}

const growth = [
  point('2024-03-10T14:00:00Z', 250_000, 250_000),
  point('2025-06-15T09:00:00Z', 2_000_000, 2_250_000),
  point('2026-05-03T07:00:00Z', 2_500_000, 4_750_000),
  point('2026-05-10T09:00:00Z', 1.5, 4_750_001.5),
]

function renderReadout(overrides: Partial<Parameters<typeof TerritoryReadout>[0]> = {}) {
  return render(
    <TerritoryReadout
      totalM2={4_750_001.5}
      counts={counts}
      closureMaxM={200}
      sliverRadiusM={15}
      growth={growth}
      {...overrides}
    />,
  )
}

/** jsdom answers every media query `false`, the phone layout; this makes the desktop one match. */
function asDesktop() {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: true,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('TerritoryReadout', () => {
  it('states the total in km², the unit its own element', () => {
    renderReadout()
    const value = screen.getByText('Claimed ground').nextElementSibling
    expect(value?.tagName).toBe('DD')
    expect(value).toHaveTextContent(/^4\.75 km²$/)
    const figure = value?.firstElementChild
    expect(Array.from(figure?.children ?? [], (child) => child.textContent)).toEqual(['4.75', ' km²'])
  })

  it('says how the total grew: what the last claim year added, and the latest readable gain', () => {
    renderReadout()
    const gain = screen.getByText('Claimed ground').parentElement?.querySelectorAll('dd')[1]
    // The last run added 1.5 m², which would read 0.00 km²; the one before it is named.
    expect(gain).toHaveTextContent('+2.50 km² in 2026, most recently 2.50 km² on 3 May 2026')
  })

  it('says since when instead of a year gain when every claim is in one year', () => {
    renderReadout({ growth: [point('2026-02-01T08:00:00Z', 500_000, 500_000), ...growth.slice(2)] })
    const gain = screen.getByText('Claimed ground').parentElement?.querySelectorAll('dd')[1]
    expect(gain).toHaveTextContent('Claimed since 1 Feb 2026, most recently 2.50 km² on 3 May 2026')
    expect(gain).not.toHaveTextContent(' in 2026')
  })

  it('names the one day of a single claim', () => {
    renderReadout({ growth: growth.slice(0, 1), totalM2: 250_000 })
    const gain = screen.getByText('Claimed ground').parentElement?.querySelectorAll('dd')[1]
    expect(gain).toHaveTextContent(/^Claimed on 10 Mar 2024$/)
  })

  it('says what the total rests on: the claiming runs, the loops of every outdoor run, the places', () => {
    renderReadout()
    expect(screen.getByText('Runs').parentElement).toHaveTextContent('20claimed ground')
    const loops = screen.getByText('Loops')
    expect(loops.nextElementSibling).toHaveTextContent('25 of 40')
    // The closure rule comes from the payload, not from a constant here.
    expect(loops.parentElement).toHaveTextContent('within 200 m')
    expect(screen.getByText('Places').parentElement).toHaveTextContent('49 parts')
  })

  it('says part, not parts, for one', () => {
    renderReadout({ counts: { ...counts, regions: 1, parts: 1 } })
    expect(screen.getByText('1 part')).toBeInTheDocument()
  })

  it('on a phone, carries the spark beside the total and leaves the rules to the view', () => {
    renderReadout()
    expect(screen.getByTestId('territory-growth-spark')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.queryByText('What counts, and why')).not.toBeInTheDocument()
  })

  it('on a desktop, where the chart is in sight under the map, has no spark and sets the rules under the counts', () => {
    asDesktop()
    renderReadout()
    expect(screen.queryByTestId('territory-growth-spark')).not.toBeInTheDocument()
    expect(screen.getByText('What counts, and why')).toBeInTheDocument()
  })

  it('draws no spark for a single claim, which has no shape', () => {
    renderReadout({ growth: growth.slice(0, 1), totalM2: 250_000 })
    expect(screen.queryByTestId('territory-growth-spark')).not.toBeInTheDocument()
  })
})

describe('TerritoryRules', () => {
  it('states the closure and sliver rules from the payload', () => {
    render(<TerritoryRules closureMaxM={200} sliverRadiusM={15} />)
    const body = screen.getByText(/claims ground when/)
    expect(body).toHaveTextContent('within 200 m of its first')
    expect(body).toHaveTextContent('Strips narrower than 30 m')
    expect(body).toHaveTextContent('Ground claimed twice counts once')
  })
})
