// Frontier regions = (province x biome). Provinces are warped Voronoi cells over a jittered point grid
// (gen.provinces); each gets a procedural name, a danger tier and a level band from its distance to the origin
// (gen.levels). Encounter tables come from species habitats (biome.encounterHabitats) x rarity weights; tiers
// enter a table only from RarityBehavior.minDistance on and only if they spawn in the wild ('grass' / 'visible').
// The per-encounter distance multiplier (distanceWeightPer1000) and the grass/visible tier multipliers are
// applied at spawn time by src/shared/gameplay/spawns.ts, so they are deliberately not baked in here.
import type { EncounterSlot, FieldWeatherKind, RarityDef, RegionDef } from '../../types.ts'
import { CONTENT, type Content } from '../../content/index.ts'
import { computeEncounters } from '../encounters.ts'
import { fmt } from '../grid.ts'
import { hash3, rngFor } from '../random.ts'
import type { Vec2 } from '../schema.ts'
import { curve } from './config.ts'
import type { Fields } from './fields.ts'
import { Lru } from './lru.ts'

export interface Province { px: number; py: number; x: number; y: number }

export function provincePoint(F: Fields, px: number, py: number): Province {
  const P = F.cf.fc.gen.provinces
  const j = P.jitter * P.cell
  const h = hash3(F.seed ^ 0x51f15e, px, py)
  const ox = ((h & 0xffff) / 65536 - 0.5) * j, oy = ((h >>> 16) / 65536 - 0.5) * j
  return { px, py, x: Math.round((px + 0.5) * P.cell + ox), y: Math.round((py + 0.5) * P.cell + oy) }
}

/** Province points of every cell that can own a tile of the rect (warp + jitter reach). */
export function provincesNear(F: Fields, x0: number, y0: number, x1: number, y1: number): Province[] {
  const P = F.cf.fc.gen.provinces
  const pad = P.warp.amplitude + P.cell
  const out: Province[] = []
  for (let py = Math.floor((y0 - pad) / P.cell); py <= Math.floor((y1 + pad) / P.cell); py++) {
    for (let px = Math.floor((x0 - pad) / P.cell); px <= Math.floor((x1 + pad) / P.cell); px++) out.push(provincePoint(F, px, py))
  }
  return out
}

/** Index into `provs` of the province owning the (warped) tile. */
export function nearestProvince(provs: Province[], wx: number, wy: number): number {
  let best = 0, bd = Infinity
  for (let k = 0; k < provs.length; k++) {
    const dx = provs[k].x - wx, dy = provs[k].y - wy
    const d = dx * dx + dy * dy
    if (d < bd) { bd = d; best = k }
  }
  return best
}

export function regionId(px: number, py: number, biome: string): string { return `fr:${px}:${py}:${biome}` }

export function parseRegionId(id: string): { px: number; py: number; biome: string } | null {
  if (!id.startsWith('fr:')) return null
  const p = id.split(':')
  if (p.length !== 4) return null
  const px = Number(p[1]), py = Number(p[2])
  if (!Number.isInteger(px) || !Number.isInteger(py) || !CONTENT.biomeById[p[3]]) return null
  return { px, py, biome: p[3] }
}

export function provinceName(F: Fields, px: number, py: number): string {
  const n = F.cf.fc.names.province
  const rng = rngFor(F.seed, `fx-prov-name-${px}-${py}`)
  return fmt(rng.pick(n.patterns), { a: rng.pick(n.first), b: rng.pick(n.second) })
}

export function dangerAt(F: Fields, dist: number): number {
  const L = F.cf.fc.gen.levels
  let d = 0
  for (let i = 0; i < L.dangerDistances.length; i++) if (dist >= L.dangerDistances[i]) d = i
  return d
}

export function levelRangeAt(F: Fields, dist: number, danger: number): Vec2 {
  const L = F.cf.fc.gen.levels
  const maxLevel = CONTENT.config.party.maxLevel
  const mid = curve(L.curve as [number, number][], dist) + (L.dangerLevelBonus[danger] ?? 0)
  const lo = Math.max(1, Math.min(maxLevel, Math.round(mid - L.span / 2)))
  const hi = Math.max(lo, Math.min(maxLevel, Math.round(mid + L.span / 2)))
  return [lo, hi]
}

