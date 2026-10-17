import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useElementHeight } from './useElementHeight'

type Entry = { borderBoxSize: { blockSize: number }[] }

let report: ((entries: Entry[]) => void) | null
let observed: Element[]
let disconnects: number

beforeEach(() => {
  report = null
  observed = []
  disconnects = 0
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: (entries: Entry[]) => void) {
        report = callback
      }
      observe(target: Element) {
        observed.push(target)
      }
      disconnect() {
        disconnects += 1
      }
    },
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function Probe({ show }: { show: boolean }) {
  const [ref, height] = useElementHeight<HTMLParagraphElement>()
  return (
    <div>
      {show && <p ref={ref}>note</p>}
      <span data-testid="height">{height}</span>
    </div>
  )
}

describe('useElementHeight', () => {
  it('reports the observed border-box height', () => {
    const { getByTestId } = render(<Probe show />)
    expect(observed).toHaveLength(1)
    expect(getByTestId('height')).toHaveTextContent('0')
    act(() => report?.([{ borderBoxSize: [{ blockSize: 42.5 }] }]))
    expect(getByTestId('height')).toHaveTextContent('42.5')
  })

  it('returns to 0 and stops observing when the element goes away', () => {
    const { getByTestId, rerender } = render(<Probe show />)
    act(() => report?.([{ borderBoxSize: [{ blockSize: 30 }] }]))
    rerender(<Probe show={false} />)
    expect(disconnects).toBe(1)
    expect(getByTestId('height')).toHaveTextContent('0')
  })

  it('stays 0 without a ResizeObserver, as in jsdom', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    const { getByTestId } = render(<Probe show />)
    expect(getByTestId('height')).toHaveTextContent('0')
  })
})
