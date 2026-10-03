// Mutable map under construction + tile flags + prop occupancy helpers shared by all generator stages.
import type { Dir, GameMap, GroundItemDef, LightDef, PropPlacement, RegionDef, SignDef, Warp } from '../types.ts'
import { CONTENT } from '../content/index.ts'
import { propCenter, propRect } from './collision.ts'

// Tile flags (generation bookkeeping only; not part of GameMap).
export const F_PATH = 1 << 0       // carved route / connector path
export const F_ROAD = 1 << 1       // hamlet / POI internal road (not part of the route network)
export const F_TOWN = 1 << 2       // inside a stamped town template
export const F_LOCK = 1 << 3       // flattened area (town + margin, lake)
export const F_RIVER = 1 << 4
export const F_BRIDGE = 1 << 5
export const F_BORDER = 1 << 6     // region border band (walled)
export const F_KEEP = 1 << 7       // keep clear of scattered props
export const F_EDGE = 1 << 8       // map edge band (walled)
export const F_BEACH = 1 << 9
export const F_RESERVED = 1 << 10  // warp / door front / sign / anchor tiles
export const F_ISLAND = 1 << 11
export const F_LAKE = 1 << 12
export const F_GATE = 1 << 13
export const F_SEA = 1 << 14
export const F_CRATER = 1 << 15
export const F_SITE = 1 << 16     // hamlet / POI pad (no biome dressing, no scatter)
export const F_NEST = 1 << 17     // rare-spawn nest grass

export interface MapDraft {
  id: string
  nameZh: string
  kind: GameMap['kind']
  w: number
  h: number
  terrain: Uint8Array
  elevation: Uint8Array
  region: Uint8Array
  flags: Uint32Array
  /** prop index + 1 covering the tile (0 = none) */
  occ: Int32Array
  props: PropPlacement[]
  warps: Warp[]
  signs: SignDef[]
  items: GroundItemDef[]
  regions: RegionDef[]
  spawn: { x: number; y: number; facing: Dir }
  outdoor: boolean
  music: string
  parent?: string
}

export function newDraft(o: { id: string; nameZh: string; kind: GameMap['kind']; w: number; h: number; fill: number; outdoor: boolean; music: string; parent?: string }): MapDraft {
  const n = o.w * o.h
  return {
    id: o.id, nameZh: o.nameZh, kind: o.kind, w: o.w, h: o.h,
    terrain: new Uint8Array(n).fill(o.fill), elevation: new Uint8Array(n), region: new Uint8Array(n),
    flags: new Uint32Array(n), occ: new Int32Array(n),
    props: [], warps: [], signs: [], items: [], regions: [],
    spawn: { x: 0, y: 0, facing: 'down' }, outdoor: o.outdoor, music: o.music, parent: o.parent,
  }
}

export const idx = (d: MapDraft, x: number, y: number) => y * d.w + x
export const inside = (d: MapDraft, x: number, y: number) => x >= 0 && y >= 0 && x < d.w && y < d.h

export function hasFlag(d: MapDraft, i: number, f: number): boolean { return (d.flags[i] & f) !== 0 }
export function addFlag(d: MapDraft, i: number, f: number): void { d.flags[i] |= f }

/** A GameMap view sharing the draft's arrays (for collision queries during generation). */
export function draftView(d: MapDraft): GameMap {
  return {
    id: d.id, nameZh: d.nameZh, kind: d.kind, width: d.w, height: d.h,
    terrain: d.terrain, elevation: d.elevation, region: d.region, regions: d.regions,
    props: d.props, warps: d.warps, npcs: [], signs: d.signs, items: d.items, lights: [],
    spawn: d.spawn, outdoor: d.outdoor, music: d.music, parent: d.parent,
  }
}

export function lightsFor(props: PropPlacement[]): LightDef[] {
  const out: LightDef[] = []
  for (const p of props) {
    const l = CONTENT.props[p.prop]?.light
    if (!l) continue
    const c = propCenter(p)
    out.push({ x: c.x, y: c.y, h: l.h, color: l.color, intensity: l.intensity, radius: l.radius, nightOnly: l.nightOnly })
  }
  return out
}

export function finalizeDraft(d: MapDraft): GameMap {
  return { ...draftView(d), lights: lightsFor(d.props), npcs: [] }
}

export interface PlaceOpts {
  /** Flags that forbid placement on any footprint tile. */
  forbid?: number
  /** Allow placement on non-walkable terrain (boats on water). */
  anyTerrain?: boolean
  /** Allowed terrain ids (overrides walkability check). */
  on?: Set<number> | null
  /** Require the whole footprint at one elevation (default true). */
  flat?: boolean
}

export function canPlace(d: MapDraft, p: PropPlacement, o: PlaceOpts = {}): boolean {
  const r = propRect(p)
  if (r.x < 0 || r.y < 0 || r.x + r.w > d.w || r.y + r.h > d.h) return false
  const e0 = d.elevation[idx(d, r.x, r.y)]
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const i = idx(d, x, y)
      if (d.occ[i] !== 0) return false
      if (o.forbid && (d.flags[i] & o.forbid) !== 0) return false
      if (o.flat !== false && d.elevation[i] !== e0) return false
      const t = CONTENT.terrain[d.terrain[i]]
      if (o.on) { if (!o.on.has(d.terrain[i])) return false }
      else if (!o.anyTerrain && (!t?.walkable || t.stairs || t.liquid)) return false
    }
  }
  return true
}

/** Places a prop and marks its footprint as occupied. Returns the prop index. */
export function placeProp(d: MapDraft, p: PropPlacement): number {
  const r = propRect(p)
  d.props.push(p)
  const n = d.props.length
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (inside(d, x, y)) d.occ[idx(d, x, y)] = n
  return n - 1
}

/** Multi-source BFS distance (4-neighbour) from source tiles, capped at `max`. */
export function distanceField(d: MapDraft, isSource: (i: number) => boolean, max: number, passable?: (i: number) => boolean): Uint16Array {
  const cap = Math.min(max, 65535)
  const W = d.w, N = d.w * d.h
  const dist = new Uint16Array(N).fill(cap)
  const queue = new Int32Array(N)
  let head = 0, tail = 0
  for (let i = 0; i < N; i++) if (isSource(i)) { dist[i] = 0; queue[tail++] = i }
  while (head < tail) {
    const i = queue[head++]
    const nd = dist[i] + 1
    if (nd >= cap) continue
    const x = i % W
    for (let k = 0; k < 4; k++) {
      const j = k === 0 ? (x > 0 ? i - 1 : -1) : k === 1 ? (x < W - 1 ? i + 1 : -1) : k === 2 ? i - W : i + W
      if (j < 0 || j >= N || dist[j] <= nd || (passable && !passable(j))) continue
      dist[j] = nd
      queue[tail++] = j
    }
  }
  return dist
}

/** Fills `{token}` placeholders. */
export function fmt(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m))
}
