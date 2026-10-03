// Seeded, deterministic 2D noise: gradient (Perlin) and simplex noise, fBm, ridged multifractal, domain
// warping, Worley/cellular noise and a coarse-lattice field sampler. Pure functions over small immutable
// tables; only integer ops (Math.imul), + - * /, Math.floor and Math.sqrt are used so every JS engine
// produces bit-identical results (client and server build the same world).

/** 32-bit integer mix of three values (same family as the world generator's hash3). */
export function mix3(a: number, b: number, c: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b | 0, 0x27d4eb2d) ^ Math.imul(c | 0, 0x165667b1)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  return (h ^ (h >>> 15)) >>> 0
}

const PERIOD = 1024
const MASK = PERIOD - 1

/** A seeded noise source (permutation table + per-octave offsets). Create once, sample many times. */
export interface Noise2 {
  readonly seed: number
  /** Permutation table, doubled (length 2 * PERIOD). */
  readonly perm: Uint16Array
  /** Per-octave lattice offsets (decorrelate octaves). */
  readonly ox: Float64Array
  readonly oy: Float64Array
}

export function createNoise(seed: number): Noise2 {
  const p = new Uint16Array(PERIOD * 2)
  for (let i = 0; i < PERIOD; i++) p[i] = i
  for (let i = PERIOD - 1; i > 0; i--) {
    const j = mix3(seed, i, 0x51ed) % (i + 1)
    const t = p[i]; p[i] = p[j]; p[j] = t
  }
  for (let i = 0; i < PERIOD; i++) p[PERIOD + i] = p[i]
  const ox = new Float64Array(16), oy = new Float64Array(16)
  for (let o = 0; o < 16; o++) {
    ox[o] = (mix3(seed, o, 0x0ff5e7) % 100003) / 7.31
    oy[o] = (mix3(seed, o, 0x0ff5e8) % 100003) / 7.31
  }
  return { seed: seed >>> 0, perm: p, ox, oy }
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)

function grad(h: number, x: number, y: number): number {
  switch (h & 7) {
    case 0: return x + y
    case 1: return -x + y
    case 2: return x - y
    case 3: return -x - y
    case 4: return x
    case 5: return -x
    case 6: return y
    default: return -y
  }
}

/** Classic 2D gradient (Perlin) noise, roughly in [-1, 1], period 1024 lattice cells. */
export function perlin(n: Noise2, x: number, y: number): number {
  const fx0 = Math.floor(x), fy0 = Math.floor(y)
  const fx = x - fx0, fy = y - fy0
  const X = fx0 & MASK, Y = fy0 & MASK
  const p = n.perm
  const a = p[X] + Y, b = p[X + 1] + Y
  const u = fade(fx), v = fade(fy)
  const n00 = grad(p[a & MASK], fx, fy)
  const n10 = grad(p[b & MASK], fx - 1, fy)
  const n01 = grad(p[(a + 1) & MASK], fx, fy - 1)
  const n11 = grad(p[(b + 1) & MASK], fx - 1, fy - 1)
  const l0 = n00 + u * (n10 - n00)
  const l1 = n01 + u * (n11 - n01)
  return l0 + v * (l1 - l0)
}

const SQRT3 = Math.sqrt(3)
const F2 = 0.5 * (SQRT3 - 1)
const G2 = (3 - SQRT3) / 6

/** 2D simplex noise, roughly in [-1, 1]. Fewer directional artefacts than Perlin at similar cost. */
export function simplex(n: Noise2, x: number, y: number): number {
  const s = (x + y) * F2
  const i = Math.floor(x + s), j = Math.floor(y + s)
  const t = (i + j) * G2
  const x0 = x - (i - t), y0 = y - (j - t)
  const i1 = x0 > y0 ? 1 : 0, j1 = 1 - i1
  const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2
  const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2
  const ii = i & MASK, jj = j & MASK
  const p = n.perm
  let sum = 0
  let q = 0.5 - x0 * x0 - y0 * y0
  if (q > 0) { q *= q; sum += q * q * grad(p[(ii + p[jj]) & MASK], x0, y0) }
  q = 0.5 - x1 * x1 - y1 * y1
  if (q > 0) { q *= q; sum += q * q * grad(p[(ii + i1 + p[(jj + j1) & MASK]) & MASK], x1, y1) }
  q = 0.5 - x2 * x2 - y2 * y2
  if (q > 0) { q *= q; sum += q * q * grad(p[(ii + 1 + p[(jj + 1) & MASK]) & MASK], x2, y2) }
  return 45 * sum
}

export interface FbmOpts {
  /** Lattice frequency of the first octave (1 / feature size in tiles). */
  frequency: number
  octaves: number
  /** Amplitude multiplier per octave (persistence). */
  gain: number
  /** Frequency multiplier per octave. */
  lacunarity: number
}

/** Fractal Brownian motion of Perlin octaves, normalised to roughly [-1, 1]. */
export function fbm(n: Noise2, x: number, y: number, o: FbmOpts): number {
  let sum = 0, amp = 1, norm = 0, f = o.frequency
  const oc = o.octaves < 16 ? o.octaves : 16
  for (let k = 0; k < oc; k++) {
    sum += amp * perlin(n, x * f + n.ox[k], y * f + n.oy[k])
    norm += amp
    amp *= o.gain
    f *= o.lacunarity
  }
  return norm > 0 ? sum / norm : 0
}

