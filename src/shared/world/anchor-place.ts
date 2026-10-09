// Placement of teleport anchors during world generation: a spot search shared by the core continent (MapDraft of
// the overworld) and the frontier (site-layout windows and wilderness chunks), then the rule driver for the core.
// Rules, kinds and tuning numbers come from content/world/anchors.json; this file only holds the algorithms.
// Every anchor stands on flat, walkable, dry ground inside a free walkable ring, so it can never seal a passage.
import type { PropPlacement } from '../types.ts'
import { CONTENT } from '../content/index.ts'
import { WORLD_CONTENT } from './data.ts'
import { anchorId } from './anchor-ids.ts'
import { buildCollision, canStep, COLLISION_FREE, propRect } from './collision.ts'
import {
  F_BORDER, F_BRIDGE, F_EDGE, F_GATE, F_KEEP, F_LAKE, F_NEST, F_PATH, F_RESERVED, F_RIVER, F_ROAD, F_SEA,
  addFlag, draftView, idx, inside, placeProp, type MapDraft,
} from './grid.ts'
import type { OwCtx } from './ctx.ts'
import type { CarvedRoute } from './routes.ts'
import type { StampedHamlet } from './hamlets.ts'
import type { StampedPoi } from './pois.ts'
import type { StampedTown } from './towns.ts'
import type { BuiltDungeon } from './dungeons.ts'
import type { AnchorFlagName, AnchorKindId, AnchorRule } from './schema.ts'

const A = WORLD_CONTENT.anchors

const FLAG_BITS: Record<AnchorFlagName, number> = {
  path: F_PATH, road: F_ROAD, reserved: F_RESERVED, gate: F_GATE, keep: F_KEEP, bridge: F_BRIDGE, nest: F_NEST,
  border: F_BORDER, edge: F_EDGE, river: F_RIVER, lake: F_LAKE, sea: F_SEA,
}
const flagMask = (names: readonly AnchorFlagName[]) => names.reduce((m, n) => m | FLAG_BITS[n], 0)

/** What the spot search needs to know about the ground; adapters exist for MapDrafts and for frontier chunks. */
export interface AnchorField {
  /** The tile may be part of the anchor's footprint. */
  foot(x: number, y: number): boolean
  /** The tile may lie in the free ring around the footprint. */
  ring(x: number, y: number): boolean
  level(x: number, y: number): number
  /** Road-bed terrain: allowed, but a verge tile is preferred. */
  road?(x: number, y: number): boolean
}

export function anchorFootprint(kind: AnchorKindId): [number, number] {
  return CONTENT.props[A.kinds[kind].prop].footprint
}

function fits(field: AnchorField, x: number, y: number, fw: number, fh: number, margin: number): boolean {
  const e = field.level(x, y)
  for (let yy = y - margin; yy < y + fh + margin; yy++) {
    for (let xx = x - margin; xx < x + fw + margin; xx++) {
      const inner = xx >= x && yy >= y && xx < x + fw && yy < y + fh
      if (!(inner ? field.foot(xx, yy) : field.ring(xx, yy)) || field.level(xx, yy) !== e) return false
    }
  }
  return true
}

/**
 * Footprint top-left of the best anchor spot whose centre tile lies in the Chebyshev band [min, max] around
 * (cx, cy): the nearest ring that has one, then the cheapest within `slack` rings (road-bed tiles cost extra).
 */
export function findAnchorSpot(field: AnchorField, kind: AnchorKindId, cx: number, cy: number, min: number, max: number): { x: number; y: number } | null {
  const [fw, fh] = anchorFootprint(kind)
  const margin = A.kinds[kind].margin
  const ox = Math.floor(fw / 2), oy = Math.floor(fh / 2)
  let best: { x: number; y: number } | null = null
  let bestCost = Infinity
  let firstRing = 0
  for (let r = min; r <= max; r++) {
    if (best && r > firstRing + A.place.slack) break
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
        const x = cx + dx - ox, y = cy + dy - oy
        if (!fits(field, x, y, fw, fh, margin)) continue
        let cost = dx * dx + dy * dy
        if (field.road) {
          for (let yy = y; yy < y + fh; yy++) for (let xx = x; xx < x + fw; xx++) if (field.road(xx, yy)) cost += A.place.roadPenalty
        }
        if (cost < bestCost) {
          if (!best) firstRing = r
          best = { x, y }
          bestCost = cost
        }
      }
    }
  }
  return best
}

