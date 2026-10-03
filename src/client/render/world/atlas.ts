// Runtime terrain atlas: every terrain/cliff texture key packed into padded cells of one nearest-filtered
// canvas texture. Source textures may load asynchronously (or be swapped for real files later); refresh()
// redraws cells whose source changed.
import * as THREE from 'three'
import { CONTENT } from '../../../shared/content/index.ts'
import type { AssetStore } from '../../contracts.ts'
import { RENDER, hexToRgb, type Vec3 } from '../config.ts'
import { configurePixelTexture, createCanvas, drawTextureImage, textureImageReady } from '../sprite-utils.ts'

export interface UvRect { u0: number; v0: number; u1: number; v1: number }

export interface TerrainAtlas {
  readonly texture: THREE.Texture
  rect(key: string): UvRect
  /** Average sRGB color of a key's texture (0..1). */
  averageColor(key: string): Vec3
  /** Redraws cells whose source texture (re)loaded. Returns true if anything changed. */
  refresh(): boolean
  /** Bumped every time a cell is redrawn. */
  readonly version: number
  dispose(): void
}

interface Cell { key: string; x: number; y: number; tex: THREE.Texture; drawnVersion: number; drawn: boolean; avg: Vec3 }

export function createTerrainAtlas(assets: AssetStore, keys: string[]): TerrainAtlas {
  const cfg = RENDER.terrain
  const unique = [...new Set(keys)]
  const inner = cfg.atlasCell
  const pad = cfg.atlasPad
  const cellSize = inner + pad * 2
  const cols = Math.max(1, Math.ceil(Math.sqrt(unique.length)))
  const rows = Math.max(1, Math.ceil(unique.length / cols))
  const W = THREE.MathUtils.ceilPowerOfTwo(cols * cellSize)
  const H = THREE.MathUtils.ceilPowerOfTwo(rows * cellSize)
  const canvas = createCanvas(W, H)
  const g = canvas.getContext('2d', { willReadFrequently: true })!
  g.imageSmoothingEnabled = false
  const texture = configurePixelTexture(new THREE.CanvasTexture(canvas))
  let version = 0

  const cells = new Map<string, Cell>()
  unique.forEach((key, i) => {
    const cx = (i % cols) * cellSize, cy = Math.floor(i / cols) * cellSize
    cells.set(key, { key, x: cx, y: cy, tex: assets.terrainTexture(key), drawnVersion: -1, drawn: false, avg: [0.5, 0.5, 0.5] })
  })

  const fallbackColor = (key: string): string => CONTENT.terrainByKey[key]?.minimap ?? CONTENT.terrainByKey[CONTENT.biomes.find((b) => b.cliff === key)?.groundTerrain ?? '']?.minimap ?? RENDER.terrain.fallbackColor

  function draw(cell: Cell): void {
    const { x, y } = cell
    g.clearRect(x, y, cellSize, cellSize)
    const ok = drawTextureImage(g, cell.tex, x + pad, y + pad, inner, inner)
    if (!ok) {
      const [r, gg, b] = hexToRgb(fallbackColor(cell.key))
      g.fillStyle = `rgb(${r * 255},${gg * 255},${b * 255})`
      g.fillRect(x + pad, y + pad, inner, inner)
    }
    // replicate edges into the padding so nearest sampling at cell borders never reads a neighbour
    g.drawImage(canvas, x + pad, y + pad, inner, 1, x + pad, y, inner, pad)
    g.drawImage(canvas, x + pad, y + pad + inner - 1, inner, 1, x + pad, y + pad + inner, inner, pad)
    g.drawImage(canvas, x + pad, y, 1, cellSize, x, y, pad, cellSize)
    g.drawImage(canvas, x + pad + inner - 1, y, 1, cellSize, x + pad + inner, y, pad, cellSize)
    const data = g.getImageData(x + pad, y + pad, inner, inner).data
    let r = 0, gg = 0, b = 0, n = 0
    for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 8) { r += data[i]; gg += data[i + 1]; b += data[i + 2]; n++ }
    cell.avg = n ? [r / n / 255, gg / n / 255, b / n / 255] : hexToRgb(fallbackColor(cell.key))
    cell.drawn = ok
    cell.drawnVersion = cell.tex.version
  }

  for (const c of cells.values()) draw(c)
  texture.needsUpdate = true

  const missing: UvRect = { u0: 0, v0: 0, u1: inner / W, v1: inner / H }
  return {
    texture,
    get version() { return version },
    rect(key) {
      const c = cells.get(key)
      if (!c) return missing
      const x0 = c.x + pad, y0 = c.y + pad
      return { u0: x0 / W, u1: (x0 + inner) / W, v1: 1 - y0 / H, v0: 1 - (y0 + inner) / H }
    },
    averageColor(key) { return cells.get(key)?.avg ?? [0.5, 0.5, 0.5] },
    refresh() {
      let changed = false
      for (const c of cells.values()) {
        if ((!c.drawn && textureImageReady(c.tex)) || (c.drawn && c.tex.version !== c.drawnVersion)) { draw(c); changed = true }
      }
      if (changed) { texture.needsUpdate = true; version++ }
      return changed
    },
    dispose() { texture.dispose() },
  }
}

/** Every texture key the terrain renderer may sample: terrain keys, biome cliffs, liquid beds. */
export function terrainAtlasKeys(): string[] {
  const keys = CONTENT.terrain.map((t) => t.key)
  for (const b of CONTENT.biomes) keys.push(b.cliff, b.groundTerrain)
  const lists = [RENDER.terrain.surfaces, ...Object.values(RENDER.terrain.mapKindSurfaces)]
  for (const list of lists) for (const s of Object.values(list ?? {})) {
    if (s.bed) keys.push(s.bed)
    if (s.face && s.face !== '$cliff') keys.push(s.face)
    if (s.top) keys.push(s.top)
  }
  keys.push(RENDER.terrain.defaultCliff)
  return [...new Set(keys)]
}
