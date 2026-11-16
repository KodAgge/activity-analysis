import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { components } from '../../api/schema'
import { PlanAssessment } from './PlanAssessment'

type Assessment = components['schemas']['Assessment']

const ASSESSMENT: Assessment = {
  summary:
    'Why it can work:\n- Volume holds at 30 km a week\n\nVerdict:\n- 20:00 is possible\n- About 2% faster than today\n\nWhat decides it:\n- The time trial',
  estimate_s: 1230,
  estimate_reasoning: 'From the store:\n- The 5 km best effort',
  verdict: 'possible',
  citations: [{ label: 'Predictions on 1 March', pointer: '/predictions/items/0' }],
}


/** Text drawn for the eye only, such as the feasibility scale's step names, which repeat the word. */
const HIDDEN = '[aria-hidden="true"], [aria-hidden="true"] *'
describe('PlanAssessment', () => {
  it('shows the feasibility and the Verdict block, and keeps the rest in a closed "Why this verdict"', () => {
    const { container } = render(<PlanAssessment assessment={ASSESSMENT} />)

    expect(screen.getByRole('heading', { level: 2, name: 'Assessment' })).toBeInTheDocument()
    expect(screen.getByText('Possible', { ignore: HIDDEN }).parentElement).toHaveTextContent('Feasibility Possible')
    // The scale says its step in words, since its dashes are drawn for the eye.
    const scale = screen.getByRole('img', {
      name: 'Feasibility: Possible, step 2 of 3 on a scale of unlikely, possible and likely',
    })
    expect(scale.querySelectorAll('[data-state="done"]')).toHaveLength(2)
    expect(scale.querySelectorAll('[data-state="todo"]')).toHaveLength(1)
    // Each step is named under its dash, the verdict's own in bold.
    const steps = scale.nextElementSibling
    expect(Array.from(steps?.children ?? []).map((s) => s.textContent)).toEqual(['Unlikely', 'Possible', 'Likely'])
    expect(steps?.querySelectorAll('[class*="stepOn"]')).toHaveLength(1)
    expect(steps?.querySelector('[class*="stepOn"]')).toHaveTextContent('Possible')
    const verdict = screen.getByRole('list', { name: 'Verdict' })
    expect(within(verdict).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      '20:00 is possible',
      'About 2% faster than today',
    ])

    const details = container.querySelector('details')
    expect(details).not.toBeNull()
    expect(details?.open).toBe(false)
    expect(details?.querySelector('summary')).toHaveTextContent('Why this verdict')
    expect(verdict.closest('details')).toBeNull()
    // Everything else sits inside the disclosure, in order.
    for (const name of ['Why it can work', 'What decides it', 'From the store']) {
      expect(screen.getByRole('list', { name, hidden: true }).closest('details')).toBe(details)
    }
    expect(details).toHaveTextContent('Cited: Predictions on 1 March')
  })

  it('a one-line summary shows whole, and the reasoning still goes behind the disclosure', () => {
    const { container } = render(
      <PlanAssessment assessment={{ ...ASSESSMENT, summary: 'Within reach but not yet likely.', citations: [] }} />,
    )
    expect(screen.getByText('Within reach but not yet likely.').closest('details')).toBeNull()
    expect(container.querySelector('details')).toHaveTextContent('The 5 km best effort')
    expect(container.querySelector('details')).not.toHaveTextContent('Cited')
  })

  it('fills the scale to the verdict: one step for unlikely, all three for likely', () => {
    const { rerender } = render(<PlanAssessment assessment={{ ...ASSESSMENT, verdict: 'unlikely' }} />)
    const unlikely = screen.getByRole('img', { name: /^Feasibility: Unlikely, step 1 of 3/ })
    expect(unlikely.querySelectorAll('[data-state="done"]')).toHaveLength(1)
    rerender(<PlanAssessment assessment={{ ...ASSESSMENT, verdict: 'likely' }} />)
    const likely = screen.getByRole('img', { name: /^Feasibility: Likely, step 3 of 3/ })
    expect(likely.querySelectorAll('[data-state="done"]')).toHaveLength(3)
  })

  it('has no disclosure when there is nothing past the verdict', () => {
    const { container } = render(
      <PlanAssessment
        assessment={{ ...ASSESSMENT, summary: 'Verdict:\n- Likely', estimate_reasoning: '', citations: [] }}
      />,
    )
    expect(container.querySelector('details')).toBeNull()
  })
})
