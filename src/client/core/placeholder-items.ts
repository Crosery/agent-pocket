// 32x32 item icons: procedural capture ball (colour from the ball effect) or category / key-item stamps.
import type { ItemDef } from '../../shared/types.ts'
import { CONTENT } from '../../shared/content/index.ts'
import type { Content } from '../../shared/content/index.ts'
import type { PixelImage, RGB } from './pixel.ts'
import { createImage, hexToRgb, mix, outline, setPx, shift, upscale } from './pixel.ts'
import { stamp } from './placeholder-chibi.ts'
import { PH } from './placeholders-data.ts'
import type { PlaceholdersFile } from './placeholders-data.ts'

function drawBall(img: PixelImage, top: RGB, ph: PlaceholdersFile): void {
  const n = img.w
  const c = (n - 1) / 2
  const r = n / 2 - 1.5
  const white = hexToRgb(ph.items.ball.white)
  const band = hexToRgb(ph.items.ball.band)
  const button = hexToRgb(ph.items.ball.button)
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const dx = x - c, dy = y - c
    const d = Math.hypot(dx, dy)
    if (d > r) continue
    const lit = (-dx - dy) / (r * 1.4)
    const base = dy < -0.5 ? top : white
    let col = lit > 0.45 ? shift(base, 0.12, 8) : lit < -0.35 ? shift(base, -0.16, -10) : base
    if (Math.abs(dy) < 0.6) col = band
    setPx(img, x, y, col)
  }
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const d = Math.hypot(x - c, y - c)
    if (d <= 2.6 && d > 1.4) setPx(img, x, y, band)
    else if (d <= 1.4) setPx(img, x, y, button)
  }
  const shine = hexToRgb(ph.details.shine)
  setPx(img, Math.round(c - r * 0.45), Math.round(c - r * 0.55), shine)
  setPx(img, Math.round(c - r * 0.45) + 1, Math.round(c - r * 0.55), mix(top, shine, ph.details.shineMix))
}

function itemColor(item: ItemDef, c: Content, ph: PlaceholdersFile): RGB {
  const e = item.effect
  if (e.kind === 'ball') return hexToRgb(e.color)
  if (e.kind === 'chip') {
    const move = c.moves[e.move]
    const type = move ? c.typeById[move.type] : undefined
    if (type) return hexToRgb(type.color)
  }
  const hex = ph.items.effectColors[e.kind] ?? ph.items.categoryColors[item.category] ?? ph.items.categoryColors.misc
  return hexToRgb(hex ?? ph.details.neutral)
}

/** Icon at items.size (drawn at items.logicalSize and upscaled). Unknown ids get the misc icon. */
export function drawItemIcon(itemId: string, c: Content = CONTENT, ph: PlaceholdersFile = PH): PixelImage {
  const n = ph.items.logicalSize
  const img = createImage(n, n)
  const item = c.items[itemId]
  if (item?.effect.kind === 'ball') {
    drawBall(img, hexToRgb(item.effect.color), ph)
  } else {
    const stampId = item?.effect.kind === 'key'
      ? ph.items.keyIcons[item.effect.key] ?? ph.items.categoryIcons.key
      : (item && ph.items.effectIcons[item.effect.kind]) ?? ph.items.categoryIcons[item?.category ?? 'misc'] ?? ph.items.categoryIcons.misc
    const st = ph.stamps[stampId]
    const color = item ? itemColor(item, c, ph) : hexToRgb(ph.items.categoryColors.misc ?? ph.details.neutral)
    if (st) stamp(st, Math.floor(n / 2), Math.floor(n / 2), color, ph, (x, y, col) => setPx(img, x, y, col))
  }
  outline(img, (nb) => mix(shift(nb, ph.outline.lightness, ph.outline.hue), hexToRgb(ph.outline.dark), ph.outline.mix))
  return upscale(img, Math.max(1, Math.round(ph.items.size / n)))
}
