// Seamless 32x32 pixel terrain tiles, cliff faces and transparent tall-grass tufts.
// Patterns are capabilities keyed by id; colours / densities come from content/placeholders.json.
import { CONTENT } from '../../shared/content/index.ts'
import type { Content } from '../../shared/content/index.ts'
import { seededFrom } from './hash.ts'
import type { SeededRandom } from './hash.ts'
import type { PixelImage, RGB } from './pixel.ts'
import { bayer4, createImage, fractalNoise, hexToRgb, makeRamp, mix, rgbToHex, setPx, shift, tileableNoise } from './pixel.ts'
import { PH } from './placeholders-data.ts'
import type { PlaceholdersFile, TerrainRecipe } from './placeholders-data.ts'

interface Ctx {
  img: PixelImage
  n: number
  rnd: SeededRandom
  colors: RGB[]
  accents: RGB[]
  p: (k: string, d: number) => number
}

const wrap = (v: number, n: number) => ((Math.floor(v) % n) + n) % n
const put = (ctx: Ctx, x: number, y: number, c: RGB) => setPx(ctx.img, wrap(x, ctx.n), wrap(y, ctx.n), c)

/** Quantises tileable noise onto the colour ramp with ordered dithering. */
function noiseFill(ctx: Ctx, cells: number[], contrast = 1.6, dither = 0.35, colors = ctx.colors): void {
  const noise = fractalNoise(ctx.n, ctx.n, cells, ctx.rnd.next)
  for (let y = 0; y < ctx.n; y++) {
    for (let x = 0; x < ctx.n; x++) {
      let v = (noise[y * ctx.n + x] - 0.5) * contrast + 0.5 + (bayer4(x, y) - 0.5) * dither
      v = Math.min(0.999, Math.max(0, v))
      setPx(ctx.img, x, y, colors[Math.floor(v * colors.length)])
    }
  }
}

const accent = (ctx: Ctx, i: number): RGB => ctx.accents[i % Math.max(1, ctx.accents.length)] ?? ctx.colors[ctx.colors.length - 1]
const light = (ctx: Ctx) => ctx.colors[ctx.colors.length - 1]
const dark = (ctx: Ctx) => ctx.colors[0]

function blades(ctx: Ctx, count: number, len: number): void {
  for (let i = 0; i < count; i++) {
    const x = ctx.rnd.int(0, ctx.n - 1), y = ctx.rnd.int(0, ctx.n - 1)
    const lean = ctx.rnd.pick([-1, 0, 0, 1])
    put(ctx, x, y + 1, dark(ctx))
    for (let k = 0; k < len; k++) put(ctx, x + (k === len - 1 ? lean : 0), y - k, k === len - 1 ? light(ctx) : ctx.colors[Math.max(1, ctx.colors.length - 2)])
  }
}

function pebbles(ctx: Ctx, count: number): void {
  for (let i = 0; i < count; i++) {
    const x = ctx.rnd.int(0, ctx.n - 1), y = ctx.rnd.int(0, ctx.n - 1)
    const c = accent(ctx, i)
    const w = ctx.rnd.int(1, 2)
    for (let dx = 0; dx <= w; dx++) { put(ctx, x + dx, y, shift(c, 0.06)); put(ctx, x + dx, y + 1, c) }
    put(ctx, x + w + 1, y + 1, dark(ctx)); put(ctx, x + 1, y + 2, dark(ctx))
  }
}

