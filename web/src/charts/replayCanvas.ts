import { piecesPassed } from './paceColour'

/** One pace piece, ready to stroke: its last grid sample, its colour and its points. */
export interface ReplayPath {
  end: number
  colour: string
  /** `x0, y0, x1, y1, ...` in the layout's own units. */
  points: number[]
}

/** How the layout's units map onto the canvas's CSS pixels: `px = unit * scale + offset`. */
export interface ReplayTransform {
  scale: number
  dx: number
  dy: number
}

export const IDENTITY: ReplayTransform = { scale: 1, dx: 0, dy: 0 }

/**
 * The replay's growing line, drawn on a 2D canvas of its own over a static
 * picture - `RouteMap`'s basemap or `Route`'s trace - so a frame never
 * repaints the picture underneath. See docs/reference/frontend.md, "Replay".
 *
 * Why a canvas: a MapLibre feature-state change repaints the whole map,
 * basemap included, about 50 ms a repaint under SwiftShader, and a moving
 * SVG repaints the whole trace behind it; a canvas keeps what it has
 * already drawn. So a frame strokes only the pieces between the previous
 * head and the new one, and a head that moves back clears and redraws.
 *
 * The context is only asked for once there is something to draw, so a
 * picture that never replays never touches it.
 */
export class ReplayCanvas {
  private readonly canvas: HTMLCanvasElement
  private paths: ReplayPath[] | null = null
  private transform: ReplayTransform = IDENTITY
  private lineWidth = 1
  private dpr = 1
  private head: number | null = null
  /** How many of `paths` are on the canvas now. */
  private drawn = 0

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
  }

  /**
   * Sizes the canvas to `cssWidth` x `cssHeight` at `dpr`, takes the paths
   * and how their units map to pixels, and redraws up to the current head.
   * Resizing a canvas clears it, so this is the one full redraw a resize or
   * a refit costs.
   */
  layout(
    paths: ReplayPath[],
    cssWidth: number,
    cssHeight: number,
    dpr: number,
    transform: ReplayTransform,
    lineWidth: number,
  ): void {
    this.paths = paths
    this.transform = transform
    this.lineWidth = lineWidth
    this.dpr = dpr
    this.canvas.width = Math.round(cssWidth * dpr)
    this.canvas.height = Math.round(cssHeight * dpr)
    this.drawn = 0
    this.drawTo(this.head)
  }

  /** The replay head: a grid index, or null for no replay, which clears the canvas. */
  setHead(head: number | null): void {
    this.head = head
    this.drawTo(head)
  }

  private drawTo(head: number | null): void {
    const paths = this.paths
    if (head === null || paths === null) {
      if (this.drawn > 0) this.clear()
      return
    }
    const target = piecesPassed(paths, head)
    if (target < this.drawn) this.clear()
    if (target === this.drawn) return
    const ctx = this.canvas.getContext('2d')
    if (ctx === null) return
    const { scale, dx, dy } = this.transform
    ctx.setTransform(this.dpr * scale, 0, 0, this.dpr * scale, this.dpr * dx, this.dpr * dy)
    ctx.lineWidth = this.lineWidth
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (let k = this.drawn; k < target; k++) {
      const path = paths[k]
      if (path === undefined || path.points.length < 4) continue
      ctx.strokeStyle = path.colour
      ctx.beginPath()
      ctx.moveTo(path.points[0] ?? 0, path.points[1] ?? 0)
      for (let i = 2; i + 1 < path.points.length; i += 2) ctx.lineTo(path.points[i] ?? 0, path.points[i + 1] ?? 0)
      ctx.stroke()
    }
    this.drawn = target
  }

  private clear(): void {
    this.drawn = 0
    const ctx = this.canvas.getContext('2d')
    if (ctx === null) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
  }
}
