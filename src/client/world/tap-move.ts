// Tap-to-move: turn a screen tap into a walkable route, then steer the body along it.
// Pure logic (no DOM, no scene): the controller injects the camera projection and the collision grid.
//   screenToGround   camera ray -> ground tile, corrected against the terrain height
//   pickCandidate    nearest NPC / item / door / sign / prop to the tap in screen space
//   planTapRoute     A* over the existing collision grid (quest-navigation's createRouteSearch)
//   stepTravel       per-frame steering axis + arrival + stuck detection
import * as THREE from 'three'
import type { TapMoveConfig } from '../core/input-config.ts'
import { gridField, type MotionGrid } from './motion.ts'
import { createRouteSearch, type RoutePoint } from './quest-navigation.ts'

export interface TileRect { x: number; y: number; w: number; h: number }

export type TapKind = 'ground' | 'npc' | 'item' | 'sign' | 'prop' | 'warp'

export interface TapCandidate {
  kind: Exclude<TapKind, 'ground'>
  id: string
  /** Footprint in tiles. */
  rect: TileRect
  /** World-space body centre (tile coordinates, float) and the ground height under it. */
  x: number
  y: number
  elev: number
}

export interface TapTarget {
  kind: TapKind
  id: string
  rect: TileRect
}

const _ray = new THREE.Raycaster()
const _ndc = new THREE.Vector2()
const _plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
const _hit = new THREE.Vector3()

/**
 * Ground point (tile coordinates, float) under a canvas pixel. The ray is intersected with the plane at `planeY`, then
 * re-intersected at the terrain height found there, so stairs and raised ground land on the right tile.
 */
export function screenToGround(
  camera: THREE.PerspectiveCamera,
  px: { x: number; y: number },
  size: { width: number; height: number },
  planeY: number,
  elevationAt: (x: number, y: number) => number,
  passes: number,
): { x: number; y: number } | null {
  _ndc.set((px.x / size.width) * 2 - 1, 1 - (px.y / size.height) * 2)
  _ray.setFromCamera(_ndc, camera)
  let y = planeY
  let out: { x: number; y: number } | null = null
  for (let i = 0; i <= passes; i++) {
    _plane.constant = -y
    if (!_ray.ray.intersectPlane(_plane, _hit)) return null
    out = { x: _hit.x, y: _hit.z }
    y = elevationAt(out.x, out.y)
  }
  return out
}

/** The candidate whose body is nearest the tap on screen, within `rules.pickRadiusPx` (kind biases make NPCs easier to hit). */
export function pickCandidate(
  project: (x: number, elev: number, y: number) => { x: number; y: number; visible: boolean },
  tap: { x: number; y: number },
  candidates: readonly TapCandidate[],
  rules: Pick<TapMoveConfig, 'pickRadiusPx' | 'bodyLift' | 'kindBiasPx'>,
): TapCandidate | null {
  let best: TapCandidate | null = null
  let bestScore = Infinity
  for (const c of candidates) {
    const s = project(c.x, c.elev + rules.bodyLift, c.y)
    if (!s.visible) continue
    const d = Math.hypot(s.x - tap.x, s.y - tap.y)
    if (d > rules.pickRadiusPx) continue
    const score = d - (rules.kindBiasPx[c.kind] ?? 0)
    if (score < bestScore) { bestScore = score; best = c }
  }
  return best
}

export interface TapPlan {
  /** Tile path including the starting tile. */
  path: RoutePoint[]
  goal: RoutePoint
  /** Tile coordinates (float) to face and interact with on arrival, or null for plain movement / doors. */
  interactAt: { x: number; y: number } | null
  /** Ground point the marker is shown on. */
  marker: { x: number; y: number }
}

const tileOf = (v: number) => Math.floor(v)

/** May a body stand on this tile (ignoring how to get there)? Warp tiles count: they are goals of door taps. */
function standable(grid: MotionGrid, x: number, y: number, surf: boolean): boolean {
  if (!grid.map.infinite && (x < 0 || y < 0 || x >= grid.map.width || y >= grid.map.height)) return false
  if (grid.blocked?.(x, y)) return false
  const c = gridField(grid).at(x, y)
  return c === 0 || (surf && c === 2)
}

/** Tiles around a rect that a body can stand on, nearest to `from` first. */
function ringTiles(grid: MotionGrid, rect: TileRect, from: RoutePoint, surf: boolean): RoutePoint[] {
  const out: RoutePoint[] = []
  for (let x = rect.x - 1; x <= rect.x + rect.w; x++) {
    for (let y = rect.y - 1; y <= rect.y + rect.h; y++) {
      const inside = x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h
      const corner = (x < rect.x || x >= rect.x + rect.w) && (y < rect.y || y >= rect.y + rect.h)
      if (inside || corner || !standable(grid, x, y, surf)) continue
      out.push({ x, y })
    }
  }
  return out.sort((a, b) => Math.abs(a.x - from.x) + Math.abs(a.y - from.y) - (Math.abs(b.x - from.x) + Math.abs(b.y - from.y)))
}

