// Tile collision for every GameMap (CollisionApi) plus the shared prop-footprint / stairs conventions.
//
// Conventions (also documented in docs/world.md):
// - PropPlacement (x, y) is the TOP-LEFT tile of the rotated footprint. rot = quarter turns counter-clockwise
//   seen from above (three.js rotation.y = rot * PI / 2): the facade (+Z, south) faces south at rot 0, east at
//   rot 1, north at rot 2, west at rot 3. For rot 1/3 the footprint [w, d] becomes [d, w].
// - PropDef.door [dx, dz] is relative to the footprint centre tile (floor(w/2), floor(d/2)) at rot 0 and points
//   at the tile in FRONT of the facade. The door warp sits on the facade tile behind it (inside the footprint),
//   with doorSpan extending that opening along local X. Other footprint tiles remain blocked.
// - A stairs tile stores the LOWER level L; exactly one orthogonal neighbour (stairsDir) is at L+1 and the ramp
//   rises towards it. Elevation changes happen only along that axis; diagonal moves never change elevation.
// - buildCollision values: 0 free, 1 blocked, 2 water (enterable only while surfing).
import type { Dir, GameMap, PropDef, PropPlacement, TerrainDef } from '../types.ts'
import { CONTENT, terrainId } from '../content/index.ts'
import { WORLD_CONTENT } from './data.ts'

export const COLLISION_FREE = 0
export const COLLISION_BLOCKED = 1
export const COLLISION_WATER = 2

export const DIRS: readonly Dir[] = ['up', 'down', 'left', 'right']
export const DIR_DX: Record<Dir, number> = { up: 0, down: 0, left: -1, right: 1 }
export const DIR_DY: Record<Dir, number> = { up: -1, down: 1, left: 0, right: 0 }
const OPPOSITE: Record<Dir, Dir> = { up: 'down', down: 'up', left: 'right', right: 'left' }
/** Facade direction per rotation (rot 0 faces south). */
const FACING_BY_ROT: readonly Dir[] = ['down', 'right', 'up', 'left']

const OOB_TERRAIN = terrainId(WORLD_CONTENT.world.overworld.outOfBounds)

export function opposite(d: Dir): Dir { return OPPOSITE[d] }

function propDef(key: string): PropDef {
  const def = CONTENT.props[key]
  if (!def) throw new Error(`unknown prop "${key}"`)
  return def
}

/** Rotated footprint size [W, D] in tiles. */
export function propSize(key: string, rot: number): [number, number] {
  const [w, d] = propDef(key).footprint
  return rot === 1 || rot === 3 ? [d, w] : [w, d]
}

export interface TileRect { x: number; y: number; w: number; h: number }

export function propRect(p: PropPlacement): TileRect {
  const [w, h] = propSize(p.prop, p.rot)
  return { x: p.x, y: p.y, w, h }
}

/** World-space centre of the footprint in tile units (tile i spans [i, i+1)). */
export function propCenter(p: PropPlacement): { x: number; y: number } {
  const r = propRect(p)
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 }
}

/** Rotate a cell of the unrotated w x d footprint frame (cells may lie just outside it). */
function rotateCell(i: number, j: number, w: number, d: number, rot: number): [number, number] {
  switch (rot & 3) {
    case 1: return [j, w - 1 - i]
    case 2: return [w - 1 - i, d - 1 - j]
    case 3: return [d - 1 - j, i]
    default: return [i, j]
  }
}

export interface DoorInfo {
  /** Facade tile holding the door warp (inside the footprint). */
  x: number; y: number
  /** Tile in front of the door (outside) — where the player stands / exits to. */
  front: { x: number; y: number }
  /** Direction pointing away from the building (exit facing). */
  facing: Dir
}

function doorAt(p: PropPlacement, lateral: number): DoorInfo | null {
  const def = propDef(p.prop)
  if (!def.door) return null
  const [w, d] = def.footprint
  const ci = Math.floor(w / 2) + def.door[0] + lateral
  const cj = Math.floor(d / 2) + def.door[1]
  const facing = FACING_BY_ROT[p.rot & 3]
  const [fi, fj] = rotateCell(ci, cj, w, d, p.rot)
  const front = { x: p.x + fi, y: p.y + fj }
  return { x: front.x - DIR_DX[facing], y: front.y - DIR_DY[facing], front, facing }
}

/** Primary entry: stable return destination and anchor, including for a multi-tile opening. */
export function propDoor(p: PropPlacement): DoorInfo | null { return doorAt(p, 0) }

/** All entry lanes, primary first, rotated together with the footprint. */
export function propDoors(p: PropPlacement): DoorInfo[] {
  const main = propDoor(p)
  if (!main) return []
  const out = [main]
  const [lo, hi] = propDef(p.prop).doorSpan ?? [0, 0]
  for (let offset = lo; offset <= hi; offset++) {
    if (offset !== 0) out.push(doorAt(p, offset)!)
  }
  return out
}

function terrainDef(id: number): TerrainDef | undefined { return CONTENT.terrain[id] }

