// Free 8-direction movement over the tile grid: an axis-aligned body box resolved per axis against tile
// collision (WorldApi.canStep, so elevation/stairs/ledge/water rules match the server and NPC logic, on finite
// maps and on the infinite overworld alike), with corner slipping so the body never snags on the edge of a
// 1-tile opening. Pure: no DOM, no three.
import type { Dir, GameMap } from '../../shared/types.ts'
import type { CollisionField } from '../../shared/contracts.ts'
import { canStep, collisionField } from '../../shared/world/worldapi.ts'

export interface MotionGrid {
  map: GameMap
  /** WorldApi.collisionField(map) — required for infinite maps. */
  field?: CollisionField
  /** Legacy finite collision array (buildCollision layout); used when `field` is absent. */
  col?: Uint8Array
  /** Extra dynamic blockers (NPC-occupied tiles). */
  blocked?: (tx: number, ty: number) => boolean
  /** Extra veto on a step canStep allows (the player's ledge trap guard, ledge-guard.ts). */
  stepGuard?: (fx: number, fy: number, tx: number, ty: number) => boolean
}

const COL_FIELDS = new WeakMap<Uint8Array, CollisionField>()

/** Collision field of a grid: `field`, else a view over the legacy `col` array, else the map's own field. */
export function gridField(g: MotionGrid): CollisionField {
  if (g.field) return g.field
  const col = g.col
  if (!col) return collisionField(g.map)
  let f = COL_FIELDS.get(col)
  if (!f || f.map !== g.map) {
    const m = g.map
    f = { map: m, at: (x, y) => (x >= 0 && y >= 0 && x < m.width && y < m.height ? col[y * m.width + x] : 1) }
    COL_FIELDS.set(col, f)
  }
  return f
}

export interface MotionOpts {
  radius: number
  surf: boolean
  /** Max perpendicular overlap (tiles) that is slipped around instead of blocking. */
  cornerSlip: number
  /** Slip speed relative to the blocked movement. */
  cornerSlipRate: number
  /** Max distance per sub-step (tiles). */
  substep: number
}

export interface MoveResult { x: number; y: number; blocked: boolean }

const EPS = 1e-4
const tileOf = (v: number) => Math.floor(v)

export const DIR_VEC: Record<Dir, { x: number; y: number }> = {
  up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 },
}

/** May a body whose centre is on tile (cx, cy) overlap tile (tx, ty)? */
export function tilePassable(g: MotionGrid, cx: number, cy: number, tx: number, ty: number, surf: boolean): boolean {
  if (!g.map.infinite && (tx < 0 || ty < 0 || tx >= g.map.width || ty >= g.map.height)) return false
  if (g.blocked?.(tx, ty)) return false
  if (tx === cx && ty === cy) return true
  return canStep(g.map, gridField(g), cx, cy, tx, ty, { surf }) && (!g.stepGuard || g.stepGuard(cx, cy, tx, ty))
}

function boxTiles(x: number, y: number, r: number): { x0: number; x1: number; y0: number; y1: number } {
  return { x0: tileOf(x - r), x1: tileOf(x + r - EPS), y0: tileOf(y - r), y1: tileOf(y + r - EPS) }
}

/** Tiles the box at (nx, ny) overlaps that the box at (ox, oy) did not, all passable from the old centre tile. */
function canOccupy(g: MotionGrid, ox: number, oy: number, nx: number, ny: number, r: number, surf: boolean): boolean {
  const cx = tileOf(ox), cy = tileOf(oy)
  const a = boxTiles(ox, oy, r)
  const b = boxTiles(nx, ny, r)
  for (let ty = b.y0; ty <= b.y1; ty++) {
    for (let tx = b.x0; tx <= b.x1; tx++) {
      const wasInside = tx >= a.x0 && tx <= a.x1 && ty >= a.y0 && ty <= a.y1
      if (wasInside) continue
      if (!tilePassable(g, cx, cy, tx, ty, surf)) return false
    }
  }
  return true
}

/**
 * Moves along one axis. When blocked, clamps to the blocking tile edge and tries to slip around a corner by
 * nudging the other coordinate toward the free lane (only if the overlap is within opts.cornerSlip).
 */
