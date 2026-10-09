// Teleport anchors on the client: names and regions of anchor spots, the destination list of the picker / world
// map, the travel gate, landing tiles and the save bookkeeping (unlock / seen). Tuning: content/world/anchors.json
// (placement, kinds, naming) and content/game.json anchorTravel (who may travel); strings: content/text/zh-CN.
import type { GameMap, SaveData, TownDef, World } from '../../shared/types.ts'
import { CONTENT, t } from '../../shared/content/index.ts'
import { WORLD_CONTENT } from '../../shared/world/data.ts'
import { anchorSpotFromId, homeAnchor, type AnchorSpot } from '../../shared/world/anchors.ts'
import { hashString } from '../../shared/world/random.ts'
import { regionUnder } from '../ui/worldgeo.ts'
import { GAME } from './config.ts'
import { findLanding, placeKindOf } from './explore.ts'
import { ownedKeyItem } from './save-ops.ts'
import { EXPLORE, type PlaceKind } from './explore-config.ts'

const NAMES = WORLD_CONTENT.anchors.naming
const overworld = (world: World): GameMap => world.maps[world.startMap]

export type DestKind = 'home' | 'grand' | 'minor' | 'town' | 'hamlet' | 'landmark' | 'dungeon'

export interface TravelDest {
  /** Anchor id (`anchor:…`) or place id. */
  id: string
  kind: DestKind
  name: string
  region: string
  /** Where it is (anchors: footprint centre). */
  x: number
  y: number
  /** Tiles from the player. */
  dist: number
  /** The anchor the player is standing at (picker opened from it). */
  here: boolean
}

// ---------------------------------------------------------------------------------------------- names

type FrontierPlaces = { placesIn?(x0: number, y0: number, x1: number, y1: number): TownDef[] }

/** Places (core towns / hamlets / landmarks and frontier sites) within `r` tiles of (x, y). */
function placesNear(world: World, x: number, y: number, r: number): TownDef[] {
  const out = new Map<string, TownDef>()
  for (const p of world.towns) if (Math.abs(p.x - x) <= r && Math.abs(p.y - y) <= r) out.set(p.id, p)
  const fp = overworld(world).infinite as unknown as FrontierPlaces | undefined
  for (const p of fp?.placesIn?.(x - r, y - r, x + r, y + r) ?? []) out.set(p.id, p)
  return [...out.values()]
}

const PLACE_MEMO = new WeakMap<World, Map<string, TownDef | null>>()
const NAME_MEMO = new WeakMap<World, Map<string, string>>()
const GROUP_MEMO = new WeakMap<World, Map<string, string>>()

const memoOf = <T>(store: WeakMap<World, Map<string, T>>, world: World): Map<string, T> => {
  let m = store.get(world)
  if (!m) { m = new Map(); store.set(world, m) }
  return m
}

/** The town / hamlet / landmark / dungeon mouth an anchor belongs to (nearest within the naming radius), or null in the wild. */
export function anchorPlace(world: World, spot: AnchorSpot): TownDef | null {
  const memo = memoOf(PLACE_MEMO, world)
  if (memo.has(spot.id)) return memo.get(spot.id) ?? null
  let best: TownDef | null = null
  let bd = NAMES.radius
  for (const p of placesNear(world, spot.cx, spot.cy, NAMES.radius)) {
    const d = Math.hypot(p.x + 0.5 - spot.cx, p.y + 0.5 - spot.cy)
    if (d <= bd) { bd = d; best = p }
  }
  memo.set(spot.id, best)
  return best
}

/** The place an anchor stands at (its name), else "<region>·<word>". */
export function anchorName(world: World, spot: AnchorSpot): string {
  const memo = memoOf(NAME_MEMO, world)
  const hit = memo.get(spot.id)
  if (hit) return hit
  const place = anchorPlace(world, spot)
  let name: string
  if (place) name = place.nameZh
  else {
    const words = t('world.anchor.words').split('|')
    const r = regionUnder(overworld(world), spot.cx, spot.cy)
    name = t('world.anchor.fallback', { region: r?.nameZh ?? t('world.anchor.wild'), word: words[hashString(spot.id) % words.length] })
  }
  memo.set(spot.id, name)
  return name
}

/** Display kind of the place behind an anchor, for the list tag ("城镇", "村落", ...); null for wild anchors. */
export function anchorPlaceKind(world: World, spot: AnchorSpot): PlaceKind | null {
  const place = anchorPlace(world, spot)
  return place ? placeKindOf(world, place) : null
}

/** Area heading for grouping: the story zone of the core (its roads, towns and wilds share one), else the frontier region. */
export function anchorGroup(world: World, spot: AnchorSpot): string {
  const memo = memoOf(GROUP_MEMO, world)
  const hit = memo.get(spot.id)
  if (hit) return hit
  const map = overworld(world)
  const r = regionUnder(map, spot.cx, spot.cy)
  const zone = r && map.regions.includes(r) ? map.regions.find((z) => z.id === r.biome && !z.isTown) : null
  const name = zone?.nameZh ?? r?.nameZh ?? t('screens.anchor.unknownRegion')
  memo.set(spot.id, name)
  return name
}

// ---------------------------------------------------------------------------------------------- travel gate

