import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import type { components } from '../api/schema'
import { Decoupling } from './Decoupling'

type DecouplingOut = components['schemas']['DecouplingOut']

/** The section links to /trends, so it mounts inside a real router; see RowList.test.tsx. */
function renderInRouter(children: ReactNode) {
  const rootRoute = createRootRoute()
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => <>{children}</> })
  const trendsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/trends', component: () => <div>trends</div> })
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, trendsRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  return render(<RouterProvider router={router} />)
}

/** The 2026-08-28 reference run, from the fixture store. */
function referenceRun(overrides: Partial<DecouplingOut> = {}): DecouplingOut {
  return {
    decoupling_pct: 13.076,
    first_half_speed_mps: 2.5574,
    second_half_speed_mps: 2.4451,
    first_half_hr_bpm: 148.41,
    second_half_hr_bpm: 163.24,
    is_aerobic_long_run: true,
    outside_population_reason: null,
    ...overrides,
  }
}

const OUTSIDE =
  'Under 40 fitted minutes, so this measures the session rather than the athlete: aerobic durability is read on easy or steady runs of 40 minutes or more.'

describe('Decoupling', () => {
  it('reads a population run against the 5% line and links to the trend', async () => {
    renderInRouter(<Decoupling decoupling={referenceRun()} absentReason={null} />)
    expect(await screen.findByText('+13.1%')).toBeInTheDocument()
    expect(screen.getByText('Above the 5% durability line')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Decoupling trend' })).toHaveAttribute('href', '/trends#decoupling')
  })

  it("shows each half's pace and heart rate in a table", async () => {
    renderInRouter(<Decoupling decoupling={referenceRun()} absentReason={null} />)
    const table = await screen.findByRole('table')
    expect(table).toHaveTextContent('First half')
    expect(table).toHaveTextContent('Second half')
    // 1000 / 2.5574 = 391.0 s = 6:31; 1000 / 2.4451 = 409.0 s = 6:49.
    expect(screen.getByRole('row', { name: /Pace/ })).toHaveTextContent('6:31/km')
    expect(screen.getByRole('row', { name: /Pace/ })).toHaveTextContent('6:49/km')
    expect(screen.getByRole('row', { name: /Heart rate/ })).toHaveTextContent('148 bpm')
    expect(screen.getByRole('row', { name: /Heart rate/ })).toHaveTextContent('163 bpm')
  })

  it('states why a run outside the population is not a durability reading, in the open', async () => {
    renderInRouter(
      <Decoupling
        decoupling={referenceRun({ decoupling_pct: 4.68, is_aerobic_long_run: false, outside_population_reason: OUTSIDE })}
        absentReason={null}
      />,
    )
    // Visible text, not a disclosure or a popover: it is what makes the number honest.
    expect(await screen.findByText(OUTSIDE)).toBeVisible()
    expect(screen.queryByText(/durability line/)).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Decoupling trend' })).not.toBeInTheDocument()
  })

  it('treats a null population flag as not known, and does not read the 5% line', async () => {
    const unknown =
      "Whether this run is one durability is read on is not known until 'activity-analysis recompute' rewrites the store."
    renderInRouter(
      <Decoupling
        decoupling={referenceRun({ is_aerobic_long_run: null, outside_population_reason: unknown })}
        absentReason={null}
      />,
    )
    expect(await screen.findByText(unknown)).toBeVisible()
    expect(screen.queryByText(/durability line/)).not.toBeInTheDocument()
  })

  it('states the absent reason verbatim when the run has no value', async () => {
    renderInRouter(<Decoupling decoupling={null} absentReason="An interval session, which the efficiency fit leaves out." />)
    expect(await screen.findByRole('note')).toHaveTextContent('An interval session, which the efficiency fit leaves out.')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
})
