// Wilderness content per chunk: bounty outlaws beside hamlet roads, wandering trainers (class by biome, team by
// distance), hermit camps and merchant stalls, tucked-away item caches scaled by distance, and road plaques at
// province borders and difficulty milestones (rarity minDistance / danger tiers from the data).
import type { Dir, NpcDef } from '../../../types.ts'
import { CONTENT } from '../../../content/index.ts'
import { propSize } from '../../collision.ts'
import type { Rng } from '../../random.ts'
import { compiledFrontier } from '../config.ts'
import type { ChunkDecorContext } from '../decorate.ts'
import { parseRegionId } from '../regions.ts'
import { bountyPlans, hamletBounties, outlawNpc } from './bounties.ts'
import { FRONTIER_PACK } from './data.ts'
import { hermitPerson, merchantPerson } from './landmarks.ts'
import type { Locale } from './people.ts'
import { rememberTrainer, wandererId } from './registry.ts'
import { classesFor, classTrainer, trainerNpc, trainerScript } from './teams.ts'
import { biomeName, curveAt, findSpot, fitsProp, occupyRect, rollItem, spotOk, stars, text, type Params, type Pt } from './util.ts'

const DIRS: readonly { d: Dir; x: number; y: number }[] = [{ d: 'down', x: 0, y: 1 }, { d: 'up', x: 0, y: -1 }, { d: 'left', x: -1, y: 0 }, { d: 'right', x: 1, y: 0 }]
const faceTo = (from: Pt, to: Pt): Dir => {
  const dx = to.x - from.x, dy = to.y - from.y
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left'
  return dy >= 0 ? 'down' : 'up'
}

const count = (expected: number, rng: Rng): number => Math.floor(expected) + (rng.chance(expected - Math.floor(expected)) ? 1 : 0)

/** Drawn road tiles inside the chunk (in edge order). */
function roadTiles(ctx: ChunkDecorContext): Pt[] {
  const out: Pt[] = []
  for (const e of ctx.edges) for (let i = 0; i < e.xs.length; i++) if (e.drawn[i] && ctx.inChunk(e.xs[i], e.ys[i])) out.push({ x: e.xs[i], y: e.ys[i] })
  return out
}

/** Not inside any site's pad (+ clearance). */
function clearOfSites(ctx: ChunkDecorContext, x: number, y: number, clearance: number): boolean {
  for (const ds of ctx.sites) {
    const r = ds.site.radius + clearance
    if ((ds.site.x - x) ** 2 + (ds.site.y - y) ** 2 <= r * r) return false
  }
  return true
}

/** A free wilderness / roadside tile: roadside = beside a drawn road tile on its level. */
function pickTile(ctx: ChunkDecorContext, rng: Rng, roadside: boolean, roads: readonly Pt[], clearance: number, away: readonly Pt[], spacing: number): { at: Pt; road: Pt | null } | null {
  if (roadside && roads.length) {
    const r = rng.pick(roads)
    for (const d of rng.shuffle(DIRS.slice())) {
      const x = r.x + d.x, y = r.y + d.y
      if (clearOfSites(ctx, x, y, clearance) && spotOk(ctx, x, y, { level: ctx.levelAt(r.x, r.y), away, spacing })) return { at: { x, y }, road: r }
    }
    return null
  }
  const x = ctx.x0 + rng.int(1, ctx.size - 2), y = ctx.y0 + rng.int(1, ctx.size - 2)
  if (!clearOfSites(ctx, x, y, clearance) || !spotOk(ctx, x, y, { wild: true, away, spacing })) return null
  return { at: { x, y }, road: null }
}

function localeAt(ctx: ChunkDecorContext, p: Pt): Locale | null {
  const region = ctx.regionAt(p.x, p.y)
  if (!region || region.isTown) return null
  return { biome: region.biome, dist: ctx.distance(p.x, p.y), nearRefs: [] }
}

// ---------------------------------------------------------------------------------------------- outlaws

