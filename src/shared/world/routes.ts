// Region border bands, route carving (A* with bridges over rivers and one-level stairs), gates at
// 1-tile choke points, route signs and connector paths (cave mouths).
import type { PropPlacement } from '../types.ts'
import { CONTENT } from '../content/index.ts'
import { findPath, findPathTo, type StepCost } from './astar.ts'
import {
  F_BORDER, F_BRIDGE, F_CRATER, F_EDGE, F_GATE, F_KEEP, F_LAKE, F_PATH, F_RESERVED, F_RIVER, F_ROAD, F_SEA, F_TOWN,
  addFlag, canPlace, fmt, hasFlag, idx, inside, placeProp, type MapDraft,
} from './grid.ts'
import { noiseField, rngFor } from './random.ts'
import type { PathCosts, RouteSpec } from './schema.ts'
import { addAnchor, biomeOf, tid, type OwCtx } from './ctx.ts'
import { placeSign, type StampedTown } from './towns.ts'

export interface CarvedRoute {
  spec: RouteSpec
  index: number
  /** Centre line, start to end. */
  path: number[]
  /** Every tile carved for this route (centre + widening). */
  tiles: number[]
  gate: number
}

/**
 * Region border bands from the land zone map (`zoneRaw`, which ignores the sea so bands continue through the
 * shallows) plus the map edge band. Islands never get bands.
 */
export function markBands(ctx: OwCtx): void {
  const { d, macro, spec } = ctx
  const regions = ctx.wc.regions
  const walled = regions.map((r) => r.border !== false && !r.water)
  const r = spec.borderRadius
  const W = d.w, H = d.h
  const zr = macro.zoneRaw
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x
    if (x < spec.edgeBand || y < spec.edgeBand || x >= W - spec.edgeBand || y >= H - spec.edgeBand) addFlag(d, i, F_EDGE)
    if (macro.island[i]) continue
    const ri = zr[i]
    if (!walled[ri]) continue
    let band = false
    for (let oy = -r; oy <= r && !band; oy++) {
      const ny = y + oy
      if (ny < 0 || ny >= H) continue
      for (let ox = -r; ox <= r; ox++) {
        const nx = x + ox
        if (nx < 0 || nx >= W) continue
        const j = ny * W + nx
        const rj = zr[j]
        if (rj !== ri && walled[rj] && !macro.island[j]) { band = true; break }
      }
    }
    if (band) addFlag(d, i, F_BORDER)
  }
}

const walkable = (id: number) => CONTENT.terrain[id]?.walkable === true
const liquid = (id: number) => CONTENT.terrain[id]?.liquid === true
const swim = (id: number) => CONTENT.terrain[id]?.swim === true

const BLOCKING = F_TOWN | F_LAKE | F_SEA | F_EDGE | F_CRATER

/** Can `lo` become a stairs tile rising to its orthogonal neighbour `hi` (exactly one level up, in line)? */
export function stairsOk(d: MapDraft, lo: number, hi: number, occupied: (i: number) => boolean = (i) => d.occ[i] !== 0): boolean {
  const e = d.elevation[lo]
  if (d.elevation[hi] !== e + 1) return false
  if ((d.flags[lo] & (BLOCKING | F_RIVER | F_BRIDGE | F_RESERVED | F_GATE)) !== 0) return false
  if (occupied(lo) || occupied(hi) || !walkable(d.terrain[lo]) || liquid(d.terrain[lo])) return false
  if (!walkable(d.terrain[hi]) || liquid(d.terrain[hi])) return false
  const lx = lo % d.w, ly = (lo - lx) / d.w
  const hx = hi % d.w, hy = (hi - hx) / d.w
  const bx = 2 * lx - hx, by = 2 * ly - hy
  if (!inside(d, bx, by) || d.elevation[idx(d, bx, by)] > e) return false
  let ups = 0
  if (lx > 0 && d.elevation[lo - 1] === e + 1) ups++
  if (lx < d.w - 1 && d.elevation[lo + 1] === e + 1) ups++
  if (ly > 0 && d.elevation[lo - d.w] === e + 1) ups++
  if (ly < d.h - 1 && d.elevation[lo + d.w] === e + 1) ups++
  return ups === 1
}

export interface PathCostOpts {
  block?: (i: number) => boolean
  /** Occupancy test (default: any prop). */
  occupied?: (i: number) => boolean
  /** Additional cost of entering a tile. */
  extra?: (i: number) => number
}

