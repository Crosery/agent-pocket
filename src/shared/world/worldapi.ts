// WorldApi: tile/object access that works for finite maps AND the infinite (ChunkProvider) overworld.
// Every consumer outside the generator should go through these helpers instead of indexing GameMap arrays.
// Conventions are the same as collision.ts (footprints, doors, stairs); additionally a `ledge` terrain tile
// lets an entity drop exactly one level onto the orthogonal neighbour it moves to (one-way).
import type { Dir, GameMap, GroundItemDef, LightDef, MapChunk, NpcDef, PropPlacement, RegionDef, SignDef, TownDef, Warp, World } from '../types.ts'
import type { CollisionField } from '../contracts.ts'
import { CONTENT } from '../content/index.ts'
import {
  COLLISION_BLOCKED, COLLISION_FREE, COLLISION_WATER, DIRS, DIR_DX, DIR_DY,
  buildCollision, elevationAt as finiteElevationAt, propRect, regionAt as finiteRegionAt, terrainAt as finiteTerrainAt,
} from './collision.ts'

export function isInfinite(map: GameMap): boolean { return map.infinite !== undefined }

/** world.maps[id], or a lazily generated frontier interior/dungeon (cached into world.maps). */
export function getMap(world: World, id: string): GameMap | null {
  const m = world.maps[id]
  if (m) return m
  for (const key in world.maps) {
    const p = world.maps[key].infinite
    if (!p) continue
    const gen = p.interior(id)
    if (gen) { world.maps[id] = gen; return gen }
  }
  return null
}

function locate(map: GameMap, x: number, y: number): { ch: MapChunk; i: number } {
  const p = map.infinite!
  const s = p.size
  const tx = Math.floor(x), ty = Math.floor(y)
  const cx = Math.floor(tx / s), cy = Math.floor(ty / s)
  const ch = p.chunk(cx, cy)
  return { ch, i: (ty - cy * s) * s + (tx - cx * s) }
}

export function terrainAt(map: GameMap, x: number, y: number): number {
  if (!map.infinite) return finiteTerrainAt(map, Math.floor(x), Math.floor(y))
  const { ch, i } = locate(map, x, y)
  return ch.terrain[i]
}

export function elevationAt(map: GameMap, x: number, y: number): number {
  if (!map.infinite) return finiteElevationAt(map, x, y)
  const { ch, i } = locate(map, x, y)
  return ch.elevation[i]
}

export function regionAt(map: GameMap, x: number, y: number): RegionDef | null {
  if (!map.infinite) return map.regions[finiteRegionAt(map, x, y)] ?? null
  const { ch, i } = locate(map, x, y)
  const id = ch.regionIds[ch.region[i]]
  return id === undefined ? null : map.infinite.region(id)
}

function inside(map: GameMap, x: number, y: number): boolean {
  return map.infinite !== undefined || (x >= 0 && y >= 0 && x < map.width && y < map.height)
}

function terrainCollision(id: number): number {
  const t = CONTENT.terrain[id]
  return !t ? COLLISION_BLOCKED : t.walkable ? COLLISION_FREE : t.swim ? COLLISION_WATER : COLLISION_BLOCKED
}

// Per-chunk collision. Props are anchored at their top-left tile, so a chunk can be covered by props anchored
// in its west / north / north-west neighbours (footprints are always smaller than a chunk).
const CHUNK_COL = new WeakMap<MapChunk, Uint8Array>()

function chunkCollision(map: GameMap, ch: MapChunk): Uint8Array {
  let col = CHUNK_COL.get(ch)
  if (col) return col
  const p = map.infinite!
  const s = ch.size, ox = ch.cx * s, oy = ch.cy * s
  col = new Uint8Array(s * s)
  for (let i = 0; i < s * s; i++) col[i] = terrainCollision(ch.terrain[i])
  const sources = [ch, p.chunk(ch.cx - 1, ch.cy), p.chunk(ch.cx, ch.cy - 1), p.chunk(ch.cx - 1, ch.cy - 1)]
  for (const src of sources) {
    for (const pl of src.props) {
      if (!CONTENT.props[pl.prop]?.collide) continue
      const r = propRect(pl)
      const x0 = Math.max(r.x, ox), x1 = Math.min(r.x + r.w, ox + s)
      const y0 = Math.max(r.y, oy), y1 = Math.min(r.y + r.h, oy + s)
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) col[(y - oy) * s + (x - ox)] = COLLISION_BLOCKED
    }
  }
  // Warp tiles (door facades, cave mouths, stairs) are always enterable.
  for (const wp of ch.warps) {
    const i = (wp.y - oy) * s + (wp.x - ox)
    if (i < 0 || i >= s * s) continue
    col[i] = terrainCollision(ch.terrain[i]) === COLLISION_WATER ? COLLISION_WATER : COLLISION_FREE
  }
  CHUNK_COL.set(ch, col)
  return col
}

