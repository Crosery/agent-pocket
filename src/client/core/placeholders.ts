// DOM side of procedural placeholders: pixel buffers -> cached canvases / data URLs.
import { CONTENT } from '../../shared/content/index.ts'
import type { Content } from '../../shared/content/index.ts'
import type { PixelImage } from './pixel.ts'
import { drawCharacterSheet } from './placeholder-character.ts'
import { drawCreature } from './placeholder-creature.ts'
import { drawItemIcon } from './placeholder-items.ts'
import { drawTerrain, drawTuft } from './placeholder-terrain.ts'
import { PH } from './placeholders-data.ts'
import type { PlaceholdersFile } from './placeholders-data.ts'

export type PlaceholderKind = 'creature' | 'character' | 'terrain' | 'item'

/** Suffix of transparent grass overlays for tall-grass terrains. */
export const TUFT_SUFFIX = '_tuft'

export function imageToCanvas(img: PixelImage): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = img.w
  canvas.height = img.h
  const ctx = canvas.getContext('2d')
  if (ctx) ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.w, img.h), 0, 0)
  return canvas
}

export interface Placeholders {
  canvas(kind: PlaceholderKind, id: string): HTMLCanvasElement
  dataUrl(kind: PlaceholderKind, id: string): string
  /** Pure pixel buffer (no DOM) — used by tests and tools. */
  pixels(kind: PlaceholderKind, id: string): PixelImage
}

export function drawPlaceholder(kind: PlaceholderKind, id: string, c: Content = CONTENT, ph: PlaceholdersFile = PH): PixelImage {
  switch (kind) {
    case 'creature': return drawCreature(id, c, ph)
    case 'character': return drawCharacterSheet(id, c, ph)
    case 'item': return drawItemIcon(id, c, ph)
    case 'terrain':
      if (id.endsWith(TUFT_SUFFIX) && !c.terrainByKey[id] && !ph.terrain.recipes[id]) return drawTuft(id.slice(0, -TUFT_SUFFIX.length), c, ph)
      return drawTerrain(id, c, ph)
  }
}

export function createPlaceholders(c: Content = CONTENT, ph: PlaceholdersFile = PH): Placeholders {
  const canvases = new Map<string, HTMLCanvasElement>()
  const urls = new Map<string, string>()
  const canvas = (kind: PlaceholderKind, id: string) => {
    const key = `${kind}:${id}`
    let cv = canvases.get(key)
    if (!cv) { cv = imageToCanvas(drawPlaceholder(kind, id, c, ph)); canvases.set(key, cv) }
    return cv
  }
  return {
    canvas,
    dataUrl(kind, id) {
      const key = `${kind}:${id}`
      let url = urls.get(key)
      if (!url) { url = canvas(kind, id).toDataURL('image/png'); urls.set(key, url) }
      return url
    },
    pixels: (kind, id) => drawPlaceholder(kind, id, c, ph),
  }
}