/** Content view without the rarity tiers that cannot spawn in the wild at this distance. */
export function rarityView(F: Fields, dist: number): Content {
  const rarityById: Record<string, RarityDef> = {}
  for (const r of CONTENT.rarities) {
    const b = F.cf.rarity[r.id]
    const wild = !b || ((b.spawn.includes('grass') || b.spawn.includes('visible')) && dist >= b.minDistance)
    rarityById[r.id] = wild ? r : { ...r, encounterWeight: 0 }
  }
  return { ...CONTENT, rarityById }
}

export class RegionTable {
  private readonly F: Fields
  private readonly cache: Lru<string, RegionDef>

  constructor(F: Fields) {
    this.F = F
    this.cache = new Lru(F.cf.fc.gen.cache.regions)
  }

  get(id: string): RegionDef | null {
    const hit = this.cache.get(id)
    if (hit) return hit
    const p = parseRegionId(id)
    if (!p) return null
    const r = this.build(id, p.px, p.py, p.biome)
    this.cache.set(id, r)
    return r
  }

  /** Cached region built by `make` (hamlet town regions, nests). */
  memo(id: string, make: () => RegionDef): RegionDef {
    const hit = this.cache.get(id)
    if (hit) return hit
    const r = make()
    this.cache.set(id, r)
    return r
  }

  /** A boosted region for a rare-spawn nest (POI 'nest' tiles) at `dist` tiles from the origin. */
  nest(id: string, base: RegionDef, nest: { rareBoost: number; levelBonus: number; encounterRate: number }, nameZh: string, dist: number): RegionDef {
    return this.memo(id, () => {
      const maxLevel = CONTENT.config.party.maxLevel
      const lr = base.levelRange ?? [1, 1]
      const levelRange: Vec2 = [Math.min(maxLevel, lr[0] + nest.levelBonus), Math.min(maxLevel, lr[1] + nest.levelBonus)]
      const danger = (base.danger ?? 0) + this.F.cf.fc.gen.levels.nestDangerBonus
      return { ...base, id, nameZh, danger, levelRange, encounterRate: nest.encounterRate, encounters: this.encounters(id, base.biome, levelRange, dist, nest.rareBoost) }
    })
  }

  encounters(key: string, biome: string, levelRange: Vec2, dist: number, rareBoost: number): EncounterSlot[] {
    const F = this.F
    const habitats = CONTENT.biomeById[biome]?.encounterHabitats ?? [biome]
    const rules = F.cf.fc.gen.encounters
    return computeEncounters({ key, biomes: habitats, fallback: habitats.slice(0, 1), levelRange, rareBoost }, rules, F.seed, rarityView(F, dist))
  }

  private build(id: string, px: number, py: number, biome: string): RegionDef {
    const F = this.F
    const pv = provincePoint(F, px, py)
    const dist = F.originDist(pv.x, pv.y)
    const danger = dangerAt(F, dist)
    const levelRange = levelRangeAt(F, dist, danger)
    const spec = F.cf.fc.biomes.biomes[biome] // present for every biome (validateFrontierContent)
    const L = F.cf.fc.gen.levels
    const rng = rngFor(F.seed, `fx-region-${id}`)
    const names = F.cf.fc.names.region
    const pattern = rng.pick(names.byBiome[biome] ?? names.fallback)
    const nameZh = fmt(pattern, { p: provinceName(F, px, py) })
    let weather: FieldWeatherKind | undefined
    if (spec.weather.length) weather = rng.weighted(spec.weather, (w) => w[1])[0]
    const rareBoost = L.rareBoost[danger] ?? 1
    return {
      id, nameZh, biome, danger,
      music: spec.music,
      encounters: this.encounters(id, biome, levelRange, dist, rareBoost),
      encounterRate: spec.encounterRate * (L.encounterRate[danger] / L.encounterRate[0]),
      roamingDensity: spec.roaming * (L.roaming[danger] / L.roaming[0]),
      weather,
      levelRange,
    }
  }
}

