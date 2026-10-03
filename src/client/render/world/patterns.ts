// Procedural pixel-art surface patterns for prop fallback meshes (and sandbox placeholders).
// A pattern id is a rendering capability (like MoveAnim); its colors come from content/render.json.
import * as THREE from 'three'
import { RENDER, hexToRgb, type Vec3 } from '../config.ts'
import { configurePixelTexture, createCanvas } from '../sprite-utils.ts'
import { hashString } from './coords.ts'

export interface PatternSpec {
  id: string
  color: string
  color2?: string
  colors?: string[]
  /** Leave holes transparent (alpha-tested parts). */
  cutout?: boolean
}

type RGB = Vec3

interface Px {
  size: number
  data: Uint8ClampedArray
  rnd: () => number
  base: RGB
  alt: RGB
  colors: RGB[]
  cutout: boolean
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const shade = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k]
const mixc = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
/** Blend toward white by t. */
const lighten = (c: RGB, t: number): RGB => [c[0] + (1 - c[0]) * t, c[1] + (1 - c[1]) * t, c[2] + (1 - c[2]) * t]

function put(p: Px, x: number, y: number, c: RGB, a = 1): void {
  const s = p.size
  const xi = ((Math.floor(x) % s) + s) % s, yi = ((Math.floor(y) % s) + s) % s
  const i = (yi * s + xi) * 4
  p.data[i] = c[0] * 255
  p.data[i + 1] = c[1] * 255
  p.data[i + 2] = c[2] * 255
  p.data[i + 3] = a * 255
}

function fill(p: Px, c: RGB, noise: number): void {
  for (let y = 0; y < p.size; y++) for (let x = 0; x < p.size; x++) put(p, x, y, shade(c, 1 + (p.rnd() - 0.5) * 2 * noise))
}

function rect(p: Px, x: number, y: number, w: number, h: number, c: RGB, noise = 0): void {
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(p, x + i, y + j, noise ? shade(c, 1 + (p.rnd() - 0.5) * 2 * noise) : c)
}

function clear(p: Px): void { p.data.fill(0) }

const N = () => RENDER.props.patterns.noiseAmount

