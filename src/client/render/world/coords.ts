// Tile/world conventions shared by every overworld render module (pure: no three, no DOM). They follow
// src/shared/world/collision.ts:
//
//   Tile (tx, ty) spans world x in [tx, tx+1), z in [ty, ty+1); its centre is (tx + 0.5, ty + 0.5).
//   Float "tile coords" given to actors / elevationAt / worldToScreen / spawnFx use the same continuous space
//   (tile index = floor(coord)). World Y of a tile top = elevation level * config.world.levelHeight.
//   PropPlacement (x, y) is the TOP-LEFT tile of the rotated footprint; rot = quarter turns counter-clockwise
//   (rotation.y = rot * PI/2), facade +Z faces south at rot 0. PropDef.door is relative to the footprint
//   centre tile (floor(w/2), floor(d/2)) at rot 0 and points at the tile in front of the facade.
//
//   Infinite maps (GameMap.infinite): every tile at any integer coordinate (negative included) exists; the helpers
//   below read them through the shared WorldApi (chunks generated on demand). Streaming code reads tiles through a
//   TerrainSampler instead (terrain.ts), which caches world chunks and never generates outside its ensure() stage.
import { CONTENT, type Content } from '../../../shared/content/index.ts'
import type { BiomeDef, GameMap, PropDef, PropPlacement, TerrainDef } from '../../../shared/types.ts'
import { elevationAt as worldElevationAt, regionAt as worldRegionAt, terrainAt as worldTerrainAt } from '../../../shared/world/worldapi.ts'
import { RENDER, type RenderContent, type SurfaceDef } from '../config.ts'

export const tileOf = (v: number) => Math.floor(v)

export function inBounds(map: GameMap, tx: number, ty: number): boolean {
  return map.infinite !== undefined || (tx >= 0 && ty >= 0 && tx < map.width && ty < map.height)
}

export function terrainAt(map: GameMap, tx: number, ty: number, c: Content = CONTENT): TerrainDef | null {
  if (map.infinite) return c.terrain[worldTerrainAt(map, tx, ty)] ?? null
  if (!inBounds(map, tx, ty)) return null
  return c.terrain[map.terrain[ty * map.width + tx]] ?? null
}

export function levelAt(map: GameMap, tx: number, ty: number): number {
  if (map.infinite) return worldElevationAt(map, tx, ty)
  return inBounds(map, tx, ty) ? map.elevation[ty * map.width + tx] : 0
}

export function biomeAt(map: GameMap, tx: number, ty: number, c: Content = CONTENT): BiomeDef | null {
  if (map.infinite) { const r = worldRegionAt(map, tx, ty); return (r && c.biomeById[r.biome]) ?? null }
  if (!inBounds(map, tx, ty)) return null
  const region = map.regions[map.region[ty * map.width + tx]]
  return (region && c.biomeById[region.biome]) ?? null
}

export function surfaceAt(map: GameMap, tx: number, ty: number, r: RenderContent = RENDER, c: Content = CONTENT): SurfaceDef | null {
  const t = terrainAt(map, tx, ty, c)
  if (!t) return null
  const s = r.terrain.mapKindSurfaces[map.kind]?.[t.key] ?? r.terrain.surfaces[t.key]
  if (s) return s
  return t.liquid ? r.terrain.defaultLiquid : null
}

export function isLiquidSurface(s: SurfaceDef | null): boolean {
  return !!s && (s.kind === 'water' || s.kind === 'lava')
}

// ---------------------------------------------------------------------------
// Stairs: a stairs tile ramps one level toward its higher neighbour (or from its lower neighbour).
// ---------------------------------------------------------------------------

export interface StairsRamp {
  axis: 'x' | 'y'
  /** +1 when the high end is toward +axis. */
  dir: 1 | -1
  lowLevel: number
  highLevel: number
}

/** Tile reads needed by the stairs rule (a map, or a TerrainSampler's cached tiles). */
export interface LevelGrid {
  inside(tx: number, ty: number): boolean
  level(tx: number, ty: number): number
  stairs(tx: number, ty: number): boolean
}

export function stairsRamp(map: GameMap, tx: number, ty: number, c: Content = CONTENT): StairsRamp | null {
  return rampOf({ inside: (x, y) => inBounds(map, x, y), level: (x, y) => levelAt(map, x, y), stairs: (x, y) => !!terrainAt(map, x, y, c)?.stairs }, tx, ty)
}

