// Deterministic SpeciesPick resolver. Filters CONTENT.speciesList by the pick's constraints, moves every match to
// its level-appropriate evolution stage and chooses one by a stable hash of seedKey + salt. Constraints that match
// nothing are relaxed in the order configured in content/world/story/story.json (`pick`). Never references ids.
// Story-only extension: `habitats` (StoryPick) prefers species living in those biomes; it never reaches the World.
import type { SpeciesDef, SpeciesPick } from '../types.ts'
import { CONTENT, type Content } from '../content/index.ts'
import { hashString } from './random.ts'
import storyJson from '../../../content/world/story/story.json' with { type: 'json' }

export type PickConstraint = 'types' | 'rarities' | 'stages' | 'families' | 'countries' | 'excludeStarters' | 'habitats'

/** SpeciesPick plus authoring-only constraints resolved here (never stored in the World). */
export interface StoryPick extends SpeciesPick {
  /** Any of these biomes in SpeciesDef.habitats. */
  habitats?: string[]
}

export interface PickRules {
  /** Constraints dropped one at a time (rarities widen to neighbouring rarity orders first) until something matches. */
  relaxOrder: PickConstraint[]
  /** Rarities never chosen unless the pick names rarities explicitly. */
  defaultExcludeRarities: string[]
  /** Applied when the pick leaves `excludeStarters` undefined. */
  defaultExcludeStarters: boolean
  /** Before repeating a species inside one party, allow rarities this many orders away from the requested ones. */
  avoidRarityWiden: number
}

export const PICK_RULES: PickRules = (storyJson as unknown as { pick: PickRules }).pick

const EVOLUTION_GUARD = 16

/** The form of `s`'s evolution line a creature of `level` would have: devolves while too young, evolves while able. */
export function levelForm(s: SpeciesDef, level: number, c: Content = CONTENT): SpeciesDef {
  let cur = s
  for (let g = 0; g < EVOLUTION_GUARD; g++) {
    const parent = cur.evolvesFrom ? c.species[cur.evolvesFrom] : undefined
    if (!parent || parent.evolvesTo?.id !== cur.id || level >= parent.evolvesTo.level) break
    cur = parent
  }
  for (let g = 0; g < EVOLUTION_GUARD; g++) {
    const next = cur.evolvesTo
    if (!next || level < next.level || !c.species[next.id]) break
    cur = c.species[next.id]
  }
  return cur
}

/** Lowest level at which `s` exists (the evolution levels along its line). */
export function minLevelOf(s: SpeciesDef, c: Content = CONTENT): number {
  let level = 1
  let cur = s
  for (let g = 0; g < EVOLUTION_GUARD; g++) {
    const parent = cur.evolvesFrom ? c.species[cur.evolvesFrom] : undefined
    if (!parent) break
    if (parent.evolvesTo?.id === cur.id) level = Math.max(level, parent.evolvesTo.level)
    cur = parent
  }
  return level
}

function starterFamilies(c: Content): Set<string> {
  return new Set(c.speciesList.filter((s) => s.starter).map((s) => s.family))
}

interface Active {
  types: boolean; stages: boolean; families: boolean; countries: boolean; excludeStarters: boolean; habitats: boolean
  /** -1 = rarity constraint dropped; otherwise the allowed distance in rarity order from a requested rarity. */
  rarityWiden: number
}

function matches(s: SpeciesDef, p: StoryPick, a: Active, rules: PickRules, starters: Set<string>, c: Content): boolean {
  if (a.types && p.types?.length && !s.types.some((t) => p.types!.includes(t))) return false
  if (a.stages && p.stages?.length && !p.stages.includes(s.stage)) return false
  if (a.families && p.families?.length && !p.families.includes(s.family)) return false
  if (a.countries && p.countries?.length && !p.countries.includes(s.country)) return false
  if (a.habitats && p.habitats?.length && !s.habitats.some((h) => p.habitats!.includes(h))) return false
  if (a.excludeStarters && (p.excludeStarters ?? rules.defaultExcludeStarters) && (s.starter || starters.has(s.family))) return false
  if (a.rarityWiden >= 0) {
    if (p.rarities?.length) {
      const order = c.rarityById[s.rarity]?.order ?? 0
      const ok = p.rarities.some((r) => Math.abs((c.rarityById[r]?.order ?? -99) - order) <= a.rarityWiden)
      if (!ok) return false
    } else if (rules.defaultExcludeRarities.includes(s.rarity)) return false
  }
  return true
}

function candidates(p: StoryPick, rules: PickRules, c: Content, minWiden: number): SpeciesDef[] {
  const starters = starterFamilies(c)
  const a: Active = { types: true, stages: true, families: true, countries: true, excludeStarters: true, habitats: true, rarityWiden: minWiden }
  const run = () => c.speciesList.filter((s) => matches(s, p, a, rules, starters, c))
  let found = run()
  const maxOrder = c.rarities.reduce((m, r) => Math.max(m, r.order), 0)
  for (const step of rules.relaxOrder) {
    if (found.length) break
    if (step === 'rarities') {
      for (let w = minWiden + 1; w <= maxOrder && !found.length && p.rarities?.length; w++) { a.rarityWiden = w; found = run() }
      if (!found.length) { a.rarityWiden = -1; found = run() }
    } else {
      a[step] = false
      found = run()
    }
  }
  return found.length ? found : c.speciesList.slice()
}

/**
 * Like resolvePick, but prefers species not in `avoid` (keeps a trainer's party varied). Throws only when the
 * species roster is empty.
 */
export function resolvePickAvoiding(pick: StoryPick, level: number, seedKey: string, avoid: ReadonlySet<string>, c: Content = CONTENT, rules: PickRules = PICK_RULES): string {
  if (!c.speciesList.length) throw new Error('resolvePick: species roster is empty')
  const formsFor = (widen: number, p: StoryPick = pick): SpeciesDef[] => {
    const base = candidates(p, rules, c, widen)
    let forms: SpeciesDef[]
    if (p.stages?.length) {
      const fits = base.filter((s) => minLevelOf(s, c) <= level)
      forms = fits.length ? fits : base
    } else {
      const evolved = [...new Map(base.map((s) => { const f = levelForm(s, level, c); return [f.id, f] as const })).values()]
      const typed = p.types?.length ? evolved.filter((s) => s.types.some((t) => p.types!.includes(t))) : evolved
      // Habitat is a preference: an on-type form from elsewhere beats a local one that lost the type at this level.
      if (!typed.length && p.types?.length && p.habitats?.length) return formsFor(widen, { ...p, habitats: undefined })
      forms = typed.length ? typed : evolved
    }
    return forms.sort((x, y) => x.dexNo - y.dexNo || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
  }
  const forms = formsFor(0)
  let pool = forms.filter((s) => !avoid.has(s.id))
  for (let w = 1; !pool.length && pick.rarities?.length && w <= rules.avoidRarityWiden; w++) pool = formsFor(w).filter((s) => !avoid.has(s.id))
  if (!pool.length) pool = forms
  return pool[hashString(`${seedKey}|${pick.salt ?? ''}`) % pool.length].id
}

/** Deterministic species for a pick at `level`; identical inputs always give the same species. */
export function resolvePick(pick: StoryPick, level: number, seedKey: string, c: Content = CONTENT): string {
  return resolvePickAvoiding(pick, level, seedKey, new Set(), c)
}
