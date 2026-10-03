// Access repair: every sizeable walkable pocket of a region that the player cannot reach (plateau without
// stairs, land cut off by a river, clearing sealed by scattered trees) gets a trail to the reachable part of
// the same region — stairs on level changes, bridges over rivers, and removal of scattered props in the way.
// Region walls are never crossed, so gating is unaffected.
import { CONTENT } from '../content/index.ts'
import { findPathTo } from './astar.ts'
import { COLLISION_BLOCKED, COLLISION_FREE, COLLISION_WATER, buildCollision, propRect } from './collision.ts'
import { F_BORDER, F_BRIDGE, F_EDGE, F_KEEP, F_RIVER, F_TOWN, addFlag, draftView, hasFlag, type MapDraft } from './grid.ts'
import { floodReach, pockets } from './reach.ts'
import { pathCost } from './routes.ts'
import { tid, type OwCtx } from './ctx.ts'

function rebuildOcc(d: MapDraft): void {
  d.occ.fill(0)
  d.props.forEach((p, k) => {
    const r = propRect(p)
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (x >= 0 && y >= 0 && x < d.w && y < d.h) d.occ[y * d.w + x] = k + 1
  })
}

function terrainCollision(id: number): number {
  const t = CONTENT.terrain[id]
  return !t ? COLLISION_BLOCKED : t.walkable ? COLLISION_FREE : t.swim ? COLLISION_WATER : COLLISION_BLOCKED
}

/**
 * @param removableFrom props with index >= this may be removed to open a trail (null = never remove props).
 * @param targets tiles that must become reachable (hamlets, POI centres, dungeon mouths), tried first and
 *   regardless of pocket size.
 * @returns targets still unreachable afterwards.
 */
export function repairAccess(ctx: OwCtx, removableFrom: number | null, targets: number[] = []): number[] {
  const { d, macro, spec } = ctx
  const cfg = spec.access
  const view = draftView(d)
  const col = buildCollision(view)
  const walk = floodReach(view, col, d.spawn.x, d.spawn.y, false)
  const surf = floodReach(view, col, d.spawn.x, d.spawn.y, true)
  // Land in water regions (islands) only needs to connect to its own surf-reachable shore.
  const waterRegion = ctx.wc.regions.map((r) => r.water === true)
  const list = [...targets.map((t) => [t]), ...pockets(view, col, walk, (i) => !hasFlag(d, i, F_TOWN))]
  const forced = targets.length
  const removed = new Set<number>()
  const removable = (i: number) => removableFrom !== null && d.occ[i] > removableFrom && !removed.has(d.occ[i] - 1)
  const occupied = (i: number) => d.occ[i] !== 0 && !removed.has(d.occ[i] - 1) && !removable(i)
  const bridgeT = tid(spec.bridgeTerrain), stairsT = tid(spec.stairsTerrain)
  let repairs = 0
  for (let ci = 0; ci < list.length; ci++) {
    const comp = list[ci]
    if (ci >= forced && (comp.length < cfg.minPocket || repairs >= cfg.maxRepairs)) break
    const region = macro.wild[comp[0]]
    const island = waterRegion[region]
    const reach = island ? surf : walk
    if (reach[comp[0]]) continue
    const cost = pathCost(ctx, spec.connector, {
      block: (i) => macro.wild[i] !== region || hasFlag(d, i, F_BORDER | F_EDGE),
      occupied,
      extra: (i) => (removable(i) ? cfg.propCost : 0),
    })
    const path = findPathTo(d.w, d.h, comp[0], (i) => reach[i] === 1, cost, () => 0, spec.connector.maxCost ?? Infinity)
    if (!path) continue
    repairs++
    for (let k = 0; k < path.length; k++) {
      const i = path[k]
      if (removable(i)) {
        const pi = d.occ[i] - 1
        removed.add(pi)
        const r = propRect(d.props[pi])
        for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
          const j = y * d.w + x
          d.occ[j] = 0
          col[j] = terrainCollision(d.terrain[j])
        }
      }
      if (hasFlag(d, i, F_RIVER) && !CONTENT.terrain[d.terrain[i]]?.walkable) { d.terrain[i] = bridgeT; addFlag(d, i, F_BRIDGE); col[i] = COLLISION_FREE }
      const nb = [path[k - 1], path[k + 1]].filter((j) => j !== undefined)
      if (nb.some((j) => d.elevation[j] === d.elevation[i] + 1)) d.terrain[i] = stairsT
      addFlag(d, i, F_KEEP)
    }
    floodReach(view, col, comp[0] % d.w, Math.floor(comp[0] / d.w), island, undefined, reach)
  }
  if (removed.size) {
    d.props = d.props.filter((_, k) => !removed.has(k))
    rebuildOcc(d)
  }
  return targets.filter((t) => !(waterRegion[macro.wild[t]] ? surf : walk)[t])
}
