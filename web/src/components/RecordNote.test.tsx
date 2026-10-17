import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { components } from '../api/schema'
import { RecordNote } from './RecordNote'
import { CONFIRMED_JUMP_NOTE, recordNotes } from './recordNotes'

type BestEffort = components['schemas']['BestEffort']

const UNCONFIRMED = 'a jump in the recorded distance that the measured speed does not confirm'

function effort(key: string, overrides: Partial<BestEffort> = {}): BestEffort {
  return {
    distance_key: key,
    distance_m: 1000,
    elapsed_time_s: 300,
    start_t_s: 0,
    end_t_s: 300,
    avg_hr_bpm: 150,
    contains_pause: false,
    contains_outage: false,
    contains_jump: false,
    speed_distance_m: 1000,
    distance_trusted: true,
    is_eligible: true,
    ineligible_reason: null,
    ...overrides,
  }
}

const excluded = { contains_jump: true, distance_trusted: false, is_eligible: false, ineligible_reason: UNCONFIRMED }

describe('recordNotes', () => {
  it('says nothing when every effort counts and none held a jump', () => {
    expect(recordNotes([effort('1k'), effort('5k')])).toEqual([])
  })

  it('lists the distances one reason keeps out, in the order they are served', () => {
    expect(recordNotes([effort('400m', excluded), effort('1k', excluded), effort('5k')])).toEqual([
      `Not counted towards records at 400 m, 1 km: ${UNCONFIRMED}.`,
    ])
  })

  it('leaves the ladder out when one reason keeps every effort out', () => {
    const treadmill = { is_eligible: false, ineligible_reason: 'treadmill' }
    expect(recordNotes([effort('1k', treadmill), effort('5k', treadmill)])).toEqual([
      'No effort on this run counts towards records: treadmill.',
    ])
  })

  it('names the efforts that count only because the measured speed confirmed a jump', () => {
    // A real half marathon's shape: the short windows around the
    // jump stay out, the long ones that dilute it count.
    const confirmed = { contains_jump: true, distance_trusted: true }
    expect(recordNotes([effort('1k', excluded), effort('half', confirmed)])).toEqual([
      `Not counted towards records at 1 km: ${UNCONFIRMED}.`,
      `Counted towards records at Half marathon: ${CONFIRMED_JUMP_NOTE}.`,
    ])
  })

  it('says so rather than inventing a cause when the reason is missing', () => {
    expect(recordNotes([effort('1k', { is_eligible: false }), effort('5k')])).toEqual([
      'Not counted towards records at 1 km: no reason recorded.',
    ])
  })
})

describe('RecordNote', () => {
  it('renders nothing when there is nothing to explain', () => {
    const { container } = render(<RecordNote efforts={[effort('5k')]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders each sentence in a labelled region', () => {
    render(<RecordNote efforts={[effort('400m', excluded), effort('5k')]} />)
    expect(screen.getByLabelText('Records eligibility')).toHaveTextContent(
      `Not counted towards records at 400 m: ${UNCONFIRMED}.`,
    )
  })
})