function moveAxis(g: MotionGrid, pos: { x: number; y: number }, axis: 'x' | 'y', delta: number, o: MotionOpts): boolean {
  if (delta === 0) return false
  const r = o.radius
  const nx = axis === 'x' ? pos.x + delta : pos.x
  const ny = axis === 'y' ? pos.y + delta : pos.y
  if (canOccupy(g, pos.x, pos.y, nx, ny, r, o.surf)) { pos.x = nx; pos.y = ny; return false }

  // Clamp flush against the tile edge in the direction of travel.
  const along = axis === 'x' ? pos.x : pos.y
  const edge = delta > 0 ? Math.floor(along + r + delta) - r - EPS : Math.ceil(along - r + delta) + r + EPS
  const clamped = delta > 0 ? Math.max(along, Math.min(along + delta, edge)) : Math.min(along, Math.max(along + delta, edge))
  const cx = axis === 'x' ? clamped : pos.x
  const cy = axis === 'y' ? clamped : pos.y
  if (canOccupy(g, pos.x, pos.y, cx, cy, r, o.surf)) { pos.x = cx; pos.y = cy }

  // Corner slip: the box straddles two lanes and only one of them is blocked ahead.
  const perp = axis === 'x' ? pos.y : pos.x
  const lo = tileOf(perp - r), hi = tileOf(perp + r - EPS)
  if (lo === hi) return true
  const ahead = axis === 'x' ? tileOf(pos.x + Math.sign(delta) * (r + EPS * 4)) : tileOf(pos.y + Math.sign(delta) * (r + EPS * 4))
  const c0 = tileOf(pos.x), c1 = tileOf(pos.y)
  const free = (lane: number) => axis === 'x'
    ? tilePassable(g, c0, c1, ahead, lane, o.surf) && tilePassable(g, c0, c1, c0, lane, o.surf)
    : tilePassable(g, c0, c1, lane, ahead, o.surf) && tilePassable(g, c0, c1, lane, c1, o.surf)
  const loFree = free(lo), hiFree = free(hi)
  if (loFree === hiFree) return true
  // Overlap into the blocked lane that must be removed.
  const need = hiFree ? (lo + 1) - (perp - r) + EPS : (perp + r) - hi + EPS
  if (need > o.cornerSlip) return true
  const step = Math.min(need, Math.abs(delta) * o.cornerSlipRate) * (hiFree ? 1 : -1)
  const sx = axis === 'x' ? pos.x : pos.x + step
  const sy = axis === 'x' ? pos.y + step : pos.y
  if (canOccupy(g, pos.x, pos.y, sx, sy, r, o.surf)) { pos.x = sx; pos.y = sy }
  return true
}

/** Moves a body by (dx, dy) tiles with sub-stepping and per-axis sliding. */
export function moveBody(g: MotionGrid, x: number, y: number, dx: number, dy: number, o: MotionOpts): MoveResult {
  const dist = Math.hypot(dx, dy)
  const steps = Math.max(1, Math.ceil(dist / o.substep))
  const pos = { x, y }
  let blocked = false
  for (let i = 0; i < steps; i++) {
    const bx = moveAxis(g, pos, 'x', dx / steps, o)
    const by = moveAxis(g, pos, 'y', dy / steps, o)
    blocked = blocked || bx || by
  }
  return { x: pos.x, y: pos.y, blocked }
}

/** Dominant 4-way facing for an input vector, with hysteresis that keeps the current facing on near-diagonals. */
export function facingFromAxis(ax: number, ay: number, current: Dir, hysteresis: number): Dir {
  const horizontal: Dir = ax < 0 ? 'left' : 'right'
  const vertical: Dir = ay < 0 ? 'up' : 'down'
  const absX = Math.abs(ax), absY = Math.abs(ay)
  if (absX === 0 && absY === 0) return current
  const currentHorizontal = current === 'left' || current === 'right'
  if (currentHorizontal && current === horizontal && absX >= absY - hysteresis) return current
  if (!currentHorizontal && current === vertical && absY >= absX - hysteresis) return current
  return absX > absY ? horizontal : vertical
}

/** Tile a body at (x, y) facing `facing` would interact with. */
export function frontTile(x: number, y: number, facing: Dir, reach: number): { x: number; y: number } {
  const v = DIR_VEC[facing]
  return { x: tileOf(x + v.x * reach), y: tileOf(y + v.y * reach) }
}

/** Direction from tile a to an orthogonally/diagonally adjacent tile b, preferring the larger axis. */
export function dirTowards(fromX: number, fromY: number, toX: number, toY: number): Dir {
  const dx = toX - fromX, dy = toY - fromY
  if (Math.abs(dx) > Math.abs(dy)) return dx < 0 ? 'left' : 'right'
  return dy < 0 ? 'up' : 'down'
}

export const OPPOSITE_DIR: Record<Dir, Dir> = { up: 'down', down: 'up', left: 'right', right: 'left' }
