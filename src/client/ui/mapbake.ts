// Pure minimap baking: GameMap / map chunk -> RGBA bitmap (1 pixel per tile). No DOM access.
// Colours come from TerrainDef.minimap + content/ui.json minimap.bake; buildings by PropDef footprint/minimapIcon.
import type { ChunkProvider, GameMap, PropDef, PropPlacement } from '../../shared/types.ts'
import { CONTENT, type Content } from '../../shared/content/index.ts'
import { UI_CONFIG, type MapBakeConfig } from './config.ts'
import { parseColor, shade, tileNoise, type Bitmap, type RGBA } from './pixel.ts'

export interface TileRect { x: number; y: number; w: number; h: number }

/** Footprint rectangle of a placed prop (same convention as shared/world/collision.ts propRect): (x,y) is the
 *  top-left tile of the rotated footprint; odd rotations swap w/d. */
export function propFootprint(p: PropPlacement, def: PropDef): TileRect {
  const [fw, fd] = def.footprint
  const swap = p.rot === 1 || p.rot === 3
  return { x: p.x, y: p.y, w: swap ? fd : fw, h: swap ? fw : fd }
}

/** Tile source for bakeArea: absolute tile coordinates (neighbours outside the area are read too). */
export interface BakeSource {
  terrain(x: number, y: number): number
  /** Elevation level, or `fallback` where unknown (finite map edges). */
  elevation(x: number, y: number, fallback: number): number
}

/**
 * Bakes the tile rect [x0, x0+w) × [y0, y0+h) to RGBA (1 pixel per tile): terrain colour + hillshade, then props
 * anchored anywhere (footprints are clipped to the rect).
 */
export function bakeArea(src: BakeSource, x0: number, y0: number, w: number, h: number, props: readonly PropPlacement[], c: Content = CONTENT, cfg: MapBakeConfig = UI_CONFIG.minimap.bake): Bitmap {
  const data = new Uint8ClampedArray(w * h * 4)
  const unknown = parseColor(cfg.unknownTerrain)
  const terrainColor = terrainColors(c)

  const put = (i: number, col: RGBA) => {
    const o = i * 4
    data[o] = col[0]; data[o + 1] = col[1]; data[o + 2] = col[2]; data[o + 3] = 255
  }
  const get = (i: number): RGBA => [data[i * 4], data[i * 4 + 1], data[i * 4 + 2], 255]

  for (let ly = 0; ly < h; ly++) {
    for (let lx = 0; lx < w; lx++) {
      const x = x0 + lx, y = y0 + ly
      const e = src.elevation(x, y, 0)
      put(ly * w + lx, shadeTile(terrainColor[src.terrain(x, y)] ?? unknown, x, y, e, src.elevation(x - 1, y - 1, e), src.elevation(x, y - 1, e), cfg))
    }
  }

  const eachTile = (r: TileRect, fn: (i: number, x: number, y: number) => void) => {
    for (let y = Math.max(y0, r.y); y < Math.min(y0 + h, r.y + r.h); y++)
      for (let x = Math.max(x0, r.x); x < Math.min(x0 + w, r.x + r.w); x++) fn((y - y0) * w + (x - x0), x, y)
  }

  const solids: { rect: TileRect; color: RGBA }[] = []
  for (const p of props) {
    const def = c.props[p.prop]
    if (!def) continue
    const rect = propFootprint(p, def)
    if (rect.x >= x0 + w || rect.y >= y0 + h || rect.x + rect.w <= x0 || rect.y + rect.h <= y0) continue
    const icon = def.minimapIcon
    if (icon && icon !== 'none') {
      solids.push({ rect, color: parseColor(cfg.building.byIcon[icon] ?? cfg.building.default) })
    } else if (rect.w * rect.h >= cfg.structure.minArea && def.height >= cfg.structure.minHeight) {
      solids.push({ rect, color: parseColor(cfg.structure.color) })
    } else if (def.height >= cfg.canopy.minHeight) {
      eachTile(rect, (i) => put(i, shade(get(i), -cfg.canopy.darken)))
    } else if (def.collide && def.height >= cfg.smallProp.minHeight) {
      eachTile(rect, (i) => put(i, shade(get(i), -cfg.smallProp.darken)))
    }
  }
  for (const sd of solids) {
    const top = sd.rect.y
    const bottom = sd.rect.y + sd.rect.h - 1
    eachTile(sd.rect, (i, _x, y) => {
      const col = y === bottom && sd.rect.h > 1 ? shade(sd.color, -cfg.building.edgeDarken)
        : y === top ? shade(sd.color, cfg.building.roofLight) : sd.color
      put(i, col)
    })
  }
  return { width: w, height: h, data }
}

