// One frontier chunk: base terrain (columns + pads + roads) -> site layouts -> natural stairs / ledges on level
// contours -> biome terrain layers -> prop scatter (+ sea stacks, rapids) -> regions -> layout objects ->
// decorators. Every decision near the chunk border only reads global functions of the tile coordinates (the
// base area has a 2-tile margin), so seams match and the result never depends on generation order.
import type { MapChunk, PropPlacement, RegionDef } from '../../types.ts'
import { CONTENT } from '../../content/index.ts'
import { WORLD_CONTENT } from '../data.ts'
import { propRect, propSize } from '../collision.ts'
import { lightsFor } from '../grid.ts'
import { noiseField, rngFor, seedFor, tileRand, type NoiseField } from '../random.ts'
import type { LayerRule, PropRule } from '../schema.ts'
import { B_PAD, B_ROAD, B_SHOULDER, baseArea, type BaseDeps } from './base.ts'
import { tid } from './config.ts'
import { chunkDecorators, type ChunkDecorContext, type DecorSite } from './decorate.ts'
import { W_NONE, W_RIVER, W_SEA } from './fields.ts'
import { nearestProvince, provincesNear, regionId } from './regions.ts'
import type { FrontierSite } from './sites.ts'

export interface ChunkDeps extends BaseDeps {
  size: number
  overworldId: string
  decorSite(site: FrontierSite): DecorSite
  region(id: string): RegionDef | null
  /** Region id of a site's rare-spawn nest tiles. */
  nestRegionId(site: FrontierSite): string
  /** Region id covering a site's pad (hamlets: a safe town region) or null. */
  padRegionId(site: FrontierSite): string | null
  scatter: CompiledScatter
}

/** Per-tile CONTENT.biomes index of every chunk built by generateFrontierChunk (sample() / world-map colours). */
export const CHUNK_BIOME = new WeakMap<MapChunk, Uint8Array>()

interface CLayer { rule: LayerRule; t: number; on: Set<number>; noise: NoiseField; solid: boolean }
interface CProp { rule: PropRule; on: Set<number> | null; noise: NoiseField | null; seed: number; avoid: number; w: number; h: number }
export interface CompiledScatter {
  layers: CLayer[][]
  props: CProp[][]
  ledgeNoise: NoiseField
  stairsSeed: number
  rapidsSeed: number
  stackSeed: number
  keepOut: number
}

export function compileScatter(seed: number, deps: BaseDeps): CompiledScatter {
  const cf = deps.fields.cf
  const layers: CLayer[][] = [], props: CProp[][] = []
  const keepOut = WORLD_CONTENT.scatter.keepOutDefault
  CONTENT.biomes.forEach((b, bi) => {
    const t = cf.biome[bi]
    if (!t) { layers.push([]); props.push([]); return }
    const seen = [t.ground]
    layers.push(t.scatter.layers.map((rule, k) => {
      const tt = tid(rule.terrain)
      const on = new Set(rule.on ? rule.on.map(tid) : seen)
      seen.push(tt)
      const def = CONTENT.terrain[tt]
      return { rule, t: tt, on, noise: noiseField(rule.noise, seedFor(seed, `fx-${b.id}-layer-${k}`)), solid: !def.walkable || def.liquid === true }
    }))
    props.push(t.scatter.props.map((rule, k) => {
      const [w, h] = CONTENT.props[rule.prop].footprint
      return {
        rule, on: rule.on ? new Set(rule.on.map(tid)) : null,
        noise: rule.noise ? noiseField(rule.noise, seedFor(seed, `fx-${b.id}-prop-${k}`)) : null,
        seed: seedFor(seed, `fx-${b.id}-prop-roll-${k}`), avoid: rule.avoidPath ?? keepOut, w, h,
      }
    }))
  })
  return {
    layers, props,
    ledgeNoise: noiseField(cf.fc.gen.ledges.noise, seedFor(seed, 'frontier')),
    stairsSeed: seedFor(seed, cf.fc.gen.stairs.salt),
    rapidsSeed: seedFor(seed, 'fx-rapids'),
    stackSeed: seedFor(seed, 'fx-stacks'),
    keepOut,
  }
}

const S_STAIRS = 1, S_LEDGE = 2, S_KEEP = 4

