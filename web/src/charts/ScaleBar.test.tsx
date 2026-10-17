import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ScaleBar } from './ScaleBar'

describe('ScaleBar', () => {
  it('names a distance under a kilometre in metres', () => {
    render(<ScaleBar metres={500} fraction={0.2} />)
    expect(screen.getByTestId('scale-bar')).toHaveTextContent(/^500 m$/)
  })

  it('names a kilometre and above in kilometres, with no fraction', () => {
    render(<ScaleBar metres={1000} fraction={0.2} />)
    expect(screen.getByTestId('scale-bar')).toHaveTextContent(/^1 km$/)
  })

  it('names two kilometres in kilometres', () => {
    render(<ScaleBar metres={2000} fraction={0.2} />)
    expect(screen.getByTestId('scale-bar')).toHaveTextContent(/^2 km$/)
  })

  it("draws the rule at its fraction of the panel's width", () => {
    render(<ScaleBar metres={200} fraction={0.237} />)
    expect(screen.getByTestId('scale-bar-rule').style.width).toBe('23.7%')
  })
})
