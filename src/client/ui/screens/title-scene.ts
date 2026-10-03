// Title backdrop: procedural pixel landscape (used when /assets/ui/title.png is absent) and drifting light motes.
// Palette, ridge shapes, star counts and particle tunables live in content/screens.json title.*.
import { parseColor, type RGBA } from '../pixel.ts'
import type { ParticleConfig, TitleSceneConfig } from './config.ts'

function hash(n: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b)
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35)
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296
}

function valueNoise(x: number, seed: number): number {
  const i = Math.floor(x)
  const f = x - i
  const s = f * f * (3 - 2 * f)
  const a = hash(i * 7919 + seed * 104729)
  const b = hash((i + 1) * 7919 + seed * 104729)
  return a + (b - a) * s
}

const lerp = (a: RGBA, b: RGBA, k: number): RGBA => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, 255]

// 4x4 Bayer matrix for ordered dithering between sky bands.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]

/** Paints the procedural landscape at pixel resolution w x h. */
export function paintTitleScene(cv: HTMLCanvasElement, w: number, h: number, cfg: TitleSceneConfig): void {
  cv.width = Math.max(1, Math.round(w))
  cv.height = Math.max(1, Math.round(h))
  const W = cv.width
  const Hh = cv.height
  const ctx = cv.getContext('2d')!
  const img = ctx.createImageData(W, Hh)
  const d = img.data
  const sky = cfg.sky.map(parseColor)
  const put = (x: number, y: number, c: RGBA, a = 1) => {
    if (x < 0 || y < 0 || x >= W || y >= Hh) return
    const o = (y * W + x) * 4
    d[o] = d[o] * (1 - a) + c[0] * a
    d[o + 1] = d[o + 1] * (1 - a) + c[1] * a
    d[o + 2] = d[o + 2] * (1 - a) + c[2] * a
    d[o + 3] = 255
  }
  // Sky: banded gradient through the stops with ordered dithering at band edges.
  const bands = Math.max(2, sky.length)
  for (let y = 0; y < Hh; y++) {
    const t = (y / Math.max(1, Hh - 1)) * (bands - 1)
    const i = Math.min(bands - 2, Math.floor(t))
    const f = t - i
    for (let x = 0; x < W; x++) {
      const steps = 6
      const q = Math.floor(f * steps + BAYER[(y & 3) * 4 + (x & 3)] / 16) / steps
      put(x, y, lerp(sky[i], sky[i + 1], Math.min(1, q)))
    }
  }
  // Stars in the upper band.
  const starCols = cfg.starColors.map(parseColor)
  for (let i = 0; i < cfg.stars; i++) {
    const x = Math.floor(hash(i * 3 + 1) * W)
    const y = Math.floor(Math.pow(hash(i * 3 + 2), 1.6) * Hh * cfg.starBand)
    const c = starCols[i % starCols.length]
    const a = 0.35 + hash(i * 3 + 3) * 0.65 * (1 - y / (Hh * cfg.starBand))
    put(x, y, c, a)
    if (hash(i * 7 + 5) > 0.93) { put(x - 1, y, c, a * 0.4); put(x + 1, y, c, a * 0.4); put(x, y - 1, c, a * 0.4); put(x, y + 1, c, a * 0.4) }
  }
  // Sun with a stepped glow.
  const sun = cfg.sun
  const sc = parseColor(sun.color)
  const sg = parseColor(sun.glow)
  const cx = sun.x * W
  const cy = sun.y * Hh
  const r = sun.radius * Math.min(W, Hh)
  for (let y = Math.floor(cy - r * 5); y <= cy + r * 5; y++) {
    for (let x = Math.floor(cx - r * 5); x <= cx + r * 5; x++) {
      const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
      if (dist <= r) put(x, y, sc)
      else {
        const k = 1 - (dist - r) / (r * 4)
        if (k > 0) put(x, y, sg, Math.floor(k * 5) / 5 * 0.45)
      }
    }
  }
  // Ridges back to front.
  for (const ridge of cfg.ridges) {
    const col = parseColor(ridge.color)
    const rim = lerp(col, sg, 0.35)
    for (let x = 0; x < W; x++) {
      const u = x / W
      const n = valueNoise(u * ridge.freq, ridge.seed) * 0.65 + valueNoise(u * ridge.freq * 2.7, ridge.seed + 1) * 0.35
      const top = Math.round((ridge.base - n * ridge.amp) * Hh)
      for (let y = Math.max(0, top); y < Hh; y++) put(x, y, y === top ? rim : col)
    }
  }
  // Warm haze rising from the horizon.
  const haze = parseColor(cfg.haze)
  const hz0 = Math.floor(Hh * 0.55)
  for (let y = hz0; y < Hh; y++) {
    const k = Math.sin(((y - hz0) / (Hh - hz0)) * Math.PI) * cfg.hazeAlpha
    for (let x = 0; x < W; x++) if (BAYER[(y & 3) * 4 + (x & 3)] / 16 < k * 2) put(x, y, haze, k)
  }
  ctx.putImageData(img, 0, 0)
}

interface Mote { x: number; y: number; vy: number; size: number; phase: number; color: string; sway: number }

export interface Motes {
  resize(w: number, h: number): void
  update(dtSec: number): void
}

/** Rising light motes drawn at UI-pixel resolution (crisp 1-2px squares with a soft halo). */
export function createMotes(cv: HTMLCanvasElement, cfg: ParticleConfig): Motes {
  const ctx = cv.getContext('2d')!
  let W = 1
  let Hh = 1
  let t = 0
  let motes: Mote[] = []
  const spawn = (i: number, anywhere: boolean): Mote => {
    const r = (k: number) => hash(i * 13 + k + Math.floor(t * 1000))
    return {
      x: r(1) * W,
      y: anywhere ? r(2) * Hh : Hh + r(2) * 8,
      vy: cfg.speedMin + r(3) * (cfg.speedMax - cfg.speedMin),
      size: Math.round(cfg.sizeMin + r(4) * (cfg.sizeMax - cfg.sizeMin)),
      phase: r(5) * Math.PI * 2,
      color: cfg.colors[Math.floor(r(6) * cfg.colors.length) % cfg.colors.length],
      sway: cfg.swayUnits * (0.4 + r(7) * 0.6),
    }
  }
  return {
    resize(w, h) {
      W = Math.max(1, Math.round(w))
      Hh = Math.max(1, Math.round(h))
      cv.width = W
      cv.height = Hh
      motes = Array.from({ length: cfg.count }, (_, i) => spawn(i, true))
    },
    update(dt) {
      t += dt
      ctx.clearRect(0, 0, W, Hh)
      motes.forEach((m, i) => {
        m.y -= m.vy * dt
        if (m.y < -4) motes[i] = m = spawn(i, false)
        const x = Math.round(m.x + Math.sin(t * cfg.swayHz * Math.PI * 2 + m.phase) * m.sway)
        const y = Math.round(m.y)
        const tw = 0.55 + 0.45 * Math.sin(t * cfg.twinkleHz * Math.PI * 2 + m.phase * 3)
        ctx.globalAlpha = tw * 0.25
        ctx.fillStyle = m.color
        ctx.fillRect(x - 1, y - 1, m.size + 2, m.size + 2)
        ctx.globalAlpha = tw
        ctx.fillRect(x, y, m.size, m.size)
      })
      ctx.globalAlpha = 1
    },
  }
}
