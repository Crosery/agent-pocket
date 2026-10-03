// Overworld pipeline: macro layout (zones, climate, landforms, sea, hydrology, sites) -> base terrain ->
// authored rivers -> towns -> region border bands -> routes/gates -> story caves -> hamlets + trails -> POIs ->
// dungeon mouths -> biome dressing -> walls -> access repair -> scatter -> access repair (+ hamlet/POI/dungeon
// targets) -> wilderness regions -> region map + encounters -> reachability-based anchors and ground items.
import type { RegionDef } from '../types.ts'
import { CONTENT } from '../content/index.ts'
import { buildCollision } from './collision.ts'
import { floodReach } from './reach.ts'
import {
  F_BEACH, F_CRATER, F_GATE, F_ISLAND, F_KEEP, F_LAKE, F_LOCK, F_PATH, F_RESERVED, F_RIVER, F_SEA, F_SITE, F_TOWN,
  addFlag, distanceField, draftView, hasFlag, idx, inside, newDraft, type MapDraft,
} from './grid.ts'
import { buildMacro, townRect, type IslandInfo } from './macro.ts'
import { carveRivers } from './water.ts'
import { stampTowns, stubUnusedExits, townTemplate, type StampedTown } from './towns.ts'
import { carveRoutes, connectToPaths, markBands, type CarvedRoute } from './routes.ts'
import { accessStairs, borderWalls, paintLayers, scatterProps } from './scatter.ts'
import { repairAccess } from './access.ts'
import { linkCaves, type BuiltCave } from './caves.ts'
import { computeEncounters } from './encounters.ts'
import { apportion, placeGroundItems, type ItemArea } from './items.ts'
import { rngFor } from './random.ts'
import { addAnchor, tid, type AnchorMap, type OwCtx } from './ctx.ts'
import type { WorldContent } from './data.ts'
import { stampHamlets, type StampedHamlet } from './hamlets.ts'
import { stampPois, type StampedPoi } from './pois.ts'
import { buildDungeons, linkDungeons, type BuiltDungeon } from './dungeons.ts'
import { computeWilds, type WildRegion } from './wilds.ts'
import type { Vec2 } from './schema.ts'
import { stampCauseways } from './frontier/causeways.ts'
import type { Gate } from './frontier/sites.ts'

export interface OverworldResult {
  draft: MapDraft
  ctx: OwCtx
  towns: StampedTown[]
  routes: CarvedRoute[]
  /** Region index of each town and hamlet in draft.regions. */
  townRegion: Map<string, number>
  walkReach: Uint8Array
  surfReach: Uint8Array
  hamlets: StampedHamlet[]
  /** Causeways from the core coast to the core edge (frontier gateways). */
  gates: Gate[]
  pois: StampedPoi[]
  dungeons: BuiltDungeon[]
  wilds: WildRegion[]
  islands: IslandInfo[]
  /** Overworld region index per wild region (parallel to `wilds`). */
  wildBase: number
}

