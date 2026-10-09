// Screen composition for the battle: picks a zoom and a lens shift so that no creature sits under a HUD window or
// outside the screen. Pure (no three.js, no DOM): the stage feeds it the creatures' resting boxes projected with the
// base shot and the HUD rectangles, and gets back what the camera should apply on top of its shot (camera.ts).
// All boxes are viewport fractions (x right, y down).

export interface Box { left: number; top: number; right: number; bottom: number }
export interface Framing { zoom: number; dx: number; dy: number }

export interface SolverCfg {
  minZoom: number
  maxZoom: number
  zoomStep: number
  shiftStep: number
  shiftMax: number
  target: [number, number]
  /** Same, for a portrait screen. */
  targetPortrait: [number, number]
  /** Widest the creatures' union may get as a fraction of the screen width: [landscape, portrait]. */
  fill: [number, number]
  /** UI pixels kept between a creature and a window / the screen edge. */
  padU: number
  edgeU: number
}

export interface Viewport { w: number; h: number; /** CSS pixels per UI pixel. */ unit: number }

export interface Solution { framing: Framing; /** False when even the smallest zoom could not clear every window. */ clear: boolean; /** Remaining overlap area (viewport fractions squared) when not clear. */ overlap: number }

export const NO_FRAMING: Framing = { zoom: 1, dx: 0, dy: 0 }

/** The picture zoomed by `f.zoom` about the screen centre, then slid by (dx, dy). */
export function framed(b: Box, f: Framing): Box {
  const z = (v: number, dv: number) => 0.5 + (v - 0.5) * f.zoom + dv
  return { left: z(b.left, f.dx), right: z(b.right, f.dx), top: z(b.top, f.dy), bottom: z(b.bottom, f.dy) }
}

export function overlapArea(a: Box, b: Box, padX = 0, padY = 0): number {
  const w = Math.min(a.right + padX, b.right) - Math.max(a.left - padX, b.left)
  const h = Math.min(a.bottom + padY, b.bottom) - Math.max(a.top - padY, b.top)
  return w > 0 && h > 0 ? w * h : 0
}

export function union(boxes: readonly Box[]): Box {
  return {
    left: Math.min(...boxes.map((b) => b.left)), right: Math.max(...boxes.map((b) => b.right)),
    top: Math.min(...boxes.map((b) => b.top)), bottom: Math.max(...boxes.map((b) => b.bottom)),
  }
}

/** How much the boxes (already framed) break the rules: overlap with windows plus spill past the screen edge. */
function violation(boxes: readonly Box[], hud: readonly Box[], padX: number, padY: number, edgeX: number, edgeY: number): number {
  let v = 0
  for (const b of boxes) {
    for (const h of hud) v += overlapArea(b, h, padX, padY)
    v += Math.max(0, edgeX - b.left) * (b.bottom - b.top) + Math.max(0, b.right - (1 - edgeX)) * (b.bottom - b.top)
    v += Math.max(0, edgeY - b.top) * (b.right - b.left)
  }
  return v
}

/**
 * Largest zoom (down to minZoom) for which some shift keeps every creature clear of every window and inside the
 * screen; among those shifts the one that puts the creatures' centre closest to `target`.
 */
export function solveFraming(sprites: readonly Box[], hud: readonly Box[], vp: Viewport, cfg: SolverCfg): Solution {
  if (!sprites.length) return { framing: NO_FRAMING, clear: true, overlap: 0 }
  const padX = (cfg.padU * vp.unit) / vp.w, padY = (cfg.padU * vp.unit) / vp.h
  const edgeX = (cfg.edgeU * vp.unit) / vp.w, edgeY = (cfg.edgeU * vp.unit) / vp.h
  const steps = Math.round(cfg.shiftMax / cfg.shiftStep)
  const shifts: number[] = [0]
  for (let i = 1; i <= steps; i++) shifts.push(i * cfg.shiftStep, -i * cfg.shiftStep)
  const centre = union(sprites)
  const cx = (centre.left + centre.right) / 2, cy = (centre.top + centre.bottom) / 2
  const aspect = vp.w / vp.h
  const target = vp.w < vp.h ? cfg.targetPortrait : cfg.target

  let fallback: Solution | null = null
  const fill = vp.w < vp.h ? cfg.fill[1] : cfg.fill[0]
  const top = Math.max(cfg.minZoom, Math.min(cfg.maxZoom, fill / Math.max(1e-6, centre.right - centre.left)))
  const zooms: number[] = []
  for (let z = top; z > cfg.minZoom + 1e-9; z -= cfg.zoomStep) zooms.push(+z.toFixed(4))
  zooms.push(cfg.minZoom)
  for (const zoom of zooms) {
    const zoomed = sprites.map((b) => framed(b, { zoom, dx: 0, dy: 0 }))
    const zcx = 0.5 + (cx - 0.5) * zoom, zcy = 0.5 + (cy - 0.5) * zoom
    let best: { dx: number; dy: number; cost: number } | null = null
    let least: { dx: number; dy: number; v: number } | null = null
    for (const dx of shifts) {
      for (const dy of shifts) {
        const moved = zoomed.map((b) => ({ left: b.left + dx, right: b.right + dx, top: b.top + dy, bottom: b.bottom + dy }))
        const v = violation(moved, hud, padX, padY, edgeX, edgeY)
        if (v === 0) {
          const ex = (zcx + dx - target[0]) * aspect, ey = zcy + dy - target[1]
          const cost = ex * ex + ey * ey
          if (!best || cost < best.cost) best = { dx, dy, cost }
        } else if (!least || v < least.v || (v === least.v && Math.hypot(dx, dy) < Math.hypot(least.dx, least.dy))) least = { dx, dy, v }
      }
    }
    if (best) return { framing: { zoom, dx: best.dx, dy: best.dy }, clear: true, overlap: 0 }
    if (least && zoom <= cfg.minZoom + 1e-9) fallback = { framing: { zoom, dx: least.dx, dy: least.dy }, clear: false, overlap: least.v }
  }
  return fallback ?? { framing: NO_FRAMING, clear: false, overlap: 1 }
}