const roadIds = new Set<number>()
for (const k of A.place.roadTerrain) { const t = CONTENT.terrainByKey[k]; if (t) roadIds.add(t.id) }

/** The ground of a MapDraft; `taken` tiles (items, named anchors, warps) never carry a footprint, `exact` ones (NPC spots, items, signs, warps) never lie in its ring. */
export function draftField(d: MapDraft, taken: ReadonlySet<number>, exact: ReadonlySet<number> = taken): AnchorField {
  const avoid = flagMask(A.place.avoidFlags), ringAvoid = flagMask(A.place.ringAvoidFlags)
  const dry = (i: number) => {
    const t = CONTENT.terrain[d.terrain[i]]
    return t?.walkable === true && !t.liquid && !t.stairs && !t.ledge
  }
  return {
    foot(x, y) {
      if (!inside(d, x, y)) return false
      const i = idx(d, x, y)
      return !d.occ[i] && (d.flags[i] & avoid) === 0 && dry(i) && !taken.has(i)
    },
    ring(x, y) {
      if (!inside(d, x, y)) return false
      const i = idx(d, x, y)
      return !d.occ[i] && (d.flags[i] & ringAvoid) === 0 && dry(i) && !exact.has(i)
    },
    level: (x, y) => (inside(d, x, y) ? d.elevation[idx(d, x, y)] : -1),
    road: (x, y) => roadIds.has(d.terrain[idx(d, x, y)]),
  }
}

/** Items (with clearance), named anchors and NPC spots, warps and signs: tiles story content or pickups already rely on. */
export function takenTiles(d: MapDraft, named: Iterable<{ x: number; y: number }>): Set<number> {
  const taken = new Set<number>()
  const c = A.place.itemClearance
  for (const it of d.items) {
    for (let y = it.y - c; y <= it.y + c; y++) for (let x = it.x - c; x <= it.x + c; x++) if (inside(d, x, y)) taken.add(idx(d, x, y))
  }
  for (const a of named) if (inside(d, a.x, a.y)) taken.add(idx(d, a.x, a.y))
  for (const w of d.warps) if (inside(d, w.x, w.y)) taken.add(idx(d, w.x, w.y))
  for (const s of d.signs) if (inside(d, s.x, s.y)) taken.add(idx(d, s.x, s.y))
  return taken
}

/** Tiles something stands on: pickups, named positions, NPC spots, warps and signs (no clearance around them). */
export function exactTiles(d: MapDraft, named: Iterable<{ x: number; y: number }>): Set<number> {
  const out = new Set<number>()
  for (const o of [...d.items, ...d.warps, ...d.signs, ...named]) if (inside(d, o.x, o.y)) out.add(idx(d, o.x, o.y))
  return out
}

/** Places the anchor prop and keeps its footprint and ring clear of scatter / NPC spots. */
export function stampAnchor(d: MapDraft, kind: AnchorKindId, x: number, y: number): PropPlacement {
  const spec = A.kinds[kind]
  const p: PropPlacement = { prop: spec.prop, x, y, rot: 0 }
  placeProp(d, p)
  const r = propRect(p)
  for (let yy = r.y - spec.margin; yy < r.y + r.h + spec.margin; yy++) {
    for (let xx = r.x - spec.margin; xx < r.x + r.w + spec.margin; xx++) {
      if (!inside(d, xx, yy)) continue
      const inner = xx >= r.x && yy >= r.y && xx < r.x + r.w && yy < r.y + r.h
      addFlag(d, idx(d, xx, yy), inner ? F_RESERVED | F_KEEP : F_KEEP)
    }
  }
  return p
}

/**
 * The anchor of a frontier site, placed in the site's local layout window (`d`) near `target` (local tile).
 * `ruleKey` is a content frontier.sites key (a site kind id or `gateway`); returns the footprint top-left or
 * null when the kind has no anchor or no spot is free.
 */
export function placeSiteAnchor(d: MapDraft, ruleKey: string, target: { x: number; y: number }): { x: number; y: number; kind: AnchorKindId } | null {
  const rule = A.frontier.sites[ruleKey]
  if (!rule) return null
  const field = draftField(d, takenTiles(d, []))
  const spot = findAnchorSpot(field, rule.kind, target.x, target.y, rule.min, rule.max)
  if (!spot) return null
  stampAnchor(d, rule.kind, spot.x, spot.y)
  return { ...spot, kind: rule.kind }
}

export interface PlacedAnchor {
  id: string
  kind: AnchorKindId
  /** Footprint top-left. */
  x: number
  y: number
  rule: string
  /** Town / hamlet / dungeon / POI / route id the rule attached it to. */
  subject: string
}

