// Shapes of content/world/frontier-content/*.json (frontier NPCs, trainers, bounties, landmark roles, wild extras).
// Types only — every name, line, weight, chance and threshold lives in JSON.
import type { Rarity } from '../../../types.ts'
import type { Vec2 } from '../../schema.ts'

/** [distance from origin, value] points, piecewise linear (clamped). */
export type Curve = [number, number][]
/** One dialogue: each string becomes a `say` step. */
export type Lines = string[]
export interface ItemRoll { item: string; qty: Vec2; weight: number }
export interface ItemTier { minDistance: number; pool: ItemRoll[] }
export interface StockTier { minDistance: number; items: string[] }
/** Site kind id (sites.json kinds[].id) or POI template id -> chance. */
export type SiteChances = Record<string, number>

/** common.json */
export interface PackCommon {
  /** 8 bearings starting north, clockwise. */
  directions: string[]
  distances: { max: number; text: string }[]
  unknown: string
  /** Trainer NPC display name, {class} {name}. */
  npcName: string
  /** Text-key patterns for runtime names ({id}). */
  textKeys: { weather: string; timeOfDay: string }
  /** Extra NPC placement: ring around a centre, spiral search radius, free orthogonal neighbours required, spacing. */
  place: { ring: Vec2; search: number; minNeighbours: number; spacing: number; avoidTerrain: string[] }
  stars: { full: string; empty: string }
  /** POI template -> extra place refs it also counts as (e.g. a frontier 'stele' is a 'monolith' for events). */
  templateAliases: Record<string, string[]>
  /** Danger tier names (index = RegionDef.danger). */
  dangerNames: string[]
}

export interface VillagerArchetype {
  id: string
  weight: number
  sprites: string[]
  /** May use {surname} / {given}. */
  names: string[]
  /** gossip = tells a hidden-event rumor; sage = MYTHIC chain clues; tips = rarity / type behaviour tips; gift = one-time gift. */
  role?: 'gossip' | 'sage' | 'tips' | 'gift'
  minDistance?: number
  biomes?: string[]
  lines: Lines[]
}

export interface RarityTips {
  flee: string
  minDistance: string
  noGrass: string
  avoid: string
  legend: string
  eventOnly: string
  affinityTime: string
  affinityWeather: string
}

/** villagers.json */
export interface VillagersFile {
  perHamlet: Vec2
  wander: number
  names: { surnames: string[]; given: string[] }
  archetypes: VillagerArchetype[]
  biomeLines: Record<string, Lines[]>
  distanceLines: { minDistance: number; lines: Lines[] }[]
  /** Chance a villager adds a biome line / a distance line. */
  lineChance: { biome: number; distance: number }
  tips: RarityTips
  gossip: {
    intro: Lines[]
    /** Prefix said before a rumor the player already heard. */
    heard: string
    none: Lines[]
    outro: Lines[]
    /** Event tag -> weight; tags missing here are never gossiped. */
    tagWeights: Record<string, number>
    biomeMatch: number
    placeMatch: number
    /** Rumors compiled into one villager (first eligible one is told). */
    candidates: number
  }
  sage: { intro: Lines[]; notReady: Lines[]; done: Lines[]; minDistance: number }
  gift: { intro: Lines[]; after: Lines[]; tiers: ItemTier[] }
  residents: { sprites: string[]; names: string[]; lines: Lines[]; biomeLines: Record<string, Lines[]>; gossipChance: number; giftChance: number; tipsChance: number }
}

export interface TrainerClass {
  id: string
  classZh: string
  sprites: string[]
  names: string[]
  biomes: string[] | 'any'
  /** Preferred creature types (team bias). */
  types: string[]
  weight: number
  minDistance?: number
  levelBonus?: number
  rewardMul?: number
  intro: Lines[]
  defeat: Lines[]
  /** Said after the trainer was beaten. */
  after: string[]
  items?: Record<string, number>
}

export interface RarityTier { minDistance: number; weights: Record<Rarity, number> }

export interface PartyRules {
  /** Mean party size by distance; +- sizeJitter, clamped to [1, maxSize]. */
  size: Curve
  sizeJitter: number
  maxSize: number
  /** Member level = region band max + spread roll; the ace gets aceBonus more. */
  levelSpread: Vec2
  aceBonus: number
  rarity: RarityTier[]
  /** Weight multiplier for species sharing a type with the class. */
  typeBias: number
  /** Weight multiplier for species living in the local habitats (others still allowed as travellers). */
  habitatBias: number
  aiLevel: Curve
  rewardPerLevel: number
  rewardDistanceMul: Curve
}

export interface ChallengeRole {
  levelBonus: number
  sizeBonus: number
  aiLevel: number
  rewardMul: number
  music: string
  rarity: RarityTier[]
  items: { minDistance: number; items: Record<string, number> }[]
  prizes: ItemTier[]
  challenge: string
  options: [string, string]
  decline: Lines[]
  prizeLine: string
  classes: TrainerClass[]
}

/** trainers.json */
export interface TrainersFile {
  party: PartyRules
  wander: {
    /** Expected wandering trainers per chunk by distance. */
    count: Curve
    maxPerChunk: number
    minDistance: number
    tries: number
    spacing: number
    /** Keep this many tiles from any site centre (beyond its radius). */
    siteClearance: number
    /** Chance a trainer looks for a roadside tile first. */
    roadside: number
    sightRange: Vec2
  }
  classes: TrainerClass[]
  guardians: ChallengeRole & { sites: SiteChances; minDistance: number; titles: Record<string, string> }
  bosses: ChallengeRole
}

/** Reward table in the story bounty format (content/world/story/bounties.json `reward`). */
export interface BountyReward {
  moneyPerLevel: number
  round: number
  items: { maxLevel: number; pool: Record<string, number>[] }[]
}