function baseTerrain(ctx: OwCtx): void {
  const { d, macro, spec } = ctx
  const seaT = tid(spec.seaTerrain), shallowT = tid(spec.seaShallowTerrain), beachT = tid(spec.beach.terrain)
  const lakeT = macro.lakeTerrains.map(([a, b]) => [tid(a), tid(b)])
  const craterT = macro.craterTerrains.map(tid)
  const riverT = tid(spec.hydrology.riverTerrain), bankT = tid(spec.hydrology.bankTerrain)
  const groundT = CONTENT.biomes.map((b) => tid((ctx.wc.scatter.biomes[b.id] ?? ctx.wc.scatter.biomes.meadow).ground))
  const nearLand = distanceField(d, (i) => !macro.sea[i], spec.seaShallowWidth + 1)
  for (let i = 0; i < d.w * d.h; i++) {
    d.elevation[i] = macro.level[i]
    if (macro.locked[i]) addFlag(d, i, F_LOCK)
    if (macro.sea[i]) {
      addFlag(d, i, F_SEA)
      d.terrain[i] = nearLand[i] <= spec.seaShallowWidth ? shallowT : seaT
      continue
    }
    if (macro.island[i]) addFlag(d, i, F_ISLAND)
    if (macro.lake[i]) { addFlag(d, i, F_LAKE); d.terrain[i] = lakeT[macro.lake[i] - 1][0]; continue }
    if (macro.lakeRim[i]) { d.terrain[i] = lakeT[macro.lakeRim[i] - 1][1]; continue }
    if (macro.crater[i]) { addFlag(d, i, F_CRATER); d.terrain[i] = craterT[macro.crater[i] - 1]; continue }
    if (macro.river[i] === 1) { addFlag(d, i, F_RIVER); d.terrain[i] = riverT; continue }
    if (macro.river[i] === 2) { d.terrain[i] = bankT; continue }
    if (macro.beach[i]) { addFlag(d, i, F_BEACH); d.terrain[i] = beachT; continue }
    d.terrain[i] = groundT[macro.biome[i]]
  }
}

function regionNeighbours(ctx: OwCtx): Set<number>[] {
  const { d, macro } = ctx
  const out = ctx.wc.regions.map(() => new Set<number>())
  for (let y = 0; y < d.h; y += 2) for (let x = 0; x + 2 < d.w; x += 2) {
    const a = macro.wild[y * d.w + x], b = macro.wild[y * d.w + x + 2]
    if (a !== b) { out[a].add(b); out[b].add(a) }
    if (y + 2 < d.h) {
      const c = macro.wild[(y + 2) * d.w + x]
      if (a !== c) { out[a].add(c); out[c].add(a) }
    }
  }
  return out
}

interface RegionLayout { townRegion: Map<string, number>; wildBase: number }

