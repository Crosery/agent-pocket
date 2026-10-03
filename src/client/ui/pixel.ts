// Pure pixel helpers: colour parsing/shading and glyph rasterisation. No DOM access.
import type { GlyphDef } from './config.ts'

export type RGBA = [number, number, number, number]

export interface Bitmap { width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> }

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v))

/** Parses #rgb, #rgba, #rrggbb, #rrggbbaa and rgb()/rgba(). Unparseable input yields opaque magenta so typos are visible. */
export function parseColor(hex: string): RGBA {
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(hex.trim())
  if (fn) {
    const a = fn[4] === undefined ? 1 : fn[4].endsWith('%') ? parseFloat(fn[4]) / 100 : parseFloat(fn[4])
    return [clamp255(+fn[1]), clamp255(+fn[2]), clamp255(+fn[3]), clamp255(a * 255)]
  }
  const h = hex.trim().replace(/^#/, '')
  const expand = h.length <= 4 ? [...h].map((c) => c + c).join('') : h
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(expand)) return [255, 0, 255, 255]
  const n = (i: number) => parseInt(expand.slice(i, i + 2), 16)
  return [n(0), n(2), n(4), expand.length === 8 ? n(6) : 255]
}

/** amount > 0 lightens toward white, < 0 darkens toward black (fraction 0..1). */
export function shade(c: RGBA, amount: number): RGBA {
  if (amount >= 0) return [c[0] + (255 - c[0]) * amount, c[1] + (255 - c[1]) * amount, c[2] + (255 - c[2]) * amount, c[3]].map(clamp255) as RGBA
  const k = 1 + amount
  return [c[0] * k, c[1] * k, c[2] * k, c[3]].map(clamp255) as RGBA
}


/** Relative luminance 0..1 (sRGB approximation, good enough to pick a text ink). */
export function luminance(c: RGBA): number {
  const lin = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2])
}

/** True when dark ink reads better than white on this background (threshold = luminance cut-off). */
export function prefersDarkInk(bg: string, threshold: number): boolean {
  return luminance(parseColor(bg)) > threshold
}


/** Rotates glyph rows clockwise by quarter turns (0..3). */
export function rotateRows(rows: string[], quarterTurnsCW: number): string[] {
  let out = rows
  const turns = ((quarterTurnsCW % 4) + 4) % 4
  for (let t = 0; t < turns; t++) {
    const h = out.length
    const w = out[0]?.length ?? 0
    const next: string[] = []
    for (let x = 0; x < w; x++) {
      let row = ''
      for (let y = h - 1; y >= 0; y--) row += out[y][x]
      next.push(row)
    }
    out = next
  }
  return out
}

/** Rasterises a glyph to RGBA (1 pixel per cell). Unknown palette chars render transparent. */
export function rasterizeGlyph(def: GlyphDef, basePalette: Record<string, string>, override?: Record<string, string>, rotate = 0): Bitmap {
  const rows = rotate ? rotateRows(def.rows, rotate) : def.rows
  const height = rows.length
  const width = rows[0]?.length ?? 0
  const data = new Uint8ClampedArray(width * height * 4)
  const pal: Record<string, RGBA> = {}
  for (const [k, v] of Object.entries({ ...basePalette, ...(def.palette ?? {}), ...(override ?? {}) })) pal[k] = parseColor(v)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = pal[rows[y][x]]
      if (!c) continue
      const i = (y * width + x) * 4
      data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = c[3]
    }
  }
  return { width, height, data }
}

/** Deterministic 0..1 hash noise for tile coordinates. */
export function tileNoise(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967295
}

export function createBitmap(width: number, height: number): Bitmap {
  return { width, height, data: new Uint8ClampedArray(Math.max(0, width * height * 4)) }
}

/** Source-over blend of one pixel (integer coords, clipped). */
export function plot(b: Bitmap, x: number, y: number, c: RGBA): void {
  if (x < 0 || y < 0 || x >= b.width || y >= b.height) return
  const i = (y * b.width + x) * 4
  const a = c[3] / 255
  const da = b.data[i + 3] / 255
  const oa = a + da * (1 - a)
  if (oa <= 0) return
  for (let k = 0; k < 3; k++) b.data[i + k] = (c[k] * a + b.data[i + k] * da * (1 - a)) / oa
  b.data[i + 3] = oa * 255
}

/** Aliased (pixel-art) line, Bresenham. */
export function drawLine(b: Bitmap, x0: number, y0: number, x1: number, y1: number, c: RGBA): void {
  let ax = Math.round(x0), ay = Math.round(y0)
  const bx = Math.round(x1), by = Math.round(y1)
  const dx = Math.abs(bx - ax), dy = -Math.abs(by - ay)
  const sx = ax < bx ? 1 : -1, sy = ay < by ? 1 : -1
  let err = dx + dy
  for (;;) {
    plot(b, ax, ay, c)
    if (ax === bx && ay === by) break
    const e2 = 2 * err
    if (e2 >= dy) { err += dy; ax += sx }
    if (e2 <= dx) { err += dx; ay += sy }
  }
}

/** Aliased polygon fill (even-odd scanline at pixel centres). */
export function fillPolygon(b: Bitmap, pts: { x: number; y: number }[], c: RGBA): void {
  if (pts.length < 3) return
  const minY = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.y))))
  const maxY = Math.min(b.height - 1, Math.ceil(Math.max(...pts.map((p) => p.y))))
  for (let y = minY; y <= maxY; y++) {
    const cy = y + 0.5
    const xs: number[] = []
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length]
      if ((p.y <= cy && q.y > cy) || (q.y <= cy && p.y > cy)) xs.push(p.x + ((cy - p.y) / (q.y - p.y)) * (q.x - p.x))
    }
    xs.sort((a, z) => a - z)
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let x = Math.max(0, Math.round(xs[k])); x < Math.min(b.width, Math.round(xs[k + 1])); x++) plot(b, x, y, c)
    }
  }
}
