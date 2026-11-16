import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PlanHeader } from './PlanHeader'
import type { PlanVersionEntry, Session, WeekEntry } from './planMath'
import { weekText } from './weekText'

const easy: Session = {
  id: '2026-08-25-easy',
  date: '2026-08-25',
  kind: 'easy',
  title: 'Easy 8 km',
  description: '',
  steps: [],
}

const week: WeekEntry = {
  week: {
    start_date: '2026-08-24',
    phase: 'base',
    focus: 'Settle in',
    planned_distance_m: 24000,
    detailed: true,
    sessions: [easy],
  },
  sessions: [{ session: easy, phase: 'base' }],
}

const entry = {
  number: 1,
  status: 'accepted',
  plan: {
    goal: { goal_id: 'g', distance_m: 5000, target_time_s: 1500, race_date: '2026-09-20', surface: 'road' },
    constraints: { runs_per_week: 3 },
    assessment: { summary: '', estimate_s: 1480, estimate_reasoning: '', verdict: 'likely', citations: [] },
    weeks: [week.week],
    changes: [],
    outcomes: [],
    checkpoints: [],
    provenance: {
      number: 1,
      revises: null,
      created_at: '2026-08-23T10:00:00Z',
      data_through: '2026-08-23',
      snapshot: [],
    },
  },
} as unknown as PlanVersionEntry

const TODAY = new Date(2026, 7, 23)

function renderHeader(next: WeekEntry | null) {
  return render(<PlanHeader entry={entry} goalStatus="active" result={null} week={next} today={TODAY} />)
}

describe('PlanHeader week actions', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('names the next week and copies it as text', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    renderHeader(week)

    const group = screen.getByRole('group', { name: 'Week of 24 Aug' })
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['PDF', 'Copy as text'])
    fireEvent.click(within(group).getByRole('button', { name: 'Copy as text' }))

    expect(await within(group).findByRole('button', { name: 'Copied' })).toBeInTheDocument()
    expect(writeText).toHaveBeenCalledWith(weekText('5 km under 25:00', week, TODAY))
  })

  it('copies heart rate targets labelled with their zones when given the zone boundaries', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const capped: Session = { ...easy, steps: [{ role: 'work', repeat: 1, distance_m: 8000, heart_rate: { high_bpm: 150 } }] }
    const next: WeekEntry = { week: { ...week.week, sessions: [capped] }, sessions: [{ session: capped, phase: 'base' }] }
    const boundaries = [140, 155, 165, 175]
    render(
      <PlanHeader entry={entry} goalStatus="active" result={null} week={next} today={TODAY} zoneBoundaries={boundaries} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Copy as text' }))
    await screen.findByRole('button', { name: 'Copied' })
    expect(writeText).toHaveBeenCalledWith(weekText('5 km under 25:00', next, TODAY, boundaries))
    expect(String(writeText.mock.calls[0]?.[0])).toContain('up to 150 bpm (Z2)')
  })

  it('says the copy failed when the clipboard refuses it', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn().mockRejectedValue(new Error('no')) } })
    renderHeader(week)
    fireEvent.click(screen.getByRole('button', { name: 'Copy as text' }))
    expect(await screen.findByRole('button', { name: 'Copy failed' })).toBeInTheDocument()
  })

  it('says the copy failed where there is no clipboard at all', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    renderHeader(week)
    fireEvent.click(screen.getByRole('button', { name: 'Copy as text' }))
    expect(await screen.findByRole('button', { name: 'Copy failed' })).toBeInTheDocument()
  })

  it('draws no week controls when there is no next week to take', () => {
    renderHeader(null)
    expect(screen.queryByRole('group', { name: /^Week of/ })).toBeNull()
    expect(screen.getByRole('group', { name: 'Print or save as PDF' })).toBeInTheDocument()
  })

  it('draws a name over each pair: PDF over the plan PDFs, the week over its own', () => {
    renderHeader(week)
    const plan = screen.getByRole('group', { name: 'Print or save as PDF' })
    expect(plan).toHaveTextContent(/^PDFAs shownWith every session$/)
    const weekGroup = screen.getByRole('group', { name: /^Week of/ })
    expect(weekGroup.textContent).toMatch(/^Week of \d+ \w+PDFCopy as text$/)
  })
})

describe('PlanHeader estimate card', () => {
  it('says at its foot who wrote the version and from which runs', () => {
    renderHeader(week)
    const card = screen.getByRole('heading', { level: 2, name: 'Estimated 5 km time' }).closest('section')
    expect(card).toHaveTextContent('Version 1 · Accepted. Written by Claude on 23 August from runs through 23 August.')
  })
})