function buildRegions(ctx: OwCtx, towns: StampedTown[], routes: CarvedRoute[], wilds: WildRegion[], tileWild: Int16Array, hamlets: StampedHamlet[], pois: StampedPoi[]): RegionLayout {
  const { d, macro, wc } = ctx
  const rules = wc.world.encounters
  const neigh = regionNeighbours(ctx)
  const defs: RegionDef[] = wc.regions.map((r, ri) => ({
    id: r.id, nameZh: r.nameZh, biome: r.biome, music: r.music, weather: r.weather,
    encounters: computeEncounters({ key: r.id, biomes: [r.biome], fallback: [...neigh[ri]].map((n) => wc.regions[n].biome), levelRange: r.levelRange }, rules, ctx.seed),
    encounterRate: r.encounterRate, roamingDensity: r.roamingDensity, levelRange: r.levelRange,
  }))
  const wildBase = defs.length
  for (const w of wilds) defs.push(w.def)
  const routeBase = defs.length
  for (const cr of routes) {
    const r = cr.spec
    const passes = [...new Set(cr.path.map((i) => macro.wild[i]))]
    const mid = cr.path[Math.floor(cr.path.length / 2)]
    defs.push({
      id: r.id, nameZh: r.nameZh, biome: r.biome, music: r.music, weather: r.weather ?? wc.regions[macro.wild[mid]].weather,
      encounters: computeEncounters({ key: r.id, biomes: [r.biome], fallback: passes.map((p) => wc.regions[p].biome), levelRange: r.levelRange }, rules, ctx.seed),
      encounterRate: r.encounterRate, roamingDensity: r.roamingDensity, levelRange: r.levelRange,
    })
  }
  const townRegion = new Map<string, number>()
  towns.forEach((t) => {
    const wr = wc.regions[t.pad.region]
    defs.push({
      id: t.spec.id, nameZh: t.spec.nameZh, biome: wr.biome, music: t.spec.music, weather: t.spec.weather ?? wr.weather,
      encounters: [], encounterRate: 0, roamingDensity: 0, isTown: true, townId: t.spec.id, flySpawn: { ...t.square },
    })
    townRegion.set(t.spec.id, defs.length - 1)
  })
  const regionOf = (i: number) => (tileWild[i] >= 0 ? wildBase + tileWild[i] : macro.wild[i])
  for (const h of hamlets) {
    const under = defs[regionOf(h.site.y * d.w + h.site.x)]
    defs.push({
      id: h.id, nameZh: h.nameZh, biome: h.biome, music: wc.pois.hamlets.music, weather: under.weather,
      encounters: [], encounterRate: 0, roamingDensity: 0, isTown: true, townId: h.id, flySpawn: { ...h.center },
      levelRange: under.levelRange,
    })
    townRegion.set(h.id, defs.length - 1)
  }
  const nestRegion = new Map<StampedPoi, number>()
  for (const p of pois) {
    if (!p.tpl.nest || !p.nest.length) continue
    const under = defs[regionOf(p.site.y * d.w + p.site.x)]
    const lr = under.levelRange ?? [1, 1]
    const maxLevel = CONTENT.config.party.maxLevel
    const levelRange: Vec2 = [Math.min(maxLevel, lr[0] + p.tpl.nest.levelBonus), Math.min(maxLevel, lr[1] + p.tpl.nest.levelBonus)]
    const def: RegionDef = {
      id: p.id, nameZh: p.nameZh, biome: p.biome, music: under.music, weather: under.weather,
      encounters: computeEncounters({ key: p.id, biomes: [p.biome], fallback: [under.biome], levelRange, rareBoost: p.tpl.nest.rareBoost }, rules, ctx.seed),
      encounterRate: p.tpl.nest.encounterRate, roamingDensity: under.roamingDensity, levelRange,
    }
    Object.assign(def, { danger: 3 })
    defs.push(def)
    nestRegion.set(p, defs.length - 1)
  }
  if (defs.length > 256) throw new Error(`too many overworld regions (${defs.length}) for a Uint8Array region map`)
  for (let i = 0; i < d.w * d.h; i++) d.region[i] = regionOf(i)
  // Route bands: nearest route within routeRegionRadius (multi-source BFS keeps the closest label).
  const R = ctx.spec.routeRegionRadius
  const dist = new Int16Array(d.w * d.h).fill(-1)
  let frontier: number[] = []
  routes.forEach((cr, k) => {
    for (const i of cr.tiles) if (dist[i] < 0 && !hasFlag(d, i, F_TOWN)) { dist[i] = 0; d.region[i] = routeBase + k; frontier.push(i) }
  })
  for (let step = 1; step <= R && frontier.length; step++) {
    const next: number[] = []
    for (const i of frontier) {
      const x = i % d.w
      for (let k = 0; k < 4; k++) {
        const j = k === 0 ? (x > 0 ? i - 1 : -1) : k === 1 ? (x < d.w - 1 ? i + 1 : -1) : k === 2 ? i - d.w : i + d.w
        if (j < 0 || j >= d.w * d.h || dist[j] >= 0 || hasFlag(d, j, F_TOWN) || hasFlag(d, j, F_SEA) || hasFlag(d, j, F_SITE)) continue
        dist[j] = step
        d.region[j] = d.region[i]
        next.push(j)
      }
    }
    frontier = next
  }
  for (const t of towns) {
    const ri = townRegion.get(t.spec.id)!
    const r = townRect(t.spec, t.tpl.w, t.tpl.h)
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (inside(d, x, y)) d.region[idx(d, x, y)] = ri
  }
  for (const h of hamlets) {
    const ri = townRegion.get(h.id)!
    const R2 = h.site.radius * h.site.radius
    for (let y = h.site.y - h.site.radius; y <= h.site.y + h.site.radius; y++) for (let x = h.site.x - h.site.radius; x <= h.site.x + h.site.radius; x++) {
      const dx = x - h.site.x, dy = y - h.site.y
      if (inside(d, x, y) && dx * dx + dy * dy <= R2 && hasFlag(d, y * d.w + x, F_SITE)) d.region[y * d.w + x] = ri
    }
  }
  for (const [p, ri] of nestRegion) for (const i of p.nest) d.region[i] = ri
  d.regions = defs
  return { townRegion, wildBase }
}

