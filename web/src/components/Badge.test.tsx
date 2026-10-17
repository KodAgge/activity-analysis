import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Badge } from './Badge'
import styles from './Badge.module.css'

/** A class the stylesheet defines, which Vitest's module proxy names after the key. */
function css(key: 'badge' | 'accent' | 'quiet'): string {
  const name = styles[key]
  if (name === undefined) throw new Error(`Badge.module.css has no .${key}`)
  return name
}

describe('Badge', () => {
  it('renders the text it is given', () => {
    render(<Badge>PR 400m</Badge>)

    expect(screen.getByText('PR 400m')).toBeInTheDocument()
  })

  it('is quiet by default, the tone for a caveat about the data', () => {
    render(<Badge>Treadmill</Badge>)

    const badge = screen.getByText('Treadmill')
    expect(badge).toHaveClass(css('badge'), css('quiet'))
    expect(badge).not.toHaveClass(css('accent'))
  })

  it('takes the accent tone for a fact the reader is meant to notice', () => {
    render(<Badge tone="accent">PR 5k</Badge>)

    const badge = screen.getByText('PR 5k')
    expect(badge).toHaveClass(css('badge'), css('accent'))
    expect(badge).not.toHaveClass(css('quiet'))
  })

  it('carries a native tooltip only when given one', () => {
    render(
      <>
        <Badge title="Personal record at 1k, 1mi, 3k">PR 1k 1mi 3k</Badge>
        <Badge>Steady</Badge>
      </>,
    )

    expect(screen.getByText('PR 1k 1mi 3k')).toHaveAttribute('title', 'Personal record at 1k, 1mi, 3k')
    expect(screen.getByText('Steady')).not.toHaveAttribute('title')
  })
})
