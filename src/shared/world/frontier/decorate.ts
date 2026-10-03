// Deterministic decoration hooks for the frontier. Chunk decorators run once per generated chunk (after terrain,
// site layouts and scatter) and may add NPCs / signs / ground items / props anchored INSIDE the chunk; interior
// decorators run once per lazily generated frontier interior or dungeon floor. Decorators must be pure functions
// of their context (use ctx.rng(salt) — never Math.random or wall-clock time) so client and server agree.
// Register before the world is built (module load); provider.clearCache() regenerates already-cached chunks.
import type { GameMap, MapChunk, NpcDef, RegionDef, ScriptStep, TownDef } from '../../types.ts'
import { CONTENT } from '../../content/index.ts'
import { WORLD_CONTENT } from '../data.ts'
import { fmt } from '../grid.ts'
import { bandFor, pickItem } from '../items.ts'
import { rngFor, type Rng } from '../random.ts'
import type { RoadEdge } from './roads.ts'
import type { SiteLayout } from './layout.ts'
import type { FrontierSite } from './sites.ts'
import { compiledFrontier } from './config.ts'

export interface DecorSite {
  site: FrontierSite
  layout: SiteLayout
  /** Place entry (hamlets / landmarks) or null. */
  place: TownDef | null
  /** Region at the site centre. */
  region: RegionDef | null
}

/**
 * Global read-only frontier queries (cache-backed, pure functions of the seed), so content decorators can link a
 * site to its neighbours (bounty destinations, clue targets) without depending on chunk generation order.
 */
export interface FrontierLookup {
  /** Site grid cell size (tiles). */
  readonly cell: number
  siteAt(sx: number, sy: number): FrontierSite | null
  decorSite(site: FrontierSite): DecorSite
  region(id: string): RegionDef | null
  /** Road edges whose bounding box (grown by pad) touches [x0, x1) x [y0, y1). */
  edgesNear(x0: number, y0: number, x1: number, y1: number, pad: number): RoadEdge[]
  /** Distance in tiles from the world origin. */
  distance(x: number, y: number): number
}

export interface ChunkDecorContext {
  readonly seed: number
  /** Whole-frontier lookups (neighbouring sites, their layouts / regions / roads). */
  readonly lookup: FrontierLookup
  readonly overworldId: string
  readonly cx: number
  readonly cy: number
  readonly size: number
  /** World tile of the chunk's top-left corner. */
  readonly x0: number
  readonly y0: number
  /** The chunk under construction: push into npcs / signs / items / props (lights are derived afterwards). */
  readonly chunk: MapChunk
  /** Sites whose layout window touches this chunk (objects of a site may live in neighbouring chunks). */
  readonly sites: readonly DecorSite[]
  /** Road edges touching this chunk (path tiles + endpoints) for signposts / road-side content. */
  readonly edges: readonly RoadEdge[]
  inChunk(x: number, y: number): boolean
  terrainAt(x: number, y: number): number
  levelAt(x: number, y: number): number
  regionAt(x: number, y: number): RegionDef | null
  /** Walkable, dry, not stairs/ledge, not a road shoulder/site, no prop/warp/sign/npc/item on it (inside the chunk). */
  isFree(x: number, y: number): boolean
  /** True for natural ground (not road / shoulder / site pad); combine with isFree for wilderness spots. */
  isWild(x: number, y: number): boolean
  /** Marks a tile as taken (call after adding an object there). */
  occupy(x: number, y: number): void
  /** Distance in tiles from the world origin. */
  distance(x: number, y: number): number
  rng(salt: string): Rng
}

export interface InteriorDecorContext {
  readonly seed: number
  readonly map: GameMap
  /** 'house' | 'center' | 'shop' | other interior slot kinds | 'dungeon'. */
  readonly kind: string
  readonly slot: string
  readonly site: FrontierSite
  readonly layout: SiteLayout
  /** Dungeon floor (1-based) or 0. */
  readonly floor: number
  readonly floors: number
  /** Template anchors / dungeon spots in map coordinates. */
  readonly anchors: Readonly<Record<string, { x: number; y: number }>>
  readonly region: RegionDef
  readonly distance: number
  rng(salt: string): Rng
}

export type ChunkDecorator = (ctx: ChunkDecorContext) => void
export type InteriorDecorator = (ctx: InteriorDecorContext) => void

interface Entry<F> { id: string; order: number; fn: F }
const CHUNK_DECORATORS: Entry<ChunkDecorator>[] = []
const INTERIOR_DECORATORS: Entry<InteriorDecorator>[] = []

