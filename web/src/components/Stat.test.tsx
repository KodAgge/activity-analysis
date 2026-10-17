import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { NO_VALUE, distanceMeasure } from '../format'
import { Stat, StatGroup } from './Stat'

/**
 * The stat primitive is shared by five screens, so the things asserted
 * here are the things a later screen is entitled to rely on: the markup is
 * a valid description list, the unit is a separate element from the
 * number, and a missing value carries no unit at all.
 */

function group(children: React.ReactNode) {
  return render(<StatGroup>{children}</StatGroup>)
}

describe('Stat', () => {
  it('renders the label and the value as one term and one description', () => {
    const { container } = group(<Stat label="This week" value={distanceMeasure(8000)} />)

    expect(screen.getByText('This week').tagName).toBe('DT')
    expect(container.querySelector('dd')?.textContent).toBe('8.00 km')
  })

  it('sets the unit in its own element, not stapled into the number', () => {
    // The whole reason `format` exposes a `Measure`: the number and the
    // unit have to be two boxes so the number can carry
    // `font-variant-numeric` and the unit cannot, and so a later screen
    // can subordinate the unit from one place. A component that received
    // "8.00 km" as a single string could not do either without splitting a
    // formatted value, which `src/format` exists to prevent.
    const { container } = group(<Stat label="This week" value={distanceMeasure(8000)} />)

    const dd = container.querySelector('dd')
    const parts = Array.from(dd?.children ?? [], (child) => child.textContent)
    expect(parts).toEqual(['8.00', ' km'])
  })

  it('renders no unit element at all when the value is missing', () => {
    // Never "– km". A missing number has nothing to be the unit of.
    const { container } = group(<Stat label="This week" value={distanceMeasure(null)} />)

    const dd = container.querySelector('dd')
    expect(dd?.textContent).toBe(NO_VALUE)
    expect(dd?.children).toHaveLength(1)
  })

  it('accepts a bare string for a value that has no unit to separate', () => {
    const { container } = group(<Stat label="Consistency" value="48 of 52" />)

    expect(container.querySelector('dd')?.textContent).toBe('48 of 52')
  })

  it('renders a detail as a second description of the same term, never a paragraph', () => {
    // Inside a `<dl>`, a group wrapper may contain only `<dt>` and `<dd>`
    // children. A `<p>` here is invalid markup that a parser is free to
    // reparent, which is how a detail line ends up outside the stat it
    // belongs to.
    const { container } = group(
      <Stat label="Longest streak" value="30 weeks" detail="through 10 November 2025" />,
    )

    const wrapper = screen.getByText('Longest streak').parentElement
    expect(wrapper?.tagName).toBe('DIV')
    expect(Array.from(wrapper?.children ?? [], (child) => child.tagName)).toEqual([
      'DT',
      'DD',
      'DD',
    ])
    expect(container.querySelector('p')).toBeNull()
    expect(screen.getByText('through 10 November 2025').tagName).toBe('DD')
  })

  it('omits the detail element entirely when there is none, rather than rendering an empty one', () => {
    const wrapper = group(<Stat label="This week" value="8.00 km" />).container
      .firstElementChild?.firstElementChild
    expect(Array.from(wrapper?.children ?? [], (child) => child.tagName)).toEqual(['DT', 'DD'])
  })
})

describe('StatGroup', () => {
  it('is a description list, because a set of named values is one', () => {
    const { container } = group(<Stat label="This week" value="8.00 km" />)
    expect(container.firstElementChild?.tagName).toBe('DL')
  })

  it('renders every child as its own group', () => {
    const { container } = group(
      <>
        <Stat label="One" value="1" />
        <Stat label="Two" value="2" />
        <Stat label="Three" value="3" />
        <Stat label="Four" value="4" />
        <Stat label="Five" value="5" share="half" />
      </>,
    )
    expect(container.querySelectorAll('dt')).toHaveLength(5)
    expect(container.firstElementChild?.children).toHaveLength(5)
  })
})