const cheb = (ax: number, ay: number, bx: number, by: number) => Math.max(Math.abs(ax - bx), Math.abs(ay - by))

export interface CoreAnchorInput {
  ctx: OwCtx
  towns: StampedTown[]
  routes: CarvedRoute[]
  hamlets: StampedHamlet[]
  pois: StampedPoi[]
  dungeons: BuiltDungeon[]
  /** Overworld tiles reachable on foot from the spawn. */
  walkReach: Uint8Array
}

/** Runs content/world/anchors.json `core.rules` over the finished overworld draft (after items, before causeways). */
export function placeCoreAnchors(inp: CoreAnchorInput): PlacedAnchor[] {
  const { ctx } = inp
  const d = ctx.d
  const placed: PlacedAnchor[] = []
  // Hamlet and POI villager spots are claimed by NPCs later: an anchor must not stand on or beside one.
  const named = [...Object.values(ctx.anchors), ...inp.hamlets.flatMap((h) => h.spots), ...inp.pois.flatMap((p) => p.spots)]
  const taken = takenTiles(d, named)
  const field = draftField(d, taken, exactTiles(d, named))
  const near = (x: number, y: number, spacing: number) => placed.some((a) => cheb(a.x, a.y, x, y) < spacing)

  const attempt = (rule: AnchorRule, subject: string, cx: number, cy: number, mandatory: boolean, on: AnchorField = field): PlacedAnchor | null => {
    if (rule.minSpacing && near(cx, cy, rule.minSpacing)) return null
    const spot = findAnchorSpot(on, rule.kind, cx, cy, rule.min, rule.max)
    if (!spot) {
      if (mandatory) ctx.problems.push(`anchor ${rule.id} ${subject}: no free spot within ${rule.max} tiles of ${cx},${cy}`)
      return null
    }
    if (rule.minSpacing && near(spot.x, spot.y, rule.minSpacing)) return null
    stampAnchor(d, rule.kind, spot.x, spot.y)
    const a: PlacedAnchor = { id: anchorId(rule.kind, spot.x, spot.y), kind: rule.kind, x: spot.x, y: spot.y, rule: rule.id, subject }
    placed.push(a)
    return a
  }

  for (const rule of A.core.rules) {
    switch (rule.source) {
      case 'spawn': {
        const at = ctx.anchors[rule.anchor ?? 'spawn']
        if (at) attempt(rule, rule.anchor ?? 'spawn', at.x, at.y, true)
        else ctx.problems.push(`anchor ${rule.id}: unknown anchor "${rule.anchor}"`)
        break
      }
      case 'town':
        for (const t of inp.towns) attempt(rule, t.spec.id, t.square.x, t.square.y, true)
        break
      case 'hamlet':
        for (const h of inp.hamlets) attempt(rule, h.id, h.center.x, h.center.y, true)
        break
      case 'dungeon':
        for (const dn of inp.dungeons) if (dn.mouth) attempt(rule, dn.id, dn.mouth.x, dn.mouth.y, true)
        break
      case 'poi':
        for (const p of inp.pois) if (!p.island && rule.templates?.includes(p.template)) attempt(rule, p.id, p.center.x, p.center.y, false)
        break
      case 'route':
        for (const cr of inp.routes) {
          const L = cr.path.length, margin = rule.edgeMargin ?? 0, spacing = Math.max(1, rule.spacing ?? 64)
          const usable = L - 1 - 2 * margin
          if (usable < 0) continue
          const count = Math.floor(usable / spacing) + 1
          for (let k = 0; k < count; k++) {
            const at = count === 1 ? Math.floor((L - 1) / 2) : margin + Math.round((usable * k) / (count - 1))
            const i = cr.path[at]
            attempt(rule, cr.spec.id, i % d.w, Math.floor(i / d.w), false)
          }
        }
        break
      case 'fill':
        fillCoverage(inp, rule, field, placed, attempt)
        break
    }
  }
  return placed
}

/**
 * Raster sweep: whenever a reachable tile lies more than `maxWalk` steps from every anchor, plant another one
 * within walking reach of it, a few steps inwards (towards the unswept side), and update the step-distance
 * field incrementally. Spots are restricted to tiles walkable from the uncovered tile, so a cliff or river
 * between the two never wastes an anchor.
 */
