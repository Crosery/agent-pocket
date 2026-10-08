// Species stat budgets: BST per rarity and stage, evolution steps, stat shape and role spread, with outliers.
import type { SpeciesDef, StatKey } from '../../src/shared/types.ts'
import { C, RULES, STATS, bst, mean, r1, r2, stdev, table } from './lib.ts'

export interface BudgetRow { rarity: string; stage: number; n: number; min: number; mean: number; max: number; stdev: number }

export function budgetRows(): BudgetRow[] {
  const rows: BudgetRow[] = []
  for (const r of C.rarities) {
    for (const stage of [1, 2, 3]) {
      const xs = C.speciesList.filter((s) => s.rarity === r.id && s.stage === stage).map(bst)
      if (xs.length) rows.push({ rarity: r.id, stage, n: xs.length, min: Math.min(...xs), mean: r1(mean(xs)), max: Math.max(...xs), stdev: r1(stdev(xs)) })
    }
  }
  return rows
}

export interface RarityRow { rarity: string; n: number; lo: number; hi: number; mean: number; stdev: number; stdevOfBand: number }

export function rarityRows(): RarityRow[] {
  return C.rarities.map((r) => {
    const xs = C.speciesList.filter((s) => s.rarity === r.id).map(bst)
    const [lo, hi] = r.bst
    return { rarity: r.id, n: xs.length, lo, hi, mean: r1(mean(xs)), stdev: r1(stdev(xs)), stdevOfBand: r2(stdev(xs) / Math.max(1, hi - lo)) }
  })
}

export interface Outlier { id: string; why: string }

/** Every rule of the stat budget, evaluated against the species table. */
export function statOutliers(): Outlier[] {
  const R = RULES.stats
  const out: Outlier[] = []
  for (const r of C.rarities) {
    const xs = C.speciesList.filter((s) => s.rarity === r.id)
    const vals = xs.map(bst)
    const m = mean(vals)
    const sd = stdev(vals)
    for (const s of xs) {
      const b = bst(s)
      if (b < r.bst[0] || b > r.bst[1]) out.push({ id: s.id, why: `BST ${b} outside ${r.id} band [${r.bst}]` })
      if (sd > 0 && Math.abs(b - m) / sd > R.outlierZ) out.push({ id: s.id, why: `BST ${b} is ${r2((b - m) / sd)} sd from the ${r.id} mean ${r1(m)}` })
    }
  }
  for (const s of C.speciesList) {
    const b = bst(s)
    for (const k of STATS) {
      const v = s.baseStats[k]
      if (v / b > R.maxStatShare) out.push({ id: s.id, why: `${k} ${v} is ${r2(v / b)} of BST ${b} (max ${R.maxStatShare})` })
      if (v < R.minStat) out.push({ id: s.id, why: `${k} ${v} below floor ${R.minStat}` })
      if (v > R.maxStat) out.push({ id: s.id, why: `${k} ${v} above ceiling ${R.maxStat}` })
    }
  }
  for (const s of C.speciesList) {
    if (!s.evolvesTo) continue
    const to = C.species[s.evolvesTo.id]
    if (!to) continue
    const ratio = bst(to) / bst(s)
    const [lo, hi] = R.evolutionBstRatio
    if (ratio < lo || ratio > hi) out.push({ id: `${s.id}->${to.id}`, why: `evolution BST ratio ${r2(ratio)} outside [${lo}, ${hi}]` })
  }
  return out
}

export interface EvoStep { from: string; to: string; ratio: number; fromBst: number; toBst: number }
export function evolutionSteps(): EvoStep[] {
  const out: EvoStep[] = []
  for (const s of C.speciesList) {
    const to = s.evolvesTo && C.species[s.evolvesTo.id]
    if (to) out.push({ from: s.id, to: to.id, fromBst: bst(s), toBst: bst(to), ratio: r2(bst(to) / bst(s)) })
  }
  return out
}

/** Role of a species from its stat shape (descriptive; docs/balance.md section 3). */
export type RoleId = 'sweeper' | 'wallbreaker' | 'tank' | 'bulky-attacker' | 'support' | 'balanced'

export function roleOf(sp: SpeciesDef): RoleId {
  const b = sp.baseStats
  const t = bst(sp)
  const atk = Math.max(b.atk, b.spa)
  const bulk = (b.hp * (b.def + b.spd)) / 2
  const norm = (v: number) => v / t
  const fast = b.spe / t >= 0.19
  const strong = atk / t >= 0.215
  const bulky = (b.hp + b.def + b.spd) / t >= 0.56
  if (strong && fast) return 'sweeper'
  if (strong && !fast && !bulky) return 'wallbreaker'
  if (bulky && !strong) return 'tank'
  if (bulky && strong) return 'bulky-attacker'
  if (!strong && !bulky && norm(bulk) < 0) return 'support'
  return fast ? 'support' : 'balanced'
}

export function roleCounts(): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {}
  for (const s of C.speciesList) {
    const row = (out[s.rarity] ??= {})
    const r = roleOf(s)
    row[r] = (row[r] ?? 0) + 1
  }
  return out
}

export function physicalShare(sp: SpeciesDef): number {
  return sp.baseStats.atk / (sp.baseStats.atk + sp.baseStats.spa)
}

export function report(): string {
  const lines: string[] = []
  lines.push('== BST per rarity ==')
  lines.push(table(['rarity', 'n', 'band', 'min..max', 'mean', 'stdev', 'sd/band'], rarityRows().map((r) => {
    const xs = C.speciesList.filter((s) => s.rarity === r.rarity).map(bst)
    return [r.rarity, r.n, `${r.lo}-${r.hi}`, `${Math.min(...xs)}..${Math.max(...xs)}`, r.mean, r.stdev, r.stdevOfBand]
  })))
  lines.push('', '== BST per rarity and stage ==')
  lines.push(table(['rarity/stage', 'n', 'min', 'mean', 'max', 'stdev'], budgetRows().map((r) => [`${r.rarity}/${r.stage}`, r.n, r.min, r.mean, r.max, r.stdev])))
  const steps = evolutionSteps()
  const ratios = steps.map((s) => s.ratio)
  lines.push('', `== evolution steps: ${steps.length}, ratio min ${Math.min(...ratios)} mean ${r2(mean(ratios))} max ${Math.max(...ratios)} ==`)
  lines.push('', '== stat shape by role ==')
  const rc = roleCounts()
  const roles = [...new Set(Object.values(rc).flatMap((r) => Object.keys(r)))].sort()
  lines.push(table(['rarity', ...roles], C.rarities.map((r) => [r.id, ...roles.map((k) => rc[r.id]?.[k] ?? 0)])))
  const o = statOutliers()
  lines.push('', `== outliers: ${o.length} ==`, ...o.map((x) => `${x.id}: ${x.why}`))
  return lines.join('\n')
}

export const statKeyList: readonly StatKey[] = STATS
