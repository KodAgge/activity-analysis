import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Section } from './Section'

describe('Section', () => {
  it('names itself with an h2, so a screen keeps one outline level per block', () => {
    render(
      <Section title="Last 12 weeks">
        <p>content</p>
      </Section>,
    )

    const heading = screen.getByRole('heading', { name: 'Last 12 weeks' })
    expect(heading.tagName).toBe('H2')
  })

  it('renders its children inside the section element', () => {
    const { container } = render(
      <Section title="Time in zone">
        <p>content</p>
      </Section>,
    )

    const section = container.querySelector('section')
    expect(section?.contains(screen.getByText('content'))).toBe(true)
  })

  it('renders a note as a caption, not as a second heading', () => {
    // "Past 12 weeks" in the reference is label-sized dim text above the
    // chart. A heading there would claim an outline level for what is a
    // caption, and a screen reader's heading list would fill with them.
    render(
      <Section title="Last 12 weeks" note="Distance run each week">
        <p>content</p>
      </Section>,
    )

    expect(screen.getByText('Distance run each week').tagName).toBe('P')
    expect(screen.getAllByRole('heading')).toHaveLength(1)
  })

  it('renders no note element when there is none', () => {
    const { container } = render(
      <Section title="Full history">
        <p>content</p>
      </Section>,
    )

    const section = container.querySelector('section')
    expect(Array.from(section?.children ?? [], (child) => child.tagName)).toEqual(['H2', 'P'])
  })

  it('marks a divided section with a class rather than an extra element', () => {
    // The rule is a pseudo-element, so it costs the layout nothing and the
    // section's own children are unchanged whether it is drawn or not.
    // jsdom applies no CSS module styles, so this asserts the hook the
    // stylesheet hangs the rule on; the rule's geometry is a screenshot's
    // job, not a unit test's.
    const plain = render(
      <Section title="A">
        <p>a</p>
      </Section>,
    ).container.querySelector('section')
    const divided = render(
      <Section title="B" divided>
        <p>b</p>
      </Section>,
    ).container.querySelector('section')

    expect(divided?.className.split(' ').length).toBe(2)
    expect(plain?.className.split(' ').length).toBe(1)
    expect(divided?.children).toHaveLength(plain?.children.length ?? 0)
  })

  it('sets an aside on the title line, outside the heading, and keeps the note a caption', () => {
    // The key belongs beside the heading, not in it: a screen reader's
    // heading list should still read "Growth" alone.
    const { container } = render(
      <Section title="Growth" note="Claimed ground after each run" aside={<span>5 runs in Jönköping</span>}>
        <p>content</p>
      </Section>,
    )

    expect(screen.getByRole('heading', { name: 'Growth' })).toBeInTheDocument()
    const head = screen.getByRole('heading').parentElement
    expect(head?.contains(screen.getByText('5 runs in Jönköping'))).toBe(true)
    expect(head?.nextElementSibling).toBe(screen.getByText('Claimed ground after each run'))
    expect(container.querySelector('section')?.contains(head ?? null)).toBe(true)
  })
})
