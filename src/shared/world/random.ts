// Deterministic hashing, PRNG and gradient noise for world generation.
// Only integer ops (Math.imul), + - * / and sqrt are used so every JS engine produces bit-identical
// worlds (client and server must agree); no Math.sin/exp/pow here.
import type { NoiseSpec } from './schema.ts'
import { createNoise, perlin as perlinN, type Noise2 } from '../noise.ts'

export function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export function hash3(a: number, b: number, c: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b | 0, 0x27d4eb2d) ^ Math.imul(c | 0, 0x165667b1)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  return (h ^ (h >>> 15)) >>> 0
}

/** Sub-seed for a named generation stage. */
export function seedFor(seed: number, salt: string): number {
  return hash3(seed >>> 0, hashString(salt), 0x5bd1e995)
}

/** sfc32 generator. */
export class Rng {
  private a: number
  private b: number
  private c: number
  private d: number

  constructor(seed: number) {
    this.a = hash3(seed, 1, 0)
    this.b = hash3(seed, 2, 0)
    this.c = hash3(seed, 3, 0)
    this.d = 1
    for (let i = 0; i < 12; i++) this.u32()
  }

  u32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0
    this.d = (this.d + 1) | 0
    this.a = this.b ^ (this.b >>> 9)
    this.b = (this.c + (this.c << 3)) | 0
    this.c = (this.c << 21) | (this.c >>> 11)
    this.c = (this.c + t) | 0
    return t >>> 0
  }

  /** float in [0,1) */
  next(): number { return this.u32() / 4294967296 }

  /** integer in [min, max] inclusive */
  int(min: number, max: number): number { return min + Math.floor(this.next() * (max - min + 1)) }

  chance(p: number): boolean { return this.next() < p }

  pick<T>(arr: readonly T[]): T { return arr[Math.floor(this.next() * arr.length)] }

  weighted<T>(items: readonly T[], weight: (t: T) => number): T {
    let total = 0
    for (const it of items) total += Math.max(0, weight(it))
    let r = this.next() * total
    for (const it of items) {
      r -= Math.max(0, weight(it))
      if (r < 0) return it
    }
    return items[items.length - 1]
  }

  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1))
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t
    }
    return arr
  }
}

export function rngFor(seed: number, salt: string): Rng { return new Rng(seedFor(seed, salt)) }

/** Per-tile uniform value in [0,1) — stable regardless of iteration order. */
export function tileRand(seed: number, x: number, y: number): number {
  return hash3(seed, x, y) / 4294967296
}

/** 2D gradient noise in roughly [-1, 1] (stateless; prefer noiseField / src/shared/noise.ts in loops). */
export function perlin(seed: number, x: number, y: number): number {
  return perlinN(noiseFor(seed), x, y)
}

const NOISE_CACHE = new Map<number, Noise2>()
function noiseFor(seed: number): Noise2 {
  let n = NOISE_CACHE.get(seed)
  if (!n) {
    n = createNoise(seed)
    if (NOISE_CACHE.size > 512) NOISE_CACHE.clear()
    NOISE_CACHE.set(seed, n)
  }
  return n
}

/** Fractal noise normalised to [0, 1]. */
export interface NoiseField { sample(x: number, y: number): number }

export function noiseField(spec: NoiseSpec, seed: number): NoiseField {
  const n = noiseFor(seedFor(seed, spec.salt))
  const octaves = Math.max(1, Math.min(16, Math.floor(spec.octaves)))
  let norm = 0
  let amp = 1
  for (let o = 0; o < octaves; o++) { norm += amp; amp *= spec.gain }
  const k = 0.7 / norm
  const inv = 1 / spec.scale, gain = spec.gain, lac = spec.lacunarity
  return {
    sample(x: number, y: number): number {
      let sum = 0, a = 1, f = inv
      for (let o = 0; o < octaves; o++) {
        sum += a * perlinN(n, x * f + n.ox[o], y * f + n.oy[o])
        a *= gain
        f *= lac
      }
      const v = 0.5 + sum * k
      return v < 0 ? 0 : v > 1 ? 1 : v
    },
  }
}

/** Every tile of a w x h grid sampled from a NoiseField ([0, 1]). */
export function noiseGrid(spec: NoiseSpec, seed: number, w: number, h: number): Float32Array {
  const f = noiseField(spec, seed)
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = f.sample(x, y)
  return out
}
