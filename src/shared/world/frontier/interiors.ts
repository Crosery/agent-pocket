// Lazily generated frontier maps: hamlet building interiors ('fx:hamlet:<sx>:<sy>:<slot>') stamped from the
// ordinary interior templates, and dungeon floors ('fx:dungeon:<sx>:<sy>:<floor>') carved by caves.ts. Both are
// pure functions of the site, with two-way warps to the overworld door / cave mouth.
import type { GameMap, RegionDef } from '../../types.ts'
import { CONTENT } from '../../content/index.ts'
import { WORLD_CONTENT } from '../data.ts'
import { buildCave, type BuiltCave } from '../caves.ts'
import { computeEncounters } from '../encounters.ts'
import { F_KEEP, F_RESERVED, finalizeDraft, fmt } from '../grid.ts'
import { stampInterior } from '../interiors.ts'
import { bandFor, pickItem } from '../items.ts'
import { rngFor } from '../random.ts'
import type { BaseDeps } from './base.ts'
import { interiorDecorators, type InteriorDecorContext } from './decorate.ts'
import { frontierWorldContent, type SiteDoor, type SiteLayout } from './layout.ts'

function decorate(deps: BaseDeps, map: GameMap, kind: string, slot: string, layout: SiteLayout, floor: number, floors: number, anchors: Record<string, { x: number; y: number }>, region: RegionDef): void {
  const F = deps.fields
  const ctx: InteriorDecorContext = {
    seed: F.seed, map, kind, slot, site: layout.site, layout, floor, floors, anchors, region,
    distance: F.originDist(layout.site.x, layout.site.y),
    rng: (salt) => rngFor(F.seed, `fx-int-${map.id}-${salt}`),
  }
  for (const d of interiorDecorators()) d.fn(ctx)
}

export function buildHamletInterior(deps: BaseDeps, layout: SiteLayout, door: SiteDoor, overworldId: string, siteRegion: RegionDef | null): GameMap | null {
  const wc = frontierWorldContent(deps)
  const tpl = wc.interiorLayouts.templates[door.template]
  if (!tpl) return null
  const name = door.nameZh ?? fmt(tpl.nameZh, { town: layout.nameZh })
  const region: RegionDef = {
    id: door.mapId, nameZh: name, biome: tpl.biome ?? siteRegion?.biome ?? CONTENT.biomes[layout.site.biome]?.id ?? CONTENT.biomes[0].id,
    music: tpl.music, encounters: [], encounterRate: 0, roamingDensity: 0, isTown: true, townId: layout.site.id,
  }
  const problems: string[] = []
  const d = stampInterior(wc, door.template, tpl, door.mapId, name, overworldId, region, problems)
  if (tpl.exit) {
    d.warps.push({ x: tpl.exit[0], y: tpl.exit[1], toMap: overworldId, toX: door.front.x, toY: door.front.y, facing: door.facing, kind: 'door' })
    d.flags[tpl.exit[1] * d.w + tpl.exit[0]] |= F_RESERVED
  }
  const map = finalizeDraft(d)
  const anchors: Record<string, { x: number; y: number }> = { entrance: { x: d.spawn.x, y: d.spawn.y } }
  for (const [k, [x, y]] of Object.entries(tpl.anchors)) anchors[k] = { x, y }
  const kind = door.slot.replace(/\d+$/, '')
  decorate(deps, map, kind, door.slot, layout, 0, 0, anchors, region)
  return map
}

/** Every floor of a frontier dungeon (stairs linked both ways; floor 1 exits to the overworld mouth). Floor k's danger
 * tier is the surface region's tier + k (capped at the last gen.json levels.dangerDistances tier). */
export function buildDungeonFloors(deps: BaseDeps, layout: SiteLayout, overworldId: string, surfaceDanger = 0): GameMap[] {
  const plan = layout.dungeon
  if (!plan) return []
  const F = deps.fields
  const dg = WORLD_CONTENT.dungeons
  const caves: BuiltCave[] = plan.floors.map((spec) => buildCave(spec, F.seed, overworldId))
  for (let k = 0; k + 1 < caves.length; k++) {
    const a = caves[k], b = caves[k + 1]
    const down = a.ends[1], up = b.ends[0]
    a.draft.warps.push({ x: down.exit.x, y: down.exit.y, toMap: b.spec.id, toX: up.arrive.x, toY: up.arrive.y, facing: up.facing, kind: 'stairs' })
    b.draft.warps.push({ x: up.exit.x, y: up.exit.y, toMap: a.spec.id, toX: down.arrive.x, toY: down.arrive.y, facing: down.facing, kind: 'stairs' })
  }
  const first = caves[0]
  const up = first.ends[0]
  first.draft.warps.push({ x: up.exit.x, y: up.exit.y, toMap: overworldId, toX: plan.mouth.x, toY: plan.mouth.y, facing: 'down', kind: 'cave' })
  const rules = WORLD_CONTENT.items
  const maxDanger = F.cf.fc.gen.levels.dangerDistances.length - 1
  return caves.map((cave, k) => {
    const spec = cave.spec
    const region: RegionDef = {
      id: spec.id, nameZh: spec.nameZh, biome: spec.biome, music: spec.music, weather: spec.weather, danger: Math.min(maxDanger, surfaceDanger + k + 1),
      encounters: computeEncounters({ key: spec.id, biomes: spec.habitats, fallback: [spec.biome], levelRange: spec.levelRange, rareBoost: dg.rareBoost }, WORLD_CONTENT.world.encounters, F.seed),
      encounterRate: spec.encounterRate, roamingDensity: spec.roamingDensity, levelRange: spec.levelRange,
    }
    cave.draft.regions = [region]
    // Ground items on reachable open floor.
    const d = cave.draft
    const rng = rngFor(F.seed, `fx-dg-items-${spec.id}`)
    const levelMid = Math.round((spec.levelRange[0] + spec.levelRange[1]) / 2)
    const free: number[] = []
    for (let i = 0; i < d.w * d.h; i++) {
      const t = CONTENT.terrain[d.terrain[i]]
      if (cave.reach[i] && !d.occ[i] && (d.flags[i] & (F_RESERVED | F_KEEP)) === 0 && t?.walkable && !t.liquid) free.push(i)
    }
    rng.shuffle(free)
    let n = 0
    for (const hidden of [...Array(spec.items.visible).fill(false), ...Array(spec.items.hidden).fill(true)] as boolean[]) {
      const i = free.pop()
      if (i === undefined) break
      const item = pickItem(rules, levelMid, hidden, rng)
      if (!item) break
      const band = bandFor(rules, levelMid)
      d.items.push({ id: `${spec.id}:item:${n++}`, x: i % d.w, y: Math.floor(i / d.w), item: item.id, qty: rng.int(band.qty[0], band.qty[1]), hidden })
      d.flags[i] |= F_RESERVED
    }
    const map = finalizeDraft(d)
    const anchors: Record<string, { x: number; y: number }> = { entrance: { ...cave.ends[0].arrive } }
    const last = k === caves.length - 1
    cave.spots.forEach((s, j) => { anchors[last && j === 0 ? 'boss' : `spot-${j + 1}`] = { ...s } })
    decorate(deps, map, 'dungeon', `floor${k + 1}`, layout, k + 1, caves.length, anchors, region)
    return map
  })
}
