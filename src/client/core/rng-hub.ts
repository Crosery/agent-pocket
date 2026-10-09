// One master seed, several independent random streams (ADR 0002 §4.3). A stream is consumed only by its own
// subsystem, so a draw in one (an NPC wandering) never shifts another (the next encounter, the next battle seed).
// The master seed is random per session unless the developer mode pins it (&rng=<n>, window.__ap.v1.rng.seed).
import type { IRng } from '../../shared/contracts.ts'
import { Rng, hashString } from '../../shared/rng.ts'

export const RNG_STREAMS = ['encounter', 'script', 'battle', 'debug', 'cosmetic'] as const
export type RngStream = (typeof RNG_STREAMS)[number]

/** A fresh non-deterministic master seed (what the game used before the hub existed). */
export const randomSeed = (): number => (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0

/** Counts every next() draw (int / chance / pick / weighted all go through it). */
class CountingRng extends Rng {
  draws = 0
  override next(): number {
    this.draws++
    return super.next()
  }
}

/** A stream that can be reseeded in place, so subsystems keep the reference they were handed at boot. */
export class StreamRng implements IRng {
  private inner: CountingRng
  constructor(seed: number) { this.inner = new CountingRng(seed) }
  get seed(): number { return this.inner.seed }
  /** Number of random draws since the (re)seed. */
  get draws(): number { return this.inner.draws }
  reseed(seed: number): void { this.inner = new CountingRng(seed) }
  next(): number { return this.inner.next() }
  int(min: number, max: number): number { return this.inner.int(min, max) }
  chance(p: number): boolean { return this.inner.chance(p) }
  pick<T>(arr: readonly T[]): T { return this.inner.pick(arr) }
  weighted<T>(items: readonly T[], weight: (t: T) => number): T { return this.inner.weighted(items, weight) }
}

const streamSeed = (master: number, name: RngStream): number => hashString(`${master >>> 0}:${name}`)

export class RngHub {
  private master: number
  private readonly streams: Record<RngStream, StreamRng>

  constructor(seed: number = randomSeed()) {
    this.master = seed >>> 0
    this.streams = Object.fromEntries(RNG_STREAMS.map((n) => [n, new StreamRng(streamSeed(this.master, n))])) as Record<RngStream, StreamRng>
  }

  get seed(): number { return this.master }

  stream(name: RngStream): StreamRng { return this.streams[name] }

  /** Restarts every stream from a new master seed (draw counters go back to zero). */
  reseed(seed: number): void {
    this.master = seed >>> 0
    for (const n of RNG_STREAMS) this.streams[n].reseed(streamSeed(this.master, n))
  }

  /** Draws taken from each stream so far. */
  cursors(): Record<RngStream, number> {
    return Object.fromEntries(RNG_STREAMS.map((n) => [n, this.streams[n].draws])) as Record<RngStream, number>
  }
}
