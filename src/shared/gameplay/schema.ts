// Content schemas for the gameplay layer (content/events/**, content/research.json). Types only — the data is
// loaded by ./data.ts and validated by ./validate.ts (hooked into validateContent()).
import type { BiomeId, EventCondition, FieldWeatherKind, ResearchFile, TimeOfDay, TypeId, WorldEventDef } from '../types.ts'

export interface SchedulerRules {
  /** The scheduler rolls once per slot of this many in-game minutes (eventSlot()). */
  checkEveryMinutes: number
  /** Max simultaneously active auto events (script/legend triggers may exceed it). */
  maxActive: number
  /** Max auto events started by one check. */
  maxStartsPerCheck: number
  /** Tiles around a local event's anchor where its effects apply. */
  localRadius: number
  /** Tiles around a region event's anchor where it applies when the region id is unknown. */
  regionRadius: number
  /** Effects of a local event are placed inside this ring around the anchor (min, max tiles). */
  placeRing: [number, number]
  /** Sight range (tiles) of pop-up event trainers whose effect does not set its own. */
  trainerSightRange: number
}

export interface RumorRules {
  /** Pick weights by rumor source. */
  hiddenWeight: number
  visibleWeight: number
  chainWeight: number
  legendWeight: number
  /** Flag set when a rumor has been told: `${flagPrefix}${eventId}`. Such flags are ignored by rumor gating. */
  flagPrefix: string
  /** Weight multiplier for rumors the player has already heard. */
  heardWeightMul: number
}

export interface VisibleRules {
  /** Side of the square spawn area (tiles) the per-tier caps (RarityBehavior.maxVisiblePerArea) refer to. */
  areaTiles: number
  /** Weight multiplier for a conditional-tier species whose spawn condition matches its affinity strongly (anyOf hit). */
  conditionBonus: number
}

export interface LegendRules {
  /** Band edges in tiles from the origin: band k = [bandEdges[k], bandEdges[k+1]); past the last edge bands repeat every bandStep. */
  bandEdges: number[]
  bandStep: number
  /** In-game days per rotation epoch (each band may host a different legend per epoch). */
  rotationDays: number
  /** wander/blink patterns jump to a new waypoint every hopMinutes (blink: hopMinutes / blinkDivisor). */
  hopMinutes: number
  blinkDivisor: number
  /** Within appearRadius the legend materialises as a visible roamer; within senseRadius the HUD shows its cue. */
  appearRadius: number
  senseRadius: number
  /** Map ping: fuzz radius (tiles) and how often (in-game minutes) the fuzzed ping moves. */
  pingFuzz: number
  pingSlotMinutes: number
  /** After fleeing / being escaped from, the legend relocates and stays hidden this many in-game minutes. */
  fleeRestMinutes: number
  /** Legend level by band; bands past the list add levelPerExtraBand per band (capped at config.party.maxLevel). */
  levelByBand: number[]
  levelPerExtraBand: number
  /** Radius searched by snapToFree() for a walkable tile near the nominal position. */
  snapRadius: number
  /** Fraction of the band width kept clear of the band edges. */
  edgeMargin: number
}

/** How a roaming wild creature reacts when it notices the player. */
export type RoamingStance = 'neutral' | 'chase' | 'flee'

/** `base` while the wild creature is at least as strong as the player's strongest party member, `outleveled` once the player is stronger. */
export interface RoamingStances { base: RoamingStance; outleveled: RoamingStance }

export interface RoamingPolicy {
  /** Country codes not listed in `countries` (SpeciesDef.country). */
  default: RoamingStances
  countries: Record<string, RoamingStances>
}

export interface SpawnRules {
  scheduler: SchedulerRules
  rumor: RumorRules
  visible: VisibleRules
  legends: LegendRules
  /** Overworld attitude of roaming creatures by country (see shared/gameplay/spawns.ts roamingDisposition). */
  roamingPolicy: RoamingPolicy
  /** Type weight multipliers by time of day / field weather, applied on top of encounter slot weights. */
  typeAffinity: {
    time: Partial<Record<TimeOfDay, Record<TypeId, number>>>
    weather: Partial<Record<FieldWeatherKind, Record<TypeId, number>>>
  }
  /** Spawn conditions for tiers with requireConditions: OR over the conditions of the species' types. */
  typeConditions: Record<TypeId, EventCondition[]>
  /** Per-species condition lists that replace the type-derived ones. */
  speciesConditions: Record<string, EventCondition[]>
  /** Rarities event spawns / pop-up trainers never pick unless the SpeciesPick names them. */
  pickExcludeRarities: string[]
  /**
   * Registry of renderer/HUD cue keys by group (aura, spawn, notice, flee, ping, ambience). Every cue used in
   * rarities.json / events must be declared here; the renderer implements each key (unknown keys = no-op).
   * RarityBehavior.cues.music is a bgm track id instead (content/audio.json).
   */
  cues: Record<string, string[]>
}

export type LegendPattern = 'orbit' | 'wander' | 'tide' | 'blink'

/** content/events/legends.json — one roaming UR legend. Text keys: events.legend.<species>.{title,appear,rumor}. */
export interface RoamingLegendDef {
  species: string
  pattern: LegendPattern
  /** orbit/tide: angular speed in degrees per in-game hour. */
  speed: number
  /** Lowest province band it may roam (0 = core continent). */
  minBand: number
  /** Extra appearance condition (time/weather/biome/...) checked when the player is near. */
  when: EventCondition
  /** Ambience cue while it is near (renderer/HUD). */
  cue: string
  /** Field weather it drags along while it is visible (optional). */
  weather?: FieldWeatherKind
  levelBonus: number
  /** Preferred biomes (map ping tint / rumor wording); empty = any. */
  biomes: BiomeId[]
}

/** content/events/mythic.json — a hidden multi-step chain that leads to one MYTHIC species. */
export interface MythicChainStep {
  /** Step event id (its WorldEventDef.chain === chain id). */
  event: string
  /** Flag the step sets when solved (the next step's `when.flags` requires it). */
  flag: string
  /** Clue text key shown in the dex/journal once the previous step is solved. */
  clue: string
}

export interface MythicChainDef {
  id: string
  species: string
  /** Ordered steps; the last one is the encounter and sets doneFlag. */
  steps: MythicChainStep[]
  doneFlag: string
  level: number
  /** Story / legend progress required before the chain's first rumor can be heard. */
  requires: EventCondition
}

export interface EventFile { events: WorldEventDef[] }
export interface LegendFile { legends: RoamingLegendDef[] }
export interface MythicFile { chains: MythicChainDef[]; events: WorldEventDef[] }

export interface GameplayData {
  /** Every world event: authored files + generated roaming-legend encounter events (`legend-<species>`). */
  events: WorldEventDef[]
  eventById: Record<string, WorldEventDef>
  spawn: SpawnRules
  legends: RoamingLegendDef[]
  legendBySpecies: Record<string, RoamingLegendDef>
  chains: MythicChainDef[]
  chainById: Record<string, MythicChainDef>
  research: ResearchFile
}
