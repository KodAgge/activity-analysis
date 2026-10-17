import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RangeFilter } from './RangeFilter'

/**
 * The props every test here starts from. `value` is overridden per test,
 * and deliberately never set to the value a test is about to drag a handle
 * to: React suppresses a change event that does not change the input's
 * value, so a test that drags a handle to where it already is asserts
 * nothing.
 */
function renderFilter(
  value: [number, number | undefined],
  onChange: (next: [number, number | undefined]) => void = () => {},
) {
  return render(
    <RangeFilter
      label="Distance"
      min={0}
      max={20}
      step={1}
      value={value}
      onChange={onChange}
      formatValue={(v) => `${String(v)} km`}
      topLabel="20 km+"
    />,
  )
}

describe('RangeFilter', () => {
  it('reports no upper bound when the top handle is at its stop', () => {
    // Six of the 307 runs are longer than 20 km, the longest by more than a
    // quarter, so a top stop that meant "20 km" would hide real runs. It means "and
    // above", exactly as an empty box means no filter rather than zero.
    const onChange = vi.fn()
    renderFilter([0, 12], onChange)

    fireEvent.change(screen.getByLabelText('Distance, maximum'), { target: { value: '20' } })

    expect(onChange).toHaveBeenCalledWith([0, undefined])
  })

  it('reports both bounds when neither handle is at a stop', () => {
    const onChange = vi.fn()
    renderFilter([0, 20], onChange)

    fireEvent.change(screen.getByLabelText('Distance, maximum'), { target: { value: '12' } })

    expect(onChange).toHaveBeenCalledWith([0, 12])
  })

  it('shows the top stop as "and above" rather than as a number', () => {
    renderFilter([0, undefined])
    expect(screen.getByText(/20 km\+/)).toBeInTheDocument()
    // And the handle still sits at the stop, rather than nowhere.
    expect(screen.getByLabelText('Distance, maximum')).toHaveValue('20')
  })

  it('reads out both bounds in the reader\'s own unit', () => {
    renderFilter([4, 12])
    const readout = screen.getByText(/4 km/)
    expect(readout).toHaveTextContent('4 km')
    expect(readout).toHaveTextContent('12 km')
  })

  it('never lets the handles cross', () => {
    const onChange = vi.fn()
    renderFilter([10, 12], onChange)

    fireEvent.change(screen.getByLabelText('Distance, minimum'), { target: { value: '15' } })

    const [low, high] = onChange.mock.calls[0]?.[0] ?? []
    expect(low).toBeLessThanOrEqual(high ?? Number.POSITIVE_INFINITY)
  })

  it('never lets the handles cross from the other side either', () => {
    const onChange = vi.fn()
    renderFilter([10, 15], onChange)

    fireEvent.change(screen.getByLabelText('Distance, maximum'), { target: { value: '4' } })

    const [low, high] = onChange.mock.calls[0]?.[0] ?? []
    expect(low).toBeLessThanOrEqual(high ?? Number.POSITIVE_INFINITY)
  })

  it('keeps a lower bound from outside the track intact when the upper handle moves', () => {
    // A floor beyond the top stop is reachable - a hand-edited URL, or a
    // link shared before a stop moved - and its handle clamps to the track
    // while the readout keeps saying what the filter actually is. Handing
    // the clamped handle position back instead of the bound would rewrite
    // 999 km as 20 km on the first drag of the other handle.
    const onChange = vi.fn()
    renderFilter([999, 12], onChange)
    expect(screen.getByText(/999 km/)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Distance, maximum'), { target: { value: '10' } })

    expect(onChange.mock.calls[0]?.[0]?.[0]).toBe(999)
  })

  it('keeps an open upper bound open when the lower handle moves', () => {
    // Dragging the bottom handle must not quietly reimpose a ceiling the
    // reader had removed.
    const onChange = vi.fn()
    renderFilter([0, undefined], onChange)

    fireEvent.change(screen.getByLabelText('Distance, minimum'), { target: { value: '5' } })

    expect(onChange).toHaveBeenCalledWith([5, undefined])
  })

  it('reports a ceiling of zero rather than removing the bound, at the bottom of the upper handle', () => {
    // Only the top stop means "and above". Dragging the upper handle all
    // the way down is a real ceiling of zero, and the caller is the one
    // that decides what to do with it.
    const onChange = vi.fn()
    renderFilter([0, 12], onChange)

    fireEvent.change(screen.getByLabelText('Distance, maximum'), { target: { value: '0' } })

    expect(onChange).toHaveBeenCalledWith([0, 0])
  })

  it('leaves the minimum handle in front at the top stop, where the maximum has nowhere to go', () => {
    // Both handles sit at the same x with no upper bound and the lower one
    // dragged up to meet it. The maximum is clamped to the stop and cannot
    // move, so if it keeps taking every press the filter is frozen at
    // "20 km to 20 km+" for anyone not using a keyboard.
    renderFilter([20, undefined])

    const minimum = screen.getByLabelText('Distance, minimum')
    const maximum = screen.getByLabelText('Distance, maximum')
    expect(minimum).toHaveValue('20')
    expect(maximum).toHaveValue('20')
    expect(Number(minimum.style.zIndex)).toBeGreaterThan(Number(maximum.style.zIndex))
  })

  it('and the minimum, once in front, can still be dragged back off the stop', () => {
    const onChange = vi.fn()
    renderFilter([20, undefined], onChange)

    fireEvent.change(screen.getByLabelText('Distance, minimum'), { target: { value: '8' } })

    expect(onChange).toHaveBeenCalledWith([8, undefined])
  })

  it('leaves the maximum handle in front anywhere below the top stop', () => {
    // Coinciding below the stop is not a dead end - the maximum still has
    // room to the right - and the maximum stays the handle a press finds,
    // which is the conventional behaviour everywhere else on the track.
    renderFilter([10, 10])

    const minimum = screen.getByLabelText('Distance, minimum')
    const maximum = screen.getByLabelText('Distance, maximum')
    expect(Number(maximum.style.zIndex)).toBeGreaterThan(Number(minimum.style.zIndex))
  })

  it('offers tick marks, so the stops are visible rather than inferred', () => {
    const { container } = renderFilter([0, undefined])
    const list = container.querySelector('datalist')
    if (list === null) throw new Error('no datalist')
    const ticks = Array.from(list.querySelectorAll('option'), (o) => o.value)
    expect(ticks[0]).toBe('0')
    expect(ticks.at(-1)).toBe('20')
    // Both handles point at it, so the browser draws the ticks on each.
    for (const name of ['Distance, minimum', 'Distance, maximum']) {
      expect(screen.getByLabelText(name).getAttribute('list')).toBe(list.id)
    }
  })
})
