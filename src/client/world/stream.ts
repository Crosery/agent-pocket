// Object streaming around the player. Finite maps expose their full object lists (unchanged behaviour); infinite
// maps (GameMap.infinite) re-query WorldApi.objectsInRect whenever the player moved `stepTiles` from the last
// query centre: objects within `radius + stepTiles` join the live set, live objects anchored farther than
// `despawnRadius` leave it (hysteresis, so walking along the boundary never thrashes actors). Also generates the
// chunk ring ahead of the player and trims the provider caches. Pure (no DOM / three).
import type { GameMap, GroundItemDef, NpcDef, TownDef } from '../../shared/types.ts'
import { isInfinite, objectsInRect } from '../../shared/world/worldapi.ts'
import { EXPLORE, type ExploreTuning } from './explore-config.ts'

export interface ObjectStream {
  /** Starts streaming a map (finite maps: every object is live). */
  reset(map: GameMap): void
  /** Re-queries when needed; true when the live sets changed. */
  update(px: number, py: number, force?: boolean): boolean
  /** Generates up to `prefetchPerFrame` missing chunks of the ring around the player chunk. */
  prefetch(px: number, py: number): void
  /** Periodic cache trim (call every frame with dt). */
  retain(px: number, py: number, dt: number): void
  readonly npcs: readonly NpcDef[]
  readonly items: readonly GroundItemDef[]
  readonly places: readonly TownDef[]
}

const cheb = (o: { x: number; y: number }, cx: number, cy: number) => Math.max(Math.abs(o.x - cx), Math.abs(o.y - cy))

/** Keeps live entries within `keep` of the centre and adds fresh ones (stable order: kept first). */
export function mergeLive<T extends { x: number; y: number }>(live: readonly T[], fresh: readonly T[], id: (t: T) => string, cx: number, cy: number, keep: number): T[] {
  const out: T[] = []
  const seen = new Set<string>()
  for (const o of live) if (cheb(o, cx, cy) <= keep && !seen.has(id(o))) { seen.add(id(o)); out.push(o) }
  for (const o of fresh) if (!seen.has(id(o))) { seen.add(id(o)); out.push(o) }
  return out
}

export function createObjectStream(cfg: ExploreTuning['stream'] = EXPLORE.stream): ObjectStream {
  let map: GameMap | null = null
  let centre: { x: number; y: number } | null = null
  let npcs: NpcDef[] = []
  let items: GroundItemDef[] = []
  let places: TownDef[] = []
  let retainT = 0

  const sameIds = <T>(a: readonly T[], b: readonly T[], id: (t: T) => string) =>
    a.length === b.length && a.every((x, i) => id(x) === id(b[i]))

  return {
    reset(m) {
      map = m
      centre = null
      retainT = cfg.retainEverySec
      if (isInfinite(m)) { npcs = []; items = []; places = [] }
      else { npcs = m.npcs; items = m.items; places = [] }
    },
    update(px, py, force = false) {
      if (!map || !isInfinite(map)) return false
      const tx = Math.floor(px), ty = Math.floor(py)
      if (!force && centre && Math.max(Math.abs(tx - centre.x), Math.abs(ty - centre.y)) < cfg.stepTiles) return false
      centre = { x: tx, y: ty }
      const R = cfg.radius + cfg.stepTiles
      const o = objectsInRect(map, tx - R, ty - R, tx + R + 1, ty + R + 1)
      const nextNpcs = mergeLive(npcs, o.npcs, (n) => n.id, tx, ty, cfg.despawnRadius)
      const nextItems = mergeLive(items, o.items, (i) => i.id, tx, ty, cfg.despawnRadius)
      const nextPlaces = mergeLive(places, o.places, (p) => p.id, tx, ty, cfg.despawnRadius)
      const changed = !sameIds(npcs, nextNpcs, (n) => n.id) || !sameIds(items, nextItems, (i) => i.id) || !sameIds(places, nextPlaces, (p) => p.id)
      npcs = nextNpcs
      items = nextItems
      places = nextPlaces
      return changed
    },
    prefetch(px, py) {
      const p = map?.infinite
      if (!p || cfg.prefetchPerFrame <= 0) return
      const S = p.size
      const ccx = Math.floor(px / S), ccy = Math.floor(py / S)
      let budget = cfg.prefetchPerFrame
      for (let r = 0; r <= cfg.prefetchChunks && budget > 0; r++) {
        for (let dy = -r; dy <= r && budget > 0; dy++) {
          for (let dx = -r; dx <= r && budget > 0; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
            if (p.peek(ccx + dx, ccy + dy)) continue
            p.chunk(ccx + dx, ccy + dy)
            budget--
          }
        }
      }
    },
    retain(px, py, dt) {
      const p = map?.infinite
      if (!p) return
      retainT -= dt
      if (retainT > 0) return
      retainT = cfg.retainEverySec
      p.retain([{ x: px, y: py }], cfg.retainTiles)
    },
    get npcs() { return npcs },
    get items() { return items },
    get places() { return places },
  }
}