/** Tileable Voronoi: nearest / second-nearest distances and the owning cell. */
function voronoi(ctx: Ctx, cells: number, jitter = 1): { id: Int32Array; d1: Float32Array; d2: Float32Array; seeds: [number, number][] } {
  const seeds: [number, number][] = []
  const g = Math.max(1, Math.round(Math.sqrt(cells)))
  const step = ctx.n / g
  for (let gy = 0; gy < g; gy++) for (let gx = 0; gx < g; gx++) {
    seeds.push([(gx + 0.5 + (ctx.rnd.next() - 0.5) * jitter) * step, (gy + 0.5 + (ctx.rnd.next() - 0.5) * jitter) * step])
  }
  const id = new Int32Array(ctx.n * ctx.n), d1 = new Float32Array(ctx.n * ctx.n), d2 = new Float32Array(ctx.n * ctx.n)
  for (let y = 0; y < ctx.n; y++) for (let x = 0; x < ctx.n; x++) {
    let b1 = Infinity, b2 = Infinity, bi = 0
    seeds.forEach(([sx, sy], i) => {
      let dx = Math.abs(x + 0.5 - sx), dy = Math.abs(y + 0.5 - sy)
      dx = Math.min(dx, ctx.n - dx); dy = Math.min(dy, ctx.n - dy)
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d < b1) { b2 = b1; b1 = d; bi = i } else if (d < b2) b2 = d
    })
    const k = y * ctx.n + x
    id[k] = bi; d1[k] = b1; d2[k] = b2
  }
  return { id, d1, d2, seeds }
}

function wavyLine(ctx: Ctx, y0: number, amp: number, freq: number, phase: number, c: RGB, under?: RGB, dashed = false): void {
  for (let x = 0; x < ctx.n; x++) {
    if (dashed && ((x + Math.floor(phase * 7)) % 7) > 3) continue
    const y = Math.round(y0 + Math.sin((x / ctx.n) * Math.PI * 2 * freq + phase) * amp)
    put(ctx, x, y, c)
    if (under) put(ctx, x, y + 1, under)
  }
}

function crack(ctx: Ctx, len: number, c: RGB): void {
  let x = ctx.rnd.int(0, ctx.n - 1), y = ctx.rnd.int(0, ctx.n - 1)
  for (let i = 0; i < len; i++) {
    put(ctx, x, y, c)
    x += ctx.rnd.pick([-1, 0, 1]); y += ctx.rnd.pick([0, 1, 1])
  }
}

