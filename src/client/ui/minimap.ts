// North-up circular minimap (gold pixel ring, compass N) + expanded translucent map overlay.
// Map pixels: bakeMapImage() for finite maps; infinite maps (GameMap.infinite) are drawn from per-chunk tiles
// baked on demand (bakeChunkPixels, LRU cache) with a per-chunk fog layer from the sparse FogPages.
// Fog-of-war: per-chunk bitset (CONTENT.config.world.chunk); markers: glyphs from content/ui.json
// minimap.markers keyed by MinimapMarker.kind.
import type { ChunkProvider, Dir, GameMap, MapChunk, PropPlacement } from '../../shared/types.ts'
import type { Minimap, MinimapMarker } from '../contracts.ts'
import { CONTENT, t } from '../../shared/content/index.ts'
import { objectsInRect } from '../../shared/world/worldapi.ts'
import { EXPLORE } from '../world/explore-config.ts'
import { UI_CONFIG, type MarkerStyle } from './config.ts'
import { decodeBits, encodeBits, fogGrid, hasBit, isTileExplored, normalizeBits, revealAround, type FogGrid, type FogPages } from './fog.ts'
import { glyphEl, glyphSource } from './glyphs.ts'
import { bakeChunkPixels, bakeMapPixels, buildingMarkers, propFootprint, regionCentroids, type StaticMarker } from './mapbake.ts'
import { parseColor, type Bitmap, type RGBA } from './pixel.ts'
import { ensureUIEnvironment, getUIScale, onUIScaleChange, prepareRoot } from './scale.ts'
import { el, keyHint } from './widgets.ts'

export interface MinimapHandle extends Minimap {
  readonly el: HTMLElement
  readonly expanded: boolean
  /** Fog of war of an infinite map (shared with the controller / world map); null = no fog. */
  setFogPages(pages: FogPages | null): void
  dispose(): void
}

function bitmapCanvas(bmp: Bitmap): HTMLCanvasElement {
  const cv = document.createElement('canvas')
  cv.width = Math.max(1, bmp.width)
  cv.height = Math.max(1, bmp.height)
  if (bmp.width && bmp.height) cv.getContext('2d')!.putImageData(new ImageData(bmp.data, bmp.width, bmp.height), 0, 0)
  return cv
}

/** Building markers of loose prop placements (infinite maps: the props around the player). */
function propMarkers(props: readonly PropPlacement[]): StaticMarker[] {
  const out: StaticMarker[] = []
  for (const p of props) {
    const def = CONTENT.props[p.prop]
    const icon = def?.minimapIcon
    if (!def || !icon || icon === 'none') continue
    const rect = propFootprint(p, def)
    out.push({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2, kind: icon, rect })
  }
  return out
}

const REGION_STATS = new WeakMap<MapChunk, Map<number, { sx: number; sy: number; n: number }>>()
/** Per-chunk tile sums by local region index (labels of the expanded infinite map). */
function chunkRegionStats(ch: MapChunk): Map<number, { sx: number; sy: number; n: number }> {
  let st = REGION_STATS.get(ch)
  if (st) return st
  st = new Map()
  const S = ch.size
  for (let i = 0; i < S * S; i++) {
    const r = ch.region[i]
    let a = st.get(r)
    if (!a) { a = { sx: 0, sy: 0, n: 0 }; st.set(r, a) }
    a.sx += ch.cx * S + (i % S); a.sy += ch.cy * S + Math.floor(i / S); a.n++
  }
  REGION_STATS.set(ch, st)
  return st
}