function add<F>(list: Entry<F>[], id: string, fn: F, order: number): void {
  const at = list.findIndex((e) => e.id === id)
  if (at >= 0) list.splice(at, 1)
  list.push({ id, order, fn })
  list.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1))
}

/** Adds or replaces a chunk decorator (lower order runs first; built-in defaults use order 0). */
export function registerChunkDecorator(id: string, fn: ChunkDecorator, order = 100): void { add(CHUNK_DECORATORS, id, fn, order) }
export function registerInteriorDecorator(id: string, fn: InteriorDecorator, order = 100): void { add(INTERIOR_DECORATORS, id, fn, order) }
export function unregisterDecorator(id: string): void {
  for (const list of [CHUNK_DECORATORS, INTERIOR_DECORATORS] as Entry<unknown>[][]) {
    const at = list.findIndex((e) => e.id === id)
    if (at >= 0) list.splice(at, 1)
  }
}
export function chunkDecorators(): readonly Entry<ChunkDecorator>[] { return CHUNK_DECORATORS }
export function interiorDecorators(): readonly Entry<InteriorDecorator>[] { return INTERIOR_DECORATORS }

/** Recursively formats every text field of a script with {params}. */
export function formatScript(steps: readonly ScriptStep[], params: Record<string, string | number>): ScriptStep[] {
  const walk = (s: unknown): unknown => {
    if (typeof s === 'string') return fmt(s, params)
    if (Array.isArray(s)) return s.map(walk)
    if (s && typeof s === 'object') return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, k === 'op' ? v : walk(v)]))
    return s
  }
  return walk(steps) as ScriptStep[]
}

// ---------------------------------------------------------------------------
// Built-in defaults (all data from content/world/frontier/decor.json)
// ---------------------------------------------------------------------------

function villagers(ctx: ChunkDecorContext): void {
  const dc = compiledFrontier().fc.decor.villagers
  for (const ds of ctx.sites) {
    if (ds.site.type !== 'hamlet') continue
    const rng = rngFor(ctx.seed, `${ds.site.id}-villagers`)
    const n = Math.min(ds.layout.spots.length, rng.int(dc.perHamlet[0], dc.perHamlet[1]))
    const region = ds.region
    for (let k = 0; k < n; k++) {
      const spot = ds.layout.spots[k]
      const sprite = rng.pick(dc.sprites)
      const nameZh = rng.pick(dc.names)
      const lines = rng.pick(dc.lines)
      if (!ctx.inChunk(spot.x, spot.y) || !ctx.isFree(spot.x, spot.y)) continue
      const params = {
        place: ds.layout.nameZh, distance: Math.round(ctx.distance(spot.x, spot.y)), region: region?.nameZh ?? '',
        biome: CONTENT.biomeById[region?.biome ?? '']?.nameZh ?? '',
      }
      const npc: NpcDef = {
        id: `${ds.site.id}:villager-${k + 1}`, x: spot.x, y: spot.y, facing: 'down', sprite, nameZh, role: 'villager',
        script: lines.map((text) => ({ op: 'say', text: fmt(text, params) }) as ScriptStep), wander: dc.wander,
      }
      ctx.chunk.npcs.push(npc)
      ctx.occupy(spot.x, spot.y)
    }
  }
}

/** Signposts beside every road where it enters a hamlet / landmark pad: place name, distance, level hint. */
function signposts(ctx: ChunkDecorContext): void {
  const cf = compiledFrontier()
  const sp = cf.fc.decor.signposts
  const off = cf.fc.gen.roads.signOffset
  for (const e of ctx.edges) {
    for (const [end, fromStart] of [[e.a, true], [e.b, false]] as const) {
      if (!end || !end.kind.place) continue
      const ds = ctx.sites.find((s) => s.site.id === end.id)
      if (!ds) continue
      const n = e.xs.length
      const r = end.radius + off
      // First drawn path tile outside radius r, walking away from the site.
      for (let k = 0; k < n; k++) {
        const i = fromStart ? k : n - 1 - k
        const x = e.xs[i], y = e.ys[i]
        const dx = x - end.x, dy = y - end.y
        if (dx * dx + dy * dy <= r * r || !e.drawn[i]) continue
        const j = Math.max(0, Math.min(n - 1, fromStart ? i - 1 : i + 1))
        const horiz = j !== i ? e.ys[j] === y : true
        // Perpendicular shoulder tiles beside the road.
        const cands = horiz ? [[x, y + 1], [x, y - 1]] : [[x + 1, y], [x - 1, y]]
        for (const [sx, sy] of cands) {
          if (!ctx.inChunk(sx, sy) || !ctx.isFree(sx, sy) || ctx.levelAt(sx, sy) !== e.levels[i]) continue
          const lv = ds.layout.levelRange
          const desc = fmt(sp.distanceFormat, { distance: Math.round(ctx.distance(end.x, end.y)), level: lv[0] })
          ctx.chunk.props.push({ prop: sp.prop, x: sx, y: sy, rot: 0 })
          ctx.chunk.signs.push({ x: sx, y: sy, text: fmt(sp.format, { name: ds.layout.nameZh, desc }), kind: 'sign' })
          ctx.occupy(sx, sy)
          break
        }
        break
      }
    }
  }
}