export function rampOf(g: LevelGrid, tx: number, ty: number): StairsRamp | null {
  if (!g.stairs(tx, ty)) return null
  const e = g.level(tx, ty)
  const nb = (x: number, y: number) => (g.inside(x, y) ? g.level(x, y) : e)
  const evalAxis = (a: number, b: number) => {
    // a = level toward -axis, b = toward +axis
    if (Math.max(a, b) > e) return { diff: Math.max(a, b) - e, dir: (b > a ? 1 : -1) as 1 | -1, low: e, high: e + 1 }
    if (Math.min(a, b) < e) return { diff: e - Math.min(a, b), dir: (b > a ? 1 : -1) as 1 | -1, low: e - 1, high: e }
    return null
  }
  const ax = evalAxis(nb(tx - 1, ty), nb(tx + 1, ty))
  const ay = evalAxis(nb(tx, ty - 1), nb(tx, ty + 1))
  const pick = ay && (!ax || ay.diff >= ax.diff) ? { ...ay, axis: 'y' as const } : ax ? { ...ax, axis: 'x' as const } : null
  if (!pick) return null
  return { axis: pick.axis, dir: pick.dir, lowLevel: pick.low, highLevel: pick.high }
}

/** 0..1 position along a ramp's axis from its low end, for a local point (lx, lz in 0..1, 0 = west/north). */
export function rampParam(r: StairsRamp, lx: number, lz: number): number {
  const s = r.axis === 'x' ? lx : lz
  return r.dir > 0 ? s : 1 - s
}

/** Smooth walking height (world units) at float tile coords, honoring stairs ramps and liquid surfaces. */
export function walkHeight(map: GameMap, x: number, y: number, c: Content = CONTENT, r: RenderContent = RENDER): number {
  const tx = tileOf(x), ty = tileOf(y)
  if (!inBounds(map, tx, ty)) return 0
  const lh = c.config.world.levelHeight
  const ramp = stairsRamp(map, tx, ty, c)
  if (ramp) {
    const s = rampParam(ramp, x - tx, y - ty)
    const k = Math.min(1, Math.max(0, s))
    return (ramp.lowLevel + (ramp.highLevel - ramp.lowLevel) * k) * lh
  }
  const base = levelAt(map, tx, ty) * lh
  return isLiquidSurface(surfaceAt(map, tx, ty, r, c)) ? base - r.terrain.liquidDrop : base
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface FootprintRect { x0: number; y0: number; w: number; d: number }

export function footprintRect(p: PropPlacement, def: PropDef): FootprintRect {
  const odd = (p.rot & 1) === 1
  const w = odd ? def.footprint[1] : def.footprint[0]
  const d = odd ? def.footprint[0] : def.footprint[1]
  return { x0: p.x, y0: p.y, w, d }
}

/** World x/z of the footprint centre. */
export function footprintCenter(p: PropPlacement, def: PropDef): { x: number; z: number } {
  const r = footprintRect(p, def)
  return { x: r.x0 + r.w / 2, z: r.y0 + r.d / 2 }
}

/** Opening centre (world units, rot-0 frame) relative to the footprint centre. */
export function doorOffsetX(def: PropDef): number | null {
  if (!def.door) return null
  const [lo, hi] = def.doorSpan ?? [0, 0]
  return Math.floor(def.footprint[0] / 2) + def.door[0] + 0.5 - def.footprint[0] / 2 + (lo + hi) / 2
}

/** Yaw (radians) for a placement rotation; rot 1 turns the +Z facade toward +X. */
export const rotYaw = (rot: number) => (rot & 3) * Math.PI / 2

/** Deterministic 0..1 hash of integer coords (+ salt). */
export function hash2(x: number, y: number, salt = 0): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(salt | 0, 2147483647)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

export function hashString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}

/** Smooth value noise in 0..1 (for large-scale tint variation). */
export function valueNoise(x: number, y: number, salt = 0): number {
  const x0 = Math.floor(x), y0 = Math.floor(y)
  const fx = x - x0, fy = y - y0
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy)
  const a = hash2(x0, y0, salt), b = hash2(x0 + 1, y0, salt)
  const c = hash2(x0, y0 + 1, salt), d = hash2(x0 + 1, y0 + 1, salt)
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy
}
