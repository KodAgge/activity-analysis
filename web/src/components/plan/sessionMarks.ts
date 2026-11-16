import type { Outcome, Session } from './planMath'
import styles from './sessionMarks.module.css'

/**
 * The palette slot each session kind is drawn in, as the class that sets
 * `--kind`. Fixed rather than assigned in order of appearance, so a kind
 * keeps its colour from one plan to the next, and the slots are the
 * validated `--series-n` ones (`docs/reference/frontend.md`, "Tokens and
 * palette"). Rest and cross-training are not running sessions and take
 * `neutral`.
 *
 * Its own module, beside neither component, so the calendar and the
 * session detail mark a session alike and both stay Fast-Refreshable.
 */
const KIND_SLOT: Readonly<Record<Session['kind'], string | undefined>> = {
  intervals: styles.slot1,
  tempo: styles.slot2,
  threshold: styles.slot2,
  time_trial: styles.slot3,
  race: styles.slot3,
  long: styles.slot4,
  easy: styles.slot5,
  strides: styles.slot5,
  rest: styles.neutral,
  cross_training: styles.neutral,
}

/** The class that sets `--kind` for a session's kind. */
export function kindSlotClass(kind: Session['kind']): string {
  return KIND_SLOT[kind] ?? styles.neutral ?? ''
}

/**
 * The three Runna treatments of a kind, as classes for an element that has
 * a slot class from `kindSlotClass` or sits inside one: `bar`, a solid bar
 * down its left edge; `swatch`, a square of the kind; `tint`, a fill of
 * the kind at 12% with `--ink` text. On a tint, secondary text is
 * `var(--kind-tint-dim)` rather than `--ink-dim`, and the kind as text is
 * `var(--kind-ink)`; `sessionMarks.module.css` has the contrast of each.
 */
export const KIND_MARK: Readonly<{ bar: string; swatch: string; tint: string }> = {
  bar: styles.bar ?? '',
  swatch: styles.swatch ?? '',
  tint: styles.tint ?? '',
}

/** The legend's colour key, one entry per slot in slot order. */
export const SLOT_KEY: readonly { slot: string; label: string }[] = [
  { slot: styles.slot1 ?? '', label: 'Intervals' },
  { slot: styles.slot2 ?? '', label: 'Tempo or threshold' },
  { slot: styles.slot3 ?? '', label: 'Time trial or race' },
  { slot: styles.slot4 ?? '', label: 'Long run' },
  { slot: styles.slot5 ?? '', label: 'Easy or strides' },
]

/**
 * Claude's verdict as a glyph that reads without colour: a tick, a half, a
 * cross, an arrow for a session run on another day and a swap for one
 * replaced by a different session. Wherever it is drawn it is hidden from
 * a screen reader, which reads the verdict's word instead.
 */
export const VERDICT_GLYPH: Readonly<Record<Outcome['verdict'], string>> = {
  done: '✓',
  partial: '½',
  missed: '✗',
  moved: '→',
  replaced: '⇄',
}
