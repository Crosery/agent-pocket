// Shared helpers of the frontier content pack: text formatting (story placeholder syntax), bearings, NPC spot search
// inside a chunk, script gates compiled from EventConditions, small pure LRU memo. No data — tables come from JSON.
import type { EventCondition, ScriptStep } from '../../../types.ts'
import { CONTENT, t } from '../../../content/index.ts'
import { fmt } from '../../grid.ts'
import { rngFor, type Rng } from '../../random.ts'
import { compiledFrontier, curve, tid } from '../config.ts'
import type { ChunkDecorContext } from '../decorate.ts'
import { Lru } from '../lru.ts'
import { FRONTIER_PACK } from './data.ts'
import type { Curve, ItemRoll, ItemTier, Lines } from './schema.ts'

export type Params = Record<string, string | number>
export interface Pt { x: number; y: number }

export const curveAt = (c: Curve, d: number): number => curve(c, d)

/**
 * fmt() plus the story bounty syntax: `{item:<id>}` / `{type:<id>}` / `{species:<id>}` resolve to display names
 * (the inner `{param}` is substituted first, so `{item:{parcel}}` works).
 */
export function text(template: string, params: Params): string {
  const once = fmt(template, params)
  return once.replace(/\{(item|type|species):([\w-]+)\}/g, (m, kind: string, id: string) => {
    if (kind === 'item') return CONTENT.items[id]?.nameZh ?? m
    if (kind === 'type') return CONTENT.typeById[id]?.nameZh ?? m
    return CONTENT.species[id]?.nameZh ?? m
  })
}

export const say = (line: string, params: Params): ScriptStep => ({ op: 'say', text: text(line, params) })
export const sayAll = (lines: readonly string[], params: Params): ScriptStep[] => lines.map((l) => say(l, params))

/** 8-way bearing word from `from` to `to` (common.json directions, north first, clockwise). */
export function bearing(from: Pt, to: Pt): string {
  const d = FRONTIER_PACK.common.directions
  const dx = to.x - from.x, dy = to.y - from.y
  const ax = Math.abs(dx), ay = Math.abs(dy)
  // tan(22.5°): inside it of an axis the bearing is cardinal, otherwise diagonal.
  const T = 0.41421356
  if (ax <= ay * T) return dy < 0 ? d[0] : d[4]
  if (ay <= ax * T) return dx > 0 ? d[2] : d[6]
  if (dy < 0) return dx > 0 ? d[1] : d[7]
  return dx > 0 ? d[3] : d[5]
}

export function farness(from: Pt, to: Pt): string {
  const bands = FRONTIER_PACK.common.distances
  const dd = Math.hypot(to.x - from.x, to.y - from.y)
  return (bands.find((b) => dd <= b.max) ?? bands[bands.length - 1]).text
}

export function stars(danger: number): string {
  const s = FRONTIER_PACK.common.stars
  const n = Math.max(1, danger + 1)
  const max = Math.max(n, FRONTIER_PACK.common.dangerNames.length)
  return s.full.repeat(n) + s.empty.repeat(Math.max(0, max - n))
}

export const biomeName = (id: string | undefined): string => (id ? CONTENT.biomeById[id]?.nameZh ?? '' : '')
export const typeName = (id: string): string => CONTENT.typeById[id]?.nameZh ?? id
export const weatherName = (id: string): string => t(fmt(FRONTIER_PACK.common.textKeys.weather, { id }))
export const timeName = (id: string): string => t(fmt(FRONTIER_PACK.common.textKeys.timeOfDay, { id }))

/** Person name from a pattern with {surname}/{given} (villagers.json names pools). */
export function personName(pattern: string, rng: Rng): string {
  const n = FRONTIER_PACK.villagers.names
  return fmt(pattern, { surname: rng.pick(n.surnames), given: rng.pick(n.given) })
}

export function rollItem(tiers: readonly ItemTier[], dist: number, rng: Rng): { item: string; qty: number } | null {
  let tier: ItemTier | null = null
  for (const t0 of tiers) if (dist >= t0.minDistance) tier = t0
  const pool = (tier?.pool ?? []).filter((r) => CONTENT.items[r.item])
  if (!pool.length) return null
  const r: ItemRoll = rng.weighted(pool, (x) => x.weight)
  return { item: r.item, qty: rng.int(r.qty[0], r.qty[1]) }
}

