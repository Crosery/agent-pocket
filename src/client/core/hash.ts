// Deterministic hashing / seeded randomness for procedural content (placeholders, cries, save checksums).

import { hashString } from '../../shared/rng.ts'

/** Shared deterministic string hash (src/shared/rng.ts) so cries / placeholders match across modules. */
export { hashString }

export interface SeededRandom {
  /** float in [0,1) */
  next(): number
  /** integer in [min,max] inclusive */
  int(min: number, max: number): number
  range(min: number, max: number): number
  chance(p: number): boolean
  pick<T>(arr: readonly T[]): T
  weighted<T>(items: readonly T[], weight: (t: T) => number): T
}

/** mulberry32 generator. */
export function seededRandom(seed: number): SeededRandom {
  let a = seed >>> 0
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    range: (min, max) => min + next() * (max - min),
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    weighted(items, weight) {
      const total = items.reduce((s, x) => s + Math.max(0, weight(x)), 0)
      if (total <= 0) return items[Math.floor(next() * items.length)]
      let r = next() * total
      for (const x of items) { r -= Math.max(0, weight(x)); if (r < 0) return x }
      return items[items.length - 1]
    },
  }
}

export function seededFrom(...parts: (string | number)[]): SeededRandom {
  return seededRandom(hashString(parts.join('\u0001')))
}
