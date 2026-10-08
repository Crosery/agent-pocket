// Type chart health: offensive/defensive coverage of every type, dual-type extremes, species usage.
import { typeEffectiveness } from '../../src/shared/content/index.ts'
import type { TypeId } from '../../src/shared/types.ts'
import { C, RULES, mean, r2, table } from './lib.ts'

export interface TypeRow {
  id: TypeId
  nameZh: string
  species: number
  /** Types this type hits super effectively / is resisted by / cannot hit. */
  se: number
  resisted: number
  noEffect: number
  /** Types that hit this type super effectively / that it resists / that cannot hit it. */
  weak: number
  resists: number
  immune: number
  /** Mean multiplier dealt over all single types (1 = neutral). */
  offense: number
  /** Mean multiplier received over all attacking types (1 = neutral; lower = better). */
  defense: number
  /** Species-weighted versions (real defenders / real attackers' STAB types). */
  offenseVsSpecies: number
  defenseOfSpecies: number
  /** Share of species hit super effectively by at least one STAB type of a mono-type attacker (= se coverage). */
  seCoverage: number
  /** offense / defense of the single type; > 1 favours the type overall. */
  index: number
}

const ids = (): TypeId[] => C.types.map((t) => t.id)
const mult = (a: TypeId, d: TypeId): number => C.typeChart[a]?.[d] ?? 1

export function typeRows(): TypeRow[] {
  const all = ids()
  const species = C.speciesList
  return all.map((t) => {
    const dealt = all.map((d) => mult(t, d))
    const taken = all.map((a) => mult(a, t))
    const own = species.filter((s) => s.types.includes(t))
    const vs = species.map((s) => typeEffectiveness(t, s.types, C))
    const seCoverage = vs.filter((v) => v > 1).length / species.length
    const defenseOfSpecies = own.length
      ? mean(own.map((s) => mean(all.map((a) => typeEffectiveness(a, s.types, C)))))
      : mean(taken)
    const offense = mean(dealt)
    const defense = mean(taken)
    return {
      id: t,
      nameZh: C.typeById[t].nameZh,
      species: own.length,
      se: dealt.filter((v) => v > 1).length,
      resisted: dealt.filter((v) => v > 0 && v < 1).length,
      noEffect: dealt.filter((v) => v === 0).length,
      weak: taken.filter((v) => v > 1).length,
      resists: taken.filter((v) => v > 0 && v < 1).length,
      immune: taken.filter((v) => v === 0).length,
      offense: r2(offense),
      defense: r2(defense),
      offenseVsSpecies: r2(mean(vs)),
      defenseOfSpecies: r2(defenseOfSpecies),
      seCoverage: r2(seCoverage),
      index: r2(offense / Math.max(0.01, defense)),
    }
  })
}

export interface DualStats {
  /** Distinct type combinations present in the species table. */
  combos: number
  quadWeak: number
  quadWeakShare: number
  quadResist: number
  immuneCombos: number
  /** Worst single weakness among all species (max incoming multiplier). */
  worst: { speciesId: string; attacker: TypeId; mult: number }[]
}

export function dualStats(): DualStats {
  const all = ids()
  const seen = new Set<string>()
  let quadWeak = 0
  let quadResist = 0
  let immune = 0
  const worst: DualStats['worst'] = []
  for (const s of C.speciesList) {
    const mults = all.map((a) => ({ a, m: typeEffectiveness(a, s.types, C) }))
    const top = mults.reduce((x, y) => (y.m > x.m ? y : x))
    if (top.m >= 4) {
      quadWeak += 1
      worst.push({ speciesId: s.id, attacker: top.a, mult: top.m })
    }
    if (mults.some((x) => x.m > 0 && x.m <= 0.25)) quadResist += 1
    if (mults.some((x) => x.m === 0)) immune += 1
    seen.add([...s.types].sort().join('/'))
  }
  return { combos: seen.size, quadWeak, quadWeakShare: r2(quadWeak / C.speciesList.length), quadResist, immuneCombos: immune, worst }
}

export interface TypeViolation { id: string; why: string }

export function typeViolations(): TypeViolation[] {
  const R = RULES.types
  const rows = typeRows()
  const out: TypeViolation[] = []
  const [lo, hi] = R.indexRange
  for (const r of rows) {
    if (r.se < R.minSuperEffective || r.se > R.maxSuperEffective) out.push({ id: r.id, why: `hits ${r.se} types super effectively (allowed ${R.minSuperEffective}-${R.maxSuperEffective})` })
    if (r.resists < R.minResisted) out.push({ id: r.id, why: `resists only ${r.resists} types (min ${R.minResisted})` })
    if (r.weak > R.maxWeaknesses) out.push({ id: r.id, why: `${r.weak} types hit it super effectively (max ${R.maxWeaknesses})` })
    if (r.weak === 0) out.push({ id: r.id, why: 'has no weakness' })
    if (r.se === 0) out.push({ id: r.id, why: 'hits nothing super effectively' })
    if (r.offense < lo || r.offense > hi) out.push({ id: r.id, why: `offense index ${r.offense} outside [${lo}, ${hi}]` })
    if (r.defense < lo || r.defense > hi) out.push({ id: r.id, why: `defense index ${r.defense} outside [${lo}, ${hi}]` })
    if (r.index > R.maxCombinedIndex) out.push({ id: r.id, why: `combined index ${r.index} above ${R.maxCombinedIndex}` })
  }
  const d = dualStats()
  if (d.quadWeakShare > R.maxQuadWeakShare) out.push({ id: 'dual-types', why: `${d.quadWeak} species (${d.quadWeakShare}) have a 4x weakness (max share ${R.maxQuadWeakShare})` })
  return out
}

export function report(): string {
  const rows = typeRows()
  const lines: string[] = []
  lines.push('== per type (attack: SE/resisted/immune targets; defence: weak/resist/immune) ==')
  lines.push(table(
    ['type', 'spp', 'SE', 'res', 'no', 'weak', 'resist', 'imm', 'off', 'def', 'offSp', 'defSp', 'seCov', 'idx'],
    rows.map((r) => [`${r.id}`, r.species, r.se, r.resisted, r.noEffect, r.weak, r.resists, r.immune, r.offense, r.defense, r.offenseVsSpecies, r.defenseOfSpecies, r.seCoverage, r.index]),
  ))
  const d = dualStats()
  lines.push('', `== dual types: ${d.combos} combos, 4x-weak species ${d.quadWeak} (${d.quadWeakShare}), 4x-resist species ${d.quadResist}, with an immunity ${d.immuneCombos} ==`)
  const v = typeViolations()
  lines.push('', `== violations: ${v.length} ==`, ...v.map((x) => `${x.id}: ${x.why}`))
  return lines.join('\n')
}