describe('every stat is the same object', () => {
  /**
   * jsdom applies no CSS module styles, so what is asserted here is the
   * hook the stylesheet hangs the reservation on rather than a rendered
   * height. The height itself is a screenshot's job, and was measured.
   *
   * Vite hashes a CSS module's class names, so the name is matched as a
   * substring of the generated one rather than compared whole.
   */
  function classes(element: Element | null | undefined): string {
    return element?.className ?? ''
  }
  it('reserves the caption line on the stats of a group where something has a caption', () => {
    // Two neighbouring cells in one row coming out different heights - one
    // with a caption, one without - is what both round-1 critics named.
    const cells = group(
      <>
        <Stat label="A" value="1" detail="a caption" />
        <Stat label="B" value="2" />
        <Stat label="C" value="3" />
      </>,
    ).container.querySelectorAll('dl > div')

    // The one that has a caption does not need the line held open: it is
    // drawing on it.
    expect(classes(cells[0])).not.toMatch(/reserved/)
    expect(classes(cells[1])).toMatch(/reserved/)
    expect(classes(cells[2])).toMatch(/reserved/)
  })

  it('reserves nothing in a group where no stat has a caption', () => {
    // The reservation is there to keep one row's cells the same object.
    // Where no caption exists anywhere in the group there is no raggedness
    // to prevent, and reserving anyway is dead air: measured on the
    // activity detail screen at 412px, 16px of surplus on every row pitch
    // and another 21px hanging under the last row.
    const cells = group(
      <>
        <Stat label="A" value="1" />
        <Stat label="B" value="2" />
      </>,
    ).container.querySelectorAll('dl > div')

    expect(classes(cells[0])).not.toMatch(/reserved/)
    expect(classes(cells[1])).not.toMatch(/reserved/)
  })

  it('finds a caption that arrives through a fragment or a mapped array', () => {
    // How the activity feed card builds its stats. A walk that only looked
    // at `StatGroup`'s immediate children would see one array and no
    // caption, and the group would come out ragged - which is the failure
    // mode a per-caller flag has too, and the reason the group works this
    // out itself.
    const cells = group(
      <>
        {[
          <Stat key="a" label="A" value="1" />,
          <Stat key="b" label="B" value="2" detail="a caption" />,
        ]}
      </>,
    ).container.querySelectorAll('dl > div')

    expect(classes(cells[0])).toMatch(/reserved/)
    expect(classes(cells[1])).not.toMatch(/reserved/)
  })

  it('marks the group itself, because its row gap depends on the same answer', () => {
    // Rows that are 21px taller for the reserved line need less between
    // them than rows that are not: 8px against 16. Both live in
    // `Stat.module.css` and both hang off this one class.
    const captioned = group(<Stat label="A" value="1" detail="a caption" />).container
    const plain = group(<Stat label="A" value="1" />).container

    expect(classes(captioned.querySelector('dl'))).toMatch(/captioned/)
    expect(classes(plain.querySelector('dl'))).not.toMatch(/captioned/)
  })

  it('treats a caption that computed to undefined as no caption at all', () => {
    // `StatRail` passes `detail={... ? undefined : text}`. The group's test
    // and the stat's own have to be the same test, or a group can mark
    // itself captioned while every stat in it reserves.
    const cells = group(
      <>
        <Stat label="A" value="1" detail={undefined} />
        <Stat label="B" value="2" />
      </>,
    ).container.querySelectorAll('dl > div')

    expect(classes(cells[0])).not.toMatch(/reserved/)
    expect(classes(cells[1])).not.toMatch(/reserved/)
  })

  it('does not reserve it by rendering an empty description', () => {
    // An empty `<dd>` is a term announced as having a blank description.
    // Reserving space is a layout concern and stays in the stylesheet.
    const { container } = group(<Stat label="B" value="2" />)
    expect(container.querySelectorAll('dd')).toHaveLength(1)
  })

  it('takes a third of the group by default, and the share it is given otherwise', () => {
    // A row fills as three thirds, as two thirds and a third, as two
    // halves, or as one full-width stat. Five stats fill two rows exactly
    // on the first of those plus the second; a fixed three-wide grid could
    // only do it by leaving a sixth cell empty.
    const byDefault = group(<Stat label="A" value="1" />).container
    const asTwoThirds = group(<Stat label="B" value="2" share="two-thirds" />).container
    const asHalf = group(<Stat label="C" value="3" share="half" />).container
    const asFull = group(<Stat label="D" value="4" share="full" />).container

    expect(classes(byDefault.querySelector('dl > div'))).toMatch(/third/)
    expect(classes(asTwoThirds.querySelector('dl > div'))).toMatch(/twoThirds/)
    expect(classes(asHalf.querySelector('dl > div'))).toMatch(/half/)
    expect(classes(asFull.querySelector('dl > div'))).toMatch(/full/)
  })
})
