import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Replay, ReplayStatus } from '../moment/useReplay'
import { ReplayControls } from './ReplayControls'

function replay(status: ReplayStatus): Replay {
  return {
    status,
    head: status === 'idle' ? null : 10,
    speed: 1,
    play: vi.fn(),
    pause: vi.fn(),
    setSpeed: vi.fn(),
  }
}

describe('ReplayControls', () => {
  it('shows one Replay button and no speed switch while idle', () => {
    const r = replay('idle')
    render(<ReplayControls replay={r} />)
    expect(screen.getAllByRole('button')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Replay' }))
    expect(r.play).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('radiogroup', { name: 'Replay speed' })).toBeNull()
  })

  it('shows Pause and the speed switch while playing, 120x checked', () => {
    const r = replay('playing')
    render(<ReplayControls replay={r} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    expect(r.pause).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('radiogroup', { name: 'Replay speed' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '60x' })).not.toBeChecked()
    expect(screen.getByRole('radio', { name: '120x' })).toBeChecked()
    expect(screen.getByRole('radio', { name: '240x' })).not.toBeChecked()
  })

  it('shows Resume while paused, with the speed switch', () => {
    const r = replay('paused')
    render(<ReplayControls replay={r} />)
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    expect(r.play).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('radiogroup', { name: 'Replay speed' })).toBeInTheDocument()
  })

  it('sets the speed from the switch', () => {
    const r = replay('playing')
    render(<ReplayControls replay={r} />)
    fireEvent.click(screen.getByRole('radio', { name: '240x' }))
    expect(r.setSpeed).toHaveBeenCalledWith(2)
  })
})

describe('ReplayControls placement', () => {
  it('keeps the button in its corner, with the switch towards the middle, on either side', () => {
    const { container, rerender } = render(<ReplayControls replay={replay('playing')} side="right" />)
    const order = () =>
      Array.from(container.firstElementChild?.children ?? []).map((el) => (el.tagName === 'BUTTON' ? 'button' : 'switch'))
    expect(order()).toEqual(['switch', 'button'])
    rerender(<ReplayControls replay={replay('playing')} side="left" />)
    expect(order()).toEqual(['button', 'switch'])
  })

  it('keeps focus on the button when a press brings the switch in', () => {
    const { rerender } = render(<ReplayControls replay={replay('idle')} side="left" />)
    const button = screen.getByRole('button', { name: 'Replay' })
    button.focus()
    rerender(<ReplayControls replay={replay('playing')} side="left" />)
    expect(screen.getByRole('button', { name: 'Pause' })).toBe(button)
    expect(button).toHaveFocus()
  })
})
