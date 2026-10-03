// Seeded gradient noise for the renderer (procedural props, ground decor, climate/tint fields). Pure TS (no three,
// no DOM) so it runs in node tests. Render-only: unlike src/shared/world/random.ts it may use float math freely,
// client and server never have to agree on these values.

/** mulberry32 PRNG: deterministic floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Integer hash of (x, y, seed) -> uint32. */
export function hash32(x: number, y: number, seed = 0): number {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1)) | 0
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}

/** Hash of (x, y, seed) -> float in [0, 1). */
export const hash01 = (x: number, y: number, seed = 0) => hash32(x, y, seed) / 4294967296

/** FNV-1a string hash (seeds derived from content ids). */
export function seedOf(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return h >>> 0
}

const G3 = new Float32Array([1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1])
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)

export interface Noise {
  readonly seed: number
  /** 2D gradient (Perlin) noise, roughly in [-1, 1]. */
  noise2(x: number, y: number): number
  /** 3D gradient (Perlin) noise, roughly in [-1, 1]. */
  noise3(x: number, y: number, z: number): number
}

/** Improved Perlin noise with a permutation table shuffled by `seed`. */
export function createNoise(seed: number): Noise {
  const rnd = mulberry32(seed ^ 0x5bd1e995)
  const p = new Uint8Array(256)
  for (let i = 0; i < 256; i++) p[i] = i
  for (let i = 255; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t }
  const perm = new Uint8Array(512)
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255]

  function g2(h: number, x: number, y: number): number {
    const k = (h % 12) * 3
    return G3[k] * x + G3[k + 1] * y
  }
  function g3(h: number, x: number, y: number, z: number): number {
    const k = (h % 12) * 3
    return G3[k] * x + G3[k + 1] * y + G3[k + 2] * z
  }
  return {
    seed,
    noise2(x, y) {
      const xf = Math.floor(x), yf = Math.floor(y)
      const X = xf & 255, Y = yf & 255
      x -= xf; y -= yf
      const u = fade(x), v = fade(y)
      const a = perm[X] + Y, b = perm[X + 1] + Y
      const n00 = g2(perm[a], x, y), n10 = g2(perm[b], x - 1, y)
      const n01 = g2(perm[a + 1], x, y - 1), n11 = g2(perm[b + 1], x - 1, y - 1)
      const nx0 = n00 + u * (n10 - n00), nx1 = n01 + u * (n11 - n01)
      return (nx0 + v * (nx1 - nx0)) * 1.4
    },
    noise3(x, y, z) {
      const xf = Math.floor(x), yf = Math.floor(y), zf = Math.floor(z)
      const X = xf & 255, Y = yf & 255, Z = zf & 255
      x -= xf; y -= yf; z -= zf
      const u = fade(x), v = fade(y), w = fade(z)
      const A = perm[X] + Y, AA = perm[A] + Z, AB = perm[A + 1] + Z
      const B = perm[X + 1] + Y, BA = perm[B] + Z, BB = perm[B + 1] + Z
      const l = (a: number, b: number, t: number) => a + t * (b - a)
      return l(
        l(l(g3(perm[AA], x, y, z), g3(perm[BA], x - 1, y, z), u), l(g3(perm[AB], x, y - 1, z), g3(perm[BB], x - 1, y - 1, z), u), v),
        l(l(g3(perm[AA + 1], x, y, z - 1), g3(perm[BA + 1], x - 1, y, z - 1), u), l(g3(perm[AB + 1], x, y - 1, z - 1), g3(perm[BB + 1], x - 1, y - 1, z - 1), u), v),
        w,
      )
    },
  }
}

/** Fractal-noise parameters (content/render.json). `scale` = feature size in world units. */
export interface FbmSpec { scale: number; octaves: number; gain?: number; lacunarity?: number; salt?: number }

/** Fractal Brownian motion of noise2, normalised to [0, 1]. */
export function fbm2(n: Noise, x: number, y: number, spec: FbmSpec): number {
  const oct = Math.max(1, Math.floor(spec.octaves))
  const gain = spec.gain ?? 0.5, lac = spec.lacunarity ?? 2
  const off = (spec.salt ?? 0) * 17.13
  let f = 1 / Math.max(1e-6, spec.scale), a = 1, sum = 0, norm = 0
  for (let o = 0; o < oct; o++) {
    sum += a * n.noise2(x * f + off + o * 31.7, y * f - off + o * 47.3)
    norm += a
    a *= gain
    f *= lac
  }
  const v = 0.5 + 0.5 * (sum / norm)
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** Fractal noise3 in roughly [-1, 1] (for vertex displacement). */
export function fbm3(n: Noise, x: number, y: number, z: number, octaves: number, gain = 0.5, lacunarity = 2): number {
  let a = 1, f = 1, sum = 0, norm = 0
  for (let o = 0; o < Math.max(1, octaves); o++) {
    sum += a * n.noise3(x * f, y * f, z * f)
    norm += a
    a *= gain
    f *= lacunarity
  }
  return sum / norm
}

export const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a || 1e-6)))
  return t * t * (3 - 2 * t)
}
export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
/** Uniform pick in [lo, hi] from a 0..1 value. */
export const range = (r: readonly [number, number] | number, t: number) => (typeof r === 'number' ? r : r[0] + (r[1] - r[0]) * t)
