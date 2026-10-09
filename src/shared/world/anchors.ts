// Teleport anchors as the game sees them: props of the overworld (core continent and frontier) identified by
// kind and footprint tile. Queries only; placement lives in anchor-place.ts, tuning in content/world/anchors.json.
import type { GameMap, PropPlacement, World } from '../types.ts'
import { CONTENT } from '../content/index.ts'
import { WORLD_CONTENT } from './data.ts'
import { anchorId, parseAnchorId } from './anchor-ids.ts'
import { objectsInRect } from './worldapi.ts'
import type { AnchorKindId, AnchorKindSpec } from './schema.ts'

export { anchorId, parseAnchorId } from './anchor-ids.ts'

const KINDS = WORLD_CONTENT.anchors.kinds

export interface AnchorSpot {
  id: string
  kind: AnchorKindId
  /** Footprint top-left and size (tiles). */
  x: number
  y: number
  w: number
  h: number
  /** Footprint centre (tile units, i.e. x + w / 2). */
  cx: number
  cy: number
  /** The tile a visitor stands on: south of the footprint, centred. */
  front: { x: number; y: number }
}

const KIND_OF_PROP = new Map<string, AnchorKindId>((Object.keys(KINDS) as AnchorKindId[]).map((k) => [KINDS[k].prop, k]))

export const anchorKindSpec = (kind: AnchorKindId): AnchorKindSpec => KINDS[kind]

export function isAnchorProp(prop: string): boolean { return KIND_OF_PROP.has(prop) }

function spotAt(kind: AnchorKindId, x: number, y: number): AnchorSpot {
  const [w, h] = CONTENT.props[KINDS[kind].prop].footprint
  return { id: anchorId(kind, x, y), kind, x, y, w, h, cx: x + w / 2, cy: y + h / 2, front: { x: x + Math.floor(w / 2), y: y + h } }
}

export function anchorSpotOf(p: PropPlacement): AnchorSpot | null {
  const kind = KIND_OF_PROP.get(p.prop)
  return kind ? spotAt(kind, p.x, p.y) : null
}

/** Spot of a stored id (saves keep only ids), or null for junk. */
export function anchorSpotFromId(id: string): AnchorSpot | null {
  const a = parseAnchorId(id)
  return a ? spotAt(a.kind, a.x, a.y) : null
}

/** Anchors anchored inside [x0,x1) x [y0,y1) (generates the covering frontier chunks on demand). */
export function anchorsInRect(map: GameMap, x0: number, y0: number, x1: number, y1: number): AnchorSpot[] {
  const out: AnchorSpot[] = []
  for (const p of objectsInRect(map, x0, y0, x1, y1).props) {
    const s = anchorSpotOf(p)
    if (s) out.push(s)
  }
  return out
}

const CORE = new WeakMap<World, AnchorSpot[]>()

/** Every anchor of the core continent (cheap, cached; the frontier is queried by rect). */
export function coreAnchors(world: World): AnchorSpot[] {
  let list = CORE.get(world)
  if (!list) {
    const map = world.maps[world.startMap]
    list = []
    for (const p of map?.props ?? []) {
      const s = anchorSpotOf(p)
      if (s) list.push(s)
    }
    CORE.set(world, list)
  }
  return list
}

const spawnOf = (world: World) => world.maps[world.startMap]?.spawn ?? { x: 0, y: 0 }

/** The grand anchor nearest the start town: where "回原点" takes you. */
export function homeAnchor(world: World): AnchorSpot | null {
  const sp = spawnOf(world)
  let best: AnchorSpot | null = null
  let bd = Infinity
  for (const a of coreAnchors(world)) {
    if (a.kind !== 'grand') continue
    const d = Math.hypot(a.cx - sp.x, a.cy - sp.y)
    if (d < bd) { bd = d; best = a }
  }
  return best
}

/** Anchors active from a fresh save: the grand ones at the start (content preUnlock.grandWithin). */
export function preUnlockedIds(world: World): string[] {
  const sp = spawnOf(world)
  const R = WORLD_CONTENT.anchors.preUnlock.grandWithin
  return coreAnchors(world).filter((a) => a.kind === 'grand' && Math.hypot(a.cx - sp.x, a.cy - sp.y) <= R).map((a) => a.id)
}
