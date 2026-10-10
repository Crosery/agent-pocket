// Shared state threaded through the overworld generation stages.
import type { Dir } from '../types.ts'
import { CONTENT, terrainId } from '../content/index.ts'
import type { WorldContent } from './data.ts'
import type { MapDraft } from './grid.ts'
import type { Macro } from './macro.ts'
import type { BiomeScatter, OverworldSpec } from './schema.ts'
import type { DoorInfo } from './collision.ts'

export interface AnchorPoint { map: string; x: number; y: number }
export type AnchorMap = Record<string, AnchorPoint>

/** A building door on the overworld that leads into one or more interior floors. */
export interface DoorLink {
  townId: string
  townNameZh: string
  slot: string
  /** Interior template id per floor (bottom first). */
  floors: string[]
  /** Map id per floor. */
  mapIds: string[]
  /** How many of the last `floors` lie below the ground floor (the first entry). */
  belowCount: number
  door: DoorInfo
  biome: string
  nameZh?: string
}

/** Exit of a stamped town: `x,y` is the edge tile, `out` the first tile outside the template. */
export interface TownExit { x: number; y: number; out: { x: number; y: number }; dir: Dir }

export interface OwCtx {
  seed: number
  wc: WorldContent
  spec: OverworldSpec
  d: MapDraft
  macro: Macro
  regionIdx: Map<string, number>
  anchors: AnchorMap
  doors: DoorLink[]
  /** Non-fatal generation issues; surfaced by tests. */
  problems: string[]
  /** Distance to the path network (search heuristic for connector trails; refreshed between stages). */
  pathHeur?: Uint16Array
}

const terrainCache = new Map<string, number>()
export function tid(key: string): number {
  let v = terrainCache.get(key)
  if (v === undefined) { v = terrainId(key); terrainCache.set(key, v) }
  return v
}

export function addAnchor(anchors: AnchorMap, problems: string[], name: string, map: string, x: number, y: number): void {
  if (anchors[name]) { problems.push(`duplicate anchor "${name}"`); return }
  anchors[name] = { map, x, y }
}

/** Scatter rules of the tile's biome (per-tile climate biome in the wilds, the zone biome in the core). */
export function biomeOf(ctx: OwCtx, i: number): BiomeScatter {
  const biome = CONTENT.biomes[ctx.macro.biome[i]]?.id ?? ctx.wc.regions[ctx.macro.wild[i]].biome
  const b = ctx.wc.scatter.biomes[biome]
  if (!b) throw new Error(`scatter.json: no rules for biome "${biome}"`)
  return b
}

export function isWalkableTerrain(id: number): boolean { return CONTENT.terrain[id]?.walkable === true }
export function isSwimTerrain(id: number): boolean { return CONTENT.terrain[id]?.swim === true }
export function isStairsTerrain(id: number): boolean { return CONTENT.terrain[id]?.stairs === true }
