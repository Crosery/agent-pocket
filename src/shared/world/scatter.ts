// Biome dressing driven by content/world/scatter.json: terrain layers (tall-grass variants, flowers,
// ice, mud, lava...), extra cliff stairs, region border walls and prop scattering.
import type { PropPlacement } from '../types.ts'
import { CONTENT } from '../content/index.ts'
import {
  F_BORDER, F_BRIDGE, F_CRATER, F_EDGE, F_GATE, F_KEEP, F_LAKE, F_LOCK, F_NEST, F_PATH, F_RESERVED, F_RIVER, F_ROAD, F_SEA, F_SITE, F_TOWN,
  addFlag, canPlace, placeProp, type MapDraft,
} from './grid.ts'
import { noiseField, rngFor, seedFor, tileRand, type NoiseField } from './random.ts'
import type { BiomeScatter, LayerRule, PropRule, Rot } from './schema.ts'
import { biomeOf, tid, type OwCtx } from './ctx.ts'
import { stairsOk } from './routes.ts'

const NO_DRESS = F_PATH | F_TOWN | F_RESERVED | F_KEEP | F_GATE | F_SEA | F_LAKE | F_RIVER | F_BRIDGE | F_CRATER | F_SITE | F_ROAD | F_NEST

interface CompiledLayer { rule: LayerRule; t: number; on: Set<number>; noise: NoiseField; solid: boolean }
interface CompiledProp { rule: PropRule; on: Set<number> | null; noise: NoiseField | null; seed: number; avoid: number }

function compileLayers(ctx: OwCtx, biome: string, b: BiomeScatter): CompiledLayer[] {
  const seen = [tid(b.ground)]
  return b.layers.map((rule, k) => {
    const t = tid(rule.terrain)
    const on = new Set(rule.on ? rule.on.map(tid) : seen)
    seen.push(t)
    const def = CONTENT.terrain[t]
    return { rule, t, on, noise: noiseField(rule.noise, seedFor(ctx.seed, `${biome}-layer-${k}`)), solid: !def.walkable || def.liquid === true }
  })
}

export function paintLayers(ctx: OwCtx, pathDist: Uint16Array): void {
  const { d } = ctx
  const compiled = new Map<BiomeScatter, CompiledLayer[]>()
  for (const [id, b] of Object.entries(ctx.wc.scatter.biomes)) compiled.set(b, compileLayers(ctx, id, b))
  const byBiome = CONTENT.biomes.map((b) => compiled.get(ctx.wc.scatter.biomes[b.id]) ?? [])
  const stairs = CONTENT.terrain.map((t) => t.stairs === true)
  for (let y = 0; y < d.h; y++) for (let x = 0; x < d.w; x++) {
    const i = y * d.w + x
    if ((d.flags[i] & NO_DRESS) !== 0 || stairs[d.terrain[i]]) continue
    const layers = byBiome[ctx.macro.biome[i]]
    for (const L of layers) {
      if (!L.on.has(d.terrain[i])) continue
      if (L.solid && (d.flags[i] & (F_LOCK | F_BORDER | F_EDGE)) !== 0) continue
      if (L.rule.pathDist && (pathDist[i] < L.rule.pathDist[0] || pathDist[i] > L.rule.pathDist[1])) continue
      const v = L.noise.sample(x, y)
      if (v < L.rule.min || (L.rule.max !== undefined && v > L.rule.max)) continue
      d.terrain[i] = L.t
    }
  }
}

