import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PlanCard, PlanGrid } from './PlanCard'
import { ProgressDashes } from './ProgressDashes'

describe('PlanCard', () => {
  it('is a section under its own h2, with the note and the aside', () => {
    render(
      <PlanCard title="Weekly distance" note="Planned against run." aside={<span>Key</span>}>
        <p>Body</p>
      </PlanCard>,
    )
    const heading = screen.getByRole('heading', { level: 2, name: 'Weekly distance' })
    const section = heading.closest('section')
    expect(section).not.toBeNull()
    expect(section).toHaveTextContent('Planned against run.')
    expect(section).toHaveTextContent('Key')
    expect(section).toHaveTextContent('Body')
  })

  it('adds a block class to the card rather than replacing it', () => {
    render(
      <PlanCard title="History" className="mine">
        <p>Body</p>
      </PlanCard>,
    )
    const section = screen.getByRole('heading', { level: 2, name: 'History' }).closest('section')
    expect(section?.classList.contains('mine')).toBe(true)
    expect(section?.classList.length).toBe(2)
  })
})

describe('PlanGrid', () => {
  it('sets the narrowest column only when asked', () => {
    const { container } = render(
      <>
        <PlanGrid>
          <div />
        </PlanGrid>
        <PlanGrid min="16rem">
          <div />
        </PlanGrid>
      </>,
    )
    const [plain, narrow] = Array.from(container.children) as HTMLElement[]
    expect(plain?.style.getPropertyValue('--plan-row-min')).toBe('')
    expect(narrow?.style.getPropertyValue('--plan-row-min')).toBe('16rem')
  })
})

describe('ProgressDashes', () => {
  it('draws one dash per item in its state and says the row in words', () => {
    const items = ['done', 'done', 'current', 'todo', 'todo'] as const
    render(<ProgressDashes items={items} label="Week 3 of 5, 2 done" />)
    const row = screen.getByRole('img', { name: 'Week 3 of 5, 2 done' })
    const dashes = Array.from(row.querySelectorAll('[data-state]'))
    expect(dashes.map((d) => d.getAttribute('data-state'))).toEqual(['done', 'done', 'current', 'todo', 'todo'])
  })
})