export function freeTile(d: MapDraft, i: number): boolean {
  if (d.occ[i] || (d.flags[i] & (F_PATH | F_TOWN | F_RESERVED | F_GATE | F_KEEP)) !== 0) return false
  const t = CONTENT.terrain[d.terrain[i]]
  return t?.walkable === true && !t.liquid && !t.stairs
}

/** Nearest free reachable tile to (x, y), optionally restricted by `filter`. */
function snap(d: MapDraft, reach: Uint8Array, x: number, y: number, maxR: number, filter?: (i: number) => boolean): number {
  for (let r = 0; r <= maxR; r++) {
    let best = -1, bestD = Infinity
    for (let yy = y - r; yy <= y + r; yy++) for (let xx = x - r; xx <= x + r; xx++) {
      if (Math.max(Math.abs(xx - x), Math.abs(yy - y)) !== r || !inside(d, xx, yy)) continue
      const i = idx(d, xx, yy)
      if (!reach[i] || !freeTile(d, i) || (filter && !filter(i))) continue
      const dd = (xx - x) * (xx - x) + (yy - y) * (yy - y)
      if (dd < bestD) { bestD = dd; best = i }
    }
    if (best >= 0) return best
  }
  return -1
}

function trainerSpots(ctx: OwCtx, routes: CarvedRoute[], reach: Uint8Array): void {
  const { d, spec } = ctx
  const ts = spec.trainerSpots
  for (const cr of routes) {
    // Candidates within maxPathDist of this route's tiles (local scan instead of a full-map field).
    const own = new Set(cr.tiles)
    const cands: number[] = []
    const seen = new Set<number>()
    for (const t of cr.tiles) {
      const tx = t % d.w, ty = (t - tx) / d.w
      for (let oy = -ts.maxPathDist; oy <= ts.maxPathDist; oy++) for (let ox = -ts.maxPathDist; ox <= ts.maxPathDist; ox++) {
        const m = Math.abs(ox) + Math.abs(oy)
        if (m < ts.minPathDist || m > ts.maxPathDist || !inside(d, tx + ox, ty + oy)) continue
        const i = (ty + oy) * d.w + tx + ox
        if (seen.has(i) || own.has(i)) continue
        seen.add(i)
        if (!reach[i] || !freeTile(d, i) || hasFlag(d, i, F_LOCK)) continue
        cands.push(i)
      }
    }
    cands.sort((a, b) => a - b)
    const n = cr.spec.trainerSpots
    const chosen: number[] = []
    for (let k = 0; k < n; k++) {
      const target = cr.path[Math.floor(((k + 0.5) / n) * cr.path.length)]
      const tx = target % d.w, ty = (target - tx) / d.w
      let best = -1
      for (let spacing = ts.minSpacing; spacing >= 1 && best < 0; spacing--) {
        let bestD = Infinity
        for (const i of cands) {
          const x = i % d.w, y = (i - x) / d.w
          if (chosen.some((j) => Math.max(Math.abs((j % d.w) - x), Math.abs(Math.floor(j / d.w) - y)) < spacing)) continue
          const dd = Math.abs(x - tx) + Math.abs(y - ty) + (d.elevation[i] !== d.elevation[target] ? d.w : 0)
          if (dd < bestD) { bestD = dd; best = i }
        }
      }
      if (best < 0) { ctx.problems.push(`route ${cr.spec.id}: only ${chosen.length}/${n} trainer spots`); break }
      chosen.push(best)
      addFlag(d, best, F_RESERVED)
      addAnchor(ctx.anchors, ctx.problems, `route:${cr.spec.id}:${k + 1}`, d.id, best % d.w, Math.floor(best / d.w))
    }
  }
}

