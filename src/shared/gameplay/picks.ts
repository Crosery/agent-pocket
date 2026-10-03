// Gameplay-local species picking (event spawns, pop-up trainers). Filters CONTENT.speciesList by a SpeciesPick,
// moves the result to its level-appropriate evolution form and chooses with an IRng. Constraints that match
// nothing are dropped one by one (rarities, stages, families, countries, types). Never references species ids.
import type { SpeciesDef, SpeciesPick } from '../types.ts'
import type { IRng } from '../contracts.ts'
import { CONTENT, type Content } from '../content/index.ts'

const GUARD = 16

/** Evolution form of `s`'s line a creature of `level` would have (devolves while too young, evolves while able). */
export function formAtLevel(s: SpeciesDef, level: number, c: Content = CONTENT): SpeciesDef {
  let cur = s
  for (let g = 0; g < GUARD; g++) {
    const parent = cur.evolvesFrom ? c.species[cur.evolvesFrom] : undefined
    if (!parent || parent.evolvesTo?.id !== cur.id || level >= parent.evolvesTo.level) break
    cur = parent
  }
  for (let g = 0; g < GUARD; g++) {
    const next = cur.evolvesTo
    if (!next || level < next.level || !c.species[next.id]) break
    cur = c.species[next.id]
  }
  return cur
}

type Key = 'rarities' | 'stages' | 'families' | 'countries' | 'types' | 'excludeStarters'
const RELAX: readonly Key[] = ['excludeStarters', 'countries', 'families', 'stages', 'rarities', 'types']

function matches(s: SpeciesDef, p: SpeciesPick, off: ReadonlySet<Key>): boolean {
  if (!off.has('types') && p.types?.length && !s.types.some((t) => p.types!.includes(t))) return false
  if (!off.has('rarities') && p.rarities?.length && !p.rarities.includes(s.rarity)) return false
  if (!off.has('stages') && p.stages?.length && !p.stages.includes(s.stage)) return false
  if (!off.has('families') && p.families?.length && !p.families.includes(s.family)) return false
  if (!off.has('countries') && p.countries?.length && !p.countries.includes(s.country)) return false
  if (!off.has('excludeStarters') && p.excludeStarters && s.starter) return false
  return true
}

/** Species matching `pick` (relaxed until something matches); `exclude` rarities are never returned unless named. */
export function pickCandidates(pick: SpeciesPick, exclude: readonly string[] = [], c: Content = CONTENT): SpeciesDef[] {
  const base = c.speciesList.filter((s) => pick.rarities?.includes(s.rarity) || !exclude.includes(s.rarity))
  const off = new Set<Key>()
  let found = base.filter((s) => matches(s, pick, off))
  for (const k of RELAX) {
    if (found.length) break
    off.add(k)
    found = base.filter((s) => matches(s, pick, off))
  }
  return found.length ? found : base
}

/**
 * One species id for `pick` at `level`. Without `stages` the level form of each candidate is used, and forms that
 * drifted out of the pick (an evolution changed its types or rarity) are dropped when possible.
 */
export function pickSpecies(pick: SpeciesPick, level: number, rng: IRng, exclude: readonly string[] = [], c: Content = CONTENT): string | null {
  const cands = pickCandidates(pick, exclude, c)
  if (!cands.length) return null
  if (pick.stages?.length) return rng.pick(cands).id
  const forms = [...new Map(cands.map((s) => formAtLevel(s, level, c)).map((f) => [f.id, f])).values()]
  const allowed = forms.filter((f) => (pick.rarities?.length ? pick.rarities.includes(f.rarity) : !exclude.includes(f.rarity)))
  const typed = allowed.filter((f) => !pick.types?.length || f.types.some((t) => pick.types!.includes(t)))
  const pool = typed.length ? typed : allowed.length ? allowed : cands
  return rng.pick(pool).id
}
