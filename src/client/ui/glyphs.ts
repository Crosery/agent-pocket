// Pixel glyphs (art in content/ui.json "glyphs") rendered to cached canvases / data URLs.
// DOM is touched only when a function is called, so pure modules may import the ids safely.
import { UI_CONFIG } from './config.ts'
import { rasterizeGlyph } from './pixel.ts'

/** Glyph role ids the UI code draws directly (art lives in content/ui.json). */
export const UI_GLYPHS = ['cursor', 'advance', 'end', 'scrollUp', 'scrollDown', 'diamond', 'coin', 'shine', 'quest'] as const

export interface GlyphOptions { palette?: Record<string, string>; rotate?: number }

const cache = new Map<string, HTMLCanvasElement>()
const urlCache = new Map<string, string>()

const keyOf = (id: string, o?: GlyphOptions) => `${id}|${o?.rotate ?? 0}|${o?.palette ? JSON.stringify(o.palette) : ''}`

export function glyphDims(id: string, rotate = 0): { w: number; h: number } {
  const g = UI_CONFIG.glyphs[id]
  if (!g) return { w: 0, h: 0 }
  const w = g.rows[0]?.length ?? 0
  const h = g.rows.length
  return rotate % 2 ? { w: h, h: w } : { w, h }
}

/** Shared 1-pixel-per-cell canvas for drawImage(). Do not insert it into the DOM (use glyphEl). */
export function glyphSource(id: string, o?: GlyphOptions): HTMLCanvasElement {
  const key = keyOf(id, o)
  const hit = cache.get(key)
  if (hit) return hit
  const cv = document.createElement('canvas')
  const def = UI_CONFIG.glyphs[id]
  if (def) {
    const bmp = rasterizeGlyph(def, UI_CONFIG.glyphPalette, o?.palette, o?.rotate ?? 0)
    cv.width = Math.max(1, bmp.width)
    cv.height = Math.max(1, bmp.height)
    if (bmp.width && bmp.height) cv.getContext('2d')!.putImageData(new ImageData(bmp.data, bmp.width, bmp.height), 0, 0)
  } else {
    cv.width = 1
    cv.height = 1
  }
  cache.set(key, cv)
  return cv
}

export function glyphUrl(id: string, o?: GlyphOptions): string {
  const key = keyOf(id, o)
  let url = urlCache.get(key)
  if (!url) {
    url = glyphSource(id, o).toDataURL('image/png')
    urlCache.set(key, url)
  }
  return url
}

/** A crisp DOM glyph sized in UI pixels (scales with --ui-scale). */
export function glyphEl(id: string, o?: GlyphOptions & { className?: string }): HTMLElement {
  const { w, h } = glyphDims(id, o?.rotate ?? 0)
  const span = document.createElement('span')
  span.className = `ap-glyph${o?.className ? ` ${o.className}` : ''}`
  span.style.width = `calc(var(--u) * ${w})`
  span.style.height = `calc(var(--u) * ${h})`
  span.style.backgroundImage = `url("${glyphUrl(id, o)}")`
  span.setAttribute('aria-hidden', 'true')
  return span
}
