import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { printPlan } from './printPlan'

describe('printPlan', () => {
  let print: ReturnType<typeof vi.fn>

  beforeEach(() => {
    document.title = 'activity-analysis'
    print = vi.fn()
    vi.stubGlobal('print', print)
  })

  afterEach(() => {
    window.dispatchEvent(new Event('afterprint'))
    vi.unstubAllGlobals()
  })

  it('marks the page for the long PDF and names the file for it while the dialog is open', () => {
    print.mockImplementation(() => {
      expect(document.documentElement.dataset.planPrint).toBe('full')
      expect(document.title).toBe('Plan, Half marathon under 1:45:00, every session')
    })
    printPlan('full', 'Half marathon under 1:45:00')
    expect(print).toHaveBeenCalledOnce()
  })

  it('leaves the page unmarked for the short PDF, which prints it as shown', () => {
    document.documentElement.dataset.planPrint = 'full'
    print.mockImplementation(() => {
      expect(document.documentElement.dataset.planPrint).toBeUndefined()
      expect(document.title).toBe('Plan, Half marathon under 1:45:00')
    })
    printPlan('shown', 'Half marathon under 1:45:00')
    expect(print).toHaveBeenCalledOnce()
  })

  it('marks the page for the week PDF and names the file after the week', () => {
    print.mockImplementation(() => {
      expect(document.documentElement.dataset.planPrint).toBe('week')
      expect(document.title).toBe('Plan, 5 km under 25:00, week of 31 Aug')
    })
    printPlan('week', '5 km under 25:00', '31 Aug')
    expect(print).toHaveBeenCalledOnce()
    window.dispatchEvent(new Event('afterprint'))
    expect(document.documentElement.dataset.planPrint).toBeUndefined()
    expect(document.title).toBe('activity-analysis')
  })

  it('puts the page back once the dialog closes, not when print returns', () => {
    printPlan('full', '10 km under 45:00')
    // Some mobile browsers return from print() before the dialog closes.
    expect(document.documentElement.dataset.planPrint).toBe('full')
    window.dispatchEvent(new Event('afterprint'))
    expect(document.documentElement.dataset.planPrint).toBeUndefined()
    expect(document.title).toBe('activity-analysis')
  })
})