function spotAnchors(ctx: OwCtx, reach: Uint8Array): void {
  const { d, spec, macro, wc } = ctx
  for (const s of spec.spots) {
    const i = snap(d, reach, s.near[0], s.near[1], spec.snapRadius.spot)
    if (i < 0) { ctx.problems.push(`spot ${s.name}: no reachable tile near ${s.near}`); continue }
    addFlag(d, i, F_RESERVED)
    addAnchor(ctx.anchors, ctx.problems, s.name, d.id, i % d.w, Math.floor(i / d.w))
  }
  wc.regions.forEach((r, ri) => {
    const [x, y] = r.points[0]
    const i = snap(d, reach, x, y, spec.snapRadius.region, (j) => macro.wild[j] === ri)
    if (i >= 0) addAnchor(ctx.anchors, ctx.problems, `region:${r.id}`, d.id, i % d.w, Math.floor(i / d.w))
    else ctx.problems.push(`region ${r.id}: no reachable tile for its anchor`)
  })
  macro.islands.forEach((isl, k) => {
    const i = snap(d, reach, isl.x, isl.y, Math.ceil(isl.radius * 1.5) + 2, (j) => macro.island[j] === k + 1)
    if (i >= 0) addAnchor(ctx.anchors, ctx.problems, `island:${isl.id}`, d.id, i % d.w, Math.floor(i / d.w))
    else ctx.problems.push(`island ${isl.id}: no reachable tile`)
  })
}

/** `wild:<regionId>:<n>` spots spread over every wilderness region (walk-reachable, surf for islands). */
function wildSpots(ctx: OwCtx, wilds: WildRegion[], wildBase: number, walk: Uint8Array, surf: Uint8Array): void {
  const { d } = ctx
  const ws = ctx.wc.wilds.spots
  // Walk-reachable tiles; regions only reachable by surfing (islands, cut-off coastal strips) use surf reach.
  const cands: number[][] = wilds.map(() => [])
  const surfOnly: number[][] = wilds.map(() => [])
  for (let i = 0; i < d.w * d.h; i++) {
    const k = d.region[i] - wildBase
    if (k < 0 || k >= wilds.length) continue
    if (!surf[i] || !freeTile(d, i) || hasFlag(d, i, F_SITE | F_LOCK)) continue
    if (walk[i] && !wilds[k].island) cands[k].push(i)
    else surfOnly[k].push(i)
  }
  wilds.forEach((_, k) => { if (!cands[k].length) cands[k] = surfOnly[k] })
  const want = apportion(ws.total, wilds.map((w) => Math.sqrt(w.tiles))).map((n) => Math.max(ws.perRegionMin, n))
  wilds.forEach((w, k) => {
    const rng = rngFor(ctx.seed, `wild-spots-${w.def.id}`)
    const list = rng.shuffle(cands[k])
    const chosen: number[] = []
    for (const i of list) {
      if (chosen.length >= want[k]) break
      const x = i % d.w, y = (i - x) / d.w
      if (chosen.some((j) => Math.abs((j % d.w) - x) + Math.abs(Math.floor(j / d.w) - y) < ws.minSpacing)) continue
      chosen.push(i)
      addFlag(d, i, F_RESERVED)
      addAnchor(ctx.anchors, ctx.problems, `wild:${w.def.id}:${chosen.length}`, d.id, x, y)
    }
    if (!chosen.length) ctx.problems.push(`wild region ${w.def.id}: no reachable spot`)
  })
}

