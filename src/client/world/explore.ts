// Exploration of the (infinite) overworld: sparse fog of war persisted in SaveData.explored, distance records and
// milestones (SaveData.maxDistance), discovered places (SaveData.discoveredPlaces) + fly targets, place lookup
// across the core and the frontier, safe landing tiles and the danger-star region banner. Tunables:
// content/explore.json; strings: content/text/zh-CN/world.json "frontier".
import type { GameMap, RegionDef, SaveData, TownDef, World } from '../../shared/types.ts'
import { CONTENT, t } from '../../shared/content/index.ts'
import { collisionField, getMap, isInfinite, terrainAt, warpAt, worldOrigin } from '../../shared/world/worldapi.ts'
import { parseFrontierId } from '../../shared/world/frontier/sites.ts'
import { decodeBits, FogPages, fogGrid } from '../ui/fog.ts'
import { EXPLORE, type PlaceKind } from './explore-config.ts'

// ---------------------------------------------------------------------------------------------- fog pages

const FOG = new WeakMap<SaveData, FogPages>()

/** The overworld (start map) — the only map that may be infinite. */
export function overworldOf(world: World): GameMap | null {
  return world.maps[world.startMap] ?? null
}

/**
 * Explored cells of the overworld for a save (decoded once, cached per save object). Older saves kept a finite
 * bitset in exploredChunks[overworld]; it is merged in on first use.
 */
export function fogPagesFor(save: SaveData, world: World): FogPages {
  let f = FOG.get(save)
  if (f) return f
  const cell = CONTENT.config.world.chunk
  f = FogPages.decode(save.explored, cell, EXPLORE.fog.pageCells, EXPLORE.fog.maxPages) ?? new FogPages(cell, EXPLORE.fog.pageCells)
  const ow = overworldOf(world)
  const legacy = ow ? save.exploredChunks[ow.id] : undefined
  if (ow && legacy) {
    const g = fogGrid(ow.width, ow.height, cell)
    const bits = decodeBits(legacy, g.bytes)
    if (bits) f.importGrid(bits, g)
  }
  FOG.set(save, f)
  return f
}

/** Writes the fog pages into save.explored (the legacy overworld bitset is folded in and dropped). */
export function storeFogPages(save: SaveData, world: World): void {
  const f = FOG.get(save)
  if (!f) return
  save.explored = f.encode()
  const ow = overworldOf(world)
  if (ow && isInfinite(ow)) delete save.exploredChunks[ow.id]
}

// ---------------------------------------------------------------------------------------------- places

const PLACE_MEMO = new WeakMap<World, Map<string, TownDef | null>>()
const DUNGEONS = new WeakMap<World, Set<string>>()

/** A place (story town, hamlet, landmark, dungeon mouth) of the core or the frontier by id, or null. */
export function resolvePlace(world: World, id: string): TownDef | null {
  let memo = PLACE_MEMO.get(world)
  if (!memo) { memo = new Map(); PLACE_MEMO.set(world, memo) }
  if (memo.has(id)) return memo.get(id) ?? null
  let place: TownDef | null = world.towns.find((tw) => tw.id === id) ?? null
  if (!place && parseFrontierId(id)) {
    for (const key in world.maps) {
      const p = world.maps[key].infinite
      if (!p) continue
      place = p.place(id)
      if (place) break
    }
  }
  memo.set(id, place)
  return place
}

/** Display kind: story town / hamlet / landmark, or dungeon for dungeon mouths (core and frontier). */
export function placeKindOf(world: World, place: Pick<TownDef, 'id' | 'kind'>): PlaceKind {
  const fx = parseFrontierId(place.id)
  if (fx) return fx.kind === 'dungeon' ? 'dungeon' : place.kind ?? 'landmark'
  let set = DUNGEONS.get(world)
  if (!set) {
    // Core dungeon floors are cave maps named after their site id ('<site>-…').
    set = new Set<string>()
    const caves = Object.values(world.maps).filter((m) => m.kind === 'cave')
    for (const tw of world.towns) if (caves.some((m) => m.id.startsWith(`${tw.id}-`))) set.add(tw.id)
    DUNGEONS.set(world, set)
  }
  return set.has(place.id) ? 'dungeon' : place.kind ?? 'town'
}

/** Story towns need a visit; hamlets / landmarks / dungeons (explore.json discover.flyKinds) need discovery. */
export function isFlyTarget(world: World, save: SaveData, place: TownDef): boolean {
  if (save.visitedTowns.includes(place.id)) return true
  const kind = placeKindOf(world, place)
  if (kind === 'town') return false
  return EXPLORE.discover.flyKinds.includes(kind) && (save.discoveredPlaces ?? []).includes(place.id)
}

/** Places shown on the world map: visited story towns, discovered places, and known towns of explored cells. */
export function knownPlaces(world: World, save: SaveData, fog: FogPages): TownDef[] {
  const out = new Map<string, TownDef>()
  const ow = world.startMap
  for (const tw of world.towns) {
    if (tw.map !== ow) continue
    if (save.visitedTowns.includes(tw.id) || (save.discoveredPlaces ?? []).includes(tw.id) || fog.tileExplored(tw.x, tw.y)) out.set(tw.id, tw)
  }
  for (const id of [...(save.discoveredPlaces ?? []), ...save.visitedTowns]) {
    if (out.has(id)) continue
    const p = resolvePlace(world, id)
    if (p && p.map === ow) out.set(id, p)
  }
  return [...out.values()]
}

