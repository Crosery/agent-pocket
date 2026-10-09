// Individual quality: natures (stat bias) and grades (IV sum). Pure; every number comes from content/quality.json.
// Natures are integer math on purpose: ceil(10 * 1.1) is 12 in floating point, floor((10 * 110 + 99) / 100) is 11.
import type { Creature, GradeDef, StatKey, Stats } from '../types.ts'
import type { IRng } from '../contracts.ts'
import { CONTENT, type Content } from '../content/index.ts'

const KEYS: readonly StatKey[] = ['hp', 'atk', 'def', 'spa', 'spd', 'spe']

const clampInt = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.floor(v)))
const sumOf = (ivs: Stats): number => KEYS.reduce((s, k) => s + (ivs[k] ?? 0), 0)

/** Nature-adjusted value of a non-hp stat (`v` is the stat before the nature); neutral or unknown natures return `v`. */
export function natureMod(v: number, stat: StatKey, nature: string | undefined, c: Content = CONTENT): number {
  if (stat === 'hp' || !nature) return v
  const n = c.natureById[nature]
  if (!n || n.up === n.down) return v
  if (n.up === stat) return Math.floor((v * c.quality.natureMulPct.up + 99) / 100)
  if (n.down === stat) return Math.floor((v * c.quality.natureMulPct.down) / 100)
  return v
}

/** Per-stat arrows of a nature, for badges next to stat names. Neutral natures give an empty object. */
export function natureArrows(nature: string | undefined, c: Content = CONTENT): Partial<Record<StatKey, 'up' | 'down'>> {
  const n = nature ? c.natureById[nature] : undefined
  const out: Partial<Record<StatKey, 'up' | 'down'>> = {}
  if (n?.up && n.up !== n.down) out[n.up] = 'up'
  if (n?.down && n.up !== n.down) out[n.down] = 'down'
  return out
}

/** Uniform pick over all natures (one draw). */
export function rollNature(rng: IRng, c: Content = CONTENT): string {
  return rng.pick(c.quality.natures).id
}

export const gradeRank = (id: string, c: Content = CONTENT): number => c.quality.grades.findIndex((g) => g.id === id)

/** Grade of an IV spread: the highest grade whose minimum the total reaches. */
export function gradeOf(ivs: Stats, c: Content = CONTENT): GradeDef {
  const total = sumOf(ivs)
  const grades = c.quality.grades
  let out = grades[0]
  for (const g of grades) if (total >= g.min) out = g
  return out
}

export const gradeOfCreature = (cr: Pick<Creature, 'ivs'>, c: Content = CONTENT): GradeDef => gradeOf(cr.ivs, c)

/** The stat with the highest IV (first on ties). */
export function bestStat(ivs: Stats): StatKey {
  let best: StatKey = KEYS[0]
  for (const k of KEYS) if ((ivs[k] ?? 0) > (ivs[best] ?? 0)) best = k
  return best
}

export interface IvRollOpts {
  /** How many stats are forced to the IV maximum. */
  perfect?: number
  /** Floor of every stat's roll. */
  min?: number
  /** The IV total must reach this grade... */
  gradeFloor?: string
  /** ...and must not exceed this grade (dev scenarios that show exactly one grade). */
  gradeCap?: string
}

/**
 * Rolls the six IVs. The first attempt is the plain six draws; when `gradeFloor` / `gradeCap` reject it, the roll is
 * repeated (at most REJECT_ATTEMPTS times, still deterministic for a given rng) and then repaired by nudging the
 * lowest (or highest) stat until the total fits.
 */
const REJECT_ATTEMPTS = 64

export function rollIvs(rng: IRng, opts: IvRollOpts = {}, c: Content = CONTENT): Stats {
  const max = c.config.creature.ivMax
  const min = clampInt(opts.min ?? 0, 0, max)
  const perfect = clampInt(opts.perfect ?? 0, 0, KEYS.length)
  const grades = c.quality.grades
  const lo = opts.gradeFloor !== undefined ? (grades[gradeRank(opts.gradeFloor, c)]?.min ?? 0) : 0
  const capIdx = opts.gradeCap !== undefined ? gradeRank(opts.gradeCap, c) : -1
  const hi = capIdx >= 0 ? (grades[capIdx + 1] ? grades[capIdx + 1].min - 1 : KEYS.length * max) : KEYS.length * max

  const draw = (): Stats => {
    const ivs = {} as Stats
    for (const k of KEYS) ivs[k] = rng.int(min, max)
    const free = [...KEYS]
    for (let i = 0; i < perfect; i++) ivs[free.splice(rng.int(0, free.length - 1), 1)[0]] = max
    return ivs
  }

  let ivs = draw()
  if (lo === 0 && hi >= KEYS.length * max) return ivs
  for (let i = 1; i < REJECT_ATTEMPTS; i++) {
    const total = sumOf(ivs)
    if (total >= lo && total <= hi) return ivs
    ivs = draw()
  }
  while (sumOf(ivs) < lo) {
    const k = KEYS.reduce((a, b) => (ivs[b] < ivs[a] ? b : a))
    if (ivs[k] >= max) break
    ivs[k] += 1
  }
  while (sumOf(ivs) > hi) {
    const k = KEYS.reduce((a, b) => (ivs[b] > ivs[a] ? b : a))
    if (ivs[k] <= min) break
    ivs[k] -= 1
  }
  return ivs
}

export interface RevealFacts {
  /** The species was not in the dex before this catch. */
  newSpecies: boolean
  /** This is the first creature the player ever caught. */
  firstCatch: boolean
}

/** Whether the appraisal shows as a full card (true) or a one-line chip (false). */
export function revealIsFull(cr: Creature, facts: RevealFacts, c: Content = CONTENT): boolean {
  const w = c.quality.reveal.fullWhen
  if (w.newSpecies && facts.newSpecies) return true
  if (w.firstCatch && facts.firstCatch) return true
  if (w.boss && cr.origin?.kind === 'boss') return true
  return gradeRank(gradeOf(cr.ivs, c).id, c) >= gradeRank(w.gradeAtLeast, c)
}