const PATTERNS: Record<string, (p: Px) => void> = {
  plain(p) { fill(p, p.base, N() * 0.6) },
  noise(p) { fill(p, p.base, N() * 2.2) },
  plaster(p) {
    fill(p, p.base, N() * 0.7)
    for (let k = 0; k < p.size / 2; k++) put(p, p.rnd() * p.size, p.rnd() * p.size, shade(p.base, 0.9))
    for (let k = 0; k < p.size / 4; k++) put(p, p.rnd() * p.size, p.rnd() * p.size, shade(p.base, 1.06))
  },
  stone(p) {
    const s = p.size
    fill(p, shade(p.alt, 0.85), N())
    const cells = Math.max(3, Math.round(s / 6))
    for (let k = 0; k < cells * cells * 0.9; k++) {
      const w = 3 + Math.floor(p.rnd() * s / 4), h = 3 + Math.floor(p.rnd() * s / 5)
      const x = Math.floor(p.rnd() * s), y = Math.floor(p.rnd() * s)
      const c = shade(p.base, 0.88 + p.rnd() * 0.24)
      rect(p, x + 1, y + 1, w - 1, h - 1, c, N())
      for (let i = 1; i < w; i++) put(p, x + i, y + 1, shade(c, 1.12))
      for (let j = 1; j < h; j++) put(p, x + w - 1, y + j, shade(c, 0.82))
    }
  },
  bricks(p) {
    const s = p.size, bh = Math.max(3, s / 4), bw = Math.max(6, s / 2)
    const mortar = p.alt
    fill(p, mortar, N())
    for (let row = 0; row < s / bh; row++) {
      const off = row % 2 ? bw / 2 : 0
      for (let col = -1; col < s / bw + 1; col++) {
        const c = shade(p.base, 0.9 + p.rnd() * 0.18)
        rect(p, col * bw + off + 1, row * bh + 1, bw - 1, bh - 1, c, N() * 0.8)
        for (let i = 1; i < bw; i++) put(p, col * bw + off + i, row * bh + 1, shade(c, 1.1))
      }
    }
  },
  planks(p) {
    const s = p.size, ph = Math.max(3, s / 4)
    for (let row = 0; row < s / ph; row++) {
      const c = shade(p.base, 0.9 + p.rnd() * 0.18)
      rect(p, 0, row * ph, s, ph, c, N() * 0.6)
      for (let x = 0; x < s; x++) put(p, x, row * ph, shade(p.alt, 0.8))
      for (let k = 0; k < s / 3; k++) put(p, p.rnd() * s, row * ph + 1 + p.rnd() * (ph - 1), shade(c, 0.88))
      const seam = Math.floor(p.rnd() * s)
      for (let j = 1; j < ph; j++) put(p, seam, row * ph + j, shade(p.alt, 0.85))
    }
  },
  vplanks(p) {
    const s = p.size, pw = Math.max(3, s / 4)
    for (let col = 0; col < s / pw; col++) {
      const c = shade(p.base, 0.9 + p.rnd() * 0.18)
      rect(p, col * pw, 0, pw, s, c, N() * 0.6)
      for (let y = 0; y < s; y++) put(p, col * pw, y, shade(p.alt, 0.8))
      for (let k = 0; k < s / 3; k++) put(p, col * pw + 1 + p.rnd() * (pw - 1), p.rnd() * s, shade(c, 0.88))
    }
  },
  crate(p) {
    const s = p.size
    PATTERNS.vplanks(p)
    const f = p.alt
    rect(p, 0, 0, s, 3, f, N()); rect(p, 0, s - 3, s, 3, f, N())
    rect(p, 0, 0, 3, s, f, N()); rect(p, s - 3, 0, 3, s, f, N())
    for (let i = 2; i < s - 2; i++) { put(p, i, i, f); put(p, i + 1, i, f); put(p, s - 1 - i, i, f); put(p, s - 2 - i, i, f) }
  },
  shingles(p) {
    const s = p.size, rh = Math.max(3, s / 5), sw = Math.max(4, s / 4)
    for (let row = 0; row < Math.ceil(s / rh); row++) {
      const off = row % 2 ? sw / 2 : 0
      for (let col = -1; col < s / sw + 1; col++) {
        const c = shade(p.base, 0.88 + p.rnd() * 0.2)
        rect(p, col * sw + off, row * rh, sw, rh, c, N() * 0.6)
        for (let i = 0; i < sw; i++) put(p, col * sw + off + i, row * rh + rh - 1, shade(c, 0.7))
        put(p, col * sw + off, row * rh + rh - 2, shade(c, 0.75))
        for (let i = 1; i < sw - 1; i++) put(p, col * sw + off + i, row * rh, shade(c, 1.12))
      }
    }
  },
  leaves(p) {
    const s = p.size
    fill(p, shade(p.base, 0.8), N())
    for (let k = 0; k < s * s / 7; k++) {
      const x = p.rnd() * s, y = p.rnd() * s
      const light = p.rnd()
      const c = light > 0.66 ? shade(p.base, 1.18) : light > 0.33 ? p.base : shade(p.base, 0.7)
      put(p, x, y, c); put(p, x + 1, y, c); put(p, x, y + 1, shade(c, 0.92))
    }
    for (let k = 0; k < s / 2; k++) put(p, p.rnd() * s, p.rnd() * s, shade(p.base, 1.32))
  },
  bark(p) {
    const s = p.size
    fill(p, p.base, N() * 0.5)
    for (let k = 0; k < s / 2; k++) {
      const x = Math.floor(p.rnd() * s), y = Math.floor(p.rnd() * s), len = 3 + Math.floor(p.rnd() * s / 3)
      const c = p.rnd() > 0.5 ? shade(p.base, 0.72) : shade(p.base, 1.15)
      for (let j = 0; j < len; j++) put(p, x, y + j, c)
    }
  },
  metal(p) {
    const s = p.size
    for (let y = 0; y < s; y++) { const c = shade(p.base, 0.94 + ((y * 7) % 5) * 0.025); for (let x = 0; x < s; x++) put(p, x, y, shade(c, 1 + (p.rnd() - 0.5) * N())) }
    for (const [x, y] of [[2, 2], [s - 3, 2], [2, s - 3], [s - 3, s - 3]]) { put(p, x, y, shade(p.base, 1.3)); put(p, x + 1, y + 1, shade(p.base, 0.6)) }
  },
  panel(p) {
    const s = p.size, h = s / 2
    fill(p, p.base, N() * 0.5)
    for (let i = 0; i < s; i++) { put(p, i, 0, p.alt); put(p, 0, i, p.alt); put(p, i, h, p.alt); put(p, h, i, p.alt) }
    for (let i = 1; i < s; i++) { put(p, i, 1, shade(p.base, 1.12)); put(p, i, h + 1, shade(p.base, 1.12)) }
  },
  grate(p) {
    const s = p.size, step = Math.max(3, s / 8)
    if (p.cutout) clear(p); else fill(p, p.alt, N())
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) if (x % step === 0 || y % step === 0) put(p, x, y, shade(p.base, (x % step === 0 ? 0.9 : 1.05)))
  },
  glass(p) {
    const s = p.size
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) put(p, x, y, shade(p.base, 0.85 + 0.25 * (1 - y / s)))
    for (let i = 0; i < s; i++) { put(p, i, s - 1 - i, shade(p.base, 1.4)); put(p, i + 3, s - 1 - i, shade(p.base, 1.25)) }
  },
  stripes(p) {
    const s = p.size, w = Math.max(2, s / 4)
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) put(p, x, y, shade(Math.floor(x / w) % 2 ? p.alt : p.base, 1 + (p.rnd() - 0.5) * N()))
  },
  rings(p) {
    const s = p.size, c = s / 2
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const r = Math.hypot(x - c + 0.5, y - c + 0.5)
      put(p, x, y, Math.floor(r / 2.5) % 2 ? p.alt : shade(p.base, 1 + (p.rnd() - 0.5) * N()))
    }
  },
  books(p) {
    const s = p.size, shelfH = s / 2
    fill(p, shade(p.alt, 0.35), 0)
    for (let shelf = 0; shelf < 2; shelf++) {
      let x = 0
      while (x < s) {
        const w = 2 + Math.floor(p.rnd() * 3)
        const h = Math.floor(shelfH * (0.6 + p.rnd() * 0.35))
        const c = p.colors.length ? p.colors[Math.floor(p.rnd() * p.colors.length)] : p.base
        rect(p, x, shelf * shelfH + shelfH - h, w, h, c)
        put(p, x, shelf * shelfH + shelfH - h + 2, shade(c, 1.4))
        x += w + (p.rnd() > 0.85 ? 1 : 0)
      }
      for (let i = 0; i < s; i++) put(p, i, shelf * shelfH + shelfH - 1, shade(p.alt, 0.6))
    }
  },
  crystal(p) {
    const s = p.size
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const facet = Math.floor((x + y * 0.5) / (s / 4)) % 2
      put(p, x, y, shade(p.base, (facet ? 1.08 : 0.88) + 0.2 * (1 - y / s)))
    }
    for (let k = 0; k < s / 3; k++) put(p, p.rnd() * s, p.rnd() * s, lighten(p.base, 0.8))
  },
  flowers(p) {
    const s = p.size
    clear(p)
    for (let k = 0; k < s * 0.7; k++) {
      const x = Math.floor(p.rnd() * s), h = Math.floor(s * (0.25 + p.rnd() * 0.4))
      const c = shade(p.base, 0.75 + p.rnd() * 0.4)
      for (let j = 0; j < h; j++) put(p, x + (j > h * 0.6 && p.rnd() > 0.6 ? 1 : 0), s - 1 - j, c)
    }
    for (let k = 0; k < s / 3; k++) {
      const x = 1 + Math.floor(p.rnd() * (s - 2)), y = Math.floor(s * (0.2 + p.rnd() * 0.45))
      const c = p.colors.length ? p.colors[Math.floor(p.rnd() * p.colors.length)] : lighten(p.base, 0.8)
      put(p, x, y, c); put(p, x - 1, y, shade(c, 0.85)); put(p, x + 1, y, shade(c, 0.85)); put(p, x, y - 1, shade(c, 1.1)); put(p, x, y + 1, shade(c, 0.8))
      put(p, x, y, lighten(c, 0.6))
    }
  },
  reeds(p) {
    const s = p.size
    clear(p)
    for (let k = 0; k < s * 0.45; k++) {
      const x = Math.floor(p.rnd() * s), h = Math.floor(s * (0.5 + p.rnd() * 0.48))
      const c = shade(p.base, 0.8 + p.rnd() * 0.35)
      for (let j = 0; j < h; j++) put(p, x, s - 1 - j, c)
      if (p.rnd() > 0.55 && p.colors.length) {
        const head = p.colors[0]
        for (let j = 0; j < 4; j++) { put(p, x, s - h + j, head); put(p, x + 1, s - h + j, shade(head, 0.8)) }
      }
    }
  },
  rug(p) {
    const s = p.size
    fill(p, p.base, N())
    for (let i = 0; i < s; i++) for (const b of [1, 2, s - 2, s - 3]) { put(p, i, b, p.alt); put(p, b, i, p.alt) }
    const c = s / 2
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) if (Math.abs(x - c + 0.5) + Math.abs(y - c + 0.5) < s / 4 && (x + y) % 2 === 0) put(p, x, y, p.alt)
  },
  arena(p) {
    const s = p.size
    if (p.cutout) clear(p); else fill(p, [0.5, 0.5, 0.5], 0)
    for (let i = 0; i < s; i++) { put(p, i, 0, p.base); put(p, 0, i, p.base); put(p, i, s - 1, p.base); put(p, s - 1, i, p.base); put(p, i, s / 2, p.base) }
    const c = s / 2
    for (let a = 0; a < 64; a++) { const t = a / 64 * Math.PI * 2; put(p, c + Math.cos(t) * s / 5, c + Math.sin(t) * s / 5, p.alt) }
  },
  stairsdown(p) {
    const s = p.size
    fill(p, p.base, N())
    for (let k = 0; k < 4; k++) rect(p, 2 + k, 4 + k * 6, s - 4 - 2 * k, 2, shade(p.alt, 1 - k * 0.15))
  },
  cloth(p) {
    const s = p.size
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) put(p, x, y, (x + y) % 4 < 2 ? p.base : mixc(p.base, p.alt, 0.5))
  },
  spots(p) {
    const s = p.size
    fill(p, p.base, N())
    for (let k = 0; k < 5; k++) {
      const x = p.rnd() * s, y = p.rnd() * s, r = 1.5 + p.rnd() * 2
      for (let j = -3; j <= 3; j++) for (let i = -3; i <= 3; i++) if (i * i + j * j <= r * r) put(p, x + i, y + j, p.alt)
    }
  },
  fluted(p) {
    const s = p.size, w = Math.max(3, s / 6)
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const t = (x % w) / w
      put(p, x, y, shade(t < 0.25 ? p.alt : p.base, 0.95 + 0.1 * Math.sin(t * Math.PI) + (p.rnd() - 0.5) * N()))
    }
  },
  magma(p) {
    const s = p.size
    fill(p, p.base, N())
    for (let k = 0; k < 4; k++) {
      let x = p.rnd() * s, y = p.rnd() * s
      for (let j = 0; j < s * 0.8; j++) {
        put(p, x, y, p.alt)
        if (p.rnd() > 0.7) put(p, x + 1, y, shade(p.alt, 0.7))
        x += p.rnd() > 0.5 ? 1 : -1
        y += p.rnd() > 0.35 ? 1 : 0
      }
    }
  },
  leds(p) {
    const s = p.size
    fill(p, shade(p.base, 0.18), N())
    for (let y = 2; y < s; y += 4) for (let x = 1; x < s; x += 3) if (p.rnd() > 0.3) put(p, x, y, p.rnd() > 0.2 ? p.base : lighten(p.base, 0.7))
  },
  screen(p) {
    const s = p.size
    fill(p, shade(p.base, 0.35), 0)
    for (let y = 3; y < s - 2; y += 3) {
      const len = 4 + Math.floor(p.rnd() * (s - 10)), x0 = 2 + (y % 2) * 2
      for (let x = x0; x < x0 + len && x < s - 2; x++) if (p.rnd() > 0.15) put(p, x, y, shade(p.base, 1.1))
    }
  },
  water(p) {
    const s = p.size
    fill(p, p.base, N() * 0.5)
    for (let k = 0; k < s / 2; k++) { const x = p.rnd() * s, y = p.rnd() * s; for (let i = 0; i < 3; i++) put(p, x + i, y, shade(p.base, 1.3)) }
  },
  cross(p) {
    const s = p.size, t = s / 6
    fill(p, p.base, N() * 0.4)
    const mark = lighten(p.base, 0.9)
    rect(p, s / 2 - t, s / 5, 2 * t, s - 2 * s / 5, mark)
    rect(p, s / 5, s / 2 - t, s - 2 * s / 5, 2 * t, mark)
  },
  badge(p) {
    const s = p.size, c = s / 2
    fill(p, p.base, N() * 0.4)
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const r = Math.hypot(x - c + 0.5, y - c + 0.5)
      if (r < s * 0.3) put(p, x, y, r < s * 0.18 ? lighten(p.base, 0.9) : shade(p.base, 0.6))
    }
  },
}