function outlaws(ctx: ChunkDecorContext, roads: readonly Pt[]): void {
  const B = FRONTIER_PACK.bounties
  let road: Set<string> | null = null
  const reach = (B.kinds.hunt.road?.[1] ?? 0) + compiledFrontier().fc.sites.hamlet.radius + 2
  const C = ctx.lookup.cell
  for (let sy = Math.floor((ctx.y0 - reach) / C); sy <= Math.floor((ctx.y0 + ctx.size + reach) / C); sy++) {
    for (let sx = Math.floor((ctx.x0 - reach) / C); sx <= Math.floor((ctx.x0 + ctx.size + reach) / C); sx++) {
      const site = ctx.lookup.siteAt(sx, sy)
      if (!site || site.type !== 'hamlet') continue
      if (!bountyPlans(ctx.seed, ctx.lookup, site).some((p) => p.kind === 'hunt' && p.anchor && ctx.inChunk(p.anchor.x, p.anchor.y))) continue
      for (const b of hamletBounties(ctx.seed, ctx.lookup, site, ctx.overworldId)) {
        if (b.kind !== 'hunt' || !b.anchor || !b.outlaw || !ctx.inChunk(b.anchor.x, b.anchor.y)) continue
        const lv = ctx.levelAt(b.anchor.x, b.anchor.y)
        // Nearest roadside tile (square rings), never on a drawn road tile so the road stays passable. A road over
        // shallows has no roadside there: follow this chunk's road tiles (nearest first) to the next bit of land
        // (same level as the road first, then any level — graded roads may run below their banks).
        const rules = { level: lv, away: ctx.chunk.npcs, keepOff: (road ??= new Set(roads.map((p) => `${p.x},${p.y}`))) }
        let at = findSpot(ctx, b.anchor.x, b.anchor.y, FRONTIER_PACK.common.place.search, rules)
        let face: Pt = b.anchor
        if (!at) {
          const a = b.anchor
          const md = (p: Pt) => Math.abs(p.x - a.x) + Math.abs(p.y - a.y)
          const near = roads.filter((p) => md(p) <= B.kinds.hunt.road![1]).sort((p, q) => md(p) - md(q) || p.y - q.y || p.x - q.x)
          for (const anyLevel of [false, true]) {
            for (const r of near) {
              at = findSpot(ctx, r.x, r.y, 1, { ...rules, level: anyLevel ? undefined : ctx.levelAt(r.x, r.y) })
              if (at) { face = r; break }
            }
            if (at) break
          }
        }
        if (!at) continue
        ctx.chunk.npcs.push(outlawNpc(b, at.x, at.y, faceTo(at, face)))
        ctx.occupy(at.x, at.y)
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------- trainers

function wanderers(ctx: ChunkDecorContext, roads: readonly Pt[]): void {
  const T = FRONTIER_PACK.trainers
  const W = T.wander
  const mid = { x: ctx.x0 + ctx.size / 2, y: ctx.y0 + ctx.size / 2 }
  const dist = ctx.distance(mid.x, mid.y)
  if (dist < W.minDistance) return
  const rng = ctx.rng('fxc-trainers')
  const n = Math.min(W.maxPerChunk, count(curveAt(W.count, dist), rng))
  let placed = 0
  for (let tries = 0; placed < n && tries < W.tries; tries++) {
    const pick = pickTile(ctx, rng, rng.chance(W.roadside), roads, W.siteClearance, ctx.chunk.npcs, W.spacing)
    if (!pick) continue
    const loc = localeAt(ctx, pick.at)
    const region = ctx.regionAt(pick.at.x, pick.at.y)
    if (!loc || !region) continue
    const classes = classesFor(T.classes, loc.biome, loc.dist)
    if (!classes.length) continue
    const cls = rng.weighted(classes, (c) => c.weight)
    const id = wandererId(ctx.cx, ctx.cy, placed)
    const params: Params = { region: region.nameZh, biome: biomeName(loc.biome), distance: Math.round(loc.dist) }
    const build = classTrainer(id, cls, {
      biome: loc.biome, levelRange: region.levelRange ?? [1, 1], dist: loc.dist, types: cls.types, levelBonus: cls.levelBonus ?? 0, sizeBonus: 0, rarity: T.party.rarity,
    }, rng, params)
    if (!build.def.party.length) continue
    const facing = pick.road ? faceTo(pick.at, pick.road) : rng.pick(DIRS).d
    const sight = rng.int(W.sightRange[0], W.sightRange[1])
    ctx.chunk.npcs.push(trainerNpc(build.def, pick.at.x, pick.at.y, facing, trainerScript(id, String(build.params.after ?? '')), sight))
    rememberTrainer(ctx.chunk, build.def)
    ctx.occupy(pick.at.x, pick.at.y)
    placed++
  }
}

// ---------------------------------------------------------------------------------------------- camps

/** A prop of `key` beside `at` (footprint fully inside the chunk, never on paths); returns true when placed. */
function campProp(ctx: ChunkDecorContext, key: string, at: Pt, rng: Rng): boolean {
  if (!CONTENT.props[key]) return false
  const [w, h] = propSize(key, 0)
  const cands: Pt[] = [{ x: at.x + 1, y: at.y - h + 1 }, { x: at.x - w, y: at.y - h + 1 }, { x: at.x - Math.floor(w / 2), y: at.y - h }, { x: at.x - Math.floor(w / 2), y: at.y + 1 }]
  for (const c of rng.shuffle(cands)) {
    if (!fitsProp(ctx, c.x, c.y, w, h)) continue
    ctx.chunk.props.push({ prop: key, x: c.x, y: c.y, rot: 0 })
    occupyRect(ctx, c.x, c.y, w, h)
    return true
  }
  return false
}

function camps(ctx: ChunkDecorContext, roads: readonly Pt[]): void {
  const Wd = FRONTIER_PACK.wild
  const mid = { x: ctx.x0 + ctx.size / 2, y: ctx.y0 + ctx.size / 2 }
  const dist = ctx.distance(mid.x, mid.y)
  const clearance = FRONTIER_PACK.trainers.wander.siteClearance
  const H = Wd.hermitCamps
  const rh = ctx.rng('fxc-hermit')
  if (dist >= H.minDistance && rh.chance(curveAt(H.chance, dist))) {
    for (let t = 0; t < H.tries; t++) {
      const pick = pickTile(ctx, rh, false, roads, clearance, ctx.chunk.npcs, FRONTIER_PACK.trainers.wander.spacing)
      const loc = pick && localeAt(ctx, pick.at)
      if (!pick || !loc) continue
      const id = `fh:${ctx.cx}:${ctx.cy}`
      const region = ctx.regionAt(pick.at.x, pick.at.y)
      const h = hermitPerson(id, loc, rh, { region: region?.nameZh ?? '', biome: biomeName(loc.biome), distance: Math.round(loc.dist) })
      if (!h) break
      const npc: NpcDef = { id, x: pick.at.x, y: pick.at.y, facing: 'down', sprite: h.sprite, nameZh: h.name, role: 'tutor', script: h.script }
      ctx.chunk.npcs.push(npc)
      ctx.occupy(pick.at.x, pick.at.y)
      for (const p of H.props) campProp(ctx, p, pick.at, rh)
      break
    }
  }
  const M = Wd.merchantCamps
  const rm = ctx.rng('fxc-merchant')
  const types = FRONTIER_PACK.landmarks.merchant.types
  if (dist >= M.minDistance && types.length && rm.chance(curveAt(M.chance, dist))) {
    const type = rm.weighted(types, (x) => x.weight)
    for (let t = 0; t < M.tries; t++) {
      const pick = pickTile(ctx, rm, roads.length > 0, roads, clearance, ctx.chunk.npcs, FRONTIER_PACK.trainers.wander.spacing)
      const loc = pick && localeAt(ctx, pick.at)
      if (!pick || !loc) continue
      const id = `fm:${ctx.cx}:${ctx.cy}`
      const region = ctx.regionAt(pick.at.x, pick.at.y)
      const m = merchantPerson(type, loc, rm, { region: region?.nameZh ?? '', biome: biomeName(loc.biome), distance: Math.round(loc.dist) })
      if (!m) break
      ctx.chunk.npcs.push({ id, x: pick.at.x, y: pick.at.y, facing: pick.road ? faceTo(pick.at, pick.road) : 'down', sprite: m.sprite, nameZh: m.name, role: 'clerk', script: m.script })
      ctx.occupy(pick.at.x, pick.at.y)
      campProp(ctx, M.prop, pick.at, rm)
      break
    }
  }
}

// ---------------------------------------------------------------------------------------------- caches

function caches(ctx: ChunkDecorContext): void {
  const K = FRONTIER_PACK.wild.caches
  const mid = { x: ctx.x0 + ctx.size / 2, y: ctx.y0 + ctx.size / 2 }
  const dist = ctx.distance(mid.x, mid.y)
  const rng = ctx.rng('fxc-cache')
  if (!rng.chance(curveAt(K.chance, dist))) return
  const near = ctx.chunk.props.filter((p) => K.nearProps.includes(p.prop))
  for (let t = 0; t < K.tries && near.length; t++) {
    const p = rng.pick(near)
    const [w, h] = propSize(p.prop, p.rot)
    const side = rng.pick(DIRS)
    const x = side.x > 0 ? p.x + w : side.x < 0 ? p.x - 1 : p.x + rng.int(0, w - 1)
    const y = side.y > 0 ? p.y + h : side.y < 0 ? p.y - 1 : p.y + rng.int(0, h - 1)
    if (!ctx.inChunk(x, y) || !ctx.isFree(x, y) || !ctx.isWild(x, y)) continue
    const roll = rollItem(K.tiers, ctx.distance(x, y), rng)
    if (!roll) return
    ctx.chunk.items.push({ id: `fi:${ctx.cx}:${ctx.cy}:c0`, x, y, item: roll.item, qty: roll.qty, hidden: rng.chance(K.hidden) })
    ctx.occupy(x, y)
    return
  }
}

// ---------------------------------------------------------------------------------------------- road plaques

let MILESTONES: { at: number; notes: string[] }[] | null = null
function milestones(): { at: number; notes: string[] }[] {
  if (MILESTONES) return MILESTONES
  const R = FRONTIER_PACK.wild.roadSigns.milestones
  const C = FRONTIER_PACK.common
  const map = new Map<number, string[]>()
  const add = (d: number, note: string | null) => { const l = map.get(d) ?? []; if (note) l.push(note); map.set(d, l) }
  for (const d of R.extra) add(d, null)
  for (const r of CONTENT.rarities) if (r.behavior && r.behavior.minDistance > 0) add(r.behavior.minDistance, text(R.rarity, { rarity: r.nameZh }))
  compiledFrontier().fc.gen.levels.dangerDistances.forEach((d, i) => { if (d > 0) add(d, text(R.danger, { danger: C.dangerNames[i] ?? String(i), stars: stars(i) })) })
  MILESTONES = [...map.entries()].sort((a, b) => a[0] - b[0]).map(([at, notes]) => ({ at, notes }))
  return MILESTONES
}

function roadSigns(ctx: ChunkDecorContext): void {
  const RS = FRONTIER_PACK.wild.roadSigns
  const place = (cur: Pt, prev: Pt, body: string): void => {
    const horiz = prev.y === cur.y
    const cands = horiz ? [[cur.x, cur.y + 1], [cur.x, cur.y - 1]] : [[cur.x + 1, cur.y], [cur.x - 1, cur.y]]
    for (const [x, y] of cands) {
      if (!fitsProp(ctx, x, y, 1, 1) || ctx.levelAt(x, y) !== ctx.levelAt(cur.x, cur.y)) continue
      ctx.chunk.props.push({ prop: RS.prop, x, y, rot: 0 })
      ctx.chunk.signs.push({ x, y, text: body, kind: 'plaque' })
      ctx.occupy(x, y)
      return
    }
  }
  const ms = milestones()
  for (const e of ctx.edges) {
    for (let i = 1; i < e.xs.length; i++) {
      if (!e.drawn[i] || !e.drawn[i - 1]) continue
      const prev = { x: e.xs[i - 1], y: e.ys[i - 1] }, cur = { x: e.xs[i], y: e.ys[i] }
      if (!ctx.inChunk(prev.x, prev.y) || !ctx.inChunk(cur.x, cur.y)) continue
      const d0 = ctx.distance(prev.x, prev.y), d1 = ctx.distance(cur.x, cur.y)
      for (const m of ms) {
        if ((d0 < m.at) === (d1 < m.at)) continue
        place(cur, prev, [text(RS.milestones.format, { distance: m.at }), ...m.notes].join('\n'))
      }
      const ra = ctx.regionAt(prev.x, prev.y), rb = ctx.regionAt(cur.x, cur.y)
      const pa = ra && parseRegionId(ra.id), pb = rb && parseRegionId(rb.id)
      if (pa && pb && rb && (pa.px !== pb.px || pa.py !== pb.py)) {
        const lr = rb.levelRange ?? [1, 1]
        place(cur, prev, text(RS.province.format, { region: rb.nameZh, biome: biomeName(rb.biome), stars: stars(rb.danger ?? 0), lo: lr[0], hi: lr[1] }))
      }
    }
  }
}

export function decorateWild(ctx: ChunkDecorContext): void {
  const roads = roadTiles(ctx)
  outlaws(ctx, roads)
  roadSigns(ctx)
  wanderers(ctx, roads)
  camps(ctx, roads)
  caches(ctx)
}
