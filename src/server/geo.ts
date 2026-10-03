// Tile-level world rules for the server, on top of the shared WorldApi: resolves static maps and lazily generated
// frontier interiors (held by the provider's bounded LRU, never cached into world.maps), checks that a walk between
// two tiles is possible with the client's step rules (elevation, stairs, one-way ledges, water while surfing), and
// trims the infinite overworld's chunk cache around online players. Loaded lazily by world.ts.
import type { GameMap, World } from '../shared/types.ts'
import { canStep, collisionField, isInfinite, worldOrigin } from '../shared/world/worldapi.ts'
import { FRONTIER_CONTENT, parseFrontierId } from '../shared/world/frontier/index.ts'

export interface PathLimits {
  /** Max WorldApi steps (8-dir) of the walk. */
  maxSteps: number
  /** Tiles around the from/to box the search may use. */
  margin: number
  /** Node cap of the breadth-first fallback. */
  maxNodes: number
}

export interface WorldGeo {
  readonly startMap: string
  /** Id of the infinite overworld, or null when the world has none. */
  readonly overworldId: string | null
  /** Static map, or a frontier interior / dungeon floor generated on demand (null = unknown id). */
  map(id: string): GameMap | null
  isInfinite(map: GameMap): boolean
  /**
   * Centre of the frontier site cell a frontier interior id belongs to (computed from the id, nothing is
   * generated); null for static maps and non-frontier ids. The site itself lies inside that cell.
   */
  anchorOf(mapId: string): { x: number; y: number } | null
  /** Distance (tiles) from the world origin. */
  distance(x: number, y: number): number
  /**
   * Frontier chunks (outside the core) not cached yet that reading tiles in [x0,x1] x [y0,y1] may generate,
   * including the W / N / NW neighbours whose props can spill into a chunk's collision.
   */
  missingChunks(map: GameMap, x0: number, y0: number, x1: number, y1: number): number
  /** True when tile (tx,ty) is reachable from (fx,fy) within lim.maxSteps WorldApi steps (surf allowed). */
  reachable(map: GameMap, fx: number, fy: number, tx: number, ty: number, lim: PathLimits): boolean
  /** Evict overworld chunks farther than radiusTiles from every point (provider.retain). */
  retain(points: { x: number; y: number }[], radiusTiles: number): void
}

const SURF = { surf: true }
const NEIGHBOURS: readonly (readonly [number, number])[] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]

/** Greedy straight walk (diagonal first, then the longer axis); most client updates resolve here. */
function greedy(map: GameMap, field: ReturnType<typeof collisionField>, fx: number, fy: number, tx: number, ty: number, maxSteps: number): boolean {
  let x = fx, y = fy
  for (let s = 0; s < maxSteps; s++) {
    const sx = Math.sign(tx - x), sy = Math.sign(ty - y)
    if (sx === 0 && sy === 0) return true
    if (sx !== 0 && sy !== 0 && canStep(map, field, x, y, x + sx, y + sy, SURF)) { x += sx; y += sy; continue }
    const xFirst = Math.abs(tx - x) >= Math.abs(ty - y)
    const a: [number, number] = xFirst ? [sx, 0] : [0, sy]
    const b: [number, number] = xFirst ? [0, sy] : [sx, 0]
    if ((a[0] !== 0 || a[1] !== 0) && canStep(map, field, x, y, x + a[0], y + a[1], SURF)) { x += a[0]; y += a[1]; continue }
    if ((b[0] !== 0 || b[1] !== 0) && canStep(map, field, x, y, x + b[0], y + b[1], SURF)) { x += b[0]; y += b[1]; continue }
    return false
  }
  return x === tx && y === ty
}

/** Breadth-first search inside the from/to box grown by lim.margin, depth <= maxSteps, nodes <= maxNodes. */
function search(map: GameMap, field: ReturnType<typeof collisionField>, fx: number, fy: number, tx: number, ty: number, lim: PathLimits): boolean {
  const m = Math.max(0, Math.floor(lim.margin))
  const x0 = Math.min(fx, tx) - m, y0 = Math.min(fy, ty) - m
  const w = Math.abs(tx - fx) + 2 * m + 1, h = Math.abs(ty - fy) + 2 * m + 1
  const seen = new Uint8Array(w * h)
  seen[(fy - y0) * w + (fx - x0)] = 1
  let level: number[] = [fx, fy]
  let nodes = 1
  for (let depth = 0; depth < lim.maxSteps && level.length > 0; depth++) {
    const next: number[] = []
    for (let i = 0; i < level.length; i += 2) {
      const x = level[i], y = level[i + 1]
      for (const [dx, dy] of NEIGHBOURS) {
        const nx = x + dx, ny = y + dy
        const lx = nx - x0, ly = ny - y0
        if (lx < 0 || ly < 0 || lx >= w || ly >= h || seen[ly * w + lx]) continue
        if (!canStep(map, field, x, y, nx, ny, SURF)) continue
        if (nx === tx && ny === ty) return true
        seen[ly * w + lx] = 1
        if (++nodes > lim.maxNodes) return false
        next.push(nx, ny)
      }
    }
    level = next
  }
  return false
}

export function createWorldGeo(world: World): WorldGeo {
  const maps = Object.values(world.maps)
  const overworld = maps.find((m) => isInfinite(m)) ?? null
  const origin = worldOrigin(world)

  return {
    startMap: world.startMap,
    overworldId: overworld?.id ?? null,

    map(id) {
      const m = world.maps[id]
      if (m) return m
      return overworld?.infinite?.interior(id) ?? null
    },

    isInfinite,

    anchorOf(mapId) {
      if (world.maps[mapId] || !overworld?.infinite) return null
      const f = parseFrontierId(mapId)
      if (!f || f.part === null) return null
      const cell = FRONTIER_CONTENT.sites.cell
      return { x: (f.sx + 0.5) * cell, y: (f.sy + 0.5) * cell }
    },

    distance: (x, y) => Math.hypot(x - origin.x, y - origin.y),

    missingChunks(map, x0, y0, x1, y1) {
      const p = map.infinite
      if (!p) return 0
      const S = p.size, c = p.core
      const inCore = (cx: number, cy: number) =>
        cx * S >= c.x && cy * S >= c.y && (cx + 1) * S <= c.x + c.width && (cy + 1) * S <= c.y + c.height
      let n = 0
      for (let cy = Math.floor(y0 / S) - 1; cy <= Math.floor(y1 / S); cy++) {
        for (let cx = Math.floor(x0 / S) - 1; cx <= Math.floor(x1 / S); cx++) {
          if (!inCore(cx, cy) && !p.peek(cx, cy)) n++
        }
      }
      return n
    },

    reachable(map, fx, fy, tx, ty, lim) {
      if (fx === tx && fy === ty) return true
      if (Math.max(Math.abs(tx - fx), Math.abs(ty - fy)) > lim.maxSteps) return false
      const field = collisionField(map)
      return greedy(map, field, fx, fy, tx, ty, lim.maxSteps) || search(map, field, fx, fy, tx, ty, lim)
    },

    retain(points, radiusTiles) {
      overworld?.infinite?.retain(points, radiusTiles)
    },
  }
}
