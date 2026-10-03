// Pure RGBA pixel buffers + pixel-art helpers (no DOM): colour ramps, outlines, transforms, tileable noise.
export type RGB = [number, number, number]
export interface PixelImage { w: number; h: number; data: Uint8ClampedArray }

export function createImage(w: number, h: number): PixelImage {
  return { w, h, data: new Uint8ClampedArray(w * h * 4) }
}

export function cloneImage(img: PixelImage): PixelImage {
  return { w: img.w, h: img.h, data: new Uint8ClampedArray(img.data) }
}

export function alphaAt(img: PixelImage, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= img.w || y >= img.h) return 0
  return img.data[(y * img.w + x) * 4 + 3]
}

export function getRgb(img: PixelImage, x: number, y: number): RGB | null {
  if (x < 0 || y < 0 || x >= img.w || y >= img.h) return null
  const i = (y * img.w + x) * 4
  return img.data[i + 3] ? [img.data[i], img.data[i + 1], img.data[i + 2]] : null
}

export function setPx(img: PixelImage, x: number, y: number, c: RGB, a = 255): void {
  x |= 0; y |= 0
  if (x < 0 || y < 0 || x >= img.w || y >= img.h) return
  const i = (y * img.w + x) * 4
  img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2]; img.data[i + 3] = a
}

/** Alpha-blends c over the pixel (keeps destination alpha at least as opaque). */
export function blendPx(img: PixelImage, x: number, y: number, c: RGB, alpha: number): void {
  x |= 0; y |= 0
  if (x < 0 || y < 0 || x >= img.w || y >= img.h || alpha <= 0) return
  const i = (y * img.w + x) * 4
  const da = img.data[i + 3] / 255
  if (da === 0) { setPx(img, x, y, c, Math.round(alpha * 255)); return }
  const a = Math.min(1, alpha)
  img.data[i] = img.data[i] * (1 - a) + c[0] * a
  img.data[i + 1] = img.data[i + 1] * (1 - a) + c[1] * a
  img.data[i + 2] = img.data[i + 2] * (1 - a) + c[2] * a
  img.data[i + 3] = Math.max(img.data[i + 3], Math.round(a * 255))
}

// ---------------------------------------------------------------------------
// Color
// ---------------------------------------------------------------------------

export function hexToRgb(hex: string): RGB {
  let h = hex.trim().replace(/^#/, '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const n = parseInt(h.slice(0, 6), 16)
  if (!Number.isFinite(n)) return [255, 0, 255]
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function rgbToHex(c: RGB): string {
  return '#' + c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')
}

export function rgbToHsl([r, g, b]: RGB): [number, number, number] {
  const R = r / 255, G = g / 255, B = b / 255
  const max = Math.max(R, G, B), min = Math.min(R, G, B)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4
  h *= 60
  return [h, s, l]
}

export function hslToRgb(h: number, s: number, l: number): RGB {
  h = ((h % 360) + 360) % 360
  s = Math.min(1, Math.max(0, s))
  l = Math.min(1, Math.max(0, l))
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)]
}

/** Lightness / hue / saturation shift in HSL space. */
export function shift(c: RGB, dl: number, dh = 0, ds = 0): RGB {
  const [h, s, l] = rgbToHsl(c)
  return hslToRgb(h + dh, s + ds, l + dl)
}

export function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t].map(Math.round) as RGB
}

export interface RampStyle {
  /** Per tone (dark -> light): [lightness delta, hue shift deg, saturation delta]; the base tone is [0,0,0]. */
  tones: [number, number, number][]
}

/** Hue-shifted shading ramp (shadows lean cool, lights lean warm per the style). */
export function makeRamp(base: RGB, style: RampStyle): RGB[] {
  return style.tones.map(([dl, dh, ds]) => shift(base, dl, dh, ds))
}

// ---------------------------------------------------------------------------
// Outline / transforms
// ---------------------------------------------------------------------------

/**
 * Adds a 1px outline around opaque pixels. `color` may depend on the neighbouring opaque pixel
 * (selective outline). Diagonal neighbours are included when `diagonal` is set.
 */
