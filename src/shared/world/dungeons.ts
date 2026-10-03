// Procedural dungeons (dungeons.json): 1-3 floors per dungeon, each a cave map carved by cellular automata or
// drunkard walks (style.algo) with a guaranteed tunnel between its up and down ends. Floor k's down-stairs
// warp to floor k+1's up end and back; floor 1's up end leads to a cave mouth on the overworld. The deepest
// floor's farthest spot is the guardian anchor `dungeon:<id>:floor<n>:boss`.
import type { RegionDef } from '../types.ts'
import { CONTENT } from '../content/index.ts'
import { buildCave, placeMouth, type BuiltCave } from './caves.ts'
import { propDoor } from './collision.ts'
import { computeEncounters } from './encounters.ts'
import { F_KEEP, F_RESERVED, F_PATH, F_GATE, addFlag, fmt, idx } from './grid.ts'
import { uniqueName } from './lore.ts'
import { rngFor } from './random.ts'
import type { CaveEndSpec, CaveSpec, DungeonStyle, Vec2 } from './schema.ts'
import type { Site } from './sites.ts'
import { addAnchor, type AnchorMap, type OwCtx } from './ctx.ts'
import type { WorldContent } from './data.ts'
import { placeSign } from './towns.ts'

export interface BuiltDungeon {
  site: Site
  id: string
  nameZh: string
  style: DungeonStyle
  floors: BuiltCave[]
  /** Overworld tile in front of the mouth (set by linkDungeons). */
  mouth: { x: number; y: number } | null
  /** Index into the overworld's signs of the mouth sign (text filled once levels are known). */
  sign: number
}

const SIDES: CaveEndSpec['side'][] = ['north', 'south', 'east', 'west']

export function buildDungeons(seed: number, wc: WorldContent, sites: Site[], owId: string, used: Set<string>): BuiltDungeon[] {
  const dg = wc.dungeons
  const out: BuiltDungeon[] = []
  for (const site of sites) {
    if (site.kind !== 'dungeon') continue
    const style = dg.styles.find((s) => s.id === site.template)
    if (!style) continue
    const rng = rngFor(seed, `dungeon-${site.id}`)
    const biome = CONTENT.biomes[site.biome]?.id ?? 'meadow'
    const nameZh = uniqueName(style.names, wc.pois.lore, biome, rng, used)
    const nFloors = rng.int(dg.floors[0], dg.floors[1])
    const floors: BuiltCave[] = []
    for (let k = 1; k <= nFloors; k++) {
      const w = rng.int(style.size[0][0], style.size[0][1]), h = rng.int(style.size[1][0], style.size[1][1])
      const upSide = rng.pick(SIDES)
      const downSide = rng.pick(SIDES.filter((s) => s !== upSide))
      const ends: CaveEndSpec[] = [{ id: 'up', side: upSide, at: 0.2 + rng.next() * 0.6, region: '', near: [site.x, site.y] }]
      if (k < nFloors) ends.push({ id: 'down', side: downSide, at: 0.2 + rng.next() * 0.6, region: '', near: [site.x, site.y] })
      const spec: CaveSpec = {
        id: `${site.id}-b${k}`, nameZh: fmt(dg.floorName, { name: nameZh, floor: k }), w, h,
        algo: style.algo, walk: style.walk,
        biome: style.habitats[0] ?? biome, habitats: style.habitats, music: style.music, weather: style.weather,
        levelRange: [1, 1], encounterRate: dg.encounterRate, roamingDensity: dg.roamingDensity,
        floor: style.floor, wall: style.wall, wallElev: style.wallElev, mat: style.mat,
        fill: style.fill, iterations: style.iterations, birth: style.birth, survive: style.survive, tunnelRadius: style.tunnelRadius,
        tunnelNoise: { ...dg.tunnelNoise, salt: `${dg.tunnelNoise.salt}-${site.id}-${k}` }, tunnelCost: style.tunnelCost,
        accents: style.accents, props: style.props, ends,
        endProps: ends.map((e) => (e.id === 'down' ? dg.stairsProp : null)),
        spots: dg.spotsPerFloor + (k === nFloors ? 1 : 0), items: dg.items, minFloor: dg.minFloor,
      }
      floors.push(buildCave(spec, seed, owId))
    }
    // Stairs between floors (down end of k <-> up end of k + 1).
    for (let k = 0; k + 1 < floors.length; k++) {
      const a = floors[k], b = floors[k + 1]
      const down = a.ends[1], up = b.ends[0]
      a.draft.warps.push({ x: down.exit.x, y: down.exit.y, toMap: b.spec.id, toX: up.arrive.x, toY: up.arrive.y, facing: up.facing, kind: 'stairs' })
      b.draft.warps.push({ x: up.exit.x, y: up.exit.y, toMap: a.spec.id, toX: down.arrive.x, toY: down.arrive.y, facing: down.facing, kind: 'stairs' })
    }
    out.push({ site, id: site.id, nameZh, style, floors, mouth: null, sign: -1 })
  }
  return out
}

