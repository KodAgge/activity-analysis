import { describe, expect, it } from 'vitest'
import { descriptionBlocks, splitVerdict } from './descriptionBlocks'

describe('descriptionBlocks', () => {
  it('reads a label with its list items', () => {
    expect(descriptionBlocks('Warm-up:\n- 2 km easy\n- 4 strides')).toEqual([
      { label: 'Warm-up', parts: [{ kind: 'list', items: ['2 km easy', '4 strides'] }] },
    ])
  })

  it('keeps a list item ending in a colon as an item, not a label', () => {
    expect(descriptionBlocks('Main set:\n- 6 x 1 km, between each:\n- 90 s jog')).toEqual([
      { label: 'Main set', parts: [{ kind: 'list', items: ['6 x 1 km, between each:', '90 s jog'] }] },
    ])
  })

  it('reads a block of plain lines as paragraphs, one per line', () => {
    expect(descriptionBlocks('Hard but controlled.\nEven splits beat a fast first rep.')).toEqual([
      {
        label: null,
        parts: [
          { kind: 'paragraph', text: 'Hard but controlled.' },
          { kind: 'paragraph', text: 'Even splits beat a fast first rep.' },
        ],
      },
    ])
  })

  it('splits blocks on a blank line and mixes labels, items and paragraphs', () => {
    const text = [
      'Warm-up:',
      '- 2 km easy',
      '- 4 strides',
      '',
      'Main set:',
      '6 x 800 m with 400 m jog.',
      '- Feel: 7-8 out of 10',
      '',
      'Strides are short accelerations.',
    ].join('\n')
    expect(descriptionBlocks(text)).toEqual([
      { label: 'Warm-up', parts: [{ kind: 'list', items: ['2 km easy', '4 strides'] }] },
      {
        label: 'Main set',
        parts: [
          { kind: 'paragraph', text: '6 x 800 m with 400 m jog.' },
          { kind: 'list', items: ['Feel: 7-8 out of 10'] },
        ],
      },
      { label: null, parts: [{ kind: 'paragraph', text: 'Strides are short accelerations.' }] },
    ])
  })

  it('reads Windows line endings, stray whitespace and runs of blank lines alike', () => {
    const text = '  Warm-up:  \r\n-   2 km easy \r\n \r\n\r\n\r\n  Cool-down:\r\n- 1.5 km easy\r\n'
    expect(descriptionBlocks(text)).toEqual([
      { label: 'Warm-up', parts: [{ kind: 'list', items: ['2 km easy'] }] },
      { label: 'Cool-down', parts: [{ kind: 'list', items: ['1.5 km easy'] }] },
    ])
  })

  it('reads a description with no newlines as one paragraph, so an older plan still reads', () => {
    const text = 'Warm-up: 2 km easy, then 4 strides. Main set: 6 x 800 m. Feel: 7-8 out of 10.'
    expect(descriptionBlocks(text)).toEqual([{ label: null, parts: [{ kind: 'paragraph', text }] }])
  })

  it('a label inside a block starts a new one, and a label with nothing under it stays', () => {
    expect(descriptionBlocks('Easy all the way.\nOn a treadmill:\n- 1% incline\nLast:')).toEqual([
      { label: null, parts: [{ kind: 'paragraph', text: 'Easy all the way.' }] },
      { label: 'On a treadmill', parts: [{ kind: 'list', items: ['1% incline'] }] },
      { label: 'Last', parts: [] },
    ])
  })

  it('an empty description has no blocks, and an empty item is dropped', () => {
    expect(descriptionBlocks('')).toEqual([])
    expect(descriptionBlocks('  \n \r\n')).toEqual([])
    expect(descriptionBlocks('Warm-up:\n- \n- 2 km easy')).toEqual([
      { label: 'Warm-up', parts: [{ kind: 'list', items: ['2 km easy'] }] },
    ])
  })
})

describe('splitVerdict', () => {
  it('shows the block labelled Verdict and keeps every other block for later, in order', () => {
    const { verdict, rest } = splitVerdict(
      descriptionBlocks('Why it can work:\n- Volume holds\n\nVerdict:\n- Possible\n\nWhat decides it:\n- The trial'),
    )
    expect(verdict.map((b) => b.label)).toEqual(['Verdict'])
    expect(rest.map((b) => b.label)).toEqual(['Why it can work', 'What decides it'])
  })

  it('reads the label whatever its case', () => {
    expect(splitVerdict(descriptionBlocks('verdict:\n- Likely\n\nWhy:\n- Fit')).verdict[0]?.label).toBe('verdict')
  })

  it('shows the first block when labelled blocks have no Verdict', () => {
    const { verdict, rest } = splitVerdict(descriptionBlocks('Where you stand:\n- Fit\n\nWhy:\n- Volume'))
    expect(verdict.map((b) => b.label)).toEqual(['Where you stand'])
    expect(rest.map((b) => b.label)).toEqual(['Why'])
  })

  it('shows only the first paragraph of a summary with no labels', () => {
    const { verdict, rest } = splitVerdict(descriptionBlocks('Within reach.\nThe trial decides.\n\nVolume holds.'))
    expect(verdict).toEqual([{ label: null, parts: [{ kind: 'paragraph', text: 'Within reach.' }] }])
    expect(rest).toEqual([
      { label: null, parts: [{ kind: 'paragraph', text: 'The trial decides.' }] },
      { label: null, parts: [{ kind: 'paragraph', text: 'Volume holds.' }] },
    ])
  })

  it('keeps nothing for later from a one-line summary', () => {
    expect(splitVerdict(descriptionBlocks('Within reach but not yet likely.'))).toEqual({
      verdict: [{ label: null, parts: [{ kind: 'paragraph', text: 'Within reach but not yet likely.' }] }],
      rest: [],
    })
    expect(splitVerdict([])).toEqual({ verdict: [], rest: [] })
  })
})
