import { CONTENT } from '../../shared/content/index.ts'
import type { Dir, GameConfig } from '../../shared/types.ts'
import { characterFrames } from './character-animation.ts'

export interface CharacterPixels {
  width: number
  height: number
  data: Uint8Array | Uint8ClampedArray
}

interface Rig {
  mask: Uint8Array
  neck: number
  lockY: number
  axis: number
  radius: number
}

function smooth(a: number, b: number, n: number): number {
  const t = Math.max(0, Math.min(1, (n - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

function bodyRig(data: Uint8Array, cell: number): Rig | null {
  const visited = new Uint8Array(cell * cell)
  let body: number[] = []
  for (let start = 0; start < visited.length; start++) {
    if (visited[start] || data[start * 4 + 3] < 128) continue
    const cluster = [start]
    visited[start] = 1
    for (let i = 0; i < cluster.length; i++) {
      const x = cluster[i] % cell, y = Math.floor(cluster[i] / cell)
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy
        if (nx < 0 || nx >= cell || ny < 0 || ny >= cell) continue
        const p = ny * cell + nx
        if (!visited[p] && data[p * 4 + 3] >= 128) { visited[p] = 1; cluster.push(p) }
      }
    }
    if (cluster.length > body.length) body = cluster
  }
  if (!body.length) return null
  let top = cell, foot = 0, x0 = cell, x1 = 0
  const mask = new Uint8Array(cell * cell)
  for (const p of body) {
    const x = p % cell, y = Math.floor(p / cell)
    mask[p] = 1
    top = Math.min(top, y); foot = Math.max(foot, y)
    x0 = Math.min(x0, x); x1 = Math.max(x1, x)
  }
  const height = foot - top + 1
  const lockY = Math.ceil(top + height * 0.76)
  const waist = body.filter((p) => Math.floor(p / cell) >= lockY - 5 && Math.floor(p / cell) < lockY)
  const axis = waist.length ? waist.reduce((sum, p) => sum + p % cell, 0) / waist.length : (x0 + x1) / 2
  return { mask, neck: top + height * 0.46, lockY, axis, radius: Math.max(4, (x1 - x0) * 0.3) }
}

function idlePose(source: Uint8Array, cell: number, rig: Rig, phase: number, dir: Dir): Uint8Array {
  if (phase === 0) return source
  const out = source.slice()
  for (let p = 0; p < rig.mask.length; p++) if (rig.mask[p]) out.fill(0, p * 4, p * 4 + 4)
  const angle = phase * Math.PI * 2
  const breath = Math.sin(angle)
  const follow = (1 - Math.cos(angle)) * 0.5
  const shift = (x: number, y: number): [number, number] => {
    const head = 1 - smooth(rig.neck - 3, rig.neck + 2, y)
    const chest = (1 - head) * (1 - smooth(rig.neck + 2, rig.lockY, y))
    const arms = (1 - head) * (1 - smooth(rig.lockY - 3, rig.lockY, y))
      * smooth(rig.radius * 0.4, rig.radius * 1.2, Math.abs(x - rig.axis))
    const side = dir === 'left' ? -1 : dir === 'right' ? 1 : Math.sign(x - rig.axis)
    return [
      chest * breath * 0.65 * (x - rig.axis) / rig.radius + arms * side * follow * 0.85,
      -(head * 0.72 + chest * 1.45) * breath + arms * follow * 0.65,
    ]
  }
  // Inverse-sample one continuous body field, never cut-and-paste limbs; shoes and separate props stay fixed.
  for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) {
    let sx = x, sy = y
    if (y < rig.lockY) for (let i = 0; i < 3; i++) {
      const [dx, dy] = shift(sx, sy)
      sx = x - dx; sy = y - dy
    }
    const ix = Math.round(sx), iy = Math.round(sy)
    if (ix < 0 || ix >= cell || iy < 0 || iy >= cell) continue
    const from = iy * cell + ix
    if (rig.mask[from]) out.set(source.subarray(from * 4, from * 4 + 4), (y * cell + x) * 4)
  }
  return out
}

/** Build once on load: original neutral, seven connected idle poses, then byte-identical walking poses. */
export function buildCharacterIdleAtlas(source: CharacterPixels, sprites: GameConfig['sprites']): CharacterPixels {
  const cell = sprites.sheetCell
  const layout = characterFrames(source.width, sprites)
  const rows = Math.max(...Object.values(sprites.sheetRows)) + 1
  if (layout.idleFrames > 1 || source.height !== cell * rows || source.width !== cell * layout.cols) return source
  const idleFrames = sprites.sheetIdleFrames
  const width = cell * (idleFrames + layout.walkFrames)
  const data = new Uint8ClampedArray(width * source.height * 4)
  for (const [dir, row] of Object.entries(sprites.sheetRows) as [Dir, number][]) {
    const neutral = new Uint8Array(cell * cell * 4)
    for (let y = 0; y < cell; y++) {
      const offset = ((row * cell + y) * source.width) * 4
      neutral.set(source.data.subarray(offset, offset + cell * 4), y * cell * 4)
    }
    const rig = bodyRig(neutral, cell)
    for (let col = 0; col < idleFrames; col++) {
      const pose = rig ? idlePose(neutral, cell, rig, col / idleFrames, dir) : neutral
      for (let y = 0; y < cell; y++) data.set(pose.subarray(y * cell * 4, (y + 1) * cell * 4), ((row * cell + y) * width + col * cell) * 4)
    }
    for (let y = 0; y < cell; y++) {
      const offset = ((row * cell + y) * source.width + layout.walkStart * cell) * 4
      data.set(source.data.subarray(offset, offset + layout.walkFrames * cell * 4), ((row * cell + y) * width + idleFrames * cell) * 4)
    }
  }
  return { width, height: source.height, data }
}

export type CharacterSheet = HTMLCanvasElement | HTMLImageElement
const prepared = new WeakMap<CharacterSheet, CharacterSheet>()

/** World, battle and UI read the same native-pixel atlas, without per-frame raster work or new network assets. */
export function prepareCharacterSheet(image: CharacterSheet): CharacterSheet {
  const cached = prepared.get(image)
  if (cached) return cached
  const width = image instanceof HTMLImageElement ? image.naturalWidth : image.width
  const height = image instanceof HTMLImageElement ? image.naturalHeight : image.height
  if (characterFrames(width, CONTENT.config.sprites).idleFrames > 1) return image
  const canvas = document.createElement('canvas')
  canvas.width = width; canvas.height = height
  const g = canvas.getContext('2d')!
  g.drawImage(image, 0, 0)
  const pixels = g.getImageData(0, 0, width, height)
  const atlas = buildCharacterIdleAtlas(pixels, CONTENT.config.sprites)
  if (atlas.width === width) { prepared.set(image, image); return image }
  canvas.width = atlas.width; canvas.height = atlas.height
  g.putImageData(new ImageData(new Uint8ClampedArray(atlas.data), atlas.width, atlas.height), 0, 0)
  prepared.set(image, canvas)
  return canvas
}
