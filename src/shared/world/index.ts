// Deterministic, data-driven world generator. All layout data lives in content/world/**; this module only
// assembles the stages. Story content (NPCs, trainers, quests) is layered on afterwards by applyStory()
// (src/shared/world/story.ts) using the anchors exposed by worldAnchors().
import type { BadgeDef, GameMap, RegionDef, TownDef, World } from '../types.ts'
import { CONTENT } from '../content/index.ts'
import { WORLD_CONTENT, scaleLayout } from './data.ts'
import { buildCollision } from './collision.ts'
import { buildCave, caveAnchors } from './caves.ts'
import { computeEncounters, ensureEncounterCoverage } from './encounters.ts'
import { F_KEEP, F_PATH, F_RESERVED, draftView, finalizeDraft, type MapDraft } from './grid.ts'
import { buildInteriors } from './interiors.ts'
import { placeGroundItems } from './items.ts'
import { buildOverworld } from './overworld.ts'
import { finishDungeons } from './dungeons.ts'
import { floodReach } from './reach.ts'
import { rngFor } from './random.ts'
import { applyStory } from './story.ts'
import { FrontierProvider } from './frontier/provider.ts'
import type { Gate } from './frontier/sites.ts'
import type { AnchorMap, DoorLink } from './ctx.ts'
import type { Vec2 } from './schema.ts'

export type { AnchorMap, AnchorPoint } from './ctx.ts'
export { WORLD_CONTENT, scaleLayout } from './data.ts'
export { validateWorldContent } from './validate.ts'
export * as frontier from './frontier/index.ts'

/** Generated features beyond the authored story layout (for tests, tools and the world map). */
export interface WorldFeatures {
  hamlets: { id: string; nameZh: string; x: number; y: number; doors: string[]; services: boolean }[]
  pois: { id: string; template: string; nameZh: string; x: number; y: number; island: boolean; landmark: boolean; nest: boolean }[]
  dungeons: { id: string; nameZh: string; style: string; floors: string[]; mouth: { x: number; y: number } | null }[]
  /** Wilderness region ids (overworld regions) with their danger tier. */
  wilds: { id: string; nameZh: string; biome: string; danger: number; levelRange: Vec2; island: boolean }[]
  islands: { id: string; authored: boolean }[]
  rivers: number
  lakes: number
  /** Causeways from the core coast into the infinite frontier (gateway hamlet centres). */
  gates: Gate[]
}

export interface WorldBuildInfo {
  anchors: AnchorMap
  /** Non-fatal generation problems (should be empty for shipped content; asserted by tests). */
  problems: string[]
  /** Overworld tiles reachable from spawn on foot / with surf (gates open, NPCs ignored). */
  walkReach: Uint8Array
  surfReach: Uint8Array
  features: WorldFeatures
  /** Wall-clock build time of the last buildWorld() for this seed (ms). */
  buildMs: number
}

export interface WorldStats {
  width: number
  height: number
  maps: number
  props: number
  pois: number
  hamlets: number
  dungeons: number
  regions: number
  buildMs?: number
}

const INFO = new WeakMap<World, WorldBuildInfo>()
const BY_SEED = new Map<number, WorldBuildInfo>()

function caveItemsArea(d: MapDraft, levelRange: Vec2, items: { visible: number; hidden: number }) {
  const view = draftView(d)
  const reach = floodReach(view, buildCollision(view), d.spawn.x, d.spawn.y, false)
  const tiles: number[] = []
  for (let i = 0; i < d.w * d.h; i++) {
    const t = CONTENT.terrain[d.terrain[i]]
    if (reach[i] && !d.occ[i] && (d.flags[i] & (F_PATH | F_KEEP | F_RESERVED)) === 0 && t?.walkable && !t.liquid) tiles.push(i)
  }
  return { draft: d, tiles, levelMid: Math.round((levelRange[0] + levelRange[1]) / 2), visible: items.visible, hidden: items.hidden }
}