/** Pixel-dithered fog over one chunk from sparse fog pages (same falloff as the finite fog canvas). */
function bakeChunkFog(pages: FogPages, cx: number, cy: number, S: number): HTMLCanvasElement {
  const cv = document.createElement('canvas')
  cv.width = S
  cv.height = S
  const g = cv.getContext('2d')!
  const img = g.createImageData(S, S)
  const col = parseColor(CFG.fog.color)
  const alpha = Math.round(255 * CFG.fog.alpha)
  const C = pages.cell
  const ox = cx * S, oy = cy * S
  for (let qy = Math.floor(oy / C); qy <= Math.floor((oy + S - 1) / C); qy++) {
    for (let qx = Math.floor(ox / C); qx <= Math.floor((ox + S - 1) / C); qx++) {
      if (pages.hasCell(qx, qy)) continue
      const near: [number, number, number, number][] = []
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if ((dx || dy) && pages.hasCell(qx + dx, qy + dy)) {
          const x0 = (qx + dx) * C, y0 = (qy + dy) * C
          near.push([x0, y0, x0 + C - 1, y0 + C - 1])
        }
      }
      for (let y = Math.max(oy, qy * C); y < Math.min(oy + S, (qy + 1) * C); y++) {
        for (let x = Math.max(ox, qx * C); x < Math.min(ox + S, (qx + 1) * C); x++) {
          let d = Infinity
          for (const [x0, y0, x1, y1] of near) {
            const ddx = x < x0 ? x0 - x : x > x1 ? x - x1 : 0
            const ddy = y < y0 ? y0 - y : y > y1 ? y - y1 : 0
            d = Math.min(d, Math.max(ddx, ddy))
          }
          if (d <= CFG.fog.ditherTiles) {
            if (d === 1 && ((x + y) & 1) === 0) continue
            if (d === 2 && (x & 1) === 0 && (y & 1) === 0) continue
          }
          const i = ((y - oy) * S + (x - ox)) * 4
          img.data[i] = col[0]; img.data[i + 1] = col[1]; img.data[i + 2] = col[2]; img.data[i + 3] = alpha
        }
      }
    }
  }
  g.putImageData(img, 0, 0)
  return cv
}

/** Version stamp of the fog pages a chunk's fog layer depends on (chunk ± one cell). */
function fogStamp(pages: FogPages, cx: number, cy: number, S: number): string {
  const span = pages.cell * pages.pageCells
  const x0 = cx * S - pages.cell, y0 = cy * S - pages.cell, x1 = (cx + 1) * S + pages.cell, y1 = (cy + 1) * S + pages.cell
  let out = ''
  for (let py = Math.floor(y0 / span); py <= Math.floor((y1 - 1) / span); py++) {
    for (let px = Math.floor(x0 / span); px <= Math.floor((x1 - 1) / span); px++) out += `${pages.pageVersion(px, py)},`
  }
  return out
}

const CFG = UI_CONFIG.minimap
const ROTATION: Record<Dir, number> = { up: 0, right: 1, down: 2, left: 3 }

/** 1 pixel per tile image of a finite map (terrain colours, hillshade, props, buildings). */
export function bakeMapImage(map: GameMap): HTMLCanvasElement {
  return bitmapCanvas(bakeMapPixels(map))
}

/** One chunk of an infinite map as a canvas; `full` = every prop source chunk was resident. */
export function bakeChunkImage(p: ChunkProvider, cx: number, cy: number): { cv: HTMLCanvasElement; full: boolean } {
  const { bmp, full } = bakeChunkPixels(p, cx, cy)
  return { cv: bitmapCanvas(bmp), full }
}

/** SaveData.exploredChunks helpers. */
export const encodeExplored = encodeBits
export function decodeExplored(s: string | undefined, map: GameMap): Uint8Array | null {
  if (!s) return null
  return decodeBits(s, fogGrid(map.width, map.height, CONTENT.config.world.chunk).bytes)
}

const styleOf = (kind: string): MarkerStyle => CFG.markers[kind] ?? CFG.markers[CFG.fallbackMarker]

/** Theme colour from styles.css custom properties (transparent if the stylesheet is missing). */
function cssColor(name: string): RGBA {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v ? parseColor(v) : [0, 0, 0, 0]
}

