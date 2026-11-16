import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PlanProse } from './PlanProse'

describe('PlanProse', () => {
  it('sets a label in bold over its list, and other lines as paragraphs', () => {
    render(<PlanProse text={'Warm-up:\n- 2 km easy\n- 4 strides\n\nKeep the reps even.'} />)

    expect(screen.getByText('Warm-up').tagName).toBe('STRONG')
    const list = screen.getByRole('list', { name: 'Warm-up' })
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['2 km easy', '4 strides'])
    expect(screen.getByText('Keep the reps even.').tagName).toBe('P')
  })

  it('as notes keeps the same structure: a label in bold over its list', () => {
    render(<PlanProse text={'Warm-up:\n- 2 km easy\n\nMain set:\n- 6 × 800 m'} variant="notes" />)

    expect(screen.getByText('Main set').tagName).toBe('STRONG')
    expect(within(screen.getByRole('list', { name: 'Warm-up' })).getByRole('listitem')).toHaveTextContent('2 km easy')
    expect(within(screen.getByRole('list', { name: 'Main set' })).getByRole('listitem')).toHaveTextContent('6 × 800 m')
  })

  it('reads a one-line description as one paragraph', () => {
    const { container } = render(<PlanProse text="Warm-up: 2 km easy, then 4 strides." />)

    expect(container.querySelectorAll('p')).toHaveLength(1)
    expect(container.querySelector('ul')).toBeNull()
  })

  it('never reads the text as markup', () => {
    const { container } = render(<PlanProse text={'<b>Fast</b>:\n- <img src=x onerror=alert(1)>'} />)

    expect(container.querySelector('b')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('<b>Fast</b>')).toBeInTheDocument()
    expect(screen.getByRole('listitem')).toHaveTextContent('<img src=x onerror=alert(1)>')
  })

  it('renders nothing for empty text', () => {
    const { container } = render(<PlanProse text={'  \n'} />)

    expect(container).toBeEmptyDOMElement()
  })
})