const FINITE_FIELD = new WeakMap<GameMap, CollisionField>()

/** Collision values: 0 free, 1 blocked, 2 water. Finite maps are built once; infinite maps per chunk on demand. */
export function collisionField(map: GameMap): CollisionField {
  let f = FINITE_FIELD.get(map)
  if (f) return f
  if (map.infinite) {
    f = { map, at: (x, y) => { const { ch, i } = locate(map, x, y); return chunkCollision(map, ch)[i] } }
  } else {
    const col = buildCollision(map)
    f = { map, at: (x, y) => (x >= 0 && y >= 0 && x < map.width && y < map.height ? col[y * map.width + x] : COLLISION_BLOCKED) }
  }
  FINITE_FIELD.set(map, f)
  return f
}

/** Drop cached collision for a finite map whose tiles/props changed (e.g. a gate opened). */
export function invalidateCollision(map: GameMap): void { FINITE_FIELD.delete(map) }

function terrainFlag(map: GameMap, x: number, y: number, key: 'stairs' | 'ledge'): boolean {
  return CONTENT.terrain[terrainAt(map, x, y)]?.[key] === true
}

export function isStairs(map: GameMap, x: number, y: number): boolean { return terrainFlag(map, x, y, 'stairs') }
export function isLedge(map: GameMap, x: number, y: number): boolean { return terrainFlag(map, x, y, 'ledge') }

/** Direction the ramp of a stairs tile rises towards, or null (same scoring as collision.ts). */
export function stairsDir(map: GameMap, x: number, y: number): Dir | null {
  if (!isStairs(map, x, y)) return null
  const e = elevationAt(map, x, y)
  let best: Dir | null = null
  let bestScore = -1
  for (const d of DIRS) {
    const nx = x + DIR_DX[d], ny = y + DIR_DY[d]
    if (!inside(map, nx, ny) || elevationAt(map, nx, ny) !== e + 1) continue
    const bx = x - DIR_DX[d], by = y - DIR_DY[d]
    const inLine = !inside(map, bx, by) || elevationAt(map, bx, by) <= e
    const walk = CONTENT.terrain[terrainAt(map, nx, ny)]?.walkable === true
    const score = (inLine ? 2 : 0) + (walk ? 1 : 0)
    if (score > bestScore) { best = d; bestScore = score }
  }
  return best
}

function enterable(v: number, surf: boolean): boolean {
  return v === COLLISION_FREE || (v === COLLISION_WATER && surf)
}

/** True when the step from (fx,fy) to the orthogonal neighbour (tx,ty) is a one-way ledge drop. */
export function isLedgeDrop(map: GameMap, fx: number, fy: number, tx: number, ty: number): boolean {
  return isLedge(map, fx, fy) && elevationAt(map, tx, ty) === elevationAt(map, fx, fy) - 1
}

function orthogonalStep(map: GameMap, field: CollisionField, fx: number, fy: number, tx: number, ty: number, surf: boolean): boolean {
  if (!enterable(field.at(tx, ty), surf)) return false
  const ea = elevationAt(map, fx, fy), eb = elevationAt(map, tx, ty)
  if (ea === eb) return true
  if (ea - eb !== 1 && eb - ea !== 1) return false
  if (ea - eb === 1 && isLedge(map, fx, fy)) return true
  const [lx, ly, hx, hy] = ea < eb ? [fx, fy, tx, ty] : [tx, ty, fx, fy]
  const d = stairsDir(map, lx, ly)
  return d !== null && lx + DIR_DX[d] === hx && ly + DIR_DY[d] === hy
}