function fillCoverage(
  inp: CoreAnchorInput, rule: AnchorRule, field: AnchorField, placed: readonly PlacedAnchor[],
  attempt: (rule: AnchorRule, subject: string, cx: number, cy: number, mandatory: boolean, on?: AnchorField) => PlacedAnchor | null,
): void {
  const d = inp.ctx.d
  const maxWalk = rule.maxWalk ?? 100
  const view = draftView(d)
  const col = buildCollision(view)
  const N = d.w * d.h
  const INF = 65535
  const dist = new Uint16Array(N).fill(INF)
  const queue = new Int32Array(N)
  const elev = d.elevation
  const opts = { surf: false }

  const stepOk = (i: number, j: number, nx: number, ny: number, x: number, y: number): boolean =>
    col[j] === COLLISION_FREE && (elev[i] === elev[j] || canStep(view, col, x, y, nx, ny, opts))

  const relax = (sources: number[]): void => {
    let head = 0, tail = 0
    for (const s of sources) if (dist[s] !== 0) { dist[s] = 0; queue[tail++] = s }
    while (head < tail) {
      const i = queue[head++]
      const nd = dist[i] + 1
      if (nd > maxWalk) continue
      const x = i % d.w, y = (i - x) / d.w
      for (let k = 0; k < 4; k++) {
        const nx = k === 0 ? x + 1 : k === 1 ? x - 1 : x
        const ny = k === 2 ? y + 1 : k === 3 ? y - 1 : y
        if (nx < 0 || ny < 0 || nx >= d.w || ny >= d.h) continue
        const j = ny * d.w + nx
        if (dist[j] <= nd || !stepOk(i, j, nx, ny, x, y)) continue
        dist[j] = nd
        queue[tail++] = j
      }
    }
  }
  /** Free tiles touching the anchor's footprint: where a visitor stands. */
  const standing = (p: PlacedAnchor): number[] => {
    const [fw, fh] = anchorFootprint(p.kind)
    const out: number[] = []
    for (let y = p.y - 1; y <= p.y + fh; y++) for (let x = p.x - 1; x <= p.x + fw; x++) {
      if (!inside(d, x, y) || (x >= p.x && x < p.x + fw && y >= p.y && y < p.y + fh)) continue
      const i = idx(d, x, y)
      if (col[i] === COLLISION_FREE) out.push(i)
    }
    return out
  }
  const block = (p: PlacedAnchor): void => {
    const r = propRect({ prop: A.kinds[p.kind].prop, x: p.x, y: p.y, rot: 0 })
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) col[idx(d, x, y)] = 1
  }
  /** Tiles within `limit` walking steps of tile `from` (breadth-first, same step rule). */
  const scratch = new Int16Array(N).fill(-1)
  const around = (from: number, limit: number): number[] => {
    const seen: number[] = [from]
    scratch[from] = 0
    for (let h = 0; h < seen.length; h++) {
      const i = seen[h]
      if (scratch[i] >= limit) continue
      const x = i % d.w, y = (i - x) / d.w
      for (let k = 0; k < 4; k++) {
        const nx = k === 0 ? x + 1 : k === 1 ? x - 1 : x
        const ny = k === 2 ? y + 1 : k === 3 ? y - 1 : y
        if (nx < 0 || ny < 0 || nx >= d.w || ny >= d.h) continue
        const j = ny * d.w + nx
        if (scratch[j] >= 0 || !stepOk(i, j, nx, ny, x, y)) continue
        scratch[j] = scratch[i] + 1
        seen.push(j)
      }
    }
    for (const i of seen) scratch[i] = -1
    return seen
  }

  relax(placed.flatMap(standing))
  const reachSteps = Math.floor(maxWalk * 0.45)
  for (let i = 0; i < N; i++) {
    if (!inp.walkReach[i] || col[i] !== COLLISION_FREE || dist[i] <= maxWalk) continue
    const region = around(i, reachSteps)
    const inRegion = new Set(region)
    // Inwards = towards the end of the raster sweep: the reachable tile with the largest x + y.
    let target = i, best = -1
    for (const j of region) {
      const v = (j % d.w) + Math.floor(j / d.w)
      if (v > best) { best = v; target = j }
    }
    const confined: AnchorField = {
      foot: (x, y) => inRegion.has(y * d.w + x) && field.foot(x, y),
      ring: (x, y) => field.ring(x, y),
      level: field.level,
      road: field.road,
    }
    const a = attempt(rule, 'fill', target % d.w, Math.floor(target / d.w), false, confined)
      ?? attempt(rule, 'fill', i % d.w, Math.floor(i / d.w), false, confined)
    if (!a) continue
    block(a)
    relax(standing(a))
  }
}
