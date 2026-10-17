import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMomentStore, MomentContext } from '../moment/momentStore'
import { RouteHero } from './RouteHero'
import styles from './RouteHero.module.css'

/** A class the stylesheet defines, which Vitest's module proxy names after the key. */
function css(key: 'momentLabel' | 'momentLabelBelowTop'): string {
  const name = styles[key]
  if (name === undefined) throw new Error(`RouteHero.module.css has no .${key}`)
  return name
}

// `cssVar` resolves a token through `getComputedStyle`, which jsdom cannot -
// see `StreamPanel.test.tsx`'s own copy of this mock. Wrapped as `var(...)`
// - see `ActivityDetail.test.tsx`'s own copy of this mock for why.
vi.mock('../charts/cssVar', () => ({ cssVar: (name: string) => `var(${name})` }))

/**
 * `RouteMap` is a lazy chunk, replaced with a prop-recording spy so this
 * file can see what `RouteHero` hands it without MapLibre or a real
 * dynamic import - the same boundary `ActivityDetail.test.tsx` draws
 * around it.
 */
const { routeMapCalls } = vi.hoisted(() => ({ routeMapCalls: [] as Record<string, unknown>[] }))
vi.mock('../charts/RouteMap', () => ({
  default: (props: Record<string, unknown>) => {
    routeMapCalls.push(props)
    return <div data-testid="route-map-stub" />
  },
}))

const lat = [57.7, 57.71, 57.72]
const lon = [14.1, 14.11, 14.12]
const speed = [3.0, 3.2, 3.4]
const paused = [false, false, false]
const outage = [false, false, false]

const basemap = { areas: [{ id: 'abc', west: -180, south: -90, east: 180, north: 90 }], attribution: 'attr' }