const PATTERNS: Record<string, (ctx: Ctx) => void> = {
  noise(ctx) { noiseFill(ctx, [16, 8, 4], ctx.p('contrast', 1.4)) },
  grass(ctx) {
    noiseFill(ctx, [16, 8, 4], ctx.p('contrast', 1.5))
    blades(ctx, ctx.p('blades', 46), ctx.p('bladeLen', 2))
    for (let i = 0; i < ctx.p('flecks', 0); i++) put(ctx, ctx.rnd.int(0, 31), ctx.rnd.int(0, 31), accent(ctx, i))
  },
  flowers(ctx) {
    PATTERNS.grass(ctx)
    for (let i = 0; i < ctx.p('flowers', 9); i++) {
      const x = ctx.rnd.int(0, ctx.n - 1), y = ctx.rnd.int(0, ctx.n - 1)
      const c = accent(ctx, i + 1)
      put(ctx, x - 1, y, c); put(ctx, x + 1, y, c); put(ctx, x, y - 1, shift(c, 0.1)); put(ctx, x, y + 1, shift(c, -0.12))
      put(ctx, x, y, accent(ctx, 0)); put(ctx, x + 1, y + 1, dark(ctx))
    }
  },
  leaves(ctx) {
    noiseFill(ctx, [16, 8, 4], ctx.p('contrast', 1.5))
    for (let i = 0; i < ctx.p('leaves', 18); i++) {
      const x = ctx.rnd.int(0, ctx.n - 1), y = ctx.rnd.int(0, ctx.n - 1)
      const c = accent(ctx, i)
      put(ctx, x, y, c); put(ctx, x + 1, y, shift(c, 0.08)); put(ctx, x + 1, y + 1, shift(c, -0.15)); put(ctx, x, y + 1, dark(ctx))
    }
    for (let i = 0; i < ctx.p('twigs', 3); i++) {
      const x = ctx.rnd.int(0, ctx.n - 1), y = ctx.rnd.int(0, ctx.n - 1)
      for (let k = 0; k < 4; k++) put(ctx, x + k, y + (k > 1 ? 1 : 0), accent(ctx, ctx.accents.length - 1))
    }
  },
  dirt(ctx) {
    noiseFill(ctx, [16, 8, 4], ctx.p('contrast', 1.3))
    pebbles(ctx, ctx.p('pebbles', 7))
    for (let i = 0; i < ctx.p('specks', 22); i++) put(ctx, ctx.rnd.int(0, 31), ctx.rnd.int(0, 31), ctx.rnd.chance(0.5) ? dark(ctx) : light(ctx))
  },
  sand(ctx) {
    noiseFill(ctx, [8, 4], ctx.p('contrast', 1.0), 0.45)
    const rows = ctx.p('ripples', 4)
    for (let r = 0; r < rows; r++) wavyLine(ctx, (r + 0.5) * (ctx.n / rows), 1.2, 1, ctx.rnd.next() * 6, light(ctx), ctx.colors[1], true)
    for (let i = 0; i < ctx.p('specks', 10); i++) put(ctx, ctx.rnd.int(0, 31), ctx.rnd.int(0, 31), accent(ctx, i))
  },
  snow(ctx) {
    noiseFill(ctx, [16, 8], ctx.p('contrast', 1.0), 0.3)
    for (let r = 0; r < 3; r++) wavyLine(ctx, (r + 0.4) * 11, 1.5, 1, ctx.rnd.next() * 6, ctx.colors[1], undefined, true)
    for (let i = 0; i < ctx.p('sparkles', 8); i++) put(ctx, ctx.rnd.int(0, 31), ctx.rnd.int(0, 31), accent(ctx, i))
  },
  water(ctx) {
    const nA = tileableNoise(ctx.n, ctx.n, 16, ctx.rnd.next), nB = tileableNoise(ctx.n, ctx.n, 8, ctx.rnd.next)
    for (let y = 0; y < ctx.n; y++) for (let x = 0; x < ctx.n; x++) {
      const v = Math.min(0.999, Math.max(0, (nA[y * ctx.n + x] * 0.7 + nB[wrap(y * 2, ctx.n) * ctx.n + x] * 0.3 - 0.5) * 1.5 + 0.5 + (bayer4(x, y) - 0.5) * 0.3))
      setPx(ctx.img, x, y, ctx.colors[Math.floor(v * (ctx.colors.length - 1))])
    }
    for (let i = 0; i < ctx.p('waves', 9); i++) {
      const x = ctx.rnd.int(0, ctx.n - 1), y = ctx.rnd.int(0, ctx.n - 1), w = ctx.rnd.int(2, 5)
      for (let k = 0; k < w; k++) put(ctx, x + k, y, k === 0 || k === w - 1 ? ctx.colors[ctx.colors.length - 2] : light(ctx))
      for (let k = 1; k < w - 1; k++) put(ctx, x + k, y + 1, ctx.colors[1])
    }
    for (let i = 0; i < ctx.p('glints', 3); i++) put(ctx, ctx.rnd.int(0, 31), ctx.rnd.int(0, 31), accent(ctx, 0))
  },
  rock(ctx) {
    noiseFill(ctx, [16, 8, 4], ctx.p('contrast', 1.5))
    for (let i = 0; i < ctx.p('cracks', 4); i++) crack(ctx, ctx.rnd.int(5, 10), dark(ctx))
    pebbles(ctx, ctx.p('pebbles', 3))
  },
  cobble(ctx) {
    const v = voronoi(ctx, ctx.p('stones', 9), 0.8)
    const tints = v.seeds.map(() => ctx.colors[ctx.rnd.int(1, Math.max(1, ctx.colors.length - 2))])
    const gap = ctx.p('mortar', 1.1)
    for (let y = 0; y < ctx.n; y++) for (let x = 0; x < ctx.n; x++) {
      const k = y * ctx.n + x
      if (v.d2[k] - v.d1[k] < gap) { setPx(ctx.img, x, y, dark(ctx)); continue }
      const [sx, sy] = v.seeds[v.id[k]]
      let dx = x + 0.5 - sx, dy = y + 0.5 - sy
      if (dx > ctx.n / 2) dx -= ctx.n; if (dx < -ctx.n / 2) dx += ctx.n
      if (dy > ctx.n / 2) dy -= ctx.n; if (dy < -ctx.n / 2) dy += ctx.n
      const edge = v.d2[k] - v.d1[k] < gap + 1.4
      const lit = -dx - dy
      let c = tints[v.id[k]]
      if (edge && lit > 0) c = light(ctx)
      else if (edge) c = shift(c, -0.1, -6)
      if ((bayer4(x, y) > 0.85) && !edge) c = shift(c, 0.04)
      setPx(ctx.img, x, y, c)
    }
    for (let i = 0; i < ctx.p('moss', 0); i++) put(ctx, ctx.rnd.int(0, 31), ctx.rnd.int(0, 31), accent(ctx, i))
  },
  mud(ctx) {
    noiseFill(ctx, [16, 8, 4], ctx.p('contrast', 1.4))
    const n = fractalNoise(ctx.n, ctx.n, [8, 4], ctx.rnd.next)
    const wet = ctx.p('wet', 0.3)
    for (let y = 0; y < ctx.n; y++) for (let x = 0; x < ctx.n; x++) if (n[y * ctx.n + x] < wet) setPx(ctx.img, x, y, accent(ctx, 0))
    for (let i = 0; i < ctx.p('glints', 10); i++) {
      const x = ctx.rnd.int(0, ctx.n - 1), y = ctx.rnd.int(0, ctx.n - 1)
      if (n[y * ctx.n + x] >= wet - 0.04) continue
      put(ctx, x, y, accent(ctx, 1))
      put(ctx, x + 1, y, accent(ctx, 1))
    }
    pebbles(ctx, ctx.p('pebbles', 3))
  },
  lava(ctx) {
    const n = fractalNoise(ctx.n, ctx.n, [16, 8, 4], ctx.rnd.next)
    for (let y = 0; y < ctx.n; y++) for (let x = 0; x < ctx.n; x++) {
      const v = n[y * ctx.n + x]
      const vein = Math.abs(v - 0.5)
      let c: RGB
      if (vein < 0.035) c = accent(ctx, 0)
      else if (vein < 0.08) c = light(ctx)
      else if (v < 0.36) c = dark(ctx)
      else c = ctx.colors[Math.min(ctx.colors.length - 2, 1 + Math.floor(((v - 0.36) / 0.64) * (ctx.colors.length - 2) + (bayer4(x, y) - 0.5) * 0.6))]
      setPx(ctx.img, x, y, c)
    }
  },
  metal(ctx) {
    noiseFill(ctx, [16, 8], ctx.p('contrast', 0.6), 0.25, ctx.colors.slice(1, -1))
    const panel = ctx.p('panel', 16)
    for (let y = 0; y < ctx.n; y++) for (let x = 0; x < ctx.n; x++) {
      const px = x % panel, py = y % panel
      if (px === 0 || py === 0) setPx(ctx.img, x, y, dark(ctx))
      else if (px === 1 || py === 1) setPx(ctx.img, x, y, light(ctx))
      else if (px === panel - 1 || py === panel - 1) setPx(ctx.img, x, y, ctx.colors[1])
    }
    for (let y = 0; y < ctx.n; y += panel) for (let x = 0; x < ctx.n; x += panel) {
      for (const [rx, ry] of [[3, 3], [panel - 4, 3], [3, panel - 4], [panel - 4, panel - 4]]) {
        put(ctx, x + rx, y + ry, light(ctx)); put(ctx, x + rx + 1, y + ry + 1, dark(ctx))
      }
    }
    if (ctx.accents.length) for (let x = 0; x < ctx.n; x++) if ((x >> 1) % 3 !== 0) put(ctx, x, Math.floor(panel / 2), accent(ctx, 0))
  },
  planks(ctx) {
    const h = ctx.p('plank', 8)
    const gapDark = ctx.p('gap', 0) > 0
    for (let row = 0; row < ctx.n / h; row++) {
      const tint = ctx.colors[ctx.rnd.int(1, ctx.colors.length - 2)]
      const seam = ctx.rnd.int(0, ctx.n - 1)
      const grainA = ctx.rnd.int(1, h - 2), grainB = ctx.rnd.int(1, h - 2)
      for (let yy = 0; yy < h; yy++) for (let x = 0; x < ctx.n; x++) {
        const y = row * h + yy
        let c = tint
        if (yy === 0) c = gapDark ? dark(ctx) : shift(tint, 0.08, 4)
        else if (yy === h - 1) c = ctx.colors[0]
        else if ((yy === grainA && (x * 3 + row * 5) % 11 < 6) || (yy === grainB && (x * 5 + row * 3) % 13 < 4)) c = shift(tint, -0.07, -4)
        if (wrap(x - seam, ctx.n) === 0 && yy > 0) c = dark(ctx)
        setPx(ctx.img, x, y, c)
      }
      if (ctx.p('nails', 0)) { put(ctx, seam + 2, row * h + 2, light(ctx)); put(ctx, seam + 2, row * h + h - 3, light(ctx)) }
    }
  },
  tiles(ctx) {
    const t = ctx.p('tile', 16)
    for (let ty = 0; ty < ctx.n / t; ty++) for (let tx = 0; tx < ctx.n / t; tx++) {
      const tint = ctx.colors[ctx.rnd.int(1, Math.max(1, ctx.colors.length - 2))]
      for (let yy = 0; yy < t; yy++) for (let xx = 0; xx < t; xx++) {
        let c = tint
        if (xx === 0 || yy === 0) c = dark(ctx)
        else if (xx === 1 || yy === 1) c = light(ctx)
        else if (xx === t - 1 || yy === t - 1) c = shift(tint, -0.08, -4)
        else if ((xx + yy) % 9 === 0 && bayer4(xx, yy) > 0.5) c = shift(tint, 0.03)
        setPx(ctx.img, tx * t + xx, ty * t + yy, c)
      }
    }
  },
  carpet(ctx) {
    noiseFill(ctx, [8, 4], ctx.p('contrast', 0.5), 0.5, ctx.colors.slice(0, -1))
    const s = ctx.p('motif', 8)
    for (let y = 0; y < ctx.n; y++) for (let x = 0; x < ctx.n; x++) {
      const dx = Math.abs((x % s) - s / 2 + 0.5), dy = Math.abs((y % s) - s / 2 + 0.5)
      if (Math.round(dx + dy) === Math.floor(s / 2) - 1) setPx(ctx.img, x, y, accent(ctx, 0))
      if (dx + dy < 1.2) setPx(ctx.img, x, y, light(ctx))
    }
  },
  ice(ctx) {
    noiseFill(ctx, [16, 8], ctx.p('contrast', 0.9), 0.3)
    for (let i = 0; i < ctx.p('streaks', 3); i++) {
      const x0 = ctx.rnd.int(0, ctx.n - 1), y0 = ctx.rnd.int(0, ctx.n - 1), len = ctx.rnd.int(4, 8)
      for (let k = 0; k < len; k++) put(ctx, x0 + k, y0 - k, k % 3 === 2 ? light(ctx) : accent(ctx, 0))
    }
    for (let i = 0; i < ctx.p('cracks', 2); i++) crack(ctx, ctx.rnd.int(5, 9), ctx.colors[ctx.colors.length - 2])
  },
  crystal(ctx) {
    const v = voronoi(ctx, ctx.p('facets', 9), 1)
    const tints = v.seeds.map(() => ctx.colors[ctx.rnd.int(1, ctx.colors.length - 2)])
    for (let y = 0; y < ctx.n; y++) for (let x = 0; x < ctx.n; x++) {
      const k = y * ctx.n + x
      const edge = v.d2[k] - v.d1[k]
      let c = tints[v.id[k]]
      if (edge < 0.9) c = light(ctx)
      else if (edge < 2) c = shift(c, 0.06)
      else if (v.d1[k] > 5) c = shift(c, -0.06)
      setPx(ctx.img, x, y, c)
    }
    for (let i = 0; i < ctx.p('glints', 5); i++) put(ctx, ctx.rnd.int(0, 31), ctx.rnd.int(0, 31), accent(ctx, 0))
  },
  bricks(ctx) {
    const bh = ctx.p('brick', 8), bw = ctx.p('brickW', 16)
    for (let row = 0; row < ctx.n / bh; row++) {
      const off = (row % 2) * (bw / 2)
      for (let b = 0; b < ctx.n / bw + 1; b++) {
        const tint = ctx.colors[ctx.rnd.int(1, ctx.colors.length - 2)]
        for (let yy = 0; yy < bh; yy++) for (let xx = 0; xx < bw; xx++) {
          let c = tint
          if (yy === bh - 1 || xx === bw - 1) c = dark(ctx)
          else if (yy === 0 || xx === 0) c = light(ctx)
          else if (bayer4(xx, yy) > 0.9) c = shift(tint, -0.05)
          put(ctx, b * bw + xx + off, row * bh + yy, c)
        }
      }
    }
    for (let i = 0; i < ctx.p('moss', 0); i++) {
      const x = ctx.rnd.int(0, ctx.n - 1), y = ctx.rnd.int(0, ctx.n - 1)
      put(ctx, x, y, accent(ctx, i)); put(ctx, x + 1, y, accent(ctx, i + 1)); put(ctx, x, y + 1, accent(ctx, i))
    }
    for (let i = 0; i < ctx.p('cracks', 0); i++) crack(ctx, ctx.rnd.int(3, 6), dark(ctx))
  },
  steps(ctx) {
    const s = ctx.p('step', 8)
    noiseFill(ctx, [8, 4], ctx.p('contrast', 0.8), 0.3, ctx.colors.slice(1, -1))
    for (let y = 0; y < ctx.n; y++) {
      const k = y % s
      for (let x = 0; x < ctx.n; x++) {
        if (k === 0) setPx(ctx.img, x, y, light(ctx))
        else if (k >= s - 3) setPx(ctx.img, x, y, k === s - 1 ? dark(ctx) : ctx.colors[1])
      }
    }
  },
  cliff(ctx) {
    const n = tileableNoise(ctx.n, ctx.n, 8, ctx.rnd.next)
    const bands = ctx.p('bands', 4)
    for (let y = 0; y < ctx.n; y++) for (let x = 0; x < ctx.n; x++) {
      const by = y + (n[y * ctx.n + x] - 0.5) * ctx.p('warp', 5)
      const band = wrap(Math.floor((by / ctx.n) * bands), bands)
      const within = ((by / ctx.n) * bands) % 1
      let c = ctx.colors[1 + (band % Math.max(1, ctx.colors.length - 2))]
      if (within < 0.12) c = light(ctx)
      else if (within > 0.86) c = dark(ctx)
      else if (bayer4(x, y) > 0.88) c = shift(c, -0.06)
      setPx(ctx.img, x, y, c)
    }
    for (let i = 0; i < ctx.p('cracks', 4); i++) {
      const x = ctx.rnd.int(0, ctx.n - 1), y = ctx.rnd.int(0, ctx.n - 1), len = ctx.rnd.int(3, 7)
      for (let k = 0; k < len; k++) { put(ctx, x + (k % 3 === 2 ? 1 : 0), y + k, dark(ctx)); put(ctx, x + 1 + (k % 3 === 2 ? 1 : 0), y + k, light(ctx)) }
    }
    if (ctx.accents.length) {
      const cap = ctx.p('cap', 0)
      for (let x = 0; x < ctx.n; x++) {
        const h = cap > 0 ? Math.round(cap + Math.sin(x * 0.9) * 1.2 + (x % 5 === 0 ? 2 : 0)) : 0
        for (let y = 0; y < h; y++) put(ctx, x, y, y === h - 1 ? accent(ctx, 1) : accent(ctx, 0))
      }
      for (let i = 0; i < ctx.p('moss', 0); i++) put(ctx, ctx.rnd.int(0, 31), ctx.rnd.int(0, 31), accent(ctx, i))
    }
  },
  void(ctx) {
    noiseFill(ctx, [16, 8], ctx.p('contrast', 0.8), 0.4)
    for (let i = 0; i < ctx.p('stars', 4); i++) put(ctx, ctx.rnd.int(0, 31), ctx.rnd.int(0, 31), accent(ctx, i))
  },
}

