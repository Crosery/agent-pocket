// Wild encounter tables derived from the species roster (CONTENT.speciesList): habitat biome, level band,
// evolution stage, rarity weight x stage weight, night-time type boosts. Never references species ids.
import type { EncounterSlot, SpeciesDef, TimeOfDay } from '../types.ts'
import { CONTENT, type Content } from '../content/index.ts'
import { hash3, hashString } from './random.ts'
import type { EncounterRules, Vec2 } from './schema.ts'

export interface EncounterQuery {
  key: string
  biomes: string[]
  /** Fallback biomes (neighbouring regions) used when the primary biomes give too few species. */
  fallback: string[]
  levelRange: Vec2
  /** Weight multiplier for rare slots (deep wilds, nests, dungeons). Default 1. */
  rareBoost?: number
}

/** Minimum level at which a species can appear in the wild (its evolution level, recursively). */
export function wildMinLevel(s: SpeciesDef, c: Content = CONTENT): number {
  let level = 1
  let cur: SpeciesDef | undefined = s
  for (let guard = 0; cur?.evolvesFrom && guard < 8; guard++) {
    const parent: SpeciesDef | undefined = c.species[cur.evolvesFrom]
    if (parent?.evolvesTo?.id === cur.id) level = Math.max(level, parent.evolvesTo.level)
    cur = parent
  }
  return level
}

function baseWeight(s: SpeciesDef, c: Content): number {
  const r = c.rarityById[s.rarity]
  const sw = c.config.encounters.stageWeight
  const stage = sw[Math.min(sw.length - 1, Math.max(0, s.stage - 1))] ?? 0
  return (r?.encounterWeight ?? 0) * stage
}

function nightBoost(s: SpeciesDef, c: Content): number {
  let b = 1
  for (const t of s.types) b = Math.max(b, c.config.encounters.nightTypeBoost[t] ?? 1)
  return b
}

interface Candidate { s: SpeciesDef; min: number; max: number; w: number }

/** One slot per species, or a day and a night slot when the species has a night-time type boost. */
function slotsOf(x: Candidate, rules: EncounterRules, c: Content): (EncounterSlot & { order: number })[] {
  const night = rules.nightPhase as TimeOfDay
  const notNight = c.config.time.phases.map((p) => p.id).filter((p) => p !== night)
  const order = c.rarityById[x.s.rarity]?.order ?? 0
  const boost = nightBoost(x.s, c)
  if (boost === 1) return [{ species: x.s.id, minLevel: x.min, maxLevel: x.max, weight: x.w, order }]
  return [
    { species: x.s.id, minLevel: x.min, maxLevel: x.max, weight: x.w, time: notNight, order },
    { species: x.s.id, minLevel: x.min, maxLevel: x.max, weight: x.w * boost, time: [night], order },
  ]
}

function candidates(biomes: string[], range: Vec2, c: Content, allowStarters: boolean, cap?: { maxOrder: number; onlyTypes?: string[] }): Candidate[] {
  const out: Candidate[] = []
  for (const s of c.speciesList) {
    if (s.starter && !allowStarters) continue
    if (!s.habitats.some((h) => biomes.includes(h))) continue
    if (cap && ((c.rarityById[s.rarity]?.order ?? 0) > cap.maxOrder || (cap.onlyTypes && !s.types.every((ty) => cap.onlyTypes!.includes(ty))))) continue
    const w = baseWeight(s, c)
    if (w <= 0) continue
    const min = Math.max(range[0], wildMinLevel(s, c))
    if (min > range[1]) continue
    out.push({ s, min, max: range[1], w })
  }
  return out
}

