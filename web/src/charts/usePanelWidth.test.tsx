import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PRINT_WIDTH_PX, usePanelWidth } from './usePanelWidth'

function Probe() {
  const [ref, width] = usePanelWidth<HTMLDivElement>()
  return <div ref={ref} data-testid="panel">{width}</div>
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('usePanelWidth', () => {
  it('caps the width at the print width when the print media query matches, and measures again on its change', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1100)
    let printing = false
    let onChange: () => void = () => {}
    vi.stubGlobal('matchMedia', (query: string) => ({
      get matches() {
        return query === 'print' && printing
      },
      media: query,
      addEventListener: (_: string, fn: () => void) => {
        if (query === 'print') onChange = fn
      },
      removeEventListener: () => {},
    }))

    render(<Probe />)
    expect(screen.getByTestId('panel')).toHaveTextContent('1100')

    printing = true
    act(() => {
      onChange()
    })
    expect(screen.getByTestId('panel')).toHaveTextContent(String(PRINT_WIDTH_PX))

    printing = false
    act(() => {
      onChange()
    })
    expect(screen.getByTestId('panel')).toHaveTextContent('1100')
  })
})