export function hasPattern(id: string): boolean { return id in PATTERNS }

/** Renders a pattern to a new canvas (size from render.json props.patternSize). */
export function renderPattern(spec: PatternSpec, size = RENDER.props.patternSize): HTMLCanvasElement {
  const canvas = createCanvas(size, size)
  const g = canvas.getContext('2d')!
  const img = g.createImageData(size, size)
  const base = hexToRgb(spec.color)
  const p: Px = {
    size,
    data: img.data,
    rnd: mulberry(hashString(`${spec.id}|${spec.color}|${spec.color2 ?? ''}`)),
    base,
    alt: spec.color2 ? hexToRgb(spec.color2) : shade(base, 0.62),
    colors: (spec.colors ?? []).map(hexToRgb),
    cutout: !!spec.cutout,
  }
  ;(PATTERNS[spec.id] ?? PATTERNS.plain)(p)
  g.putImageData(img, 0, 0)
  return canvas
}

const cache = new Map<string, THREE.Texture>()

/** Repeating (world-scaled UV) nearest texture for a pattern; cached by spec. */
export function patternTexture(spec: PatternSpec): THREE.Texture {
  const key = `${spec.id}|${spec.color}|${spec.color2 ?? ''}|${(spec.colors ?? []).join(',')}|${spec.cutout ? 1 : 0}`
  let tex = cache.get(key)
  if (!tex) {
    tex = configurePixelTexture(new THREE.CanvasTexture(renderPattern(spec)))
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping
    cache.set(key, tex)
  }
  return tex
}

export function disposePatternCache(): void {
  for (const t of cache.values()) t.dispose()
  cache.clear()
}