export function pathCost(ctx: OwCtx, c: PathCosts, o: PathCostOpts = {}): StepCost {
  const { d } = ctx
  const meander = noiseField(c.noiseSpec, ctx.seed)
  const occupied = o.occupied ?? ((i: number) => d.occ[i] !== 0)
  return (a: number, b: number): number => {
    if ((d.flags[b] & BLOCKING) !== 0 || occupied(b)) return Infinity
    if (o.block && o.block(b)) return Infinity
    const t = d.terrain[b]
    const water = !walkable(t) && swim(t)
    if (!walkable(t) && !(water && hasFlag(d, b, F_RIVER))) return Infinity
    const la = d.elevation[a], lb = d.elevation[b]
    const ta = d.terrain[a]
    const aWater = !walkable(ta) && swim(ta)
    if ((water || aWater) && la !== lb) return Infinity
    const bx = b % d.w, by = (b - bx) / d.w
    let cost = (hasFlag(d, b, F_PATH) ? c.reuse : c.base) + c.noise * meander.sample(bx, by)
    if (water) cost += c.bridge
    if (hasFlag(d, b, F_BORDER)) cost += c.border
    if (o.extra) cost += o.extra(b)
    if (la !== lb) {
      const ok = la < lb ? stairsOk(d, a, b, occupied) : stairsOk(d, b, a, occupied)
      if (!ok) return Infinity
      cost += c.stairs
    }
    return cost
  }
}

/** Heuristic step scale: the base step cost (reused paths make it inadmissible; the search stays weighted A*). */
function minStep(c: PathCosts): number { return c.base }

/** Carves centre line + widening. Returns all carved tiles. */
function carve(ctx: OwCtx, path: number[], width: number, terrainKey: string, noWiden: (j: number) => boolean): number[] {
  const { d, spec } = ctx
  const pathT = tid(terrainKey), bridgeT = tid(spec.bridgeTerrain), stairsT = tid(spec.stairsTerrain)
  const tiles: number[] = []
  const paint = (i: number, stairs: boolean) => {
    if (hasFlag(d, i, F_RIVER) && !walkable(d.terrain[i])) { d.terrain[i] = bridgeT; addFlag(d, i, F_BRIDGE) }
    else if (stairs) d.terrain[i] = stairsT
    else if (!CONTENT.terrain[d.terrain[i]]?.stairs && !hasFlag(d, i, F_BRIDGE | F_ROAD)) d.terrain[i] = pathT
    addFlag(d, i, F_PATH | F_KEEP)
    tiles.push(i)
  }
  const sides: number[] = []
  for (let k = 1; sides.length < width - 1; k++) { sides.push(k); if (sides.length < width - 1) sides.push(-k) }
  for (let j = 0; j < path.length; j++) {
    const i = path[j]
    const nxt = j + 1 < path.length ? path[j + 1] : -1
    const stairsHere = nxt >= 0 && d.elevation[nxt] === d.elevation[i] + 1
    const stairsPrev = j > 0 && d.elevation[path[j - 1]] === d.elevation[i] + 1
    paint(i, stairsHere || stairsPrev)
    if (noWiden(j)) continue
    const a = j > 0 ? path[j - 1] : i, b = nxt >= 0 ? nxt : i
    const ax = a % d.w, ay = (a - ax) / d.w, bx = b % d.w, by = (b - bx) / d.w
    const dx = Math.sign(bx - ax), dy = Math.sign(by - ay)
    if (dx !== 0 && dy !== 0) continue
    const px = -dy, py = dx
    const x = i % d.w, y = (i - x) / d.w
    const upDir = stairsHere ? nxt - i : stairsPrev ? path[j - 1] - i : 0
    for (const s of sides) {
      const qx = x + px * s, qy = y + py * s
      if (!inside(d, qx, qy)) continue
      const q = idx(d, qx, qy)
      if ((d.flags[q] & (BLOCKING | F_RESERVED | F_GATE)) !== 0 || d.occ[q] || d.elevation[q] !== d.elevation[i]) continue
      if (hasFlag(d, i, F_BRIDGE)) { if (hasFlag(d, q, F_RIVER) && !walkable(d.terrain[q])) paint(q, false); continue }
      if (upDir !== 0) { if (stairsOk(d, q, q + upDir)) paint(q, true); continue }
      if (walkable(d.terrain[q]) && !liquid(d.terrain[q]) && !CONTENT.terrain[d.terrain[q]]?.stairs) paint(q, false)
    }
  }
  return tiles
}