/** Whether anchors can be used right now from `mapKind` (separate from the town fly of game.json fly). */
export function canAnchorTravel(save: SaveData, mapKind: GameMap['kind'] | null): boolean {
  const g = GAME.anchorTravel
  if (!mapKind || !g.mapKinds.includes(mapKind) || save.badges.length < g.minBadges) return false
  return !g.keyItemKind || !!ownedKeyItem(save, g.keyItemKind, CONTENT)
}

/** Why anchors do not answer yet (a toast line), or null when they do. */
export function anchorGateMessage(save: SaveData): string | null {
  const g = GAME.anchorTravel
  if (save.badges.length < g.minBadges) return t('world.anchor.needBadges', { badges: g.minBadges })
  if (g.keyItemKind && !ownedKeyItem(save, g.keyItemKind, CONTENT)) {
    const item = CONTENT.itemList.find((it) => it.effect.kind === 'key' && it.effect.key === g.keyItemKind)
    return t('world.anchor.needItem', { item: item?.nameZh ?? g.keyItemKind })
  }
  return null
}

// ---------------------------------------------------------------------------------------------- save bookkeeping

export const unlockedAnchors = (save: SaveData): string[] => save.anchors?.unlocked ?? []
export const isUnlocked = (save: SaveData, id: string): boolean => unlockedAnchors(save).includes(id)

/** Marks an anchor activated (and seen); true when it was new. Oldest entries beyond the save caps are dropped. */
export function unlockAnchor(save: SaveData, id: string): boolean {
  const a = save.anchors ?? (save.anchors = { unlocked: [], seen: [] })
  if (a.unlocked.includes(id)) return false
  a.unlocked.push(id)
  if (!a.seen.includes(id)) a.seen.push(id)
  const cap = WORLD_CONTENT.anchors.save
  if (a.unlocked.length > cap.maxUnlocked) a.unlocked.splice(0, a.unlocked.length - cap.maxUnlocked)
  if (a.seen.length > cap.maxSeen) a.seen.splice(0, a.seen.length - cap.maxSeen)
  return true
}

/** Marks an anchor as discovered (greyed pin on the map); true when it was new. */
export function markSeen(save: SaveData, id: string): boolean {
  const a = save.anchors ?? (save.anchors = { unlocked: [], seen: [] })
  if (a.seen.includes(id)) return false
  a.seen.push(id)
  const cap = WORLD_CONTENT.anchors.save.maxSeen
  if (a.seen.length > cap) a.seen.splice(0, a.seen.length - cap)
  return true
}

// ---------------------------------------------------------------------------------------------- landing

/** Where travelling to an anchor lands: the free tile in front of it, else the nearest free one. */
export function anchorLanding(world: World, spot: AnchorSpot): { map: GameMap; x: number; y: number } | null {
  const map = overworld(world)
  if (!map) return null
  const at = findLanding(map, spot.front.x, spot.front.y, EXPLORE.landing.searchRadius)
  return at ? { map, ...at } : null
}

// ---------------------------------------------------------------------------------------------- destinations

export interface DestinationList {
  /** "回原点": the home anchor, when it is not where the player is. */
  home: TravelDest | null
  groups: { region: string; items: TravelDest[] }[]
  count: number
}

const TAG_OF_PLACE: Partial<Record<PlaceKind, DestKind>> = { town: 'town', hamlet: 'hamlet', landmark: 'landmark', dungeon: 'dungeon' }

/** One activated anchor as a destination (null for ids that no longer parse). */
export function destinationOf(world: World, id: string, from: { x: number; y: number }, hereId?: string): TravelDest | null {
  const spot = anchorSpotFromId(id)
  if (!spot) return null
  const placeKind = spot.kind === 'minor' ? anchorPlaceKind(world, spot) : null
  return {
    id, kind: (placeKind && TAG_OF_PLACE[placeKind]) || spot.kind, name: anchorName(world, spot), region: anchorGroup(world, spot),
    x: spot.cx, y: spot.cy, dist: Math.hypot(spot.cx - from.x, spot.cy - from.y), here: id === hereId,
  }
}

/**
 * Every activated anchor as seen from `from`: the home anchor apart (first), the rest grouped by area - nearest
 * area first, nearest destination first inside an area.
 */
export function travelDestinations(world: World, save: SaveData, from: { x: number; y: number }, hereId?: string): DestinationList {
  const homeId = homeAnchor(world)?.id ?? null
  let home: TravelDest | null = null
  const out: TravelDest[] = []
  for (const id of unlockedAnchors(save)) {
    const dest = destinationOf(world, id, from, hereId)
    if (!dest) continue
    if (id === homeId) { if (!dest.here) home = { ...dest, kind: 'home' }; continue }
    out.push(dest)
  }
  const groups = new Map<string, TravelDest[]>()
  for (const d of out.sort((a, b) => a.dist - b.dist || (a.id < b.id ? -1 : 1))) {
    let list = groups.get(d.region)
    if (!list) { list = []; groups.set(d.region, list) }
    list.push(d)
  }
  return {
    home,
    groups: [...groups.entries()].map(([region, items]) => ({ region, items })).sort((a, b) => a.items[0].dist - b.items[0].dist),
    count: out.length + (home ? 1 : 0),
  }
}

/** Resolves a picked id (anchor or place) to a landing: anchors via their front tile, places via flyLanding. */
export function resolveAnchorTarget(world: World, id: string): { spot: AnchorSpot; name: string } | null {
  const spot = anchorSpotFromId(id)
  return spot ? { spot, name: anchorName(world, spot) } : null
}