function groundItems(ctx: ChunkDecorContext): void {
  const cf = compiledFrontier()
  const ic = cf.fc.decor.items
  const rules = WORLD_CONTENT.items
  const rng = ctx.rng('items')
  const n = rng.int(ic.perChunk[0], ic.perChunk[1])
  const placed: { x: number; y: number }[] = []
  for (let k = 0, tries = 0; k < n && tries < ic.tries; tries++) {
    const x = ctx.x0 + rng.int(0, ctx.size - 1), y = ctx.y0 + rng.int(0, ctx.size - 1)
    if (!ctx.isFree(x, y) || !ctx.isWild(x, y)) continue
    if (placed.some((p) => Math.abs(p.x - x) + Math.abs(p.y - y) < ic.minSpacing)) continue
    const region = ctx.regionAt(x, y)
    const lr = region?.levelRange ?? [1, 1]
    const levelMid = Math.round((lr[0] + lr[1]) / 2)
    const hidden = rng.chance(ic.hiddenChance)
    const item = pickItem(rules, levelMid, hidden, rng)
    if (!item) break
    const band = bandFor(rules, levelMid)
    ctx.chunk.items.push({ id: `fi:${ctx.cx}:${ctx.cy}:${k}`, x, y, item: item.id, qty: rng.int(band.qty[0], band.qty[1]), hidden })
    ctx.occupy(x, y)
    placed.push({ x, y })
    k++
  }
}

function npcFrom(spec: { sprite: string; nameZh: string; role: NpcDef['role']; facing?: NpcDef['facing']; portrait?: string; script: ScriptStep[]; wander?: number }, id: string, x: number, y: number, params: Record<string, string | number>, script?: ScriptStep[]): NpcDef {
  const npc: NpcDef = { id, x, y, facing: spec.facing ?? 'down', sprite: spec.sprite, nameZh: spec.nameZh, role: spec.role, script: script ?? formatScript(spec.script, params) }
  if (spec.portrait) npc.portrait = spec.portrait
  if (spec.wander) npc.wander = spec.wander
  return npc
}

function services(ctx: InteriorDecorContext): void {
  const sv = compiledFrontier().fc.decor.services
  const params = { place: ctx.layout.nameZh }
  const a = ctx.anchors
  if (ctx.kind === 'center') {
    if (a.nurse) ctx.map.npcs.push(npcFrom(sv.nurse, `${ctx.map.id}:nurse`, a.nurse.x, a.nurse.y, params))
    if (a['pc-front']) ctx.map.npcs.push(npcFrom(sv.box, `${ctx.map.id}:box`, a['pc-front'].x, a['pc-front'].y, params))
  } else if (ctx.kind === 'shop' && a.clerk) {
    const items: string[] = []
    for (const t of sv.shopTiers) if (ctx.distance >= t.minDistance) for (const it of t.items) if (CONTENT.items[it] && !items.includes(it)) items.push(it)
    const script = [...formatScript(sv.shopIntro, params), { op: 'shop', items } as ScriptStep, ...formatScript(sv.shopOutro, params)]
    ctx.map.npcs.push(npcFrom(sv.clerk, `${ctx.map.id}:clerk`, a.clerk.x, a.clerk.y, params, script))
  }
}

function residents(ctx: InteriorDecorContext): void {
  if (ctx.kind !== 'house') return
  const rc = compiledFrontier().fc.decor.residents
  const rng = ctx.rng('residents')
  const a = ctx.anchors['resident-1']
  if (!a) return
  const params = { place: ctx.layout.nameZh }
  ctx.map.npcs.push(npcFrom({ sprite: rng.pick(rc.sprites), nameZh: rng.pick(rc.names), role: 'villager', script: rng.pick(rc.lines).map((text) => ({ op: 'say', text }) as ScriptStep) }, `${ctx.map.id}:resident`, a.x, a.y, params))
}

registerChunkDecorator('fx-villagers', villagers, 0)
registerChunkDecorator('fx-signposts', signposts, 1)
registerChunkDecorator('fx-items', groundItems, 2)
registerInteriorDecorator('fx-services', services, 0)
registerInteriorDecorator('fx-residents', residents, 1)
