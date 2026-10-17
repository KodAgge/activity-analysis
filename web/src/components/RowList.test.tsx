import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { Row, RowList } from './RowList'

/**
 * `Row`'s `link` is a router link, so every case here mounts inside a real
 * router rather than stubbing one: a `Link` whose route does not exist
 * renders, but its `href` does not, and an assertion on the href is most of
 * what these tests are for.
 */
function renderInRouter(children: ReactNode) {
  const rootRoute = createRootRoute()
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <>{children}</>,
  })
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/activities/$activityId',
    component: () => <div>detail</div>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, detailRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  return render(<RouterProvider router={router} />)
}

describe('RowList', () => {
  it('heads the group with the title as a heading, over a list', async () => {
    renderInRouter(
      <RowList title="Best efforts">
        <Row label="5 km" value="25:00" />
      </RowList>,
    )

    // A band is how the reference draws a heading over a list; it is still a
    // heading, and a screen reader has to be able to jump to it.
    expect(await screen.findByRole('heading', { name: 'Best efforts' })).toBeInTheDocument()
    const list = screen.getByRole('list')
    expect(within(list).getByRole('listitem')).toHaveTextContent('5 km')
  })

  it('keeps the rows in the order given, which is data in every list this is for', async () => {
    renderInRouter(
      <RowList title="Ladder">
        <Row label="400 m" value="1:36" />
        <Row label="5 km" value="25:00" />
        <Row label="10 km" value="52:30" />
      </RowList>,
    )

    await screen.findByText('400 m')
    const labels = screen.getAllByRole('listitem').map((row) => row.textContent)
    expect(labels).toEqual(['400 m1:36', '5 km25:00', '10 km52:30'])
  })

  it('makes the whole row one link when it leads somewhere, and names it from its content', async () => {
    renderInRouter(
      <RowList title="Best efforts">
        <Row
          label="5 km"
          value="25:00"
          meta={['5.00 km', '160 bpm']}
          detail="5:00/km"
          link={{ to: '/activities/$activityId', params: { activityId: 'abc123abc123abc1' } }}
        />
      </RowList>,
    )

    const link = await screen.findByRole('link')
    expect(link).toHaveAttribute('href', '/activities/abc123abc123abc1')
    for (const part of ['5 km', '25:00', '5.00 km', '160 bpm', '5:00/km']) {
      expect(link).toHaveTextContent(part)
    }
  })

  it('draws no link and no chevron on a row that leads nowhere', async () => {
    renderInRouter(
      <RowList title="Totals">
        <Row label="Runs" value="307" />
      </RowList>,
    )

    await screen.findByText('Runs')
    expect(screen.queryByRole('link')).toBeNull()
    // The chevron means "this row goes somewhere", so a row that does not go
    // anywhere must not draw one.
    expect(screen.getByRole('listitem').querySelector('svg')).toBeNull()
  })

  it('hides the separators from the accessible name, so the qualifiers are read and not the punctuation', async () => {
    const { container } = renderInRouter(
      <RowList title="Best efforts">
        <Row label="5 km" value="25:00" meta={['5.00 km', '12 Oct 2025', '160 bpm']} />
      </RowList>,
    )

    await screen.findByText('5 km')
    const hidden = Array.from(container.querySelectorAll('[aria-hidden="true"]'), (el) => el.textContent)
    expect(hidden).toEqual(['·', '·'])
    // And the first fragment gets no leading separator.
    expect(screen.getByRole('listitem').textContent).toBe('5 km25:005.00 km·12 Oct 2025·160 bpm')
  })

  it('draws neither a fragment nor a dangling separator for an empty meta slot', async () => {
    // `meta` is positional so that the desktop layout can turn the run into
    // columns that line up between rows, which means a row with nothing to
    // say in one slot has to pass `null` rather than drop the entry. The run
    // then has to read as though the slot were never there.
    const { container } = renderInRouter(
      <RowList title="Best efforts">
        <Row label="5 km" value="25:00" meta={[null, '12 Oct 2025', '160 bpm']} />
        <Row label="1 mile" value="7:30" meta={['1.61 km', '16 Aug 2025', '165 bpm']} />
      </RowList>,
    )

    await screen.findByText('5 km')
    const [first, second] = screen.getAllByRole('listitem') as HTMLElement[]
    expect(first?.textContent).toBe('5 km25:0012 Oct 2025·160 bpm')
    expect(second?.textContent).toBe('1 mile7:301.61 km·16 Aug 2025·165 bpm')
    // Two separators on the row that has three fragments, one on the row
    // that has two: none is spent on the empty slot from either side.
    const hidden = Array.from(container.querySelectorAll('[aria-hidden="true"]'), (el) => el.textContent)
    expect(hidden.filter((text) => text === '·')).toHaveLength(3)
  })
})