/**
 * Route to a tap. Things you talk to / read / open (npc, sign, prop) end on a tile beside them and interact; items,
 * doors and plain ground end on the tile itself. A ground tap on a blocked tile snaps to the nearest standable neighbour.
 * Returns null when nothing reachable is near the tap.
 */
export function planTapRoute(
  grid: MotionGrid,
  from: RoutePoint,
  target: TapTarget,
  surf: boolean,
  rules: Pick<TapMoveConfig, 'maxNodes' | 'marginTiles'>,
): TapPlan | null {
  const start = { x: tileOf(from.x), y: tileOf(from.y) }
  const r = target.rect
  const center = { x: r.x + r.w / 2, y: r.y + r.h / 2 }
  const talk = target.kind === 'npc' || target.kind === 'sign' || target.kind === 'prop'
  let goals: RoutePoint[]
  if (talk) {
    goals = ringTiles(grid, r, start, surf)
    const here = goals.find((g) => g.x === start.x && g.y === start.y)
    if (here) return { path: [start], goal: here, interactAt: center, marker: center }
  } else if (target.kind === 'warp' || standable(grid, r.x, r.y, surf)) {
    goals = [{ x: r.x, y: r.y }]
  } else {
    goals = ringTiles(grid, r, start, surf).filter((g) => g.x === r.x || g.y === r.y).slice(0, 4)
    if (!goals.length) goals = ringTiles(grid, r, start, surf).slice(0, 4)
  }
  if (!goals.length) return null
  if (goals.some((g) => g.x === start.x && g.y === start.y)) {
    return { path: [start], goal: start, interactAt: talk || target.kind === 'item' ? center : null, marker: center }
  }
  const search = createRouteSearch(grid, start, goals, surf, rules)
  search.advance(rules.maxNodes)
  if (search.status !== 'ready' || search.path.length === 0) return null
  const goal = search.path[search.path.length - 1]
  return {
    path: [...search.path],
    goal,
    interactAt: talk || target.kind === 'item' ? center : null,
    marker: target.kind === 'ground' ? { x: goal.x + 0.5, y: goal.y + 0.5 } : center,
  }
}

export interface Travel {
  path: readonly RoutePoint[]
  /** Index of the waypoint being walked to. */
  i: number
  interactAt: { x: number; y: number } | null
  anchor: { x: number; y: number; t: number }
  replans: number
  /** The original tap, kept to re-plan a stuck route. */
  target: TapTarget
}

export function createTravel(plan: TapPlan, target: TapTarget, pos: { x: number; y: number }): Travel {
  return { path: plan.path, i: Math.min(1, plan.path.length - 1), interactAt: plan.interactAt, anchor: { x: pos.x, y: pos.y, t: 0 }, replans: 0, target }
}

export interface TravelStep {
  /** Unit steering vector, or zero when done. */
  axis: { x: number; y: number }
  done: boolean
  stuck: boolean
}

/** Advances waypoints and aims at the next tile centre. `dt` accumulates the stuck clock. */
export function stepTravel(tr: Travel, pos: { x: number; y: number }, dt: number, rules: Pick<TapMoveConfig, 'waypointReach' | 'finalReach' | 'stuckSec' | 'stuckMinMove'>): TravelStep {
  const last = tr.path.length - 1
  while (tr.i <= last) {
    const p = tr.path[tr.i]
    const d = Math.hypot(p.x + 0.5 - pos.x, p.y + 0.5 - pos.y)
    if (d > (tr.i === last ? rules.finalReach : rules.waypointReach)) break
    tr.i++
  }
  if (tr.i > last) return { axis: { x: 0, y: 0 }, done: true, stuck: false }
  tr.anchor.t += dt
  let stuck = false
  if (tr.anchor.t >= rules.stuckSec) {
    stuck = Math.hypot(pos.x - tr.anchor.x, pos.y - tr.anchor.y) < rules.stuckMinMove
    tr.anchor = { x: pos.x, y: pos.y, t: 0 }
  }
  const p = tr.path[tr.i]
  const dx = p.x + 0.5 - pos.x, dy = p.y + 0.5 - pos.y
  const d = Math.hypot(dx, dy)
  return { axis: d > 1e-6 ? { x: dx / d, y: dy / d } : { x: 0, y: 0 }, done: false, stuck }
}

/** Replacing a stuck route: keeps the target, restarts the counters. */
export function retravel(tr: Travel, plan: TapPlan, pos: { x: number; y: number }): Travel {
  return { ...createTravel(plan, tr.target, pos), replans: tr.replans + 1 }
}