function recipeFor(key: string, c: Content, ph: PlaceholdersFile): TerrainRecipe {
  const r = ph.terrain.recipes[key]
  if (r) return r
  const def = c.terrainByKey[key]
  const base = hexToRgb(def?.minimap ?? ph.terrain.fallback.colors[0])
  const ramp = makeRamp(base, ph.shading)
  return { ...ph.terrain.fallback, colors: ramp.map(rgbToHex) }
}

/** Seamless terrain (or cliff) tile for a texture key. Unknown keys derive a palette from TerrainDef.minimap. */
export function drawTerrain(key: string, c: Content = CONTENT, ph: PlaceholdersFile = PH): PixelImage {
  const n = ph.terrain.size
  const recipe = recipeFor(key, c, ph)
  const ctx: Ctx = {
    img: createImage(n, n),
    n,
    rnd: seededFrom('terrain', key),
    colors: recipe.colors.map(hexToRgb),
    accents: (recipe.accents ?? []).map(hexToRgb),
    p: (k, d) => recipe.params?.[k] ?? d,
  }
  if (ctx.colors.length < 3) ctx.colors = makeRamp(ctx.colors[0] ?? hexToRgb(ph.details.neutral), ph.shading)
  ;(PATTERNS[recipe.pattern] ?? PATTERNS.noise)(ctx)
  return ctx.img
}

