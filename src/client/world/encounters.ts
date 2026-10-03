// Wild encounter selection (pure, data-driven): time-of-day slot filtering, night type boosts from
// config.encounters.nightTypeBoost, weighted pick, repel rule, field -> battle weather mapping.
import type { Creature, EncounterSlot, FieldWeatherKind, RegionDef, TimeOfDay, WeatherId } from '../../shared/types.ts'
import type { IRng } from '../../shared/contracts.ts'
import { CONTENT, type Content } from '../../shared/content/index.ts'
import { WORLD_CONTENT } from '../../shared/world/data.ts'

export interface EncounterPick { speciesId: string; level: number; slot: EncounterSlot }

/** Slots active at this time of day (slots without `time` are always active). */
export function activeSlots(slots: readonly EncounterSlot[], tod: TimeOfDay, c: Content = CONTENT): EncounterSlot[] {
  return slots.filter((s) => c.species[s.species] && s.weight > 0 && (!s.time || s.time.length === 0 || s.time.includes(tod)))
}

/** Slot weight including the night type boost (highest boost among the species' types). */
export function slotWeight(s: EncounterSlot, tod: TimeOfDay, nightPhase: TimeOfDay, c: Content = CONTENT): number {
  if (tod !== nightPhase) return s.weight
  const types = c.species[s.species]?.types ?? []
  const boost = types.reduce((m, ty) => Math.max(m, c.config.encounters.nightTypeBoost[ty] ?? 1), 1)
  return s.weight * boost
}

/** The time-of-day phase night type boosts apply to (world encounter rules). */
export function nightPhaseOf(): TimeOfDay {
  return WORLD_CONTENT.world.encounters.nightPhase as TimeOfDay
}

export function pickEncounter(slots: readonly EncounterSlot[], tod: TimeOfDay, rng: IRng, c: Content = CONTENT): EncounterPick | null {
  const active = activeSlots(slots, tod, c)
  if (!active.length) return null
  const night = nightPhaseOf()
  const slot = rng.weighted(active, (s) => slotWeight(s, tod, night, c))
  const lo = Math.min(slot.minLevel, slot.maxLevel), hi = Math.max(slot.minLevel, slot.maxLevel)
  const level = Math.max(1, Math.min(c.config.party.maxLevel, rng.int(lo, hi)))
  return { speciesId: slot.species, level, slot }
}

/** Per-step encounter check: region rate, optionally gated by repel (wild level below the lead's level). */
export function rollEncounter(region: RegionDef, tod: TimeOfDay, rng: IRng, opts: { repelActive: boolean; leadLevel: number }, c: Content = CONTENT): EncounterPick | null {
  if (!(region.encounterRate > 0) || !region.encounters.length) return null
  if (!rng.chance(region.encounterRate)) return null
  const pick = pickEncounter(region.encounters, tod, rng, c)
  if (!pick) return null
  if (opts.repelActive && repelBlocks(pick.level, opts.leadLevel)) return null
  return pick
}

/** Repel: wild creatures weaker than the party lead stay away. */
export function repelBlocks(wildLevel: number, leadLevel: number): boolean {
  return wildLevel < leadLevel
}

/** First creature able to battle (hp > 0), or null. */
export function firstConscious(party: readonly Creature[]): Creature | null {
  return party.find((c) => c.hp > 0) ?? null
}

/** Battle weather whose overworld ambience matches the field weather (WeatherDef.fieldWeather). */
export function battleWeatherFor(kind: FieldWeatherKind | undefined, c: Content = CONTENT): WeatherId | undefined {
  if (!kind) return undefined
  return c.weathers.find((w) => w.fieldWeather === kind)?.id
}

/** Rarity aura colour for a roaming creature (rare slots always glow; otherwise RarityDef.aura). */
export function auraColor(speciesId: string, rare: boolean, c: Content = CONTENT): string | null {
  const sp = c.species[speciesId]
  const r = sp ? c.rarityById[sp.rarity] : undefined
  if (!r) return null
  if (r.aura || rare) return r.color
  return null
}
