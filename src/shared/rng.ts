// Deterministic PRNG (sfc32 seeded through a splitmix-style mixer) and a 32-bit string hash.
// Identical sequences on client, server and tests for the same seed.
import type { IRng } from './contracts.ts'

/** 32-bit FNV-1a with a murmur3 finaliser; stable across platforms. */
export function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

export class Rng implements IRng {
  readonly seed: number
  private a: number
  private b: number
  private c: number
  private d: number

  constructor(seed: number) {
    this.seed = Number.isFinite(seed) ? Math.floor(seed) >>> 0 : 0
    let s = this.seed
    const mix = (): number => {
      s = (s + 0x9e3779b9) >>> 0
      let z = s
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b)
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35)
      return (z ^ (z >>> 16)) >>> 0
    }
    this.a = mix()
    this.b = mix()
    this.c = mix()
    this.d = mix()
    // Discard the first outputs so nearby seeds decorrelate.
    for (let i = 0; i < 12; i++) this.next()
  }

  next(): number {
    const t = (((this.a + this.b) >>> 0) + this.d) >>> 0
    this.d = (this.d + 1) >>> 0
    this.a = this.b ^ (this.b >>> 9)
    this.b = (this.c + (this.c << 3)) >>> 0
    this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0
    this.c = (this.c + t) >>> 0
    return t / 4294967296
  }

  int(min: number, max: number): number {
    const lo = Math.ceil(Math.min(min, max))
    const hi = Math.floor(Math.max(min, max))
    if (hi <= lo) return lo
    return lo + Math.floor(this.next() * (hi - lo + 1))
  }

  chance(p: number): boolean {
    if (!(p > 0)) return false
    if (p >= 1) return true
    return this.next() < p
  }

  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error('Rng.pick: empty array')
    return arr[this.int(0, arr.length - 1)]
  }

  weighted<T>(items: readonly T[], weight: (t: T) => number): T {
    if (items.length === 0) throw new Error('Rng.weighted: empty array')
    const ws = items.map((x) => Math.max(0, weight(x) || 0))
    const total = ws.reduce((s, w) => s + w, 0)
    if (total <= 0) return this.pick(items)
    let r = this.next() * total
    for (let i = 0; i < items.length; i++) {
      r -= ws[i]
      if (r < 0) return items[i]
    }
    return items[items.length - 1]
  }
}