/** Carves a few stairs into natural cliffs per zone so plateaus are reachable. */
export function accessStairs(ctx: OwCtx): void {
  const { d } = ctx
  const stairsT = tid(ctx.spec.stairsTerrain)
  const spacing = ctx.spec.accessStairSpacing
  const blocked = NO_DRESS | F_LOCK | F_BORDER | F_EDGE
  type Candidate = [tile: number, step: number, score: number]
  const cands: Candidate[][] = ctx.wc.regions.map(() => [])
  const W = d.w
  // A two-pass Manhattan distance transform keeps stair candidate scoring linear in map size. Scanning a
  // radius around every candidate looks equivalent, but on the 1024x1024 overworld it turns this dressing
  // pass into an accidental quadratic hot path.
  const distanceToFlags = (mask: number, radius: number): Uint8Array => {
    const max = radius + 1
    const dist = new Uint8Array(d.w * d.h)
    for (let i = 0; i < dist.length; i++) dist[i] = (d.flags[i] & mask) !== 0 ? 0 : max
    for (let y = 0; y < d.h; y++) {
      const row = y * W
      for (let x = 0; x < W; x++) {
        const i = row + x
        let v = dist[i]
        if (x > 0 && dist[i - 1] + 1 < v) v = dist[i - 1] + 1
        if (y > 0 && dist[i - W] + 1 < v) v = dist[i - W] + 1
        dist[i] = v
      }
    }
    for (let y = d.h - 1; y >= 0; y--) {
      const row = y * W
      for (let x = W - 1; x >= 0; x--) {
        const i = row + x
        let v = dist[i]
        if (x + 1 < W && dist[i + 1] + 1 < v) v = dist[i + 1] + 1
        if (y + 1 < d.h && dist[i + W] + 1 < v) v = dist[i + W] + 1
        dist[i] = v
      }
    }
    return dist
  }
  const routeDistance = distanceToFlags(F_PATH | F_ROAD, 5)
  const siteDistance = distanceToFlags(F_SITE | F_TOWN, 4)
  for (let i = 0; i < d.w * d.h; i++) {
    if ((d.flags[i] & blocked) !== 0) continue
    const x = i % W, y = (i - x) / W
    if (x < 1 || y < 1 || x >= W - 2 || y >= d.h - 2) continue
    const e = d.elevation[i]
    for (const step of [-W, W, -1, 1]) {
      const hi = i + step, beyond = hi + step
      if (d.elevation[hi] !== e + 1 || (d.flags[hi] & blocked) !== 0 || d.elevation[beyond] !== d.elevation[hi]) continue
      if (stairsOk(d, i, hi)) {
        // Prefer crossings that visually continue a route or point-of-interest approach. The old random
        // selection scattered stairs evenly through wilderness, making the map look busy and hiding the
        // intended traversal line.
        const routeScore = routeDistance[i] <= 5 ? 6 - routeDistance[i] : 0
        const siteScore = siteDistance[i] <= 4 ? 5 - siteDistance[i] : 0
        cands[ctx.macro.wild[i]].push([i, step, routeScore * 4 + siteScore])
      }
    }
  }
  ctx.wc.regions.forEach((region, ri) => {
    const want = region.accessStairs ?? 0
    if (want <= 0) return
    const list = cands[ri]
    const rng = rngFor(ctx.seed, `access-stairs-${region.id}`)
    rng.shuffle(list)
    // The score is a small bounded integer. Bucketing keeps route-biased selection linear and avoids
    // sorting tens of thousands of wilderness crossings on every world build.
    const buckets: Candidate[][] = Array.from({ length: 25 }, () => [])
    for (const candidate of list) buckets[candidate[2]].push(candidate)
    const chosen: number[] = []
    for (let score = buckets.length - 1; score >= 0 && chosen.length < want; score--) {
      for (const [i, step] of buckets[score]) {
        if (chosen.length >= want) break
        const x = i % W, y = (i - x) / W
        if (chosen.some((j) => Math.max(Math.abs((j % W) - x), Math.abs(Math.floor(j / W) - y)) < spacing)) continue
        if (!stairsOk(d, i, i + step)) continue
        d.terrain[i] = stairsT
        for (const k of [i, i + step, i - step, i + 2 * step]) addFlag(d, k, F_KEEP)
        // Markers on both flanks so the stair reads from a distance (and glows at night).
        const marker = ctx.spec.accessStairMarker
        if (marker) {
          const side = Math.abs(step) === W ? 1 : W
          for (const j of [i + side, i - side]) {
            const jx = j % W, jy = (j - jx) / W
            if (side === 1 && jy !== y) continue
            const p: PropPlacement = { prop: marker, x: jx, y: jy, rot: 0 }
            if (canPlace(d, p, { forbid: blocked | F_PATH })) placeProp(d, p)
          }
        }
        chosen.push(i)
      }
    }
  })
}

/**
 * Fills region border bands and the map edge band with 1x1 blocking props: biome border lists on land, rocks
 * (overworld.shallowBorder) in walkable shallows, a rapids prop on deep river / lake water so surfing never
 * slips past a wall. Open sea stays open (gated zones have cliff coasts instead).
 */