/** Pixel gold ring with bevel lighting and three studs (N carries the compass label). */
function drawRing(cv: HTMLCanvasElement, size: number, ring: number): void {
  const d = size + ring * 2
  cv.width = d
  cv.height = d
  const ctx = cv.getContext('2d')!
  const img = ctx.createImageData(d, d)
  const ink = cssColor('--ap-ink')
  const gold = cssColor('--ap-gold')
  const hi = cssColor('--ap-gold-hi')
  const dk = cssColor('--ap-gold-dk')
  const shadeCfg = CFG.ringShade
  const c = d / 2
  const r0 = size / 2
  for (let y = 0; y < d; y++) {
    for (let x = 0; x < d; x++) {
      const dx = x + 0.5 - c
      const dy = y + 0.5 - c
      const dist = Math.hypot(dx, dy)
      let col: RGBA | null = null
      if (dist >= r0 - 1 && dist < r0) col = [ink[0], ink[1], ink[2], shadeCfg.innerShadowAlpha]
      else if (dist >= r0 && dist < r0 + 1) col = dk
      else if (dist >= r0 + 1 && dist < r0 + ring - 1) {
        const light = (-dx - dy) / (dist * Math.SQRT2)
        col = light > shadeCfg.highlightAbove ? hi : light < shadeCfg.shadowBelow ? dk : gold
      } else if (dist >= r0 + ring - 1 && dist < r0 + ring) col = ink
      if (!col) continue
      const i = (y * d + x) * 4
      img.data[i] = col[0]; img.data[i + 1] = col[1]; img.data[i + 2] = col[2]; img.data[i + 3] = col[3]
    }
  }
  ctx.putImageData(img, 0, 0)
  const stud = glyphSource('diamond')
  const rr = r0 + ring / 2
  for (const a of [0, Math.PI / 2, Math.PI]) {
    ctx.drawImage(stud, Math.round(c + Math.cos(a) * rr - stud.width / 2), Math.round(c + Math.sin(a) * rr - stud.height / 2))
  }
}