describe('RouteHero', () => {
  it(
    "keeps the pace it hands the map at the same identity across a re-render that wraps the " +
      "same arrays in new objects, so a re-render that changes nothing this hero actually draws " +
      'does not tear down and rebuild the map',
    async () => {
      // `ActivityDetail` builds fresh `trace`/`activity` object literals on
      // every render even though the arrays inside - `lat`, `lon`, `speed`,
      // `paused`, `outage` here - come from the query cache and are
      // otherwise stable. `RouteMap`'s own build effect has `pace` as a
      // dependency (see `RouteMap.tsx`), so a `pace` that churned identity
      // on every such render would rebuild the whole MapLibre map on it.
      const { rerender } = render(
        <RouteHero
          trace={{ lat, lon }}
          activity={{ t: [0, 1, 2], distance: [0, 3, 6], speed, paused, outage }}
          basemap={basemap}
        />,
      )
      await screen.findByTestId('route-map-stub')
      const firstPace = routeMapCalls.at(-1)?.['pace']
      expect(firstPace).toBeDefined()

      rerender(
        <RouteHero
          trace={{ lat, lon }}
          activity={{ t: [0, 1, 2], distance: [0, 3, 6], speed, paused, outage }}
          basemap={basemap}
        />,
      )
      const secondPace = routeMapCalls.at(-1)?.['pace']

      expect(secondPace).toBe(firstPace)
    },
  )

  it('draws the trace in the stopped colour, with no ramp to draw a legend from, for a run with no moving speed', async () => {
    // `speed`, all null: `paceScaleEnds` finds no moving second at all and
    // returns null, but the route still colours - see `RouteHero.tsx`'s
    // `pace` memo.
    render(
      <RouteHero
        trace={{ lat, lon }}
        activity={{ t: [0, 1, 2], distance: [0, 3, 6], speed: [null, null, null], paused, outage }}
        basemap={basemap}
      />,
    )
    await screen.findByTestId('route-map-stub')

    const pace = routeMapCalls.at(-1)?.['pace'] as
      | { pieces: { step: number | null }[]; stoppedColour: string }
      | undefined
    expect(pace).toBeDefined()
    expect(pace?.pieces.length).toBeGreaterThan(0)
    expect(pace?.pieces.every((piece) => piece.step === null)).toBe(true)
    expect(pace?.stoppedColour).toBe('var(--pace-map-stopped)')
    expect(screen.queryByTestId('pace-legend')).toBeNull()
  })

  describe('the moment label', () => {
    /**
     * The label's own render doesn't depend on the store React normally
     * gets from `MomentProvider` - a plain `createMomentStore` with the
     * pointer set before the first render puts the moment straight into
     * `RouteHero`'s first read, no `act()` needed.
     */
    function renderWithMoment(index: number, basemapProp: Parameters<typeof RouteHero>[0]['basemap']) {
      const store = createMomentStore()
      store.setPointer(index)
      render(
        <MomentContext.Provider value={store}>
          <RouteHero
            trace={{ lat, lon }}
            activity={{ t: [0, 1, 2], distance: [0, 3, 6], speed, paused, outage }}
            basemap={basemapProp}
          />
        </MomentContext.Provider>,
      )
    }

    it('offsets toward the back control when a covering area exists, where the switch is the only thing that can share its row', () => {
      renderWithMoment(1, basemap)

      const label = screen.getByTestId('moment-label')
      expect(label).toHaveClass(css('momentLabel'))
      expect(label).not.toHaveClass(css('momentLabelBelowTop'))
    })

    it('drops below the top row when there is no covering area, where the pace legend - not a fixed-width switch - shares it instead', () => {
      renderWithMoment(1, { areas: [], attribution: 'attr' })

      const label = screen.getByTestId('moment-label')
      expect(label).toHaveClass(css('momentLabel'), css('momentLabelBelowTop'))
    })
  })

  describe('the replay', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    // 121 moving seconds: the whole replay is 1 s at 120x.
    const n = 121
    const long = {
      lat: Array.from({ length: n }, (_, i) => 57.7 + i * 0.0001),
      lon: Array.from({ length: n }, (_, i) => 14.1 + i * 0.0001),
      t: Array.from({ length: n }, (_, i) => i),
      distance: Array.from({ length: n }, (_, i) => i * 3),
      speed: Array.from({ length: n }, () => 3),
      paused: Array.from({ length: n }, () => false),
      outage: Array.from({ length: n }, () => false),
    }

    function renderHero(withActivity: boolean) {
      const store = createMomentStore()
      render(
        <MomentContext.Provider value={store}>
          <RouteHero
            trace={{ lat: long.lat, lon: long.lon }}
            activity={withActivity ? long : undefined}
            basemap={basemap}
          />
        </MomentContext.Provider>,
      )
      return store
    }

    it('offers a replay for a run, and none for the route view', async () => {
      renderHero(false)
      await act(async () => {})
      expect(screen.queryByRole('button', { name: 'Replay' })).toBeNull()
    })

    it('hands the head to the map and shows the speed in the label while playing', async () => {
      const store = renderHero(true)
      await act(async () => {})
      expect(routeMapCalls.at(-1)?.['replayHead']).toBeNull()

      fireEvent.click(screen.getByRole('button', { name: 'Replay' }))
      act(() => {
        vi.advanceTimersByTime(500)
      })
      const head = routeMapCalls.at(-1)?.['replayHead']
      expect(typeof head).toBe('number')
      expect(store.getSnapshot().replay).toBe(head)
      expect(screen.getByTestId('moment-label')).toHaveTextContent(/ · 120x$/)

      fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
      expect(screen.getByTestId('moment-label')).not.toHaveTextContent('120x')
      expect(routeMapCalls.at(-1)?.['replayHead']).toBe(head)

      fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
      act(() => {
        vi.advanceTimersByTime(1000)
      })
      expect(routeMapCalls.at(-1)?.['replayHead']).toBeNull()
      expect(screen.queryByTestId('moment-label')).toBeNull()
      expect(screen.getByRole('button', { name: 'Replay' })).toBeInTheDocument()
    })
  })
})