/** Persona entry of a story bounty kind. */
export interface StoryPersona { sprite: string; names: string[]; lines?: Lines[] }

/** One kind of content/world/story/bounties.json (read-only; only the fields the frontier reuses). */
export interface StoryBountyKind {
  weight: number
  names: string[]
  stages: { text: string; target?: string }[]
  giver?: StoryPersona[]
  partner?: StoryPersona[]
  texts: Record<string, string[]>
  rewardMul?: number
  parcels?: string[]
  trainer?: { classZh: string; sprite: string; names: string[]; types: string[]; introText: Lines[]; defeatText: Lines[]; after: string[] }[]
  levelBonus?: number
  catchCount?: Vec2
  fetch?: { bands: { maxLevel: number; items: string[] }[]; qty: Vec2 }
}

export interface StoryBountiesFile { reward?: BountyReward; kinds?: Record<string, StoryBountyKind> }

export type FrontierBountyKind = 'deliver' | 'hunt' | 'catch' | 'fetch' | 'visit'

export interface BountyKindSpec {
  weight: number
  /** Story bounty kind whose names / personas / texts / stages this kind reuses. */
  story: string
  minDistance?: number
  rewardMul?: number
  /** fetch: repeatable once per in-game day ({day} flag, no quest-log entry). */
  daily?: boolean
  /** deliver / visit: destination site kinds (sites.json kinds[].id). */
  destKinds?: string[]
  /** hunt: the outlaw camps beside the road this many path tiles away from the hamlet. */
  road?: Vec2
  /** hunt: party size range. */
  partySize?: Vec2
  /** hunt: {destName} of the camp ({name} = the road's far end) / when the road leads to a causeway gate. */
  destName?: string
  gateName?: string
  /** hunt: the outlaw's line of sight (0 = only fights when talked to). */
  sightRange?: number
}

/** bounties.json */
export interface BountiesFile {
  perHamlet: Vec2
  /** Destinations / inbound givers are searched within this many site cells. */
  neighbourCells: number
  kinds: Record<FrontierBountyKind, BountyKindSpec>
  board: { prop: string; format: string; entry: string; daily: string }
  courier: { sprites: string[]; names: string[]; idle: Lines[]; neighbour: string; inboundHint: string }
  accept: { question: string; options: [string, string] }
  daily: { doneToday: Lines[]; notEnough: Lines[]; handIn: string; options: [string, string] }
  /** Flag patterns ({quest} / {site} / {day}). */
  flags: { given: string; done: string; found: string; daily: string; scouted: string }
  /** Story bounty kind ids used for outlaw personas (hunt). */
  outlawStory: string
  /** Optional override of the story reward table. */
  reward?: BountyReward
}

export interface MerchantType {
  id: string
  weight: number
  sprites: string[]
  names: string[]
  intro: Lines[]
  outro: Lines[]
  /** Only trades at these times / in this weather (else `closed`). */
  times?: ('dawn' | 'day' | 'dusk' | 'night')[]
  weathers?: string[]
  closed?: Lines[]
  /** 'rare' stock tiers, 'chips' (local types) or 'exchange' (valuables for prizes). */
  stock: 'rare' | 'chips' | 'exchange'
  count: Vec2
}

/** landmarks.json */
export interface LandmarksFile {
  keeper: {
    sites: SiteChances
    sprites: string[]
    names: string[]
    intro: Lines[]
    lore: { patterns: string[]; words: Record<string, string[]>; lines: Vec2 }
    clue: { intro: Lines[]; here: string; reveal: string; far: string; none: Lines[] }
    plaque: { prop: string; format: string }
  }
  hermit: {
    sites: SiteChances
    minDistance: number
    sprites: string[]
    names: string[]
    title: string
    intro: Lines[]
    /** Species of the hermit's type the player must have caught (by distance). */
    requirement: Curve
    notEnough: string
    offer: string
    options: [string, string]
    taught: string
    decline: Lines[]
    after: Lines[]
    /** Fee = chip price x priceMul (rounded to priceRound). */
    priceMul: number
    priceRound: number
    noMoney: string
    tip: string
  }
  merchant: { sites: SiteChances; minDistance: number; types: MerchantType[] }
  merchantStock: { rare: StockTier[]; chipsPerType: number; maxChipPrice: Curve }
  exchange: { valuables: string[]; offer: string; options: [string, string]; done: string; lacking: Lines[]; prizes: ItemTier[] }
  watcher: {
    sites: SiteChances
    sprites: string[]
    names: string[]
    intro: Lines[]
    rare: string
    conditions: string
    noConditions: string
    notes: string
    notesDone: Lines[]
    researchTask: string
    tipChance: number
    /** Spawn-condition phrases ({list} / {from} {to}) joined by `joiner` inside a part and `sep` between parts. */
    parts: { time: string; weather: string; biomes: string; hours: string; joiner: string; sep: string }
  }
  /** Keeper / sage clue reach (site cells searched for the place a clue points to). */
  clueCells: number
}

/** wild.json */
export interface WildFile {
  caches: { chance: Curve; hidden: number; nearProps: string[]; tries: number; tiers: ItemTier[] }
  hermitCamps: { chance: Curve; minDistance: number; props: string[]; tries: number }
  merchantCamps: { chance: Curve; minDistance: number; prop: string; tries: number }
  roadSigns: {
    prop: string
    province: { format: string }
    /** Plaques where a road crosses these distances from the origin (plus every rarity minDistance > 0 and danger tier). */
    milestones: { format: string; rarity: string; danger: string; extra: number[] }
  }
}

/** interiors.json */
export interface InteriorsFile {
  explorer: { chance: number; sprites: string[]; names: string[]; lines: Lines[]; floorHint: string; bossHint: string }
}