/** Tile to land on near (x, y): flySpawn region tile when free, else the nearest walkable, free, non-warp tile. */
export function findLanding(map: GameMap, x: number, y: number, radius = EXPLORE.landing.searchRadius): { x: number; y: number } | null {
  const field = collisionField(map)
  const ok = (tx: number, ty: number) => {
    if (field.at(tx, ty) !== 0 || warpAt(map, tx, ty)) return false
    const tt = CONTENT.terrain[terrainAt(map, tx, ty)]
    return !!tt?.walkable && !tt.stairs && !tt.ledge && !tt.liquid
  }
  const cx = Math.floor(x), cy = Math.floor(y)
  for (let r = 0; r <= radius; r++) {
    let best: { x: number; y: number } | null = null
    let bd = Infinity
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r || !ok(cx + dx, cy + dy)) continue
      const d = dx * dx + dy * dy
      if (d < bd) { bd = d; best = { x: cx + dx, y: cy + dy } }
    }
    if (best) return best
  }
  return null
}

/** Where flying to a place lands: the town region's flySpawn (core or frontier hamlet), else near the place. */
export function flyLanding(world: World, place: TownDef): { map: GameMap; x: number; y: number } | null {
  const map = getMap(world, place.map)
  if (!map) return null
  const spawn = map.regions.find((r) => r.townId === place.id && r.flySpawn)?.flySpawn ?? map.infinite?.region(place.id)?.flySpawn
  const at = findLanding(map, spawn?.x ?? place.x, spawn?.y ?? place.y)
  return at ? { map, ...at } : null
}

// ---------------------------------------------------------------------------------------------- banner

/** "★★☆☆☆☆" for a danger tier (0-based). */
export function dangerStars(danger: number): string {
  const B = EXPLORE.banner
  const on = Math.max(1, Math.min(B.dangerTiers, Math.floor(danger) + 1))
  return B.starOn.repeat(on) + B.starOff.repeat(Math.max(0, B.dangerTiers - on))
}

/** Banner subtitle of a region: town description, else danger stars + level band. */
export function regionSubtitle(world: World, r: RegionDef): string | undefined {
  if (r.isTown && r.townId) return resolvePlace(world, r.townId)?.description
  const levels = r.levelRange ? t('world.banner.levels', { min: r.levelRange[0], max: r.levelRange[1] }) : ''
  if (r.danger === undefined || (EXPLORE.banner.wildOnly && r.isTown)) return levels || undefined
  return t('world.frontier.bannerSub', { stars: dangerStars(r.danger), danger: r.danger + 1, levels })
}

// ---------------------------------------------------------------------------------------------- explorer

export interface ExplorerHooks {
  toast(text: string, kind?: 'info' | 'success' | 'warn' | 'error'): void
  banner(title: string, subtitle?: string): void
  sfx(id: string): void
}

/** Per-session exploration bookkeeping (distance records, milestones, place discovery). */
export function createExplorer(world: World, save: () => SaveData, hooks: ExplorerHooks) {
  const origin = worldOrigin(world)
  const isOverworld = (m: GameMap) => m.id === world.startMap

  /** Distance record + milestones; call when the player enters a tile of `map`. */
  function onTile(map: GameMap, x: number, y: number): void {
    if (!isOverworld(map)) return
    const s = save()
    const d = Math.floor(Math.hypot(x + 0.5 - origin.x, y + 0.5 - origin.y))
    const prev = s.maxDistance
    if (prev === undefined) { s.maxDistance = d; return }
    if (d <= prev) return
    s.maxDistance = d
    const M = EXPLORE.milestones
    const hit = M.distances.filter((m) => prev < m && m <= d)
    if (!hit.length) return
    const m = hit[hit.length - 1]
    hooks.sfx(M.sfx)
    hooks.toast(t('world.frontier.milestone', { distance: m }), 'success')
    if (M.banner) hooks.banner(t('world.frontier.milestoneTitle', { distance: m }), t('world.frontier.milestoneSub', { distance: m }))
  }

  /** Marks places within discover.radius as discovered (toast for announceKinds). */
  function discover(map: GameMap, places: readonly TownDef[], px: number, py: number): void {
    if (!isOverworld(map) || !places.length) return
    const s = save()
    const D = EXPLORE.discover
    for (const p of places) {
      if (Math.hypot(p.x + 0.5 - px, p.y + 0.5 - py) > D.radius) continue
      const list = s.discoveredPlaces ?? (s.discoveredPlaces = [])
      if (list.includes(p.id)) continue
      if (list.length >= D.maxSaved) return
      list.push(p.id)
      const kind = placeKindOf(world, p)
      if (!D.announceKinds.includes(kind)) continue
      hooks.sfx(D.sfx)
      hooks.toast(t('world.frontier.discovered', { place: p.nameZh, kind: t(`world.frontier.kind.${kind}`) }), 'info')
    }
  }

  return { onTile, discover }
}

export type Explorer = ReturnType<typeof createExplorer>