const COLORS = new WeakMap<Content, RGBA[]>()
function terrainColors(c: Content): RGBA[] {
  let cols = COLORS.get(c)
  if (!cols) { cols = c.terrain.map((t) => parseColor(t.minimap)); COLORS.set(c, cols) }
  return cols
}

/** Terrain colour of one tile with noise, height tint and hillshade (nw / north neighbour levels). */
export function shadeTile(base: RGBA, x: number, y: number, e: number, nw: number, north: number, cfg: MapBakeConfig = UI_CONFIG.minimap.bake): RGBA {
  let col = shade(base, (tileNoise(x, y) - 0.5) * 2 * cfg.noise)
  if (e > 0) col = shade(col, Math.min(1, e * cfg.hillshade.heightTint))
  if (e > nw) col = shade(col, Math.min(1, cfg.hillshade.light * Math.min(2, e - nw)))
  else if (e < nw) col = shade(col, -Math.min(1, cfg.hillshade.shadow * Math.min(2, nw - e)))
  if (north > e) col = shade(col, -cfg.hillshade.cliffShadow)
  return col
}

/** Colour of a terrain id (minimap palette), for samplers that shade by themselves. */
export function terrainColor(id: number, c: Content = CONTENT, cfg: MapBakeConfig = UI_CONFIG.minimap.bake): RGBA {
  return terrainColors(c)[id] ?? parseColor(cfg.unknownTerrain)
}

export function bakeMapPixels(map: GameMap, c: Content = CONTENT, cfg: MapBakeConfig = UI_CONFIG.minimap.bake): Bitmap {
  const { width: w, height: h } = map
  const src: BakeSource = {
    terrain: (x, y) => map.terrain[y * w + x],
    elevation: (x, y, fallback) => (x < 0 || y < 0 || x >= w || y >= h ? fallback : map.elevation[y * w + x]),
  }
  return bakeArea(src, 0, 0, w, h, map.props, c, cfg)
}

/** Source over an infinite map's provider: exact inside the core / resident chunks, natural terrain elsewhere. */
export function providerSource(p: ChunkProvider): BakeSource {
  return {
    terrain: (x, y) => p.sample(x, y).terrain,
    elevation: (x, y) => p.sample(x, y).elevation,
  }
}

/**
 * One chunk of an infinite map (chunk-size pixels). Props come from resident chunks only (the chunk and its W / N /
 * NW neighbours whose footprints can spill in); `full` is false when some of them were not generated yet.
 */
export function bakeChunkPixels(p: ChunkProvider, cx: number, cy: number, c: Content = CONTENT, cfg: MapBakeConfig = UI_CONFIG.minimap.bake): { bmp: Bitmap; full: boolean } {
  const S = p.size
  const inCore = (x: number, y: number) => x >= 0 && y >= 0 && (x + 1) * S <= p.core.x + p.core.width && (y + 1) * S <= p.core.y + p.core.height
  const props: PropPlacement[] = []
  let full = true
  for (const [dx, dy] of [[0, 0], [-1, 0], [0, -1], [-1, -1]] as const) {
    const ch = inCore(cx + dx, cy + dy) ? p.chunk(cx + dx, cy + dy) : p.peek(cx + dx, cy + dy)
    if (ch) props.push(...ch.props)
    else full = false
  }
  return { bmp: bakeArea(providerSource(p), cx * S, cy * S, S, S, props, c, cfg), full }
}

export interface StaticMarker { x: number; y: number; kind: string; rect: TileRect }

/** Building markers derived from props that declare a minimapIcon, at the footprint centre (tile i spans [i, i+1)). */
export function buildingMarkers(map: GameMap, c: Content = CONTENT): StaticMarker[] {
  const out: StaticMarker[] = []
  for (const p of map.props) {
    const def = c.props[p.prop]
    const icon = def?.minimapIcon
    if (!def || !icon || icon === 'none') continue
    const rect = propFootprint(p, def)
    out.push({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2, kind: icon, rect })
  }
  return out
}

export interface RegionLabel { index: number; x: number; y: number; tiles: number }

/** Centroid of every region index present in map.region (used to label towns on the expanded map). */
export function regionCentroids(map: GameMap): RegionLabel[] {
  const acc = new Map<number, { sx: number; sy: number; n: number }>()
  const { width: w, height: h } = map
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const r = map.region[y * w + x]
      let a = acc.get(r)
      if (!a) { a = { sx: 0, sy: 0, n: 0 }; acc.set(r, a) }
      a.sx += x; a.sy += y; a.n++
    }
  }
  return [...acc.entries()].map(([index, a]) => ({ index, x: a.sx / a.n, y: a.sy / a.n, tiles: a.n }))
}