/**
 * Places each dungeon's overworld mouth (cliff preferred, trail to the path network) and links its warps.
 * Returns the linked dungeons; one without a connectable mouth spot is dropped (its floors are never added).
 */
export function linkDungeons(ctx: OwCtx, dungeons: BuiltDungeon[]): BuiltDungeon[] {
  const { d } = ctx
  const out: BuiltDungeon[] = []
  for (const dn of dungeons) {
    const zone = ctx.wc.regions[dn.site.zone]
    const end: CaveEndSpec = { id: 'mouth', side: 'north', at: 0, region: zone.id, near: [dn.site.x, dn.site.y] }
    const p = placeMouth(ctx, end, dn.site.zone)
    if (!p) continue
    out.push(dn)
    const door = propDoor(p)!
    const first = dn.floors[0]
    const up = first.ends[0]
    d.warps.push({ x: door.x, y: door.y, toMap: first.spec.id, toX: up.arrive.x, toY: up.arrive.y, facing: up.facing, kind: 'cave' })
    first.draft.warps.push({ x: up.exit.x, y: up.exit.y, toMap: d.id, toX: door.front.x, toY: door.front.y, facing: door.facing, kind: 'cave' })
    addFlag(d, idx(d, door.x, door.y), F_RESERVED)
    addFlag(d, idx(d, door.front.x, door.front.y), F_RESERVED | F_KEEP)
    dn.mouth = { ...door.front }
    const off = ctx.spec.caveSignOffset
    const forbid = F_PATH | F_RESERVED | F_KEEP | F_GATE
    const before = d.signs.length
    if (placeSign(ctx, door.front.x - off, door.front.y, dn.nameZh, 'sign', forbid) || placeSign(ctx, door.front.x + off, door.front.y, dn.nameZh, 'sign', forbid)) dn.sign = before
    addAnchor(ctx.anchors, ctx.problems, `dungeon:${dn.id}:mouth`, d.id, door.front.x, door.front.y)
  }
  return out
}

/** Regions, encounter tables, anchors and the mouth sign text once the surface level at the mouth is known. */
export function finishDungeons(wc: WorldContent, seed: number, dungeons: BuiltDungeon[], surfaceLevel: (dn: BuiltDungeon) => Vec2, anchors: AnchorMap, problems: string[], signs: { text: string }[]): void {
  const dg = wc.dungeons
  for (const dn of dungeons) {
    const base = surfaceLevel(dn)
    const maxLevel = CONTENT.config.party.maxLevel
    dn.floors.forEach((f, k) => {
      const bonus = (k + 1) * dg.levelPerFloor
      const levelRange: Vec2 = [Math.min(maxLevel, base[0] + bonus), Math.min(maxLevel, base[1] + bonus)]
      f.spec.levelRange = levelRange
      const region: RegionDef = {
        id: f.spec.id, nameZh: f.spec.nameZh, biome: f.spec.biome, music: f.spec.music, weather: f.spec.weather,
        encounters: computeEncounters({ key: f.spec.id, biomes: f.spec.habitats, fallback: [f.spec.biome], levelRange, rareBoost: dg.rareBoost }, wc.world.encounters, seed),
        encounterRate: f.spec.encounterRate, roamingDensity: f.spec.roamingDensity, levelRange,
      }
      Object.assign(region, { danger: k + 1 })
      f.draft.regions = [region]
      const floor = k + 1
      addAnchor(anchors, problems, `dungeon:${dn.id}:floor${floor}:entrance`, f.spec.id, f.ends[0].arrive.x, f.ends[0].arrive.y)
      const last = k === dn.floors.length - 1
      f.spots.forEach((s, n) => {
        if (last && n === 0) addAnchor(anchors, problems, `dungeon:${dn.id}:floor${floor}:boss`, f.spec.id, s.x, s.y)
        else addAnchor(anchors, problems, `dungeon:${dn.id}:floor${floor}:spot:${last ? n : n + 1}`, f.spec.id, s.x, s.y)
      })
    })
    if (dn.sign >= 0) {
      const lv = dn.floors[0].spec.levelRange
      signs[dn.sign].text = fmt(wc.world.text.dungeonSign, { dungeon: dn.nameZh, floors: dn.floors.length, level: lv[0] })
    }
  }
}
