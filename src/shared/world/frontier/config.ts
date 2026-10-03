// Loader for content/world/frontier/*.json — the only place frontier data enters the code. Everything is
// resolved to numeric ids / indices once per process (terrain ids, CONTENT.biomes indices, rule tables).
import type { RarityBehavior } from '../../types.ts'
import { CONTENT } from '../../content/index.ts'
import { WORLD_CONTENT } from '../data.ts'
import type { BiomeScatter, PoisFile } from '../schema.ts'
import type { ClimateRule, FrontierBiomeSpec, FrontierBiomesFile, FrontierDecorFile, FrontierGen, FrontierNamesFile, FrontierSitesFile } from './schema.ts'

import genJson from '../../../../content/world/frontier/gen.json' with { type: 'json' }
import biomesJson from '../../../../content/world/frontier/biomes.json' with { type: 'json' }
import sitesJson from '../../../../content/world/frontier/sites.json' with { type: 'json' }
import namesJson from '../../../../content/world/frontier/names.json' with { type: 'json' }
import decorJson from '../../../../content/world/frontier/decor.json' with { type: 'json' }

export interface FrontierContent {
  gen: FrontierGen
  biomes: FrontierBiomesFile
  sites: FrontierSitesFile
  names: FrontierNamesFile
  decor: FrontierDecorFile
}

export const FRONTIER_CONTENT: FrontierContent = {
  gen: genJson as unknown as FrontierGen,
  biomes: biomesJson as unknown as FrontierBiomesFile,
  sites: sitesJson as unknown as FrontierSitesFile,
  names: namesJson as unknown as FrontierNamesFile,
  decor: decorJson as unknown as FrontierDecorFile,
}

const tidCache = new Map<string, number>()
export function tid(key: string): number {
  let v = tidCache.get(key)
  if (v === undefined) {
    const t = CONTENT.terrainByKey[key]
    if (!t) throw new Error(`frontier: unknown terrain key "${key}"`)
    v = t.id
    tidCache.set(key, v)
  }
  return v
}

export function biomeIndex(id: string): number {
  const i = CONTENT.biomes.findIndex((b) => b.id === id)
  if (i < 0) throw new Error(`frontier: unknown biome "${id}"`)
  return i
}

/** Climate rule compiled to flat ranges (index into CONTENT.biomes). */
export interface CompiledRule {
  biome: number
  /** [lo, hi] per channel: t m w level inland rugged volcanic mountain (NaN-free; open ranges are ±Infinity). */
  r: Float64Array
  shallow?: boolean
}

export const RULE_CHANNELS = ['t', 'm', 'w', 'level', 'inland', 'rugged', 'volcanic', 'mountain'] as const

function compileRule(rule: ClimateRule & { shallow?: boolean }): CompiledRule {
  const r = new Float64Array(RULE_CHANNELS.length * 2)
  RULE_CHANNELS.forEach((k, i) => {
    const v = rule[k]
    r[i * 2] = v ? v[0] : -Infinity
    r[i * 2 + 1] = v ? v[1] : Infinity
  })
  return { biome: biomeIndex(rule.biome), r, shallow: rule.shallow }
}

export interface BiomeTables {
  spec: FrontierBiomeSpec
  scatter: BiomeScatter
  ground: number
  beach: number
  ledge: number
  road: number
}

export interface CompiledFrontier {
  fc: FrontierContent
  rules: CompiledRule[]
  seaRules: CompiledRule[]
  /** Per CONTENT.biomes index (undefined for biomes without frontier data). */
  biome: (BiomeTables | undefined)[]
  water: number
  shallow: number
  bridge: number
  stairs: number
  roadDefault: number
  causeway: number
  /** pois.json lore merged with the frontier lore (biome adjectives for the new biomes). */
  lore: PoisFile['lore']
  rarity: Record<string, RarityBehavior>
}

let COMPILED: CompiledFrontier | null = null

export function compiledFrontier(): CompiledFrontier {
  if (COMPILED) return COMPILED
  const fc = FRONTIER_CONTENT
  const biome: (BiomeTables | undefined)[] = CONTENT.biomes.map((b) => {
    const spec = fc.biomes.biomes[b.id]
    const scatter = WORLD_CONTENT.scatter.biomes[b.id]
    if (!spec || !scatter) return undefined
    return { spec, scatter, ground: tid(scatter.ground), beach: tid(spec.beach), ledge: tid(spec.ledge), road: tid(spec.road) }
  })
  const pl = WORLD_CONTENT.pois.lore
  const fl = fc.sites.lore
  const lore: PoisFile['lore'] = {
    templates: { ...pl.templates, ...fl.templates },
    words: { ...pl.words, ...fl.words },
    biomeWords: { ...pl.biomeWords, ...fl.biomeWords, ...fc.names.biomeWords },
  }
  const rarity: Record<string, RarityBehavior> = {}
  for (const r of CONTENT.rarities) {
    const b = r.behavior ?? fc.gen.rarityDefaults[r.id]
    if (b) rarity[r.id] = b
  }
  COMPILED = {
    fc,
    rules: fc.biomes.rules.map(compileRule),
    seaRules: fc.biomes.seaRules.map(compileRule),
    biome,
    water: tid(WORLD_CONTENT.world.overworld.seaTerrain),
    shallow: tid(WORLD_CONTENT.world.overworld.seaShallowTerrain),
    bridge: tid(fc.gen.roads.bridge),
    stairs: tid(fc.gen.roads.stairs),
    roadDefault: tid(fc.gen.roads.terrain),
    causeway: tid(fc.gen.causeways.terrain),
    lore,
    rarity,
  }
  return COMPILED
}

/** Piecewise-linear lookup over [x, y] points (clamped at both ends). */
export function curve(points: readonly (readonly [number, number])[], x: number): number {
  if (!points.length) return 1
  if (x <= points[0][0]) return points[0][1]
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i]
    if (x <= x1) {
      const [x0, y0] = points[i - 1]
      return y0 + (y1 - y0) * ((x - x0) / (x1 - x0 || 1))
    }
  }
  return points[points.length - 1][1]
}