export function buildWorld(seed: number = CONTENT.config.world.seed): World {
  const t0 = performance.now()
  const wc = scaleLayout(WORLD_CONTENT)
  const owId = wc.world.overworld.id
  const anchors: AnchorMap = {}
  const problems: string[] = []
  const counter = { next: 1 }
  const usedNames = new Set<string>()

  const caves = wc.caves.caves.map((spec) => buildCave(spec, seed, owId))
  const caveItems = wc.caves.caves.reduce((s, c) => ({ visible: s.visible + c.items.visible, hidden: s.hidden + c.items.hidden }), { visible: 0, hidden: 0 })
  const budget = { visible: Math.max(0, wc.items.visible - caveItems.visible), hidden: Math.max(0, wc.items.hidden - caveItems.hidden) }
  const ow = buildOverworld(seed, wc, anchors, problems, caves, counter, budget, usedNames)

  for (const cave of caves) {
    const s = cave.spec
    const region: RegionDef = {
      id: s.id, nameZh: s.nameZh, biome: s.biome, music: s.music, weather: s.weather,
      encounters: computeEncounters({ key: s.id, biomes: s.habitats, fallback: [s.biome], levelRange: s.levelRange }, wc.world.encounters, seed),
      encounterRate: s.encounterRate, roamingDensity: s.roamingDensity, levelRange: s.levelRange,
    }
    cave.draft.regions = [region]
    caveAnchors(anchors, problems, cave)
    placeGroundItems([caveItemsArea(cave.draft, s.levelRange, s.items)], wc.items, rngFor(seed, `items-${s.id}`), counter)
  }

  const owDraft = ow.draft
  finishDungeons(wc, seed, ow.dungeons, (dn) => {
    const at = dn.mouth ?? { x: dn.site.x, y: dn.site.y }
    return owDraft.regions[owDraft.region[at.y * owDraft.w + at.x]]?.levelRange ?? wc.regions[dn.site.zone].levelRange
  }, anchors, problems, owDraft.signs)
  for (const dn of ow.dungeons) {
    for (const f of dn.floors) {
      placeGroundItems([caveItemsArea(f.draft, f.spec.levelRange, f.spec.items)], wc.items, rngFor(seed, `items-${f.spec.id}`), counter)
    }
  }

  const townRegionDef = (link: DoorLink): RegionDef => {
    const ri = ow.townRegion.get(link.townId)
    const base = ri !== undefined ? owDraft.regions[ri] : undefined
    return {
      id: link.townId, nameZh: link.townNameZh, biome: link.biome, music: base?.music ?? owDraft.music,
      encounters: [], encounterRate: 0, roamingDensity: 0, isTown: true, townId: link.townId,
    }
  }
  const interiors = buildInteriors(wc, ow.ctx.doors, owId, townRegionDef, anchors, problems)

  const maps: Record<string, GameMap> = {}
  const add = (m: GameMap) => {
    if (maps[m.id]) problems.push(`duplicate map id "${m.id}"`)
    maps[m.id] = m
  }
  add(finalizeDraft(owDraft))
  for (const c of caves) add(finalizeDraft(c.draft))
  for (const dn of ow.dungeons) for (const f of dn.floors) add(finalizeDraft(f.draft))
  for (const d of interiors) add(finalizeDraft(d))
  const unplaced = ensureEncounterCoverage(
    Object.values(maps).flatMap((m) => m.regions.map((r) => ({ key: `${m.id}/${r.id}`, biome: r.biome, encounters: r.encounters, levelRange: r.levelRange }))),
    wc.world.encounters, seed,
  )
  for (const id of unplaced) problems.push(`encounter coverage: no wild table can hold base form "${id}"`)

  const levelAt = (x: number, y: number): Vec2 | undefined => owDraft.regions[owDraft.region[y * owDraft.w + x]]?.levelRange
  const towns: TownDef[] = ow.towns.map((t) => ({
    id: t.spec.id, nameZh: t.spec.nameZh, map: owId, x: t.square.x, y: t.square.y, description: t.spec.description,
    kind: 'town', levelRange: wc.regions[t.pad.region].levelRange,
  }))
  for (const h of ow.hamlets) {
    towns.push({ id: h.id, nameZh: h.nameZh, map: owId, x: h.center.x, y: h.center.y, description: h.description, kind: 'hamlet', levelRange: levelAt(h.center.x, h.center.y) })
  }
  for (const p of ow.pois) {
    if (!p.tpl.landmark) continue
    const sign = owDraft.signs.find((s) => Math.abs(s.x - p.center.x) + Math.abs(s.y - p.center.y) <= 4)
    towns.push({ id: p.id, nameZh: p.nameZh, map: owId, x: p.center.x, y: p.center.y, description: sign?.text ?? p.nameZh, kind: 'landmark', levelRange: levelAt(p.center.x, p.center.y) })
  }
  for (const dn of ow.dungeons) {
    if (!dn.mouth) continue
    towns.push({ id: dn.id, nameZh: dn.nameZh, map: owId, x: dn.mouth.x, y: dn.mouth.y, description: dn.sign >= 0 ? owDraft.signs[dn.sign].text : dn.nameZh, kind: 'landmark', levelRange: dn.floors[0].spec.levelRange })
  }
  const badges: BadgeDef[] = []
  for (const t of wc.towns) {
    if (t.gym) badges.push({ id: t.gym.badge, nameZh: t.gym.badgeNameZh, type: t.gym.type, leader: t.gym.leader, town: t.id })
  }

  const features: WorldFeatures = {
    hamlets: ow.hamlets.map((h) => ({ id: h.id, nameZh: h.nameZh, x: h.center.x, y: h.center.y, doors: h.doors.map((dr) => dr.slot), services: h.services })),
    pois: ow.pois.map((p) => ({ id: p.id, template: p.template, nameZh: p.nameZh, x: p.center.x, y: p.center.y, island: p.island, landmark: p.tpl.landmark === true, nest: p.nest.length > 0 })),
    dungeons: ow.dungeons.map((dn) => ({ id: dn.id, nameZh: dn.nameZh, style: dn.style.id, floors: dn.floors.map((f) => f.spec.id), mouth: dn.mouth })),
    wilds: ow.wilds.map((w) => ({ id: w.def.id, nameZh: w.def.nameZh, biome: w.biome, danger: w.danger, levelRange: w.def.levelRange ?? [1, 1], island: w.island })),
    islands: ow.islands.map((i) => ({ id: i.id, authored: i.authored })),
    rivers: ow.ctx.macro.hydro.rivers,
    lakes: wc.world.overworld.lakes.length + ow.ctx.macro.hydro.lakes,
    gates: ow.gates,
  }
  const world: World = { seed, maps, trainers: {}, towns, quests: [], badges, startMap: owId }
  const info: WorldBuildInfo = { anchors, problems, walkReach: ow.walkReach, surfReach: ow.surfReach, features, buildMs: 0 }
  INFO.set(world, info)
  BY_SEED.set(seed, info)
  applyStory(world)
  // The overworld is unbounded: the core continent above plus the procedural frontier around it.
  const core = maps[owId]
  core.infinite = new FrontierProvider({
    seed, overworldId: owId, core, gates: ow.gates, origin: { x: core.spawn.x, y: core.spawn.y }, corePlaces: () => world.towns,
  })
  info.buildMs = Math.round(performance.now() - t0)
  return world
}

