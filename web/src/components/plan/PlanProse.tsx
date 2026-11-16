import { descriptionBlocks } from './descriptionBlocks'
import type { DescriptionBlock } from './descriptionBlocks'
import styles from './PlanProse.module.css'

export type PlanProseProps = (
  | {
      /** Claude's text, in the block format `descriptionBlocks` reads. */
      text: string
    }
  | {
      /** Blocks already read, as the assessment's verdict and the rest `splitVerdict` gives. */
      blocks: DescriptionBlock[]
    }
) & {
  className?: string
  /**
   * `prose`, the default, for reasoning read as text. `notes` for a
   * session's description, read as instructions: its items in a smaller
   * face and closer together, its blocks flowing into two columns once the
   * width holds them.
   */
  variant?: 'prose' | 'notes'
}

/**
 * Claude's prose in a plan - a session's description, the assessment's
 * summary and reasoning, a change's reason - set out as the blocks it is
 * written in: a label in bold over its list, and paragraphs. Text written
 * before the format, one line, reads as one paragraph.
 *
 * React elements only, never markup from the text, so nothing in a plan
 * file is ever parsed as HTML.
 */
export function PlanProse(props: PlanProseProps) {
  const { className, variant = 'prose' } = props
  const blocks = 'text' in props ? descriptionBlocks(props.text) : props.blocks
  if (blocks.length === 0) return null
  const names = [styles.prose, variant === 'notes' ? styles.notes : undefined, className].filter(Boolean).join(' ')
  const content = blocks.map((block, i) => (
    <div key={i} className={styles.block}>
      {block.label !== null && (
        <p className={styles.label}>
          <strong>{block.label}</strong>
        </p>
      )}
      {block.parts.map((part, j) =>
        part.kind === 'paragraph' ? (
          <p key={j}>{part.text}</p>
        ) : (
          <ul key={j} className={styles.items} aria-label={block.label ?? undefined}>
            {part.items.map((item, k) => (
              <li key={k}>{item}</li>
            ))}
          </ul>
        ),
      )}
    </div>
  ))
  // Notes flow into columns by their own width, so the blocks sit in an
  // inner box the container query can set columns on.
  return <div className={names}>{variant === 'notes' ? <div className={styles.flow}>{content}</div> : content}</div>
}
