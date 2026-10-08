// Shared helpers for the balance toolkit (headless; reads the same CONTENT the game runs on).
// Every threshold lives in tools/balance/rules.json - nothing tunable is hardcoded in the analysis modules.
import { CONTENT, type Content } from '../../src/shared/content/index.ts'
import type { MoveDef, SpeciesDef, StatKey } from '../../src/shared/types.ts'
import rulesJson from './rules.json' with { type: 'json' }

export const C: Content = CONTENT
export const STATS: readonly StatKey[] = ['hp', 'atk', 'def', 'spa', 'spd', 'spe']

/** Shape of tools/balance/rules.json (the machine-readable half of docs/balance.md). */
export interface BalanceRules {
  stats: {
    /** Allowed BST window per rarity id; mirrors content/rarities.json and is cross-checked against it. */
    rarityBst: Record<string, [number, number]>
    /** Evolution step: the evolved form's BST must rise by a ratio inside this window. */
    evolutionBstRatio: [number, number]
    /** One stat may not exceed this share of the BST, nor any stat fall below `minStat`. */
    maxStatShare: number
    minStat: number
    maxStat: number
    /** |z| beyond this inside one rarity band flags an outlier. */
    outlierZ: number
    /** Maximum stdev of BST inside one rarity (stage 1 only), as a fraction of the band width. */
    maxStdevOfBand: number
  }
  types: {
    minSuperEffective: number
    maxSuperEffective: number
    minResisted: number
    maxWeaknesses: number
    /** Offense / defense index of a type must stay within this many stdevs of the mean. */
    indexSpread: number
    /** No type may be both best-in-class offensively and defensively (combined index ceiling). */
    maxCombinedIndex: number
    /** Share of species allowed to have a 4x weakness. */
    maxQuadWeakShare: number
  }
  moves: {
    /** power-equivalent value of one percentage point of secondary-effect chance, per effect class. */
    effectValue: Record<string, number>
    /** Expected PP window for a given effective power (rows: upTo power, pp [min,max]). */
    ppTiers: { upTo: number; pp: [number, number] }[]
    /** Outlier tolerance, in effective power points over/under the tier curve. */
    valueTolerance: number
    /** Priority price: effective power multiplier per priority step. */
    priorityMul: number
    rechargeMul: number
    recoilMul: number
    selfFaintMul: number
    /** Highest allowed effective power per rarity-free tier (hard ceiling for any damaging move). */
    maxPower: number
  }
  sim: {
    level: number
    iv: number
    battles: number
    seed: number
    maxTurns: number
    /** Archetype acceptance. */
    maxFieldWin: number
    minFieldWin: number
    maxAllOpponentsWin: number
    favourableWin: number
    unfavourableWin: number
    maxDrawRate: number
    maxTeamBstSpread: number
  }
  curve: {
    /** Battles needed to gain a level (same-level wild fight of an average species) per level bracket. */
    battlesPerLevel: { upTo: number; range: [number, number] }[]
    /** Gym leader progression: level step between consecutive gyms and the party size for each. */
    gymLevelStep: [number, number]
    gymFirstLeaderLevel: [number, number]
    /** Leader team power relative to the previous leader's. */
    gymPowerRatio: [number, number]
    /** Gym trainers (underlings) stay this many levels under their leader at most. */
    underlingMaxLevelBelow: number
  }
}

export const RULES: BalanceRules = rulesJson as unknown as BalanceRules

export const bst = (sp: Pick<SpeciesDef, 'baseStats'>): number => STATS.reduce((a, k) => a + sp.baseStats[k], 0)

export const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
export const stdev = (xs: number[]): number => {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length)
}
export const quantile = (xs: number[], q: number): number => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const i = (s.length - 1) * q
  const lo = Math.floor(i)
  return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo)
}
export const r1 = (x: number): number => Math.round(x * 10) / 10
export const r2 = (x: number): number => Math.round(x * 100) / 100
export const pct = (x: number): string => `${(x * 100).toFixed(0)}%`

/** Plain-text table with left-aligned first column. */
export function table(head: string[], rows: (string | number)[][]): string {
  const all = [head, ...rows.map((r) => r.map(String))]
  const w = head.map((_, i) => Math.max(...all.map((r) => [...(r[i] ?? '')].reduce((a, ch) => a + (ch.charCodeAt(0) > 255 ? 2 : 1), 0))))
  const len = (s: string) => [...s].reduce((a, ch) => a + (ch.charCodeAt(0) > 255 ? 2 : 1), 0)
  const pad = (s: string, n: number, left: boolean) => (left ? s + ' '.repeat(n - len(s)) : ' '.repeat(n - len(s)) + s)
  return all.map((r) => r.map((c, i) => pad(c, w[i], i === 0)).join('  ')).join('\n')
}

export const isDamagingMove = (m: MoveDef): boolean => m.category !== 'status' || m.effects.some((e) => e.kind === 'fixedDamage')

export const speciesOfRarity = (rarity: string): SpeciesDef[] => C.speciesList.filter((s) => s.rarity === rarity)