/** Transparent grass-blade overlay for tall-grass terrains (`<key>_tuft`). Wraps horizontally. */
export function drawTuft(terrainKey: string, c: Content = CONTENT, ph: PlaceholdersFile = PH): PixelImage {
  const n = ph.terrain.size
  const img = createImage(n, n)
  const rnd = seededFrom('tuft', terrainKey)
  const cfg = ph.terrain.tuft
  const recipe = ph.terrain.recipes[terrainKey]
  const colors = (ph.terrain.tuftColors[terrainKey] ?? recipe?.colors ?? cfg.colors).map(hexToRgb)
  const ramp = colors.length >= 3 ? colors : makeRamp(colors[0] ?? hexToRgb(c.terrainByKey[terrainKey]?.minimap ?? ph.details.neutral), ph.shading)
  const order = Array.from({ length: cfg.blades }, (_, i) => i).sort(() => rnd.next() - 0.5)
  for (const i of order) {
    const x0 = ((i + rnd.next()) / cfg.blades) * n
    const h = rnd.int(cfg.minHeight, cfg.maxHeight)
    const lean = (rnd.next() - 0.5) * cfg.lean
    const wide = rnd.chance(cfg.wideChance)
    for (let k = 0; k < h; k++) {
      const t = k / Math.max(1, h - 1)
      const x = x0 + lean * k * t * cfg.curve
      const y = n - 1 - k
      const ci = Math.min(ramp.length - 1, Math.floor(t * (ramp.length - 0.01)))
      const col = ramp[ci]
      setPx(img, wrap(x, n), y, col)
      if (wide && t < cfg.wideUntil) setPx(img, wrap(x + 1, n), y, mix(col, ramp[0], cfg.wideShade))
    }
  }
  return img
}
