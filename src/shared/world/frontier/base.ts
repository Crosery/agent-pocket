// Base terrain of any frontier rectangle: climate columns + flattened site pads + graded roads with shoulders.
// Pure function of the rect's tiles (roads are rasterised one tile beyond the rect so shoulders at the border
// match the neighbouring rect). Chunks and site-layout windows both start from this.
import { Fields, newColumn, W_NONE, W_SEA, type Column } from './fields.ts'
import type { RoadEdge, RoadNet } from './roads.ts'
import type { FrontierSite, SiteGrid } from './sites.ts'

export const B_ROAD = 1
export const B_SHOULDER = 2
export const B_PAD = 4
export const B_BRIDGE = 8
export const B_RSTAIRS = 16

export interface BaseArea {
  x0: number
  y0: number
  w: number
  h: number
  terrain: Uint8Array
  level: Uint8Array
  biome: Uint8Array
  /** W_* water kind of the natural column (before pads / roads). */
  water: Uint8Array
  deep: Uint8Array
  flags: Uint8Array
  /** Continentalness (sea depth for decor) and province warp offsets. */
  cont: Float32Array
  pwx: Float32Array
  pwy: Float32Array
  sites: FrontierSite[]
  edges: RoadEdge[]
}

export interface BaseDeps { fields: Fields; grid: SiteGrid; roads: RoadNet }

export function baseArea(deps: BaseDeps, x0: number, y0: number, w: number, h: number): BaseArea {
  const F = deps.fields
  const cf = F.cf
  const n = w * h
  const a: BaseArea = {
    x0, y0, w, h,
    terrain: new Uint8Array(n), level: new Uint8Array(n), biome: new Uint8Array(n), water: new Uint8Array(n), deep: new Uint8Array(n),
    flags: new Uint8Array(n), cont: new Float32Array(n), pwx: new Float32Array(n), pwy: new Float32Array(n), sites: [], edges: [],
  }
  const sheet = F.sheet(x0, y0, x0 + w - 1, y0 + h - 1)
  const col: Column = newColumn()
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    F.column(x0 + x, y0 + y, sheet, col)
    const i = y * w + x
    a.terrain[i] = col.terrain
    a.level[i] = col.level
    a.biome[i] = col.biome
    a.water[i] = col.water
    a.deep[i] = col.deep ? 1 : 0
    a.cont[i] = col.cont
    a.pwx[i] = col.pwx
    a.pwy[i] = col.pwy
  }

  // Site pads: flat at the site level (water inside the pad is filled), blended into the terrain around.
  const blend = cf.fc.sites.pad.blend
  a.sites = deps.grid.sitesNear(x0, y0, x0 + w, y0 + h, deps.grid.maxRadius + blend + 2)
  for (const s of a.sites) {
    const R = s.radius, Rb = R + blend
    const bx0 = Math.max(0, Math.floor(s.x - Rb) - x0), bx1 = Math.min(w - 1, Math.ceil(s.x + Rb) - x0)
    const by0 = Math.max(0, Math.floor(s.y - Rb) - y0), by1 = Math.min(h - 1, Math.ceil(s.y + Rb) - y0)
    for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
      const i = y * w + x
      if (a.water[i] === W_SEA) continue
      const dx = x0 + x - s.x, dy = y0 + y - s.y
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d <= R) {
        a.level[i] = s.level
        a.flags[i] |= B_PAD
        if (a.water[i] !== W_NONE) {
          const bt = cf.biome[a.biome[i]]
          a.terrain[i] = bt ? bt.ground : cf.roadDefault
        }
      } else if (d <= Rb && a.water[i] === W_NONE) {
        const t = (d - R) / blend
        a.level[i] = Math.round(s.level + (a.level[i] - s.level) * t)
      }
    }
  }

  // Roads (+1 tile ring so shoulders at the rect border agree with the neighbour rect).
  a.edges = deps.roads.edgesNear(x0 - 1, y0 - 1, x0 + w + 1, y0 + h + 1, 1)
  const RW = w + 2, RH = h + 2
  const rLevel = new Int16Array(RW * RH).fill(-1)
  for (const e of a.edges) {
    for (let k = 0; k < e.xs.length; k++) {
      if (!e.drawn[k]) continue
      const rx = e.xs[k] - x0 + 1, ry = e.ys[k] - y0 + 1
      if (rx < 0 || ry < 0 || rx >= RW || ry >= RH) continue
      rLevel[ry * RW + rx] = e.levels[k]
      const x = rx - 1, y = ry - 1
      if (x < 0 || y < 0 || x >= w || y >= h) continue
      const i = y * w + x
      a.terrain[i] = e.terrain[k]
      a.level[i] = e.levels[k]
      a.flags[i] = (a.flags[i] & ~(B_SHOULDER | B_BRIDGE | B_RSTAIRS)) | B_ROAD
      if (e.terrain[k] === cf.stairs) a.flags[i] |= B_RSTAIRS
      if (a.water[i] !== W_NONE) a.flags[i] |= B_BRIDGE
    }
  }
  // Shoulders: dry, non-road, non-pad tiles next to a road take the road's level (first road in id order wins).
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x
    if (a.flags[i] & (B_ROAD | B_PAD) || a.water[i] !== W_NONE) continue
    const ri = (y + 1) * RW + (x + 1)
    let lv = -1
    for (const j of [ri - RW, ri + RW, ri - 1, ri + 1]) if (rLevel[j] >= 0) { lv = rLevel[j]; break }
    if (lv < 0) continue
    a.level[i] = lv
    a.flags[i] |= B_SHOULDER
  }
  return a
}