// Terrain traits per terrain id (hot loops avoid CONTENT.terrain object lookups).
const T_WALK = 1, T_LIQUID = 2, T_STAIRS = 4, T_LEDGE = 8
let TRAITS: Uint8Array | null = null
function traits(): Uint8Array {
  if (TRAITS) return TRAITS
  TRAITS = new Uint8Array(256)
  for (const t of CONTENT.terrain) if (t) TRAITS[t.id] = (t.walkable ? T_WALK : 0) | (t.liquid ? T_LIQUID : 0) | (t.stairs ? T_STAIRS : 0) | (t.ledge ? T_LEDGE : 0)
  return TRAITS
}
/** Walkable dry ground that is neither stairs nor a ledge. */
const plain = (tr: number) => (tr & (T_WALK | T_LIQUID | T_STAIRS | T_LEDGE)) === T_WALK

export function generateFrontierChunk(D: ChunkDeps, cx: number, cy: number): MapChunk {
  const F = D.fields
  const cf = F.cf
  const S = D.size, M = 2
  const ox = cx * S, oy = cy * S
  const EW = S + 2 * M, ex0 = ox - M, ey0 = oy - M
  const N = EW * EW
  const TR = traits()
  const A = baseArea(D, ex0, ey0, EW, EW)
  const terrain = A.terrain, level = A.level, flags = A.flags
  const inExt = (x: number, y: number) => x >= ex0 && y >= ey0 && x < ex0 + EW && y < ey0 + EW
  const ei = (x: number, y: number) => (y - ey0) * EW + (x - ex0)

  // Site layouts touching the extended rect.
  const sc = cf.fc.sites
  const win = Math.max(sc.hamlet.window, sc.poiWindow)
  const near = D.grid.sitesNear(ox, oy, ox + S, oy + S, D.grid.maxRadius + win + M + 1)
  const decor: DecorSite[] = []
  const siteMask = new Uint8Array(N)
  for (const s of near) {
    const reach = Math.ceil(s.radius) + (s.type === 'hamlet' ? sc.hamlet.window : sc.poiWindow)
    if (s.x + reach < ex0 || s.y + reach < ey0 || s.x - reach >= ex0 + EW || s.y - reach >= ey0 + EW) continue
    const ds = D.decorSite(s)
    const L = ds.layout
    decor.push(ds)
    const R = s.radius + 1
    for (let y = Math.max(ey0, Math.floor(s.y - R)); y <= Math.min(ey0 + EW - 1, Math.ceil(s.y + R)); y++) {
      for (let x = Math.max(ex0, Math.floor(s.x - R)); x <= Math.min(ex0 + EW - 1, Math.ceil(s.x + R)); x++) {
        if ((x - s.x) * (x - s.x) + (y - s.y) * (y - s.y) <= R * R) siteMask[ei(x, y)] = 1
      }
    }
    for (let k = 0; k < L.tx.length; k++) if (inExt(L.tx[k], L.ty[k])) terrain[ei(L.tx[k], L.ty[k])] = L.tt[k]
  }

  // Natural contour crossings on the ring [1, EW-2]: stairs on the lower tile of a clean single step, ledges on
  // the upper tile of a drop (biome thresholds). Decisions read only base levels/water, never each other.
  const special = new Uint8Array(N)
  const OFF = [-EW, EW, -1, 1]
  const dryBase = (j: number) => {
    if (A.water[j] !== W_NONE && !(flags[j] & B_ROAD)) return false
    return (TR[terrain[j]] & (T_WALK | T_LIQUID)) === T_WALK
  }
  const natural = (i: number) => !siteMask[i] && (flags[i] & (B_ROAD | B_SHOULDER | B_PAD)) === 0 && A.water[i] === W_NONE
  for (let y = 1; y < EW - 1; y++) for (let x = 1; x < EW - 1; x++) {
    const i = y * EW + x
    if (!natural(i)) continue
    if ((TR[terrain[i]] & (T_WALK | T_LIQUID | T_STAIRS)) !== T_WALK) continue
    const Lv = level[i]
    let up = -1, multi = false, down = false
    for (let k = 0; k < 4; k++) {
      const lj = level[i + OFF[k]]
      if (lj === Lv + 1) { if (up >= 0) multi = true; up = k }
      else if (lj === Lv - 1 && dryBase(i + OFF[k])) down = true
    }
    const bt = cf.biome[A.biome[i]]
    if (!bt) continue
    const wx = ex0 + x, wy = ey0 + y
    if (up >= 0 && !multi) {
      const hi = i + OFF[up], back = i - OFF[up]
      if (level[back] === Lv && dryBase(hi) && dryBase(back) && tileRand(D.scatter.stairsSeed, wx, wy) < bt.spec.stairs) {
        special[i] |= S_STAIRS
        continue
      }
    }
    if (down && D.scatter.ledgeNoise.sample(wx, wy) > bt.spec.ledgeThreshold) special[i] |= S_LEDGE
  }
  for (let y = 1; y < EW - 1; y++) for (let x = 1; x < EW - 1; x++) {
    const i = y * EW + x
    if (special[i] & S_STAIRS) {
      terrain[i] = cf.stairs
      for (let k = 0; k < 4; k++) if (level[i + OFF[k]] === level[i] + 1) { special[i + OFF[k]] |= S_KEEP; special[i - OFF[k]] |= S_KEEP }
    } else if (special[i] & S_LEDGE) {
      terrain[i] = cf.biome[A.biome[i]]!.ledge
      for (let k = 0; k < 4; k++) if (level[i + OFF[k]] === level[i] - 1) special[i + OFF[k]] |= S_KEEP
    }
  }

  // Distance to drawn road tiles (Chebyshev, capped) for layer bands and prop keep-out.
  const CAP = cf.fc.gen.decor.pathDistCap
  const pathDist = new Uint8Array(N).fill(CAP)
  for (const e of D.roads.edgesNear(ex0, ey0, ex0 + EW, ey0 + EW, CAP)) {
    for (let k = 0; k < e.xs.length; k++) {
      if (!e.drawn[k]) continue
      const rx = e.xs[k] - ex0, ry = e.ys[k] - ey0
      if (rx < -CAP || ry < -CAP || rx >= EW + CAP || ry >= EW + CAP) continue
      for (let y = Math.max(0, ry - CAP + 1); y <= Math.min(EW - 1, ry + CAP - 1); y++) {
        const dy = Math.abs(y - ry)
        for (let x = Math.max(0, rx - CAP + 1); x <= Math.min(EW - 1, rx + CAP - 1); x++) {
          const dd = Math.max(dy, Math.abs(x - rx))
          if (dd < pathDist[y * EW + x]) pathDist[y * EW + x] = dd
        }
      }
    }
  }

  // Biome terrain layers (chunk tiles only).
  for (let y = M; y < M + S; y++) for (let x = M; x < M + S; x++) {
    const i = y * EW + x
    if (!natural(i) || special[i] & (S_STAIRS | S_LEDGE)) continue
    const layers = D.scatter.layers[A.biome[i]]
    for (const L of layers) {
      if (!L.on.has(terrain[i])) continue
      if (L.solid && special[i] & S_KEEP) continue
      if (L.rule.pathDist && (pathDist[i] < L.rule.pathDist[0] || pathDist[i] > L.rule.pathDist[1])) continue
      const v = L.noise.sample(ex0 + x, ey0 + y)
      if (v < L.rule.min || (L.rule.max !== undefined && v > L.rule.max)) continue
      terrain[i] = L.t
    }
  }

  const chunk: MapChunk = {
    cx, cy, size: S, terrain: new Uint8Array(S * S), elevation: new Uint8Array(S * S), region: new Uint8Array(S * S), regionIds: [],
    props: [], npcs: [], signs: [], items: [], warps: [], lights: [], places: [],
  }
  const occ = new Uint8Array(S * S)
  const ci = (x: number, y: number) => (y - oy) * S + (x - ox)
  const inChunk = (x: number, y: number) => x >= ox && y >= oy && x < ox + S && y < oy + S
  const markRect = (p: PropPlacement) => {
    const r = propRect(p)
    for (let y = Math.max(oy, r.y); y < Math.min(oy + S, r.y + r.h); y++) for (let x = Math.max(ox, r.x); x < Math.min(ox + S, r.x + r.w); x++) occ[ci(x, y)] = 1
  }

  // Layout objects: anchored here, but footprints spilling in from neighbouring chunks still occupy tiles.
  for (const ds of decor) {
    const L = ds.layout
    for (const p of L.props) { if (inChunk(p.x, p.y)) chunk.props.push(p); markRect(p) }
    for (const w of L.warps) if (inChunk(w.x, w.y)) { chunk.warps.push(w); occ[ci(w.x, w.y)] = 1 }
    for (const s of L.signs) if (inChunk(s.x, s.y)) chunk.signs.push(s)
    for (const it of L.items) if (inChunk(it.x, it.y)) { chunk.items.push(it); occ[ci(it.x, it.y)] = 1 }
    for (const sp of L.spots) if (inChunk(sp.x, sp.y)) occ[ci(sp.x, sp.y)] = 2
    if (ds.place && inChunk(ds.place.x, ds.place.y)) chunk.places.push(ds.place)
  }

  // Prop scatter (footprints never leave the chunk, so no neighbour can overlap them).
  for (let y = M; y < M + S; y++) for (let x = M; x < M + S; x++) {
    const i = y * EW + x
    const wx = ex0 + x, wy = ey0 + y
    if (occ[ci(wx, wy)]) continue
    if (A.water[i] === W_SEA) {
      const st = cf.fc.gen.decor.seaStacks
      if (A.deep[i] && A.cont[i] < cf.fc.gen.continent.seaLevel - st.minDepth && tileRand(D.scatter.stackSeed, wx, wy) < st.density) {
        const p: PropPlacement = { prop: st.prop, x: wx, y: wy, rot: (Math.floor(tileRand(D.scatter.stackSeed ^ 0x2f, wx, wy) * 4) & 3) as 0 | 1 | 2 | 3 }
        if (fitsSea(p)) { chunk.props.push(p); markRect(p) }
      }
      continue
    }
    if (A.water[i] === W_RIVER && !(flags[i] & B_ROAD)) {
      let drop = false
      for (let k = 0; k < 4; k++) { const j = i + OFF[k]; if (A.water[j] === W_RIVER && level[j] === level[i] - 1) drop = true }
      if (drop && tileRand(D.scatter.rapidsSeed, wx, wy) < cf.fc.gen.decor.rapidsChance) { const p: PropPlacement = { prop: cf.fc.gen.rivers.rapidsProp, x: wx, y: wy, rot: 0 }; chunk.props.push(p); markRect(p) }
      continue
    }
    if (!natural(i) && !(A.water[i] !== W_NONE && !siteMask[i] && !(flags[i] & B_ROAD))) continue
    if (special[i]) continue
    for (const P of D.scatter.props[A.biome[i]]) {
      if (pathDist[i] < P.avoid) continue
      if (P.noise && P.noise.sample(wx, wy) < (P.rule.min ?? 0)) continue
      if (tileRand(P.seed, wx, wy) >= P.rule.density) continue
      const rot = (P.w === P.h ? Math.floor(tileRand(P.seed ^ 0x2f, wx, wy) * 4) & 3 : 0) as 0 | 1 | 2 | 3
      const p: PropPlacement = { prop: P.rule.prop, x: wx, y: wy, rot }
      if (!fits(p, P)) continue
      if (P.rule.scale) p.scale = Math.round((P.rule.scale[0] + (P.rule.scale[1] - P.rule.scale[0]) * tileRand(P.seed ^ 0x51, wx, wy)) * 100) / 100
      if (P.rule.variant !== undefined) p.variant = P.rule.variant
      chunk.props.push(p)
      markRect(p)
      break
    }
  }
  function fits(p: PropPlacement, P: CProp): boolean {
    const [w, h] = propSize(p.prop, p.rot)
    if (p.x + w > ox + S || p.y + h > oy + S) return false
    const e0 = level[ei(p.x, p.y)]
    for (let y = p.y; y < p.y + h; y++) for (let x = p.x; x < p.x + w; x++) {
      const i = ei(x, y)
      if (occ[ci(x, y)] || special[i] || siteMask[i] || flags[i] & (B_ROAD | B_SHOULDER | B_PAD) || level[i] !== e0 || pathDist[i] < P.avoid) return false
      if (P.on) { if (!P.on.has(terrain[i])) return false }
      else if ((TR[terrain[i]] & (T_WALK | T_LIQUID | T_STAIRS)) !== T_WALK) return false
    }
    return true
  }
  function fitsSea(p: PropPlacement): boolean {
    const [w, h] = propSize(p.prop, p.rot)
    if (p.x + w > ox + S || p.y + h > oy + S) return false
    for (let y = p.y; y < p.y + h; y++) for (let x = p.x; x < p.x + w; x++) {
      const i = ei(x, y)
      if (occ[ci(x, y)] || A.water[i] !== W_SEA || !A.deep[i] || siteMask[i] || flags[i] & B_ROAD) return false
    }
    return true
  }

  // Regions: (province x biome); hamlet pads get the hamlet's town region, nest tiles their site's boosted region.
  const provs = provincesNear(F, ox, oy, ox + S, oy + S)
  const slot = new Map<number, number>()
  const nestTiles = new Map<number, string>()
  for (const ds of decor) {
    const pad = D.padRegionId(ds.site)
    if (pad) {
      const s = ds.site, R = s.radius
      for (let y = Math.max(oy, Math.floor(s.y - R)); y <= Math.min(oy + S - 1, Math.ceil(s.y + R)); y++) {
        for (let x = Math.max(ox, Math.floor(s.x - R)); x <= Math.min(ox + S - 1, Math.ceil(s.x + R)); x++) {
          if ((x - s.x) * (x - s.x) + (y - s.y) * (y - s.y) <= R * R && A.flags[ei(x, y)] & B_PAD) nestTiles.set(ci(x, y), pad)
        }
      }
    }
    for (const t of ds.layout.nest) if (inChunk(t.x, t.y)) nestTiles.set(ci(t.x, t.y), D.nestRegionId(ds.site))
  }
  const nestSlot = new Map<string, number>()
  const biomeOut = new Uint8Array(S * S)
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const c = y * S + x
    const i = (y + M) * EW + (x + M)
    chunk.terrain[c] = terrain[i]
    chunk.elevation[c] = level[i]
    biomeOut[c] = A.biome[i]
    const nest = nestTiles.get(c)
    if (nest) {
      let k = nestSlot.get(nest)
      if (k === undefined) { k = chunk.regionIds.length; chunk.regionIds.push(nest); nestSlot.set(nest, k) }
      chunk.region[c] = k
      continue
    }
    const p = nearestProvince(provs, ox + x + A.pwx[i], oy + y + A.pwy[i])
    const key = p * 256 + A.biome[i]
    let k = slot.get(key)
    if (k === undefined) {
      k = chunk.regionIds.length
      chunk.regionIds.push(regionId(provs[p].px, provs[p].py, CONTENT.biomes[A.biome[i]].id))
      slot.set(key, k)
    }
    chunk.region[c] = k
  }

  // Decorators (villagers, signposts, ground items, + whatever other modules registered).
  const edges = D.roads.edgesNear(ox, oy, ox + S, oy + S, 0)
  const isFreeTile = (x: number, y: number) => {
    if (!inChunk(x, y)) return false
    const i = ei(x, y)
    if (special[i] & (S_STAIRS | S_LEDGE)) return false
    return plain(TR[terrain[i]])
  }
  const taken = new Set<number>()
  for (const n of chunk.npcs) taken.add(ci(n.x, n.y))
  const ctx: ChunkDecorContext = {
    seed: F.seed, overworldId: D.overworldId, cx, cy, size: S, x0: ox, y0: oy, chunk, sites: decor, edges,
    lookup: {
      cell: D.grid.cell,
      siteAt: (sx, sy) => D.grid.siteAt(sx, sy),
      decorSite: (s) => D.decorSite(s),
      region: (id) => D.region(id),
      edgesNear: (x0, y0, x1, y1, pad) => D.roads.edgesNear(x0, y0, x1, y1, pad),
      distance: (x, y) => F.originDist(x, y),
    },
    inChunk,
    terrainAt: (x, y) => (inExt(x, y) ? terrain[ei(x, y)] : 0),
    levelAt: (x, y) => (inExt(x, y) ? level[ei(x, y)] : 0),
    regionAt: (x, y) => (inChunk(x, y) ? D.region(chunk.regionIds[chunk.region[ci(x, y)]]) : null),
    isFree: (x, y) => isFreeTile(x, y) && occ[ci(x, y)] !== 1 && !taken.has(ci(x, y)),
    isWild: (x, y) => inChunk(x, y) && natural(ei(x, y)),
    occupy: (x, y) => { if (inChunk(x, y)) { occ[ci(x, y)] = 1; taken.add(ci(x, y)) } },
    distance: (x, y) => F.originDist(x, y),
    rng: (salt) => rngFor(F.seed, `fx-chunk-${cx}-${cy}-${salt}`),
  }
  for (const d of chunkDecorators()) d.fn(ctx)
  // Objects must be anchored inside the chunk (decorators may only add local objects).
  chunk.props = chunk.props.filter((p) => inChunk(p.x, p.y))
  chunk.npcs = chunk.npcs.filter((n) => inChunk(n.x, n.y))
  chunk.signs = chunk.signs.filter((s) => inChunk(s.x, s.y))
  chunk.items = chunk.items.filter((s) => inChunk(s.x, s.y))
  chunk.lights = lightsFor(chunk.props)
  CHUNK_BIOME.set(chunk, biomeOut)
  return chunk
}