export function outline(img: PixelImage, color: RGB | ((neighbor: RGB) => RGB), diagonal = false): void {
  const src = cloneImage(img)
  const dirs = diagonal
    ? [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
    : [[1, 0], [-1, 0], [0, 1], [0, -1]]
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      if (alphaAt(src, x, y) > 0) continue
      for (const [dx, dy] of dirs) {
        const n = getRgb(src, x + dx, y + dy)
        if (n && alphaAt(src, x + dx, y + dy) > 127) {
          setPx(img, x, y, typeof color === 'function' ? color(n) : color)
          break
        }
      }
    }
  }
}

export function mirrorX(img: PixelImage): PixelImage {
  const out = createImage(img.w, img.h)
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const s = (y * img.w + x) * 4
      const d = (y * img.w + (img.w - 1 - x)) * 4
      out.data[d] = img.data[s]; out.data[d + 1] = img.data[s + 1]; out.data[d + 2] = img.data[s + 2]; out.data[d + 3] = img.data[s + 3]
    }
  }
  return out
}

export function upscale(img: PixelImage, k: number): PixelImage {
  if (k === 1) return cloneImage(img)
  const out = createImage(img.w * k, img.h * k)
  for (let y = 0; y < out.h; y++) {
    for (let x = 0; x < out.w; x++) {
      const s = (Math.floor(y / k) * img.w + Math.floor(x / k)) * 4
      const d = (y * out.w + x) * 4
      out.data[d] = img.data[s]; out.data[d + 1] = img.data[s + 1]; out.data[d + 2] = img.data[s + 2]; out.data[d + 3] = img.data[s + 3]
    }
  }
  return out
}

/** Copies src onto dst at (dx,dy), skipping transparent source pixels. */
export function blit(dst: PixelImage, src: PixelImage, dx: number, dy: number): void {
  for (let y = 0; y < src.h; y++) {
    for (let x = 0; x < src.w; x++) {
      const s = (y * src.w + x) * 4
      const a = src.data[s + 3]
      if (!a) continue
      if (a === 255) setPx(dst, dx + x, dy + y, [src.data[s], src.data[s + 1], src.data[s + 2]])
      else blendPx(dst, dx + x, dy + y, [src.data[s], src.data[s + 1], src.data[s + 2]], a / 255)
    }
  }
}

// ---------------------------------------------------------------------------
// Tileable noise (wraps at the image size so textures repeat seamlessly)
// ---------------------------------------------------------------------------

export function tileableNoise(w: number, h: number, cell: number, rnd: () => number): Float32Array {
  const gw = Math.max(1, Math.round(w / cell))
  const gh = Math.max(1, Math.round(h / cell))
  const grid = Array.from({ length: gw * gh }, () => rnd())
  const at = (gx: number, gy: number) => grid[((gy % gh) + gh) % gh * gw + (((gx % gw) + gw) % gw)]
  const out = new Float32Array(w * h)
  const smooth = (t: number) => t * t * (3 - 2 * t)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const fx = (x / w) * gw, fy = (y / h) * gh
      const ix = Math.floor(fx), iy = Math.floor(fy)
      const tx = smooth(fx - ix), ty = smooth(fy - iy)
      const a = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * tx
      const b = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * tx
      out[y * w + x] = a + (b - a) * ty
    }
  }
  return out
}

/** Multi-octave tileable noise in 0..1. */
export function fractalNoise(w: number, h: number, cells: number[], rnd: () => number): Float32Array {
  const out = new Float32Array(w * h)
  let total = 0
  cells.forEach((cell, i) => {
    const weight = 1 / (i + 1)
    total += weight
    const n = tileableNoise(w, h, cell, rnd)
    for (let k = 0; k < out.length; k++) out[k] += n[k] * weight
  })
  for (let k = 0; k < out.length; k++) out[k] /= total
  return out
}

/** Ordered 4x4 Bayer threshold (0..1) for crisp pixel dithering. */
export function bayer4(x: number, y: number): number {
  const m = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]
  return (m[(y & 3) * 4 + (x & 3)] + 0.5) / 16
}