export const siteRngOf = (seed: number, id: string, salt: string): Rng => rngFor(seed, `fxc-${id}-${salt}`)

// ---------------------------------------------------------------------------------------------- placement

let AVOID: Set<number> | null = null
/** Path-like terrain no extra NPC / prop may stand on (lanes, plazas, roads, bridges, stairs). */
export function pathTerrain(): Set<number> {
  if (AVOID) return AVOID
  const cf = compiledFrontier()
  const out = new Set<number>([cf.roadDefault, cf.bridge, cf.stairs, cf.causeway])
  // Biome roads drawn in a natural terrain (desert sand, snow, salt…) are not avoidable by terrain: they would ban
  // the whole biome; such roads are only recognised through their drawn edge tiles (wild.ts roadTiles).
  const natural = new Set<number>()
  for (const b of cf.biome) if (b) { natural.add(b.ground); natural.add(b.beach) }
  for (const b of cf.biome) if (b && !natural.has(b.road)) out.add(b.road)
  for (const k of FRONTIER_PACK.common.place.avoidTerrain) if (CONTENT.terrainByKey[k]) out.add(tid(k))
  AVOID = out
  return out
}

export interface SpotRules {
  /** Required free orthogonal neighbours (default common.place.minNeighbours). */
  neighbours?: number
  /** Natural ground only (not road / shoulder / site pad). */
  wild?: boolean
  /** Exact elevation level. */
  level?: number
  /** Keep this Manhattan distance from these points. */
  away?: readonly Pt[]
  spacing?: number
  /** Tiles that must stay clear (door fronts) — Chebyshev distance 1 is refused. */
  keepClear?: readonly Pt[]
  /** Exact tiles refused ("x,y" keys), e.g. drawn road tiles in biomes whose road is natural ground. */
  keepOff?: ReadonlySet<string>
}

/** True when an NPC may stand on (x, y): free, not on a path, not on the chunk rim, open around it. */
export function spotOk(ctx: ChunkDecorContext, x: number, y: number, r: SpotRules = {}): boolean {
  const S = ctx.size
  if (x <= ctx.x0 || y <= ctx.y0 || x >= ctx.x0 + S - 1 || y >= ctx.y0 + S - 1) return false
  if (!ctx.isFree(x, y) || pathTerrain().has(ctx.terrainAt(x, y))) return false
  if (r.wild && !ctx.isWild(x, y)) return false
  if (r.level !== undefined && ctx.levelAt(x, y) !== r.level) return false
  const lv = ctx.levelAt(x, y)
  let open = 0
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (ctx.isFree(x + dx, y + dy) && ctx.levelAt(x + dx, y + dy) === lv) open++
  if (open < (r.neighbours ?? FRONTIER_PACK.common.place.minNeighbours)) return false
  const sp = r.spacing ?? FRONTIER_PACK.common.place.spacing
  if (r.away) for (const p of r.away) if (Math.abs(p.x - x) + Math.abs(p.y - y) < sp) return false
  if (r.keepClear) for (const p of r.keepClear) if (Math.abs(p.x - x) <= 1 && Math.abs(p.y - y) <= 1) return false
  if (r.keepOff?.has(`${x},${y}`)) return false
  return true
}

/** Nearest acceptable tile to (ax, ay) inside the chunk (square rings, fixed scan order), or null. */
export function findSpot(ctx: ChunkDecorContext, ax: number, ay: number, radius: number, r: SpotRules = {}): Pt | null {
  for (let d = 0; d <= radius; d++) {
    for (let dy = -d; dy <= d; dy++) {
      for (let dx = -d; dx <= d; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== d) continue
        const x = ax + dx, y = ay + dy
        if (ctx.inChunk(x, y) && spotOk(ctx, x, y, r)) return { x, y }
      }
    }
  }
  return null
}

// 16 bearings from small integer vectors (sqrt only — no trigonometry, so every engine yields the same tiles).
const RING_DIRS: [number, number][] = [[1, 0], [2, 1], [1, 1], [1, 2], [0, 1], [-1, 2], [-1, 1], [-2, 1], [-1, 0], [-2, -1], [-1, -1], [-1, -2], [0, -1], [1, -2], [1, -1], [2, -1]]
  .map(([x, y]) => { const l = Math.sqrt(x * x + y * y); return [x / l, y / l] as [number, number] })