export function inBounds(map: Pick<GameMap, 'width' | 'height'>, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < map.width && y < map.height
}

export function terrainAt(map: GameMap, x: number, y: number): number {
  if (!inBounds(map, x, y)) return OOB_TERRAIN
  return map.terrain[y * map.width + x]
}

const clampX = (map: GameMap, x: number) => (x < 0 ? 0 : x >= map.width ? map.width - 1 : x)
const clampY = (map: GameMap, y: number) => (y < 0 ? 0 : y >= map.height ? map.height - 1 : y)

/** Elevation level; out-of-bounds coordinates are clamped to the map edge. */
export function elevationAt(map: GameMap, x: number, y: number): number {
  return map.elevation[clampY(map, Math.floor(y)) * map.width + clampX(map, Math.floor(x))]
}

/** Index into map.regions; out-of-bounds coordinates are clamped to the map edge. */
export function regionAt(map: GameMap, x: number, y: number): number {
  return map.region[clampY(map, Math.floor(y)) * map.width + clampX(map, Math.floor(x))]
}

export function isStairs(map: GameMap, x: number, y: number): boolean {
  return terrainDef(terrainAt(map, x, y))?.stairs === true
}

/** Direction the ramp of a stairs tile rises towards, or null if the tile is not usable stairs. */
export function stairsDir(map: GameMap, x: number, y: number): Dir | null {
  if (!isStairs(map, x, y)) return null
  const e = elevationAt(map, x, y)
  let best: Dir | null = null
  let bestScore = -1
  for (const d of DIRS) {
    const nx = x + DIR_DX[d], ny = y + DIR_DY[d]
    if (!inBounds(map, nx, ny) || elevationAt(map, nx, ny) !== e + 1) continue
    const bx = x - DIR_DX[d], by = y - DIR_DY[d]
    const inLine = !inBounds(map, bx, by) || elevationAt(map, bx, by) <= e
    const walk = terrainDef(terrainAt(map, nx, ny))?.walkable === true
    const score = (inLine ? 2 : 0) + (walk ? 1 : 0)
    if (score > bestScore) { best = d; bestScore = score }
  }
  return best
}

export function buildCollision(map: GameMap): Uint8Array {
  const w = map.width, h = map.height
  const col = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) {
    const t = terrainDef(map.terrain[i])
    col[i] = !t ? COLLISION_BLOCKED : t.walkable ? COLLISION_FREE : t.swim ? COLLISION_WATER : COLLISION_BLOCKED
  }
  for (const p of map.props) {
    const def = CONTENT.props[p.prop]
    if (!def?.collide) continue
    const r = propRect(p)
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) if (x >= 0 && y >= 0 && x < w && y < h) col[y * w + x] = COLLISION_BLOCKED
    }
  }
  // Warp tiles (door facades, cave mouths, stairs) are always enterable.
  for (const wp of map.warps) {
    if (!inBounds(map, wp.x, wp.y)) continue
    const i = wp.y * w + wp.x
    const t = terrainDef(map.terrain[i])
    col[i] = t && !t.walkable && t.swim ? COLLISION_WATER : COLLISION_FREE
  }
  return col
}

function enterable(v: number, surf: boolean): boolean {
  return v === COLLISION_FREE || (v === COLLISION_WATER && surf)
}

function orthogonalStep(map: GameMap, col: Uint8Array, fx: number, fy: number, tx: number, ty: number, surf: boolean): boolean {
  if (!enterable(col[ty * map.width + tx], surf)) return false
  const ea = elevationAt(map, fx, fy), eb = elevationAt(map, tx, ty)
  if (ea === eb) return true
  if (ea - eb !== 1 && eb - ea !== 1) return false
  const [lx, ly, hx, hy] = ea < eb ? [fx, fy, tx, ty] : [tx, ty, fx, fy]
  const d = stairsDir(map, lx, ly)
  return d !== null && lx + DIR_DX[d] === hx && ly + DIR_DY[d] === hy
}

export function canStep(map: GameMap, collision: Uint8Array, fx: number, fy: number, tx: number, ty: number, opts: { surf: boolean }): boolean {
  const dx = tx - fx, dy = ty - fy
  if ((dx === 0 && dy === 0) || dx < -1 || dx > 1 || dy < -1 || dy > 1) return false
  if (!inBounds(map, fx, fy) || !inBounds(map, tx, ty)) return false
  if (dx === 0 || dy === 0) return orthogonalStep(map, collision, fx, fy, tx, ty, opts.surf)
  // Diagonal: flat ground only, no stairs involved, and both corner tiles must be passable.
  const e = elevationAt(map, fx, fy)
  if (elevationAt(map, tx, ty) !== e || elevationAt(map, tx, fy) !== e || elevationAt(map, fx, ty) !== e) return false
  if (isStairs(map, fx, fy) || isStairs(map, tx, ty) || isStairs(map, tx, fy) || isStairs(map, fx, ty)) return false
  const w = map.width
  return enterable(collision[ty * w + tx], opts.surf)
    && enterable(collision[fy * w + tx], opts.surf)
    && enterable(collision[ty * w + fx], opts.surf)
}