function blockerProp(ctx: OwCtx, i: number): PropPlacement | null {
  const { d } = ctx
  const x = i % d.w, y = (i - x) / d.w
  const rng = rngFor(ctx.seed, `gate-wall-${i}`)
  const border = biomeOf(ctx, i).border
  const p: PropPlacement = { prop: rng.weighted(border, (b) => b.weight).prop, x, y, rot: 0 }
  return canPlace(d, p, { anyTerrain: true, flat: false }) ? p : null
}

function placeGate(ctx: OwCtx, route: RouteSpec, path: number[]): { gate: number; lo: number; hi: number } {
  const { d, macro } = ctx
  const gate = route.gate!
  const gr = ctx.regionIdx.get(gate.region)
  let j = path.findIndex((t, k) => k > 0 && macro.wild[t] === gr && macro.wild[path[k - 1]] !== gr)
  if (j < 0) { ctx.problems.push(`route ${route.id}: never enters gate region "${gate.region}"`); return { gate: -1, lo: 0, hi: -1 } }
  let lo = j, hi = j
  while (lo > 0 && hasFlag(d, path[lo - 1], F_BORDER)) lo--
  while (hi < path.length - 1 && hasFlag(d, path[hi + 1], F_BORDER)) hi++
  const mid = (lo + hi) / 2
  // Prefer: straight corridor, inside the wall band, closest to the band's middle.
  let best = -1
  let bestKey: [number, number, number] = [Infinity, Infinity, Infinity]
  for (let k = Math.max(1, lo - 6); k <= Math.min(path.length - 2, hi + 6); k++) {
    const a = path[k - 1], b = path[k], c = path[k + 1]
    const flat = d.elevation[a] === d.elevation[b] && d.elevation[b] === d.elevation[c]
    const plain = !CONTENT.terrain[d.terrain[b]]?.stairs && !hasFlag(d, b, F_BRIDGE)
    if (!flat || !plain) continue
    const key: [number, number, number] = [b - a === c - b ? 0 : 1, hasFlag(d, b, F_BORDER) ? 0 : 1, Math.abs(k - mid)]
    if (key[0] < bestKey[0] || (key[0] === bestKey[0] && (key[1] < bestKey[1] || (key[1] === bestKey[1] && key[2] < bestKey[2])))) {
      bestKey = key
      best = k
    }
  }
  if (best < 0) best = Math.round(mid)
  return { gate: best, lo: Math.min(lo, best) - 2, hi: Math.max(hi, best) + 2 }
}

/** Blocks both sides of the gate corridor so the gate tile is a true choke point. */
function wallGate(ctx: OwCtx, path: number[], g: number): void {
  const { d } = ctx
  const onPath = new Set(path)
  for (let k = Math.max(0, g - 1); k <= Math.min(path.length - 1, g + 1); k++) {
    const i = path[k]
    const a = path[Math.max(0, k - 1)], b = path[Math.min(path.length - 1, k + 1)]
    const dx = Math.sign((b % d.w) - (a % d.w)), dy = Math.sign(Math.floor(b / d.w) - Math.floor(a / d.w))
    const x = i % d.w, y = (i - x) / d.w
    for (const s of [1, -1]) {
      const qx = x - dy * s, qy = y + dx * s
      if (!inside(d, qx, qy)) continue
      const q = idx(d, qx, qy)
      if (onPath.has(q) || d.occ[q]) continue
      addFlag(d, q, F_BORDER)
      if (CONTENT.terrain[d.terrain[q]]?.stairs) d.terrain[q] = tid(biomeOf(ctx, q).ground)
      if (!walkable(d.terrain[q])) continue
      const p = blockerProp(ctx, q)
      if (p) placeProp(d, p)
      else ctx.problems.push(`gate wall at ${qx},${qy} could not be placed`)
    }
  }
}