/** Deterministic ring point around a centre (bearing from rng, radius in common.place.ring). */
export function ringPoint(c: Pt, rng: Rng, ring = FRONTIER_PACK.common.place.ring): Pt {
  const [vx, vy] = RING_DIRS[rng.int(0, RING_DIRS.length - 1)]
  const r = ring[0] + rng.next() * (ring[1] - ring[0])
  return { x: c.x + Math.round(vx * r), y: c.y + Math.round(vy * r) }
}

/** World chunk coordinates of a tile. */
export const chunkOf = (x: number, y: number, size: number): [number, number] => [Math.floor(x / size), Math.floor(y / size)]
export const ownsPoint = (ctx: ChunkDecorContext, p: Pt): boolean => ctx.inChunk(p.x, p.y)

/** Footprint fits fully inside the chunk on free, non-path tiles of one level (props never spill out). */
export function fitsProp(ctx: ChunkDecorContext, x: number, y: number, w: number, h: number): boolean {
  const lv = ctx.levelAt(x, y)
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
    if (!ctx.inChunk(xx, yy) || !ctx.isFree(xx, yy) || pathTerrain().has(ctx.terrainAt(xx, yy)) || ctx.levelAt(xx, yy) !== lv) return false
  }
  return true
}

export function occupyRect(ctx: ChunkDecorContext, x: number, y: number, w: number, h: number): void {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) ctx.occupy(xx, yy)
}

// ---------------------------------------------------------------------------------------------- script gates

/**
 * Compiles the progress gates of an EventCondition into nested script branches (flags, badges, dex count, items,
 * caught species). Flags starting with `ignorePrefix` are skipped. Returns null when the condition uses gates a
 * script cannot test (party / lead / events / research) — callers then skip that content.
 */
export function gated(cond: EventCondition | undefined, then: ScriptStep[], otherwise: ScriptStep[], ignorePrefix?: string): ScriptStep[] | null {
  if (!cond) return then
  if (cond.partyHasType || cond.partyHasSpecies || cond.partyHasRarity || cond.leadSpecies || cond.eventsDone || cond.notCaught || cond.researchLevelAtLeast !== undefined) return null
  let body = then
  const wrap = (mk: (inner: ScriptStep[]) => ScriptStep) => { body = [mk(body)] }
  for (const [flag, want] of Object.entries(cond.flags ?? {})) {
    if (ignorePrefix && flag.startsWith(ignorePrefix)) continue
    if (want === false) wrap((inner) => ({ op: 'ifFlag', flag, then: otherwise, else: inner }))
    else if (want === true) wrap((inner) => ({ op: 'ifFlag', flag, then: inner, else: otherwise }))
    else wrap((inner) => ({ op: 'ifFlag', flag, equals: want, then: inner, else: otherwise }))
  }
  if (cond.badgesAtLeast !== undefined) { const n = cond.badgesAtLeast; wrap((inner) => ({ op: 'ifBadges', atLeast: n, then: inner, else: otherwise })) }
  if (cond.dexCaughtAtLeast !== undefined) { const n = cond.dexCaughtAtLeast; wrap((inner) => ({ op: 'ifDex', caughtAtLeast: n, then: inner, else: otherwise })) }
  if (cond.hasItem) { const item = cond.hasItem; wrap((inner) => ({ op: 'ifItem', item, then: inner, else: otherwise })) }
  for (const species of cond.caught ?? []) wrap((inner) => ({ op: 'ifCaught', species, then: inner, else: otherwise }))
  return body
}

// ---------------------------------------------------------------------------------------------- memo

const MEMO = new Lru<string, unknown>(4096)
/** Memoises a pure function of the seed + key (bounded; safe across providers of the same seed). */
export function memo<T>(seed: number, key: string, make: () => T): T {
  const k = `${seed >>> 0}|${key}`
  const hit = MEMO.get(k)
  if (hit !== undefined) return hit as T
  const v = make()
  MEMO.set(k, v)
  return v
}

export function pickLines(pool: readonly Lines[], rng: Rng): Lines { return pool.length ? rng.pick(pool) : [] }