/** 8-dir step rules: same level, stairs (±1 along the stairs axis), ledge drop (-1, one-way), surf for water. */
export function canStep(map: GameMap, field: CollisionField, fx: number, fy: number, tx: number, ty: number, opts: { surf: boolean }): boolean {
  const dx = tx - fx, dy = ty - fy
  if ((dx === 0 && dy === 0) || dx < -1 || dx > 1 || dy < -1 || dy > 1) return false
  if (!inside(map, fx, fy) || !inside(map, tx, ty)) return false
  if (dx === 0 || dy === 0) return orthogonalStep(map, field, fx, fy, tx, ty, opts.surf)
  // Diagonal: flat ground only, no stairs/ledges involved, and both corner tiles must be passable.
  const e = elevationAt(map, fx, fy)
  if (elevationAt(map, tx, ty) !== e || elevationAt(map, tx, fy) !== e || elevationAt(map, fx, ty) !== e) return false
  for (const [x, y] of [[fx, fy], [tx, ty], [tx, fy], [fx, ty]]) if (isStairs(map, x, y) || isLedge(map, x, y)) return false
  return enterable(field.at(tx, ty), opts.surf) && enterable(field.at(tx, fy), opts.surf) && enterable(field.at(fx, ty), opts.surf)
}

export interface ObjectsInRect {
  props: PropPlacement[]
  npcs: NpcDef[]
  signs: SignDef[]
  items: GroundItemDef[]
  warps: Warp[]
  lights: LightDef[]
  places: TownDef[]
}

function inRect(o: { x: number; y: number }, x0: number, y0: number, x1: number, y1: number): boolean {
  return o.x >= x0 && o.y >= y0 && o.x < x1 && o.y < y1
}

/** Objects anchored inside [x0,x1) x [y0,y1). Infinite maps generate the covering chunks on demand. */
export function objectsInRect(map: GameMap, x0: number, y0: number, x1: number, y1: number): ObjectsInRect {
  const out: ObjectsInRect = { props: [], npcs: [], signs: [], items: [], warps: [], lights: [], places: [] }
  const take = (src: Omit<ObjectsInRect, 'places'> & { places?: TownDef[] }) => {
    for (const o of src.props) if (inRect(o, x0, y0, x1, y1)) out.props.push(o)
    for (const o of src.npcs) if (inRect(o, x0, y0, x1, y1)) out.npcs.push(o)
    for (const o of src.signs) if (inRect(o, x0, y0, x1, y1)) out.signs.push(o)
    for (const o of src.items) if (inRect(o, x0, y0, x1, y1)) out.items.push(o)
    for (const o of src.warps) if (inRect(o, x0, y0, x1, y1)) out.warps.push(o)
    for (const o of src.lights) if (inRect(o, x0, y0, x1, y1)) out.lights.push(o)
    for (const o of src.places ?? []) if (inRect(o, x0, y0, x1, y1)) out.places.push(o)
  }
  const p = map.infinite
  if (!p) { take(map); return out }
  const s = p.size
  for (let cy = Math.floor(y0 / s); cy <= Math.floor((y1 - 1) / s); cy++) {
    for (let cx = Math.floor(x0 / s); cx <= Math.floor((x1 - 1) / s); cx++) take(p.chunk(cx, cy))
  }
  return out
}

export function warpAt(map: GameMap, x: number, y: number): Warp | null {
  const list = map.infinite ? locate(map, x, y).ch.warps : map.warps
  return list.find((w) => w.x === x && w.y === y) ?? null
}

/** Origin of the world = the overworld spawn (start town). */
export function worldOrigin(world: World): { x: number; y: number } {
  for (const key in world.maps) {
    const m = world.maps[key]
    if (m.kind === 'overworld') return { x: m.spawn.x, y: m.spawn.y }
  }
  return { x: 0, y: 0 }
}

/** Distance in tiles from the world origin — drives frontier difficulty and rarity. */
export function distanceFromOrigin(world: World, x: number, y: number): number {
  const o = worldOrigin(world)
  return Math.hypot(x - o.x, y - o.y)
}