function infoFor(world: World): WorldBuildInfo {
  let info = INFO.get(world) ?? BY_SEED.get(world.seed)
  if (!info) {
    buildWorld(world.seed)
    info = BY_SEED.get(world.seed)!
  }
  return info
}

/**
 * Named spots for story content: '<scope>:<name>' -> { map, x, y }. See docs/world.md for the naming scheme
 * (town:<id>[:slot|:anchor], <interiorMapId>:<anchor>, gate:<name>, route:<routeId>:<n>, quest:<n>,
 * hamlet:<id>[:<slot>-door|:npc-<n>], poi:<id>:center|spot:<n>, dungeon:<id>:mouth|floor<n>:boss|..., wild:<regionId>:<n>).
 */
export function worldAnchors(world: World): Record<string, { map: string; x: number; y: number }> {
  return infoFor(world).anchors
}

export function worldBuildInfo(world: World): WorldBuildInfo {
  return infoFor(world)
}

/** Size and feature counts of a built world (buildMs when it was built in this process). */
export function worldStats(world: World): WorldStats {
  const ow = world.maps[world.startMap]
  const info = INFO.get(world) ?? BY_SEED.get(world.seed)
  let props = 0
  for (const m of Object.values(world.maps)) props += m.props.length
  return {
    width: ow.width,
    height: ow.height,
    maps: Object.keys(world.maps).length,
    props,
    pois: info?.features.pois.length ?? 0,
    hamlets: world.towns.filter((t) => t.kind === 'hamlet').length,
    dungeons: info?.features.dungeons.length ?? 0,
    regions: ow.regions.length,
    buildMs: info?.buildMs,
  }
}
