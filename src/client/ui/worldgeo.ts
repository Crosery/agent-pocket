// Geography lookups for map UIs over the infinite overworld without generating chunks: frontier province
// labels (procedural name, danger tier, level band) and the region / terrain under any tile. Exact where data is
// resident (core continent, generated chunks); elsewhere estimated from the frontier's natural columns (same
// province × biome rule the generator uses). Reads the FrontierProvider's public fields; any other ChunkProvider
// gets sample()-only answers. Pure (no DOM).
import type { ChunkProvider, GameMap, RegionDef } from '../../shared/types.ts'
import { CONTENT } from '../../shared/content/index.ts'
import { regionAt } from '../../shared/world/worldapi.ts'
import { newColumn, type Column, type Fields } from '../../shared/world/frontier/fields.ts'
import { dangerAt, levelRangeAt, nearestProvince, provinceName, provincePoint, provincesNear, regionId } from '../../shared/world/frontier/regions.ts'

interface FrontierLike extends ChunkProvider { readonly fields: Fields }

const asFrontier = (p: ChunkProvider | undefined): FrontierLike | null =>
  p && (p as Partial<FrontierLike>).fields ? (p as FrontierLike) : null

export interface ProvinceLabel { key: string; px: number; py: number; x: number; y: number; nameZh: string; danger: number; levelRange: [number, number] }

const inCore = (p: ChunkProvider, x: number, y: number) =>
  x >= p.core.x && y >= p.core.y && x < p.core.x + p.core.width && y < p.core.y + p.core.height

const PROVINCES = new WeakMap<ChunkProvider, Map<string, ProvinceLabel>>()

/** Frontier provinces whose seed point lies in the tile rect (core excluded). Cached per provider. */
export function provincesIn(p: ChunkProvider, x0: number, y0: number, x1: number, y1: number): ProvinceLabel[] {
  const F = asFrontier(p)?.fields
  if (!F) return []
  let memo = PROVINCES.get(p)
  if (!memo) { memo = new Map(); PROVINCES.set(p, memo) }
  const cell = F.cf.fc.gen.provinces.cell
  const out: ProvinceLabel[] = []
  for (let py = Math.floor(y0 / cell) - 1; py <= Math.floor(y1 / cell) + 1; py++) {
    for (let px = Math.floor(x0 / cell) - 1; px <= Math.floor(x1 / cell) + 1; px++) {
      const key = `${px},${py}`
      let lab = memo.get(key)
      if (!lab) {
        const pv = provincePoint(F, px, py)
        const dist = F.originDist(pv.x, pv.y)
        const danger = dangerAt(F, dist)
        lab = { key, px, py, x: pv.x, y: pv.y, nameZh: provinceName(F, px, py), danger, levelRange: levelRangeAt(F, dist, danger) }
        memo.set(key, lab)
      }
      if (lab.x >= x0 && lab.y >= y0 && lab.x < x1 && lab.y < y1 && !inCore(p, lab.x, lab.y)) out.push(lab)
    }
  }
  return out
}

const COLS = new WeakMap<ChunkProvider, Column>()

/** Natural column at a far tile (no chunk generation); null for non-frontier providers. */
function columnAt(p: ChunkProvider, x: number, y: number): Column | null {
  const F = asFrontier(p)?.fields
  if (!F) return null
  let col = COLS.get(p)
  if (!col) { col = newColumn(); COLS.set(p, col) }
  F.columnAt(x, y, col)
  return col
}

/** Region under a tile of the (possibly infinite) map: exact in the core / resident chunks, else estimated. */
export function regionUnder(map: GameMap, x: number, y: number): RegionDef | null {
  const p = map.infinite
  const tx = Math.floor(x), ty = Math.floor(y)
  if (!p || inCore(p, tx, ty) || p.peek(Math.floor(tx / p.size), Math.floor(ty / p.size))) return regionAt(map, tx, ty)
  const F = asFrontier(p)?.fields
  const col = columnAt(p, tx, ty)
  if (!F || !col) return null
  const provs = provincesNear(F, tx, ty, tx + 1, ty + 1)
  const pv = provs[nearestProvince(provs, tx + col.pwx, ty + col.pwy)]
  return p.region(regionId(pv.px, pv.py, CONTENT.biomes[col.biome]?.id ?? CONTENT.biomes[0].id))
}

/**
 * Cheap terrain + level at a tile for coarse map pixels: exact in the core and resident chunks, natural column
 * elsewhere (bypasses sample()'s sheet heuristics, which would build whole chunk sheets for strided reads).
 */
export function quickSample(p: ChunkProvider, x: number, y: number): { terrain: number; elevation: number } {
  if (inCore(p, x, y) || p.peek(Math.floor(x / p.size), Math.floor(y / p.size))) return p.sample(x, y)
  const col = columnAt(p, x, y)
  return col ? { terrain: col.terrain, elevation: col.level } : p.sample(x, y)
}
