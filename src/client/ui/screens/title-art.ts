// Title key-art placement: cover-scale the art, centre a focus point and keep the cast rect on screen through the
// whole Ken Burns pan. Pure (no DOM); the numbers live in content/screens.json title.art.
import type { TitleArtConfig, TitleArtFit } from './config.ts'

export interface Size { w: number; h: number }

/** Background size and offset in viewport px. */
export interface ArtPlacement { w: number; h: number; x: number; y: number }

export function pickArtFit(fits: TitleArtFit[], aspect: number): TitleArtFit {
  return fits.find((f) => aspect >= f.minAspect) ?? fits[fits.length - 1]
}

/** Fraction of the viewport per side ([x, y]) that the pan hides at its zoomed-in end. */
export function panMargins(pan: TitleArtConfig['pan']): [number, number] {
  const s = Math.max(1, pan.scale)
  const base = (1 - 1 / s) / 2
  return [base + Math.abs(pan.x) / s, base + Math.abs(pan.y) / s]
}

// Offset of one axis: focus centred, nudged so [k0, k1] stays inside the margins (centred on the keep span when it
// cannot fit), then clamped so the art always covers the viewport.
function axisOffset(box: number, size: number, focus: number, k0: number, k1: number, margin: number): number {
  const min = margin * box - k0 * size
  const max = box - margin * box - k1 * size
  const o = min <= max ? Math.min(max, Math.max(min, box / 2 - focus * size)) : box / 2 - ((k0 + k1) / 2) * size
  return Math.min(0, Math.max(box - size, o))
}

export function placeTitleArt(img: Size, box: Size, art: TitleArtConfig): ArtPlacement {
  const fit = pickArtFit(art.fits, box.w / box.h)
  const s = Math.max(box.w / img.w, box.h / img.h) * Math.max(1, fit.zoom ?? 1)
  const w = img.w * s
  const h = img.h * s
  const [mx, my] = panMargins(art.pan)
  const [x0, y0, x1, y1] = fit.keep
  return { w, h, x: axisOffset(box.w, w, fit.focus[0], x0, x1, mx), y: axisOffset(box.h, h, fit.focus[1], y0, y1, my) }
}