function makeMask(size: number): HTMLCanvasElement {
  const cv = document.createElement('canvas')
  cv.width = size
  cv.height = size
  const ctx = cv.getContext('2d')!
  const img = ctx.createImageData(size, size)
  const c = size / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (Math.hypot(x + 0.5 - c, y + 0.5 - c) < c) img.data[(y * size + x) * 4 + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  return cv
}

export function createMinimap(root: HTMLElement): MinimapHandle {
  ensureUIEnvironment()
  prepareRoot(root)

  const mapCv = el('canvas', 'ap-mm-map')
  const ringCv = el('canvas', 'ap-mm-ring')
  const north = el('div', { class: 'ap-mm-north', text: t('hud.minimap.north'), attrs: { 'aria-hidden': 'true' } })
  const box = el('div', { class: 'ap-minimap', attrs: { role: 'img', 'aria-label': t('hud.minimap.title') } }, [mapCv, ringCv, north])
  const layer = el('div', 'ap-layer ap-l-minimap', [box])
  const tapFns = new Set<() => void>()
  box.addEventListener('click', () => { for (const fn of [...tapFns]) fn() })

  const closeHint = el('span', 'ap-mapview-close')
  /** The overlay closes on any tap, so a phone gets that wording instead of a key cap it does not have. */
  const paintCloseHint = () => closeHint.replaceChildren(
    document.documentElement.dataset.touchControls === 'on'
      ? el('span', 'ap-key', [t('hud.minimap.closeTouch')])
      : keyHint('minimap', { label: t('hud.minimap.close') }))
  const viewTitle = el('div', 'ap-panel-title')
  const viewCv = el('canvas')
  const viewLabels = el('div')
  const legend = el('div', 'ap-mapview-legend')
  const viewFrame = el('div', 'ap-panel ap-mapview-frame', [
    viewTitle,
    el('div', 'ap-mapview-body', [
      el('div', 'ap-mapview-canvas-wrap', [viewCv, viewLabels]),
      el('div', 'ap-mapview-side', [legend, closeHint]),
    ]),
  ])
  const view = el('div', { class: 'ap-mapview', attrs: { role: 'dialog', 'aria-label': t('hud.minimap.title') } }, [viewFrame])
  const viewLayer = el('div', 'ap-layer ap-l-mapview', [view])
  root.append(viewLayer, layer)
  view.addEventListener('click', () => api.setExpanded(false))

  let size = 0
  let mask: HTMLCanvasElement | null = null
  let map: GameMap | null = null
  let baked: HTMLCanvasElement | null = null
  let fogCv: HTMLCanvasElement | null = null
  let grid: FogGrid | null = null
  let bits: Uint8Array | null = null
  let statics: StaticMarker[] = []
  let cam = { x: 0, y: 0 }
  let snap = true
  let lastTime = 0
  let player = { x: 0, y: 0, facing: 'down' as Dir }
  let markers: MinimapMarker[] = []
  let route: readonly { x: number; y: number }[] = []
  let expanded = false
  let visible = true
  let legendKey = ''
  let viewK = 1
  // Infinite maps: provider, fog pages, chunk tile caches (insertion-ordered LRU), view window of the expanded map.
  let inf: ChunkProvider | null = null
  let pages: FogPages | null = null
  const chunkTiles = new Map<string, { cv: HTMLCanvasElement; full: boolean }>()
  const fogTiles = new Map<string, { cv: HTMLCanvasElement; stamp: string }>()
  let bakedThisFrame = 0
  let staticsKey = ''
  let viewOrigin = { x: 0, y: 0 }
  let viewTiles = 0
  const IM = EXPLORE.minimap

  const lruGet = <V>(m: Map<string, V>, k: string): V | undefined => {
    const v = m.get(k)
    if (v !== undefined) { m.delete(k); m.set(k, v) }
    return v
  }
  const lruSet = <V>(m: Map<string, V>, k: string, v: V) => {
    m.delete(k)
    m.set(k, v)
    while (m.size > IM.chunkCache) m.delete(m.keys().next().value!)
  }

  /** Terrain tile of chunk (cx, cy); baked within the per-frame budget (null = not yet). */
  const chunkTile = (cx: number, cy: number): HTMLCanvasElement | null => {
    const p = inf!
    const k = `${cx},${cy}`
    const hit = lruGet(chunkTiles, k)
    const upgradable = hit && !hit.full && !!p.peek(cx, cy) && !!p.peek(cx - 1, cy) && !!p.peek(cx, cy - 1) && !!p.peek(cx - 1, cy - 1)
    if (hit && !upgradable) return hit.cv
    if (bakedThisFrame >= IM.bakePerFrame) return hit?.cv ?? null
    bakedThisFrame++
    const tile = bakeChunkImage(p, cx, cy)
    lruSet(chunkTiles, k, tile)
    return tile.cv
  }

  const fogTile = (cx: number, cy: number): HTMLCanvasElement | null => {
    if (!pages || !inf) return null
    const S = inf.size
    const k = `${cx},${cy}`
    const stamp = fogStamp(pages, cx, cy, S)
    const hit = lruGet(fogTiles, k)
    if (hit && hit.stamp === stamp) return hit.cv
    const cv = bakeChunkFog(pages, cx, cy, S)
    lruSet(fogTiles, k, { cv, stamp })
    return cv
  }

  /** Draws the tile rect starting at (sx, sy), `span` tiles wide, scaled by `k` px per tile (infinite maps). */
  const drawChunks = (ctx: CanvasRenderingContext2D, sx: number, sy: number, spanX: number, spanY: number, k: number) => {
    const S = inf!.size
    for (let cy = Math.floor(sy / S); cy <= Math.floor((sy + spanY) / S); cy++) {
      for (let cx = Math.floor(sx / S); cx <= Math.floor((sx + spanX) / S); cx++) {
        const dx = (cx * S - sx) * k, dy = (cy * S - sy) * k
        const tile = chunkTile(cx, cy)
        if (tile) ctx.drawImage(tile, dx, dy, S * k, S * k)
        const fog = fogTile(cx, cy)
        if (fog) ctx.drawImage(fog, dx, dy, S * k, S * k)
      }
    }
  }

  /** Building markers around the player (infinite maps), refreshed when the player's chunk changes. */
  const refreshStatics = (px: number, py: number) => {
    if (!inf || !map || !CFG.autoBuildingMarkers) return
    const S = inf.size
    const key = `${Math.floor(px / S)},${Math.floor(py / S)}`
    if (key === staticsKey) return
    staticsKey = key
    const R = IM.markerRadius
    statics = propMarkers(objectsInRect(map, Math.floor(px) - R, Math.floor(py) - R, Math.floor(px) + R, Math.floor(py) + R).props)
  }

  const resize = () => {
    const next = getUIScale().compact ? CFG.compactSize : CFG.size
    if (next === size) return
    size = next
    mapCv.width = size
    mapCv.height = size
    mask = makeMask(size)
    drawRing(ringCv, size, CFG.ring)
    draw()
  }

  const rebuildFog = () => {
    if (!map) return
    if (inf || !grid || !bits) { fogCv = null; return }
    const { width: w, height: h } = map
    if (!fogCv) fogCv = document.createElement('canvas')
    fogCv.width = w
    fogCv.height = h
    const ctx = fogCv.getContext('2d')!
    const img = ctx.createImageData(w, h)
    const col = parseColor(CFG.fog.color)
    const alpha = Math.round(255 * CFG.fog.alpha)
    const g = grid
    const explored = (cx: number, cy: number) => cx >= 0 && cy >= 0 && cx < g.cols && cy < g.rows && hasBit(bits!, cy * g.cols + cx)
    for (let cy = 0; cy < g.rows; cy++) {
      for (let cx = 0; cx < g.cols; cx++) {
        if (explored(cx, cy)) continue
        const near: [number, number, number, number][] = []
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
          if ((ox || oy) && explored(cx + ox, cy + oy)) {
            const x0 = (cx + ox) * g.chunk, y0 = (cy + oy) * g.chunk
            near.push([x0, y0, x0 + g.chunk - 1, y0 + g.chunk - 1])
          }
        }
        const xEnd = Math.min(w, (cx + 1) * g.chunk), yEnd = Math.min(h, (cy + 1) * g.chunk)
        for (let y = cy * g.chunk; y < yEnd; y++) {
          for (let x = cx * g.chunk; x < xEnd; x++) {
            let d = Infinity
            for (const [x0, y0, x1, y1] of near) {
              const dx = x < x0 ? x0 - x : x > x1 ? x - x1 : 0
              const dy = y < y0 ? y0 - y : y > y1 ? y - y1 : 0
              d = Math.min(d, Math.max(dx, dy))
            }
            // Dithered edge toward explored chunks (pixel-art falloff instead of a hard border).
            if (d <= CFG.fog.ditherTiles) {
              if (d === 1 && ((x + y) & 1) === 0) continue
              if (d === 2 && (x & 1) === 0 && (y & 1) === 0) continue
            }
            const i = (y * w + x) * 4
            img.data[i] = col[0]; img.data[i + 1] = col[1]; img.data[i + 2] = col[2]; img.data[i + 3] = alpha
          }
        }
      }
    }
    ctx.putImageData(img, 0, 0)
  }

  const isExplored = (x: number, y: number) => inf
    ? !pages || pages.tileExplored(Math.floor(x), Math.floor(y))
    : !bits || !grid || isTileExplored(bits, grid, Math.floor(x), Math.floor(y))

  /** Markers to draw this frame: dynamic + building markers not already supplied by the caller, sorted by z. */
  const collect = (): { m: MinimapMarker; s: MarkerStyle }[] => {
    const out: { m: MinimapMarker; s: MarkerStyle }[] = []
    for (const st of statics) {
      const dup = markers.some((m) => m.kind === st.kind && m.x >= st.rect.x - 1 && m.x <= st.rect.x + st.rect.w && m.y >= st.rect.y - 1 && m.y <= st.rect.y + st.rect.h)
      if (!dup) out.push({ m: { x: st.x, y: st.y, kind: st.kind as MinimapMarker['kind'] }, s: styleOf(st.kind) })
    }
    for (const m of markers) out.push({ m, s: styleOf(m.kind) })
    out.push({ m: { x: player.x, y: player.y, kind: 'player', facing: player.facing }, s: styleOf('player') })
    const now = performance.now()
    return out
      .filter(({ m, s }) => !(s.blinkMs && Math.floor(now / s.blinkMs) % 2 === 1) && (s.showInFog || isExplored(m.x, m.y)))
      .sort((a, b) => a.s.z - b.s.z)
  }

  const glyphFor = (m: MinimapMarker, s: MarkerStyle) =>
    glyphSource(s.glyph, { palette: s.palette, rotate: s.rotate && m.facing ? ROTATION[m.facing] : 0 })

  const drawRoute = (ctx: CanvasRenderingContext2D, sx: number, sy: number, ppt: number) => {
    if (route.length < 2) return
    ctx.save()
    ctx.strokeStyle = UI_CONFIG.glyphPalette.h
    ctx.lineWidth = Math.max(1, Math.round(ppt * 0.45))
    ctx.setLineDash([Math.max(2, ppt), Math.max(1, ppt * 0.7)])
    ctx.beginPath()
    route.forEach((p, i) => {
      const x = (p.x + 0.5 - sx) * ppt, y = (p.y + 0.5 - sy) * ppt
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.stroke()
    ctx.restore()
  }

  const draw = () => {
    if (!size) return
    const ctx = mapCv.getContext('2d')!
    ctx.imageSmoothingEnabled = false
    ctx.globalCompositeOperation = 'source-over'
    ctx.fillStyle = CFG.fog.color
    ctx.fillRect(0, 0, size, size)
    if (map && (baked || inf)) {
      const ppt = Math.max(1, Math.round(size / CFG.tilesVisible))
      const span = size / ppt
      const off = CFG.tileCenterOffset
      const cx = Math.round((cam.x + off) * ppt) / ppt
      const cy = Math.round((cam.y + off) * ppt) / ppt
      const sx = cx - span / 2
      const sy = cy - span / 2
      if (inf) drawChunks(ctx, sx, sy, span, span, ppt)
      else {
        ctx.drawImage(baked!, sx, sy, span, span, 0, 0, size, size)
        if (fogCv) ctx.drawImage(fogCv, sx, sy, span, span, 0, 0, size, size)
      }
      const half = size / 2
      drawRoute(ctx, sx, sy, ppt)
      for (const { m, s } of collect()) {
        const src = glyphFor(m, s)
        let px = (m.x + off - cx) * ppt + half
        let py = (m.y + off - cy) * ppt + half
        const rad = Math.hypot(px - half, py - half)
        const limit = half - Math.max(src.width, src.height) / 2 - 1
        if (rad > limit) {
          if (!s.clampToEdge) continue
          px = half + ((px - half) / rad) * limit
          py = half + ((py - half) / rad) * limit
        }
        ctx.drawImage(src, Math.round(px - src.width / 2), Math.round(py - src.height / 2))
      }
    }
    if (mask) {
      ctx.globalCompositeOperation = 'destination-in'
      ctx.drawImage(mask, 0, 0)
      ctx.globalCompositeOperation = 'source-over'
    }
  }

  /** Region names of the expanded infinite map: centroids over the resident chunks in the window (explored only). */
  /** cssK: CSS px per tile of the displayed expanded canvas. */
  const layoutInfiniteLabels = (cssK: number) => {
    viewLabels.replaceChildren()
    if (!inf) return
    const S = inf.size
    const acc = new Map<string, { sx: number; sy: number; n: number }>()
    for (let cy = Math.floor(viewOrigin.y / S); cy <= Math.floor((viewOrigin.y + viewTiles) / S); cy++) {
      for (let cx = Math.floor(viewOrigin.x / S); cx <= Math.floor((viewOrigin.x + viewTiles) / S); cx++) {
        const ch = inf.peek(cx, cy)
        if (!ch) continue
        for (const [ri, a] of chunkRegionStats(ch)) {
          const id = ch.regionIds[ri]
          if (id === undefined) continue
          let b = acc.get(id)
          if (!b) { b = { sx: 0, sy: 0, n: 0 }; acc.set(id, b) }
          b.sx += a.sx; b.sy += a.sy; b.n += a.n
        }
      }
    }
    const list = [...acc.entries()]
      .map(([id, a]) => ({ def: inf!.region(id), x: a.sx / a.n, y: a.sy / a.n, n: a.n }))
      .filter((r) => r.def?.nameZh && r.n >= CFG.expanded.minLabelTiles && isExplored(r.x, r.y))
      .sort((a, b) => Number(!!b.def!.isTown) - Number(!!a.def!.isTown) || b.n - a.n)
      .slice(0, IM.expandedLabels)
    const placed: DOMRect[] = []
    const seen = new Set<string>()
    for (const r of list) {
      if (seen.has(r.def!.nameZh)) continue
      seen.add(r.def!.nameZh)
      const label = el('div', { class: `ap-mapview-label${r.def!.isTown ? ' ap-gold' : ' ap-dim'}`, text: r.def!.nameZh })
      label.style.left = `${(r.x + 0.5 - viewOrigin.x) * cssK}px`
      label.style.top = `${(r.y + 0.5 - viewOrigin.y) * cssK}px`
      viewLabels.append(label)
      const box = label.getBoundingClientRect()
      if (placed.some((p) => box.left < p.right && box.right > p.left && box.top < p.bottom && box.bottom > p.top)) label.remove()
      else placed.push(box)
    }
  }

  const layoutView = () => {
    if (!map) return
    const ui = getUIScale()
    const dpr = window.devicePixelRatio || 1
    const ex = CFG.expanded
    const availW = (window.innerWidth * ex.maxFraction - (ui.portrait ? 0 : ex.chromeXUnits) * ui.cssPerUnit) * dpr
    const availH = (window.innerHeight * ex.maxFraction - (ex.chromeYUnits + (ui.portrait ? ex.portraitLegendUnits : 0)) * ui.cssPerUnit) * dpr
    if (inf) {
      viewTiles = IM.expandedTiles
      viewK = Math.max(1, Math.floor(Math.min(availW, availH) / viewTiles))
      viewOrigin = { x: Math.floor(player.x - viewTiles / 2), y: Math.floor(player.y - viewTiles / 2) }
      viewCv.width = viewTiles * viewK
      viewCv.height = viewTiles * viewK
      // Integer tile scale for the bitmap, then a pixelated CSS stretch so the window fills the available area.
      const side = Math.max(viewCv.width, Math.floor(Math.min(availW, availH))) / dpr
      viewCv.style.width = `${side}px`
      viewCv.style.height = `${side}px`
      viewTitle.textContent = map.nameZh
      layoutInfiniteLabels(side / viewTiles)
      legendKey = ''
      return
    }
    viewOrigin = { x: 0, y: 0 }
    viewK = Math.max(1, Math.floor(Math.min(availW / map.width, availH / map.height)))
    viewCv.width = map.width * viewK
    viewCv.height = map.height * viewK
    viewCv.style.width = `${viewCv.width / dpr}px`
    viewCv.style.height = `${viewCv.height / dpr}px`
    viewTitle.textContent = map.nameZh
    // Region labels at centroids (explored only).
    viewLabels.replaceChildren()
    const regions = regionCentroids(map)
      .filter((r) => map!.regions[r.index]?.nameZh && r.tiles >= CFG.expanded.minLabelTiles && isExplored(r.x, r.y))
      .sort((a, b) => Number(!!map!.regions[b.index].isTown) - Number(!!map!.regions[a.index].isTown) || b.tiles - a.tiles)
    const placed: DOMRect[] = []
    for (const r of regions) {
      const def = map.regions[r.index]
      const label = el('div', { class: `ap-mapview-label${def.isTown ? ' ap-gold' : ' ap-dim'}`, text: def.nameZh })
      label.style.left = `${((r.x + 0.5) * viewK) / dpr}px`
      label.style.top = `${((r.y + 0.5) * viewK) / dpr}px`
      viewLabels.append(label)
      // Greedy de-overlap: towns and larger regions win.
      const box = label.getBoundingClientRect()
      if (placed.some((p) => box.left < p.right && box.right > p.left && box.top < p.bottom && box.bottom > p.top)) label.remove()
      else placed.push(box)
    }
    legendKey = ''
  }

  const drawView = () => {
    if (!expanded || !map || (!baked && !inf)) return
    const ctx = viewCv.getContext('2d')!
    const w = viewCv.width, h = viewCv.height
    ctx.imageSmoothingEnabled = false
    ctx.clearRect(0, 0, w, h)
    if (inf) {
      ctx.fillStyle = CFG.fog.color
      ctx.fillRect(0, 0, w, h)
      drawChunks(ctx, viewOrigin.x, viewOrigin.y, viewTiles, viewTiles, viewK)
    } else {
      ctx.drawImage(baked!, 0, 0, w, h)
      if (fogCv) ctx.drawImage(fogCv, 0, 0, w, h)
    }
    const g = getUIScale().deviceScale
    drawRoute(ctx, viewOrigin.x, viewOrigin.y, viewK)
    const off = CFG.tileCenterOffset
    const kinds: string[] = []
    for (const { m, s } of collect()) {
      const src = glyphFor(m, s)
      const gw = src.width * g, gh = src.height * g
      const mx = (m.x + off - viewOrigin.x) * viewK, my = (m.y + off - viewOrigin.y) * viewK
      if (inf && (mx < 0 || my < 0 || mx > w || my > h)) continue
      ctx.drawImage(src, Math.round(mx - gw / 2), Math.round(my - gh / 2), gw, gh)
      if (!kinds.includes(m.kind)) kinds.push(m.kind)
    }
    const key = kinds.sort().join(',')
    if (key !== legendKey) {
      legendKey = key
      legend.replaceChildren(...kinds.map((k) => el('span', 'ap-legend-item', [glyphEl(styleOf(k).glyph), t(`hud.minimap.legend.${k}`)])))
    }
  }

  const unsubscribe = onUIScaleChange(() => { resize(); if (expanded) { layoutView(); drawView() } })
  resize()

  const api: MinimapHandle = {
    el: box,
    get expanded() { return expanded },
    setMap(next: GameMap, explored: Uint8Array | null) {
      map = next
      route = []
      inf = next.infinite ?? null
      chunkTiles.clear()
      fogTiles.clear()
      staticsKey = ''
      if (inf) {
        baked = null
        statics = []
        grid = null
        bits = null
        fogCv = null
        snap = true
        if (expanded) layoutView()
        draw()
        return
      }
      baked = bakeMapImage(next)
      statics = CFG.autoBuildingMarkers ? buildingMarkers(next) : []
      if (CFG.fog.kinds.includes(next.kind)) {
        grid = fogGrid(next.width, next.height, CONTENT.config.world.chunk)
        bits = normalizeBits(grid, explored)
      } else {
        grid = null
        bits = null
      }
      rebuildFog()
      snap = true
      if (expanded) layoutView()
      draw()
    },
    update(playerX: number, playerY: number, facing: Dir, next: MinimapMarker[], nextRoute: readonly { x: number; y: number }[] = []) {
      const now = performance.now()
      const dt = lastTime ? Math.min(0.25, (now - lastTime) / 1000) : 0
      lastTime = now
      player = { x: playerX, y: playerY, facing }
      markers = next
      route = nextRoute
      bakedThisFrame = 0
      refreshStatics(playerX, playerY)
      if (inf && expanded && Math.max(Math.abs(playerX - viewOrigin.x - viewTiles / 2), Math.abs(playerY - viewOrigin.y - viewTiles / 2)) > viewTiles / 4) layoutView()
      const far = Math.hypot(playerX - cam.x, playerY - cam.y) > CFG.tilesVisible
      if (snap || far) { cam = { x: playerX, y: playerY }; snap = false }
      else {
        const k = 1 - Math.exp(-CFG.followRate * dt)
        cam = { x: cam.x + (playerX - cam.x) * k, y: cam.y + (playerY - cam.y) * k }
      }
      if (visible) draw()
      drawView()
    },
    reveal(x: number, y: number) {
      if (inf) { if (expanded) layoutView(); return }
      if (!bits || !grid) return
      if (revealAround(bits, grid, x, y, CFG.fog.revealRadiusChunks).length) {
        rebuildFog()
        if (expanded) layoutView()
      }
    },
    exploredBits() {
      return bits ? bits.slice() : null
    },
    setFogPages(next: FogPages | null) {
      pages = next
      fogTiles.clear()
      draw()
    },
    setExpanded(v: boolean) {
      if (v === expanded) return
      expanded = v
      view.classList.toggle('is-on', v)
      view.classList.toggle('ap-fullscreen', v)
      if (v) { paintCloseHint(); layoutView(); drawView() }
    },
    onTap(fn: () => void) {
      tapFns.add(fn)
      return () => { tapFns.delete(fn) }
    },
    setVisible(v: boolean) {
      visible = v
      box.hidden = !v
      document.documentElement.classList.toggle('ap-minimap-hidden', !v)
      if (v) draw()
    },
    dispose() {
      unsubscribe()
      layer.remove()
      viewLayer.remove()
    },
  }
  return api
}