export function overworldItemAreas(ctx: OwCtx, reach: Uint8Array, total: { visible: number; hidden: number }): ItemArea[] {
  const { d } = ctx
  const byRegion = new Map<number, number[]>()
  for (let i = 0; i < d.w * d.h; i++) {
    if (!reach[i] || !freeTile(d, i) || hasFlag(d, i, F_LOCK)) continue
    const r = d.region[i]
    if (d.regions[r]?.isTown) continue
    let l = byRegion.get(r)
    if (!l) { l = []; byRegion.set(r, l) }
    l.push(i)
  }
  const keys = [...byRegion.keys()].sort((a, b) => a - b)
  const weights = keys.map((k) => Math.sqrt(byRegion.get(k)!.length))
  const vis = apportion(total.visible, weights)
  const hid = apportion(total.hidden, weights)
  return keys.map((k, n) => {
    const lr = d.regions[k].levelRange ?? [1, 1]
    return { draft: d, tiles: byRegion.get(k)!, levelMid: Math.round((lr[0] + lr[1]) / 2), visible: vis[n], hidden: hid[n] }
  })
}

export interface ItemBudget { visible: number; hidden: number }

export function buildOverworld(seed: number, wc: WorldContent, anchors: AnchorMap, problems: string[], caves: BuiltCave[], itemCounter: { next: number }, budget: ItemBudget, usedNames: Set<string>): OverworldResult {
  const spec = wc.world.overworld
  const macro = buildMacro({
    seed, wc,
    towns: wc.towns.map((town) => {
      const t = townTemplate(town, wc.townLayouts.templates)
      return { town, w: t.w, h: t.h }
    }),
  })
  const d = newDraft({ id: spec.id, nameZh: spec.nameZh, kind: 'overworld', w: spec.width, h: spec.height, fill: 0, outdoor: true, music: spec.music })
  const ctx: OwCtx = { seed, wc, spec, d, macro, regionIdx: new Map(wc.regions.map((r, i) => [r.id, i])), anchors, doors: [], problems }
  baseTerrain(ctx)
  carveRivers(ctx)
  const towns = stampTowns(ctx)
  for (const t of towns) {
    // Keep a one-tile ring around every town clear so its exits never dead-end in scenery.
    const r = townRect(t.spec, t.tpl.w, t.tpl.h)
    for (let y = r.y - 1; y <= r.y + r.h; y++) for (let x = r.x - 1; x <= r.x + r.w; x++) {
      if (inside(d, x, y) && !hasFlag(d, idx(d, x, y), F_TOWN)) addFlag(d, idx(d, x, y), F_KEEP)
    }
  }
  markBands(ctx)
  const used = new Set<string>()
  const routes = carveRoutes(ctx, towns, used)
  stubUnusedExits(ctx, towns, used)
  ctx.pathHeur = distanceField(d, (i) => hasFlag(d, i, F_PATH), 0xffff)
  linkCaves(ctx, caves)
  for (const t of wc.towns) usedNames.add(t.nameZh)
  for (const r of wc.regions) usedNames.add(r.nameZh)
  const hamlets = stampHamlets(ctx, macro.sites, usedNames, ctx.doors)
  for (const h of hamlets) {
    if (!connectToPaths(ctx, h.center.y * d.w + h.center.x, h.site.zone, wc.pois.hamlets.road)) problems.push(`hamlet ${h.id}: no trail to the path network`)
  }
  const pois = stampPois(ctx, macro.sites, usedNames)
  const dungeons = linkDungeons(ctx, buildDungeons(seed, wc, macro.sites, spec.id, usedNames))
  const dgFloors = dungeons.reduce((n, dn) => n + dn.floors.length, 0)
  budget = { visible: Math.max(0, budget.visible - dgFloors * wc.dungeons.items.visible), hidden: Math.max(0, budget.hidden - dgFloors * wc.dungeons.items.hidden) }
  ctx.pathHeur = undefined
  const pathDist = distanceField(d, (i) => hasFlag(d, i, F_PATH), spec.pathDistCap)
  paintLayers(ctx, pathDist)
  accessStairs(ctx)
  borderWalls(ctx)
  repairAccess(ctx, null)
  const scatterFrom = d.props.length
  scatterProps(ctx, pathDist)
  const targets: number[] = []
  for (const h of hamlets) { targets.push(h.center.y * d.w + h.center.x); for (const dr of h.doors) targets.push(dr.front.y * d.w + dr.front.x) }
  for (const p of pois) { targets.push(p.center.y * d.w + p.center.x); for (const s of p.spots) targets.push(s.y * d.w + s.x) }
  for (const dn of dungeons) if (dn.mouth) targets.push(dn.mouth.y * d.w + dn.mouth.x)
  const stuck = repairAccess(ctx, scatterFrom, targets)
  for (const t of stuck) problems.push(`unreachable feature tile at ${t % d.w},${Math.floor(t / d.w)}`)

  const start = towns.find((t) => t.spec.start)?.square ?? { x: d.spawn.x, y: d.spawn.y }
  const { regions: wilds, tileWild } = computeWilds(ctx, start, usedNames)
  const { townRegion, wildBase } = buildRegions(ctx, towns, routes, wilds, tileWild, hamlets, pois)

  const view = draftView(d)
  const col = buildCollision(view)
  const walkReach = floodReach(view, col, d.spawn.x, d.spawn.y, false)
  const surfReach = floodReach(view, col, d.spawn.x, d.spawn.y, true)
  trainerSpots(ctx, routes, walkReach)
  spotAnchors(ctx, surfReach)
  wildSpots(ctx, wilds, wildBase, walkReach, surfReach)

  // Ground items: POI quotas first, the rest spread over the overworld regions.
  const rng = rngFor(seed, 'ground-items')
  let poiVis = 0, poiHid = 0
  const poiAreas: ItemArea[] = []
  for (const p of pois) {
    const it = p.tpl.items
    if (!it || (!it.visible && !it.hidden)) continue
    const reach = p.island ? surfReach : walkReach
    const tiles: number[] = []
    const R = p.site.radius + 2
    for (let y = p.site.y - R; y <= p.site.y + R; y++) for (let x = p.site.x - R; x <= p.site.x + R; x++) {
      if (!inside(d, x, y)) continue
      const i = y * d.w + x
      if (reach[i] && !d.occ[i] && !hasFlag(d, i, F_RESERVED | F_GATE | F_TOWN) && CONTENT.terrain[d.terrain[i]]?.walkable && !CONTENT.terrain[d.terrain[i]]?.liquid && !CONTENT.terrain[d.terrain[i]]?.stairs) tiles.push(i)
    }
    const lr = d.regions[d.region[p.site.y * d.w + p.site.x]]?.levelRange ?? [1, 1]
    const vis = Math.min(it.visible, Math.max(0, budget.visible - poiVis)), hid = Math.min(it.hidden, Math.max(0, budget.hidden - poiHid))
    poiVis += vis; poiHid += hid
    poiAreas.push({ draft: d, tiles, levelMid: Math.round((lr[0] + lr[1]) / 2), visible: vis, hidden: hid })
  }
  const before = d.items.length
  placeGroundItems(poiAreas, wc.items, rng, itemCounter)
  const placedVis = d.items.slice(before).filter((x) => !x.hidden).length, placedHid = d.items.length - before - placedVis
  const areas = overworldItemAreas(ctx, surfReach, { visible: Math.max(0, budget.visible - placedVis), hidden: Math.max(0, budget.hidden - placedHid) })
  placeGroundItems(areas, wc.items, rng, itemCounter)
  // Last: causeways into the frontier (only open sea changes, so every earlier stage is unaffected).
  const gates = stampCauseways(ctx, walkReach)
  return { draft: d, ctx, towns, routes, townRegion, walkReach, surfReach, hamlets, gates, pois, dungeons, wilds, islands: macro.islands, wildBase }
}