export function borderWalls(ctx: OwCtx): void {
  const { d, spec } = ctx
  const seed = seedFor(ctx.seed, 'border-walls')
  const pickFrom = (list: { prop: string; weight: number }[], x: number, y: number) => {
    const r = tileRand(seed, x, y)
    let acc = 0
    const total = list.reduce((s, b) => s + b.weight, 0)
    for (const b of list) { acc += b.weight / total; if (r < acc) return b.prop }
    return list[list.length - 1].prop
  }
  for (let i = 0; i < d.w * d.h; i++) {
    if ((d.flags[i] & (F_BORDER | F_EDGE)) === 0) continue
    if ((d.flags[i] & (F_PATH | F_TOWN | F_RESERVED | F_GATE | F_BRIDGE)) !== 0 || d.occ[i]) continue
    const t = CONTENT.terrain[d.terrain[i]]
    if (!t || t.stairs) continue
    const x = i % d.w, y = (i - x) / d.w
    let prop: string
    if (t.walkable) prop = pickFrom((d.flags[i] & F_SEA) !== 0 ? spec.shallowBorder : biomeOf(ctx, i).border, x, y)
    else if (t.swim && (d.flags[i] & F_SEA) === 0) prop = spec.hydrology.rapidsProp
    else continue
    const p: PropPlacement = { prop, x, y, rot: (Math.floor(tileRand(seed ^ 0x55, x, y) * 4) & 3) as Rot }
    if (canPlace(d, p, { anyTerrain: true })) placeProp(d, p)
  }
}

export function scatterProps(ctx: OwCtx, pathDist: Uint16Array): void {
  const { d } = ctx
  const compiled = new Map<BiomeScatter, CompiledProp[]>()
  for (const [id, b] of Object.entries(ctx.wc.scatter.biomes)) {
    compiled.set(b, b.props.map((rule, k) => ({
      rule,
      on: rule.on ? new Set(rule.on.map(tid)) : null,
      noise: rule.noise ? noiseField(rule.noise, seedFor(ctx.seed, `${id}-prop-${k}`)) : null,
      seed: seedFor(ctx.seed, `${id}-prop-roll-${k}`),
      avoid: rule.avoidPath ?? ctx.wc.scatter.keepOutDefault,
    })))
  }
  const forbid = NO_DRESS | F_BORDER | F_EDGE
  const byBiome = CONTENT.biomes.map((b) => compiled.get(ctx.wc.scatter.biomes[b.id]) ?? [])
  for (let y = 0; y < d.h; y++) for (let x = 0; x < d.w; x++) {
    const i = y * d.w + x
    if ((d.flags[i] & forbid) !== 0 || d.occ[i]) continue
    for (const P of byBiome[ctx.macro.biome[i]]) {
      if (pathDist[i] < P.avoid) continue
      if (P.noise && P.noise.sample(x, y) < (P.rule.min ?? 0)) continue
      if (tileRand(P.seed, x, y) >= P.rule.density) continue
      const [w, h] = CONTENT.props[P.rule.prop].footprint
      const rot = (w === h ? Math.floor(tileRand(P.seed ^ 0x2f, x, y) * 4) & 3 : 0) as Rot
      const p: PropPlacement = { prop: P.rule.prop, x, y, rot }
      if (!footprintClear(d, p, pathDist, P.avoid, forbid)) continue
      if (!canPlace(d, p, { on: P.on })) continue
      placeProp(d, p)
      break
    }
  }
}

function footprintClear(d: MapDraft, p: PropPlacement, pathDist: Uint16Array, avoid: number, forbid: number): boolean {
  const [w, h] = CONTENT.props[p.prop].footprint
  const W = p.rot === 1 || p.rot === 3 ? h : w, H = p.rot === 1 || p.rot === 3 ? w : h
  if (p.x + W > d.w || p.y + H > d.h) return false
  for (let y = p.y; y < p.y + H; y++) for (let x = p.x; x < p.x + W; x++) {
    const i = y * d.w + x
    if ((d.flags[i] & forbid) !== 0 || pathDist[i] < avoid) return false
  }
  return true
}