export function computeEncounters(q: EncounterQuery, rules: EncounterRules, seed: number, c: Content = CONTENT): EncounterSlot[] {
  const allBiomes = c.biomes.map((b) => b.id)
  const picked = new Map<string, Candidate>()
  const cap = rules.rarityLevelCaps?.find((x) => q.levelRange[1] <= x.maxLevel)
  const tiers = [q.biomes, q.fallback, allBiomes]
  for (const allowStarters of [false, true]) {
    for (const tier of tiers) {
      if (picked.size >= rules.minSlots) break
      const cands = candidates(tier, q.levelRange, c, allowStarters, cap).filter((x) => !picked.has(x.s.id))
      // Deterministic per-region ordering; round-robin across rarities keeps tables varied.
      const salt = hashString(q.key)
      cands.sort((a, b) => hash3(seed, salt, hashString(a.s.id)) - hash3(seed, salt, hashString(b.s.id)) || a.s.dexNo - b.s.dexNo)
      const byRarity = new Map<string, Candidate[]>()
      for (const x of cands) { const l = byRarity.get(x.s.rarity) ?? []; l.push(x); byRarity.set(x.s.rarity, l) }
      const groups = [...byRarity.values()]
      const limit = tier === q.biomes ? rules.maxSpecies : rules.minSlots
      for (let k = 0; picked.size < limit && groups.some((g) => g.length > k); k++) {
        for (const g of groups) if (g[k] && picked.size < limit) picked.set(g[k].s.id, g[k])
      }
    }
    if (picked.size > 0) break
  }
  type Slot = EncounterSlot & { order: number }
  let slots: Slot[] = []
  for (const x of [...picked.values()].sort((a, b) => a.s.dexNo - b.s.dexNo)) slots.push(...slotsOf(x, rules, c))
  // Too few species overall: split the widest level bands so the table still has enough slots.
  while (slots.length > 0 && slots.length < rules.minSlots) {
    let wi = 0
    for (let k = 1; k < slots.length; k++) if (slots[k].maxLevel - slots[k].minLevel > slots[wi].maxLevel - slots[wi].minLevel) wi = k
    const s = slots[wi]
    if (s.maxLevel <= s.minLevel) break
    const mid = Math.floor((s.minLevel + s.maxLevel) / 2)
    slots.splice(wi, 1, { ...s, maxLevel: mid, weight: s.weight / 2 }, { ...s, minLevel: mid + 1, weight: s.weight / 2 })
  }
  if (slots.length) {
    const maxOrder = Math.max(...slots.map((s) => s.order))
    const minOrder = Math.min(...slots.map((s) => s.order))
    const anyRare = slots.some((s) => s.order >= rules.rareMinOrder)
    const boost = q.rareBoost ?? 1
    slots = slots.map((s) => (s.order >= rules.rareMinOrder || (!anyRare && maxOrder > minOrder && s.order === maxOrder) ? { ...s, rare: true, weight: s.weight * boost } : s))
  }
  return slots.map(({ order: _o, ...rest }) => rest)
}

export interface CoverageTable {
  key: string
  biome: string
  /** Mutated in place: missing species are appended. */
  encounters: EncounterSlot[]
  levelRange?: Vec2
}

/**
 * World-level guarantee that every wild-obtainable base form appears in at least one encounter table, so adding
 * species cannot make any of them unobtainable. Base forms (no pre-evolution) up to `rules.coverage.maxOrder`
 * that are in no table are appended to the smallest eligible table (habitat, level and early-game rarity caps
 * as in `computeEncounters`). Starters are gifts, not wild. Returns the species no table could take.
 */
export function ensureEncounterCoverage(tables: CoverageTable[], rules: EncounterRules, seed: number, c: Content = CONTENT): string[] {
  const maxOrder = rules.coverage?.maxOrder
  if (maxOrder === undefined) return []
  const wild = tables.filter((t) => t.encounters.length > 0)
  const seen = new Set<string>()
  const size = new Map<CoverageTable, number>()
  for (const t of wild) {
    const own = new Set(t.encounters.map((e) => e.species))
    size.set(t, own.size)
    for (const id of own) seen.add(id)
  }
  const unplaced: string[] = []
  for (const s of c.speciesList) {
    if (s.evolvesFrom || s.starter || seen.has(s.id) || (c.rarityById[s.rarity]?.order ?? 0) > maxOrder) continue
    const w = baseWeight(s, c)
    const order = c.rarityById[s.rarity]?.order ?? 0
    const sid = hashString(s.id)
    let best: { t: CoverageTable; x: Candidate; size: number; h: number } | undefined
    if (w > 0) {
      for (const t of wild) {
        if (!s.habitats.includes(t.biome)) continue
        const lo = t.levelRange?.[0] ?? Math.min(...t.encounters.map((e) => e.minLevel))
        const hi = t.levelRange?.[1] ?? Math.max(...t.encounters.map((e) => e.maxLevel))
        const cap = rules.rarityLevelCaps?.find((x) => hi <= x.maxLevel)
        if (cap && (order > cap.maxOrder || (cap.onlyTypes && !s.types.every((ty) => cap.onlyTypes!.includes(ty))))) continue
        const min = Math.max(lo, wildMinLevel(s, c))
        if (min > hi) continue
        const n = size.get(t)!
        const h = hash3(seed, sid, hashString(t.key))
        if (!best || n < best.size || (n === best.size && h < best.h)) best = { t, x: { s, min, max: hi, w }, size: n, h }
      }
    }
    if (!best) { unplaced.push(s.id); continue }
    const rare = order >= rules.rareMinOrder
    for (const { order: _o, ...slot } of slotsOf(best.x, rules, c)) best.t.encounters.push(rare ? { ...slot, rare: true } : slot)
    size.set(best.t, best.size + 1)
    seen.add(s.id)
  }
  return unplaced
}
