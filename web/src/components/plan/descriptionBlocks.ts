/**
 * A session description as the structure Claude writes it in, so the
 * detail can set it out rather than print one paragraph.
 *
 * The format, which `.claude/skills/training-plan/SKILL.md` step 6 asks
 * for: blocks separated by a blank line; a line ending in `:` on its own is
 * a block's label, such as `Warm-up:`; a line starting `- ` is a list item
 * under it; any other line is a paragraph. A description with no newlines,
 * as every plan before the format had, is one paragraph and still reads.
 *
 * Pure and plain data: the detail renders it as React elements, never as
 * HTML, so nothing Claude writes is ever parsed as markup.
 */

export type DescriptionPart = { kind: 'paragraph'; text: string } | { kind: 'list'; items: string[] }

export interface DescriptionBlock {
  /** The label without its colon, or null for a block that has none. */
  label: string | null
  parts: DescriptionPart[]
}

const ITEM = /^-(\s+|$)/

export function descriptionBlocks(description: string): DescriptionBlock[] {
  const blocks: DescriptionBlock[] = []
  let current: DescriptionBlock | null = null

  const start = (label: string | null): DescriptionBlock => {
    const block: DescriptionBlock = { label, parts: [] }
    blocks.push(block)
    return block
  }

  for (const raw of description.split(/\r\n|\r|\n/)) {
    const line = raw.trim()
    if (line === '') {
      current = null
      continue
    }
    if (line.length > 1 && line.endsWith(':') && !ITEM.test(line)) {
      current = start(line.slice(0, -1).trimEnd())
      continue
    }
    current ??= start(null)
    if (ITEM.test(line)) {
      const item = line.replace(ITEM, '').trim()
      if (item === '') continue
      const last = current.parts[current.parts.length - 1]
      if (last?.kind === 'list') last.items.push(item)
      else current.parts.push({ kind: 'list', items: [item] })
      continue
    }
    current.parts.push({ kind: 'paragraph', text: line })
  }
  return blocks
}

const VERDICT_LABEL = /^verdict$/i

/**
 * The assessment summary as the page shows it: the verdict on screen and
 * the rest behind "Why this verdict". The verdict is the block labelled
 * `Verdict`, which `.claude/skills/training-plan/SKILL.md` step 6 asks
 * the summary to open with; without one, a summary of labelled blocks
 * shows its first block, and one with no labels, as every summary before
 * the format was, shows its first paragraph.
 */
export function splitVerdict(blocks: DescriptionBlock[]): { verdict: DescriptionBlock[]; rest: DescriptionBlock[] } {
  const labelled = blocks.findIndex((b) => b.label !== null && VERDICT_LABEL.test(b.label))
  if (labelled !== -1) {
    return { verdict: [blocks[labelled] as DescriptionBlock], rest: blocks.filter((_, i) => i !== labelled) }
  }
  const [first, ...others] = blocks
  if (first === undefined) return { verdict: [], rest: [] }
  if (blocks.some((b) => b.label !== null)) return { verdict: [first], rest: others }
  const [opening, ...after] = first.parts
  const verdict = opening === undefined ? [] : [{ label: null, parts: [opening] }]
  return { verdict, rest: after.length === 0 ? others : [{ label: null, parts: after }, ...others] }
}
