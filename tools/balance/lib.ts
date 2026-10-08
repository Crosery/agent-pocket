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
    /** Evolution step: the evolved form's BST must rise by a ratio inside this window. */
    evolutionBstRatio: [number, number]
    /** One stat may not exceed this share of the BST, nor fall below `minStat` / exceed `maxStat`. */
    maxStatShare: number
    minStat: number
    maxStat: number
    /** |z| beyond this inside one rarity band flags an outlier. */
    outlierZ: number
    maxStdevOfBand: number
  }
  types: {
    minSuperEffective: number
    maxSuperEffective: number
    minResisted: number
    maxWeaknesses: number
    /** Mean multiplier dealt / taken per type must sit inside this window. */
    indexRange: [number, number]
    maxCombinedIndex: number
    maxQuadWeakShare: number
  }
  moves: {
    /** Power-equivalent value of effects (status:*, volatile:*, stat:*, heal, drain, weather, cureStatus, highCrit). */
    effectValue: Record<string, number>
    /** PP window for a given value (rows ascending by `upTo`). */
    ppTiers: { upTo: number; pp: [number, number] }[]
    /** PP window per status-move class. */
    statusPp: Record<string, [number, number]>
    maxSuicidePower: number
    valueTolerance: number
    priorityMul: number
    rechargeMul: number
    recoilMul: number
    selfFaintMul: number
    maxPower: number
  }
  ttk: {
    movePower: [number, number]
    levels: number[]
    band: Record<'neutral' | 'superEffective' | 'resisted', [number, number]>
  }
  sim: {
    level: number
    battles: number
    seed: number
    variants: number
    maxTurns: number
    minFieldWin: number
    maxFieldWin: number
    maxAllOpponentsWin: number
    favourableWin: number
    unfavourableWin: number
    maxDrawRate: number
  }
  curve: {
    expLevels: number[]
    battlesPerLevel: { upTo: number; range: [number, number] }[]
    gymCount: number
    gymFirstLeaderLevel: [number, number]
    gymLevelStep: [number, number]
    gymPowerRatio: [number, number]
    /** Gym 1 is a deliberately light tutorial leader, so the step to gym 2 is allowed a wider jump. */
    gymFirstStepPowerRatio: [number, number]
    underlingMaxLevelBelow: number
    startMoneyInPotions: number
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