/**
 * Ridged multifractal (Musgrave): sharp crests where the base noise crosses zero, each octave weighted by
 * the previous one so detail concentrates on the ridges. Result in [0, 1] (1 = crest).
 */
export function ridged(n: Noise2, x: number, y: number, o: FbmOpts, sharpness = 2): number {
  let sum = 0, amp = 1, norm = 0, f = o.frequency, weight = 1
  const oc = o.octaves < 16 ? o.octaves : 16
  for (let k = 0; k < oc; k++) {
    let v = perlin(n, x * f + n.ox[k], y * f + n.oy[k])
    v = 1 - (v < 0 ? -v : v)
    v = sharpness === 2 ? v * v : v
    v *= weight
    weight = v * sharpness
    if (weight > 1) weight = 1
    else if (weight < 0) weight = 0
    sum += v * amp
    norm += amp
    amp *= o.gain
    f *= o.lacunarity
  }
  return norm > 0 ? sum / norm : 0
}

/** Mutable 2-vector used as an out-parameter (avoids per-sample allocation). */
export interface Vec2Out { x: number; y: number }

/** Domain warp: displaces (x, y) by `amp` tiles along two independent fBm fields. */
export function warp(nx: Noise2, ny: Noise2, x: number, y: number, amp: number, o: FbmOpts, out: Vec2Out): Vec2Out {
  out.x = x + amp * fbm(nx, x, y, o)
  out.y = y + amp * fbm(ny, x, y, o)
  return out
}

export interface WorleyOut { f1: number; f2: number; /** Hash of the nearest feature cell. */ id: number; cx: number; cy: number }

/**
 * Worley / cellular noise with one jittered feature point per unit cell. Distances in lattice units;
 * `jitter` in [0, 1] (0 = regular grid). `id` identifies the nearest cell (stable per seed).
 */
export function worley(seed: number, x: number, y: number, jitter: number, out: WorleyOut): WorleyOut {
  const cx = Math.floor(x), cy = Math.floor(y)
  let f1 = Infinity, f2 = Infinity, id = 0, bx = 0, by = 0
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const gx = cx + ox, gy = cy + oy
      const h = mix3(seed, gx, gy)
      const px = gx + 0.5 + (((h & 0xffff) / 65536) - 0.5) * jitter
      const py = gy + 0.5 + (((h >>> 16) / 65536) - 0.5) * jitter
      const dx = px - x, dy = py - y
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d < f1) { f2 = f1; f1 = d; id = h; bx = gx; by = gy }
      else if (d < f2) f2 = d
    }
  }
  out.f1 = f1; out.f2 = f2; out.id = id; out.cx = bx; out.cy = by
  return out
}

/** Lattice dimensions covering a w x h field with one sample every `stride` tiles (plus a closing row/column). */
export function latticeSize(w: number, h: number, stride: number): { gw: number; gh: number } {
  const s = Math.max(1, Math.floor(stride))
  return { gw: Math.floor((w - 1) / s) + 2, gh: Math.floor((h - 1) / s) + 2 }
}

/** Bilinear upsampling of a lattice (sample (gx, gy) sits at tile (gx * stride, gy * stride)) to w x h. */
export function upsample(g: Float32Array, gw: number, stride: number, w: number, h: number, out?: Float32Array): Float32Array {
  const res = out ?? new Float32Array(w * h)
  const s = Math.max(1, Math.floor(stride))
  const inv = 1 / s
  for (let y = 0; y < h; y++) {
    const gy = Math.floor(y / s), ty = (y - gy * s) * inv
    const r0 = gy * gw, r1 = r0 + gw
    const o = y * w
    for (let x = 0; x < w; x++) {
      const gx = Math.floor(x / s), tx = (x - gx * s) * inv
      const a = g[r0 + gx], b = g[r0 + gx + 1], c = g[r1 + gx], d = g[r1 + gx + 1]
      const top = a + (b - a) * tx, bot = c + (d - c) * tx
      res[o + x] = top + (bot - top) * ty
    }
  }
  return res
}

/**
 * Samples `fn` on a coarse lattice every `stride` tiles and bilinearly upsamples to a w x h field.
 * Use for low-frequency fields (feature size >= 8 x stride) to save most of the noise evaluations.
 */
export function sampleField(w: number, h: number, stride: number, fn: (x: number, y: number) => number, out?: Float32Array): Float32Array {
  const s = Math.max(1, Math.floor(stride))
  if (s === 1) {
    const res = out ?? new Float32Array(w * h)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) res[y * w + x] = fn(x, y)
    return res
  }
  const { gw, gh } = latticeSize(w, h, s)
  const g = new Float32Array(gw * gh)
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) g[gy * gw + gx] = fn(gx * s, gy * s)
  return upsample(g, gw, s, w, h, out)
}

/** fBm remapped to roughly [0, 1] (clamped), matching the world generator's NoiseField convention. */
export function fbm01(n: Noise2, x: number, y: number, o: FbmOpts): number {
  const v = 0.5 + 0.7 * fbm(n, x, y, o)
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** Hermite smoothstep of t between edges a and b (a may exceed b for a falling edge). */
export function smoothstep(a: number, b: number, t: number): number {
  if (a === b) return t < a ? 0 : 1
  let v = (t - a) / (b - a)
  v = v < 0 ? 0 : v > 1 ? 1 : v
  return v * v * (3 - 2 * v)
}