function routeSigns(ctx: OwCtx, route: RouteSpec, path: number[], from: StampedTown, to: StampedTown): void {
  const { d, spec } = ctx
  const text = fmt(ctx.wc.world.text.routeSign, { route: route.nameZh, from: from.spec.nameZh, to: to.spec.nameZh })
  for (const atEnd of [false, true]) {
    let placed = false
    for (let off = spec.routeSign.distance; off < Math.min(path.length - 1, spec.routeSign.distance + spec.routeSign.window) && !placed; off++) {
      const k = atEnd ? path.length - 1 - off : off
      const i = path[k]
      const a = path[Math.max(0, k - 1)], b = path[Math.min(path.length - 1, k + 1)]
      const dx = Math.sign((b % d.w) - (a % d.w)), dy = Math.sign(Math.floor(b / d.w) - Math.floor(a / d.w))
      const x = i % d.w, y = (i - x) / d.w
      for (let s = 1; s <= spec.routeSign.side && !placed; s++) {
        for (const side of [1, -1]) {
          const qx = x - dy * side * s, qy = y + dx * side * s
          if (!inside(d, qx, qy)) continue
          const q = idx(d, qx, qy)
          if ((d.flags[q] & (F_PATH | F_TOWN | F_RESERVED | F_GATE | BLOCKING)) !== 0 || d.elevation[q] !== d.elevation[i]) continue
          if (!walkable(d.terrain[q]) || liquid(d.terrain[q]) || CONTENT.terrain[d.terrain[q]]?.stairs) continue
          if (placeSign(ctx, qx, qy, text, 'sign')) { placed = true; break }
        }
      }
    }
    if (!placed) ctx.problems.push(`route ${route.id}: no room for a route sign`)
  }
}

export function carveRoutes(ctx: OwCtx, towns: StampedTown[], used: Set<string>): CarvedRoute[] {
  const { d } = ctx
  const byId = new Map(towns.map((t) => [t.spec.id, t]))
  const cost = pathCost(ctx, ctx.spec.routing)
  const out: CarvedRoute[] = []
  ctx.wc.routes.forEach((route, index) => {
    const from = byId.get(route.from), to = byId.get(route.to)
    const a = from?.exits[route.fromExit], b = to?.exits[route.toExit]
    if (!from || !to || !a || !b) { ctx.problems.push(`route ${route.id}: unknown town or exit`); return }
    used.add(`${route.from}:${route.fromExit}`)
    used.add(`${route.to}:${route.toExit}`)
    const pts = [a.out, ...(route.via ?? []).map(([x, y]) => ({ x, y })), b.out]
    const path: number[] = []
    for (let k = 0; k + 1 < pts.length; k++) {
      const seg = findPath(d.w, d.h, idx(d, pts[k].x, pts[k].y), idx(d, pts[k + 1].x, pts[k + 1].y), cost, minStep(ctx.spec.routing), ctx.spec.routing.heuristic)
      if (!seg) { ctx.problems.push(`route ${route.id}: no path for leg ${k}`); return }
      path.push(...(k === 0 ? seg : seg.slice(1)))
    }
    let gate = -1, glo = 0, ghi = -1
    if (route.gate) ({ gate, lo: glo, hi: ghi } = placeGate(ctx, route, path))
    const tiles = carve(ctx, path, route.width, route.terrain, (j) => j >= glo && j <= ghi)
    if (gate >= 0) {
      const gi = path[gate]
      addFlag(d, gi, F_GATE | F_RESERVED)
      wallGate(ctx, path, gate)
      addAnchor(ctx.anchors, ctx.problems, `gate:${route.gate!.name}`, d.id, gi % d.w, Math.floor(gi / d.w))
    }
    routeSigns(ctx, route, path, from, to)
    out.push({ spec: route, index, path, tiles, gate: gate >= 0 ? path[gate] : -1 })
  })
  return out
}

/**
 * Cheapest path from `start` to the nearest tile with F_PATH, restricted to one wild region, carved 1 wide.
 * Used for cave mouths, dungeon mouths and hamlet trails so they are reachable without opening region walls.
 * `ctx.pathHeur` (distance to the path network) guides the search when present.
 */
export function connectToPaths(ctx: OwCtx, start: number, region: number, terrainKey: string): boolean {
  const { d } = ctx
  const c = ctx.spec.connector
  const cost = pathCost(ctx, c, { block: (i) => ctx.macro.wild[i] !== region || hasFlag(d, i, F_BORDER) })
  const ph = ctx.pathHeur
  const hw = c.base * c.heuristic
  const path = findPathTo(d.w, d.h, start, (i) => i !== start && hasFlag(d, i, F_PATH), cost, ph ? (i) => ph[i] * hw : () => 0, c.maxCost ?? Infinity)
  if (!path) return false
  carve(ctx, path.slice(0, -1), 1, terrainKey, () => true)
  return true
}
