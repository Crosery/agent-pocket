// Schemas (TypeScript shapes) for Agent Pocket. All game DATA lives in content/**/*.json and is
// loaded + validated by src/shared/content/index.ts. This file holds types only — no data tables.
// Keep dependency-free (no DOM, no three, no node APIs).

// ---------------------------------------------------------------------------
// Ids are plain strings resolved against content tables at load time.
// ---------------------------------------------------------------------------

export type TypeId = string        // content/types.json
export type Rarity = string        // content/rarities.json
export type BiomeId = string       // content/biomes.json
export type StatusId = string      // content/statuses.json
export type VolatileId = string    // content/volatiles.json
export type WeatherId = string     // content/weathers.json ('none' = clear)

export type StatKey = 'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe'
export type Stats = Record<StatKey, number>
/** In-battle modifiable stats (stages). */
export type BattleStatKey = 'atk' | 'def' | 'spa' | 'spd' | 'spe' | 'acc' | 'eva'
export type StatChanges = Partial<Record<BattleStatKey, number>>

export type Dir = 'down' | 'left' | 'right' | 'up'
export type GrowthRate = string    // key of config.growth
export type TimeOfDay = 'dawn' | 'day' | 'dusk' | 'night'
export type EffectTarget = 'enemy' | 'self'
export type MoveCategory = 'physical' | 'special' | 'status'

// ---------------------------------------------------------------------------
// Taxonomy tables
// ---------------------------------------------------------------------------

export interface TypeDef { id: TypeId; nameZh: string; color: string; icon?: string }
/** typeChart[attacking][defending] = multiplier. Missing entries mean 1. */
export type TypeChart = Record<TypeId, Record<TypeId, number>>
export interface TypesFile {
  types: TypeDef[]
  chart: TypeChart
  /** Types immune to a status: statusImmunities[statusId] = [typeIds]. */
  statusImmunities: Record<StatusId, TypeId[]>
}

export interface RarityDef {
  id: Rarity
  nameZh: string
  color: string
  order: number              // 0 = most common
  bst: [number, number]      // base stat total band
  catchRate: [number, number]
  encounterWeight: number    // relative weight in wild tables
  aura: boolean              // visible aura when roaming
  behavior?: RarityBehavior
}

/** How creatures of a rarity tier appear and act in the world (all numbers data-driven). */
export interface RarityBehavior {
  /** grass = random tall-grass encounters; visible = roams the overworld; event = only via WorldEventDef spawns; legend = unique roaming legend / hidden event. */
  spawn: Array<'grass' | 'visible' | 'event' | 'legend'>
  /** Minimum distance (tiles) from the world origin before this tier appears in procedural frontier tables. */
  minDistance: number
  /** Extra weight multiplier per 1000 tiles of distance from the origin (rarer tiers grow further out). */
  distanceWeightPer1000: number
  /** In battle: chance per turn (0..1) a wild of this tier flees, starting at fleeAfterTurn. */
  fleeChancePerTurn: number
  fleeAfterTurn: number
  /** Overworld roaming: speed multiplier and whether it avoids the player. */
  roamSpeed: number
  avoidPlayer: boolean
  /** Visual/audio cue keys used by the renderer/HUD (aura effect, sparkle, map ping). */
  cue: string
  // ---- optional extensions (src/shared/gameplay/spawns.ts); all default to neutral values ----
  /** Weight multiplier in tall-grass tables (default 1 when spawn has 'grass', else 0). */
  grassWeightMul?: number
  /** Weight multiplier for visible overworld roamers (default 1 when spawn has 'visible', else 0). */
  visibleWeightMul?: number
  /** Max simultaneous visible roamers of this tier per spawn area (default unlimited). */
  maxVisiblePerArea?: number
  /** Visible roamers of this tier only spawn while their species spawn condition holds (gameplay spawn rules). */
  requireConditions?: boolean
  /** Shiny odds multiplier on top of config.battle.shinyRate. */
  shinyMultiplier?: number
  /** Visible roamer lifetime in in-game minutes [min, max]. */
  lifeMinutes?: [number, number]
  /** Levels added to the area's level roll for this tier. */
  levelBonus?: number
  /** Distance (tiles) at which a visible roamer of this tier notices / starts avoiding the player. */
  noticeRadius?: number
  /** Renderer/HUD/audio cue keys by moment: aura (persistent), spawn, notice, flee, ping (map), music. */
  cues?: { aura?: string; spawn?: string; notice?: string; flee?: string; ping?: string; music?: string }
}

export interface StatDef { key: StatKey | 'acc' | 'eva'; nameZh: string; desc: string }

export interface BiomeDef {
  id: BiomeId
  nameZh: string
  /** Species habitats that may spawn here (defaults to [id]); lets new biomes reuse roster habitats. */
  encounterHabitats?: BiomeId[]
  battleBg: string           // ui asset id for the battle backdrop
  cliff: string              // terrain texture key used for cliff faces
  groundTerrain: string      // default terrain key for battle diorama ground
  ambient: string[]          // ambient particle kinds: fireflies, leaves, petals, dust, embers, snowfall...
}

/** Major status. Behaviour is fully parameterised — the engine has no per-id logic. */
export interface StatusDef {
  id: StatusId
  nameZh: string
  short: string              // 1-char chip label
  color: string
  dotFraction?: number       // end-of-turn damage as fraction of max HP
  physicalMul?: number       // multiplier to physical damage dealt
  speedMul?: number
  skipChance?: number        // chance to lose the turn
  durationMin?: number       // turns (status cures itself after)
  durationMax?: number
  cureChancePerTurn?: number // checked before acting
  catchBonus: number
}

export interface VolatileDef {
  id: VolatileId
  nameZh: string
  durationMin?: number
  durationMax?: number
  selfHitChance?: number     // confusion-like
  flinch?: boolean           // lose this turn's move if applied before acting
  protects?: boolean         // blocks incoming moves this turn
  drainFraction?: number     // leech-like: end of turn transfer of max HP fraction to the foe
  critStageAdd?: number
  blocksStatusMoves?: boolean
}

export interface WeatherDef {
  id: WeatherId
  nameZh: string
  color: string
  powerMul: Record<TypeId, number>
  chip?: { fraction: number; exemptTypes: TypeId[] }
  heal?: { fraction: number; types: TypeId[] }
  startText: string          // '{weather}' placeholder allowed
  continueText: string
  endText: string
  fieldWeather?: string      // overworld WorldWeather kind used as battle ambience
}

// ---------------------------------------------------------------------------
// Abilities — declarative effect DSL interpreted generically by the battle engine.
// ---------------------------------------------------------------------------

export interface AbilityCondition {
  hpBelow?: number           // holder hp ratio <= value
  hpFull?: boolean
  moveTypes?: TypeId[]
  moveNotOwnType?: boolean   // move type not among holder's types
  moveCategory?: MoveCategory | 'damaging'
  superEffective?: boolean
  weather?: WeatherId[]
}

export type AbilityEffect =
  | { on: 'powerMul'; mul: number; if?: AbilityCondition }           // as attacker
  | { on: 'damageTakenMul'; mul: number; if?: AbilityCondition }     // as defender
  | { on: 'statMul'; stat: BattleStatKey; mul: number }
  | { on: 'stab'; value: number }
  | { on: 'critStage'; add: number }
  | { on: 'critMul'; value: number }
  | { on: 'accuracyMul'; mul: number; ignoreEvasion?: boolean }
  | { on: 'priority'; add: number; if?: AbilityCondition }
  | { on: 'switchIn'; target: EffectTarget; stats?: StatChanges; highestOf?: BattleStatKey[]; stages?: number }
  | { on: 'switchOut'; healFraction: number }
  | { on: 'turnEnd'; stats?: StatChanges; healFraction?: number; cureStatusChance?: number }
  | { on: 'immune'; statuses?: StatusId[]; volatiles?: VolatileId[] }
  | { on: 'afterHitBy'; if?: AbilityCondition; stats: StatChanges }
  | { on: 'dealDamage'; volatile?: { id: VolatileId; chance: number }; status?: { id: StatusId; chance: number }; drainFraction?: number; selfDamageFraction?: number }
  | { on: 'knockOut'; stats: StatChanges }
  | { on: 'absorbType'; types: TypeId[]; healFraction: number }
  | { on: 'alwaysEscape' }
  | { on: 'moveLast' }
  | { on: 'ignoreFoeBoosts' }
  | { on: 'ignoreProtect' }
  | { on: 'blockFoeStatusMoves'; chance: number }
  | { on: 'noStatDrops' }

export interface AbilityDef {
  id: string
  nameZh: string
  description: string
  effects: AbilityEffect[]
}

// ---------------------------------------------------------------------------
// Moves / items / species
// ---------------------------------------------------------------------------

/** Visual effect archetype implemented by the battle VFX system (code capability, not data). */
export type MoveAnim =
  | 'hit' | 'slash' | 'beam' | 'orb' | 'burst' | 'wave' | 'rain' | 'shield'
  | 'heal' | 'buff' | 'debuff' | 'glitch' | 'code' | 'lightning' | 'fire'
  | 'ice' | 'sound' | 'light' | 'dark' | 'wind' | 'quake' | 'spark'

export type MoveEffect =
  | { kind: 'status'; status: StatusId; chance: number; target: EffectTarget }
  | { kind: 'stat'; stats: StatChanges; chance: number; target: EffectTarget }
  | { kind: 'volatile'; volatile: VolatileId; chance: number; target: EffectTarget }
  | { kind: 'heal'; fraction: number }
  | { kind: 'drain'; fraction: number }
  | { kind: 'recoil'; fraction: number }
  | { kind: 'multiHit'; min: number; max: number }
  | { kind: 'fixedDamage'; amount: number | 'level' }
  | { kind: 'weather'; weather: WeatherId }
  | { kind: 'cureStatus'; target: EffectTarget }
  | { kind: 'highCrit' }
  | { kind: 'alwaysHit' }
  | { kind: 'recharge' }
  | { kind: 'selfFaint' }

export interface MoveDef {
  id: string
  nameZh: string
  nameEn: string
  type: TypeId
  category: MoveCategory
  power: number              // 0 for status moves
  accuracy: number           // 1..100; 0 means never misses
  pp: number
  priority: number
  effects: MoveEffect[]
  description: string
  anim: MoveAnim
}

export type ItemCategory = 'ball' | 'medicine' | 'battle' | 'key' | 'chip' | 'evolution' | 'misc'
export type BallBonus = 'night' | 'quick' | 'status' | 'lowLevel' | 'rare' | 'master'
export type KeyItemKind = 'bike' | 'surf' | 'map' | 'dex' | 'badgeCase' | 'pass'

export type ItemEffect =
  | { kind: 'ball'; catchMultiplier: number; bonus?: BallBonus; color: string }
  | { kind: 'heal'; amount: number | 'full' }
  | { kind: 'cure'; status: StatusId | 'all' }
  | { kind: 'healCure' }
  | { kind: 'revive'; fraction: number }
  | { kind: 'pp'; amount: number | 'full'; all: boolean }
  | { kind: 'levelUp' }
  | { kind: 'evolve' }
  | { kind: 'battleBoost'; stat: BattleStatKey; stages: number }
  | { kind: 'repel'; steps: number }
  | { kind: 'escape' }
  | { kind: 'chip'; move: string }
  | { kind: 'key'; key: KeyItemKind }
  | { kind: 'none' }

export interface ItemDef {
  id: string
  nameZh: string
  category: ItemCategory
  price: number              // shop buy price; sell = price * config.economy.sellRatio
  buyable: boolean
  description: string
  effect: ItemEffect
  usableInBattle: boolean
  usableInField: boolean
}

export interface LearnsetEntry { level: number; move: string }

export interface SpeciesDef {
  id: string                 // ascii kebab-case; sprite file name
  dexNo: number
  nameZh: string
  nameEn: string
  company: string
  country: string
  category: string
  family: string
  stage: number
  evolvesTo?: { id: string; level: number }
  evolvesFrom?: string
  types: TypeId[]            // 1..2
  rarity: Rarity
  baseStats: Stats
  abilities: string[]
  learnset: LearnsetEntry[]
  teachable: string[]
  catchRate: number
  baseExp: number
  growth: GrowthRate
  habitats: BiomeId[]
  dexEntry: string
  releaseDate: string
  personality: string
  size: number               // world sprite scale (1 = player height)
  starter?: boolean
  designPrompt?: string      // sprite generation prompt (tools only)
}

// ---------------------------------------------------------------------------
// Presentation tables
// ---------------------------------------------------------------------------

export interface TerrainDef {
  id: number                 // value stored in GameMap.terrain
  key: string                // texture key
  nameZh: string
  walkable: boolean
  swim: boolean
  encounter: boolean
  tallGrass: boolean
  minimap: string
  speed: number
  stairs?: boolean
  liquid?: boolean
  /** One-way drop: an entity may step from this tile down exactly one level onto the lower neighbour it faces. */
  ledge?: boolean
}

export interface PropLight { color: string; intensity: number; radius: number; h: number; nightOnly: boolean }

export interface PropDef {
  key: string
  model: string
  nameZh: string
  footprint: [number, number]
  height: number
  collide: boolean
  door?: [number, number]
  /** Inclusive local-X tile offsets from the primary door; defaults to [0, 0]. */
  doorSpan?: [number, number]
  billboard?: boolean
  light?: PropLight
  minimapIcon?: 'center' | 'shop' | 'gym' | 'lab' | 'house' | 'tower' | 'none'
  interactable?: boolean
  sway?: boolean
}

export interface CharacterSheetDef { id: string; nameZh: string; playable: boolean; desc: string; portrait?: boolean }

export interface AudioTrackDef { id: string; nameZh: string }
export interface AudioFile {
  bgm: AudioTrackDef[]
  sfx: string[]
  battleMusic: { wild: string; trainer: string; gym: string; legend: string; pvp: string }
  nightTrack: string
}

// ---------------------------------------------------------------------------
// Config (content/config.json) — every tunable number lives here.
// ---------------------------------------------------------------------------

export interface GameConfig {
  world: { tile: number; levelHeight: number; chunk: number; seed: number }
  movement: { walkSpeed: number; runSpeed: number; bikeSpeed: number; surfSpeed: number }
  party: { maxParty: number; boxCount: number; boxSize: number; maxLevel: number; maxMoves: number }
  time: { dayRealSeconds: number; startMinutes: number; phases: { id: TimeOfDay; from: number; to: number }[] }
  sprites: { sheetCell: number; sheetFrames: number; sheetWalkFrames: number; sheetIdleFrames: number; idleFps: number; idleSettleMs: number; sheetRows: Record<Dir, number>; creatureSize: number }
  net: {
    tickHz: number; viewRadius: number; protocolVersion: number; chatMaxLen: number
    chatRate: { count: number; perSeconds: number }; localChatRadius: number
    pvpLevelCap: number; pvpTurnSeconds: number; tradeTimeoutSeconds: number; nameMaxLen: number
  }
  battle: {
    stab: number; critMultiplier: number; critChanceByStage: number[]; randomMin: number; randomMax: number
    statStageLimit: number; struggle: { power: number; recoilFraction: number }; confusionSelfHitPower: number
    runBase: number; runAttemptBonus: number; protectChainDecay: number; weatherTurns: number
    trainerExpMultiplier: number; expDivisor: number; shinyRate: number
  }
  catch: {
    shakeChecks: number
    ballBonus: { night: number; quick: number; status: number; lowLevel: number; lowLevelMax: number; rare: number; rareMinRarityOrder: number }
  }
  /** exp(level) = mul * level^3 */
  growth: Record<GrowthRate, { mul: number }>
  encounters: { stageWeight: number[]; nightTypeBoost: Record<TypeId, number>; roamingMax: number; roamingRadius: number }
  economy: { startMoney: number; blackoutMoneyLoss: number; sellRatio: number; startItems: Record<string, number> }
  creature: { ivMax: number; startFriendship: number; secondAbilityChance: number; starterLevel: number; levelUpFriendship: number }
  save: { autosaveSeconds: number; storagePrefix: string; version: number }
  camera: { fov: number; pitchDeg: number; zoomDistances: number[]; followDamping: number; lookAhead: number }
  render: { maxPointLights: number; shadowMapSize: number; internalHeight: Record<Settings['quality'], number> }
  defaultSettings: Settings
  /** One-time overrides applied once to every save that hasn't seen them (e.g. a new default volume). */
  settingsMigrations?: { id: string; set: Partial<Settings> }[]
}

export type TextTable = Record<string, string>

// ---------------------------------------------------------------------------
// Runtime creature instance
// ---------------------------------------------------------------------------

export interface MoveSlot { id: string; pp: number; ppMax: number }

export interface Creature {
  uid: string
  speciesId: string
  nickname?: string
  level: number
  exp: number
  ivs: Stats
  moves: MoveSlot[]
  hp: number
  status: StatusId | null
  statusTurns: number
  abilityId: string
  shiny: boolean
  friendship: number
  ballId: string
  caughtMap: string
  otName: string
  otId: string
  heldItem?: string
}

export interface CreatureView {
  uid: string
  speciesId: string
  nickname?: string
  level: number
  hp: number
  maxHp: number
  status: StatusId | null
  shiny: boolean
}

// ---------------------------------------------------------------------------
// Battle (engine contract — implementation lives in src/shared/battle/)
// ---------------------------------------------------------------------------

export type SideIndex = 0 | 1
export type BattleSideKind = 'player' | 'wild' | 'trainer' | 'remote'

export interface BattleSideInit {
  kind: BattleSideKind
  name: string
  party: Creature[]
  /** Wild only: the creature may flee (from RarityBehavior). */
  flee?: { chancePerTurn: number; afterTurn: number }
  trainerClass?: string
  sprite?: string
  aiLevel?: 0 | 1 | 2 | 3
  items?: Record<string, number>
}

export interface BattleInit {
  seed: number
  sides: [BattleSideInit, BattleSideInit]
  isWild: boolean
  canRun: boolean
  canCatch: boolean
  biome: BiomeId
  timeOfDay: TimeOfDay
  weather?: WeatherId
  expGain: boolean
  levelCap?: number
  rewardMoney?: number
  /** Active world-event multipliers (gameplay/events.ts modifierValue, resolved by the caller); absent = 1.
   * expByParty[i]: exp for player party slot i; catchRate: the wild target's species catch rate;
   * friendship: level-up friendship gain. Prize money is scaled by the caller through rewardMoney. */
  mods?: BattleModifiers
}

export interface BattleModifiers { expByParty?: number[]; catchRate?: number; friendship?: number }

export type BattleAction =
  | { kind: 'move'; moveIndex: number }
  | { kind: 'switch'; partyIndex: number }
  | { kind: 'item'; itemId: string; partyIndex?: number }
  | { kind: 'run' }
  | { kind: 'forfeit' }

export type BattleRequest =
  | { kind: 'action'; canSwitch: boolean; canRun: boolean; canItem: boolean }
  | { kind: 'switch'; forced: true }
  | { kind: 'wait' }

/** 'fled' = a wild creature ran away on its own (BattleSideInit.flee). */
export type BattleResult = 'win' | 'lose' | 'run' | 'caught' | 'draw' | 'forfeit' | 'fled'

export type BattleEvent =
  | { t: 'msg'; text: string }
  | { t: 'turn'; turn: number }
  | { t: 'move'; side: SideIndex; moveId: string; anim: MoveAnim; type: TypeId }
  | { t: 'damage'; side: SideIndex; amount: number; hp: number; maxHp: number; effectiveness: number; crit: boolean }
  | { t: 'heal'; side: SideIndex; amount: number; hp: number; maxHp: number }
  | { t: 'miss'; side: SideIndex }
  | { t: 'status'; side: SideIndex; status: StatusId | null }
  | { t: 'volatile'; side: SideIndex; volatile: VolatileId; on: boolean }
  | { t: 'stat'; side: SideIndex; stat: BattleStatKey; delta: number }
  | { t: 'faint'; side: SideIndex }
  | { t: 'switch'; side: SideIndex; partyIndex: number; creature: CreatureView }
  | { t: 'weather'; weather: WeatherId }
  | { t: 'ability'; side: SideIndex; abilityId: string }
  | { t: 'item'; side: SideIndex; itemId: string }
  | { t: 'catch'; ballId: string; shakes: number; success: boolean }
  | { t: 'exp'; partyIndex: number; amount: number; level: number; exp: number }
  | { t: 'levelUp'; partyIndex: number; level: number }
  | { t: 'learnMove'; partyIndex: number; moveId: string }
  | { t: 'moveLearnable'; partyIndex: number; moveId: string }
  | { t: 'evolveReady'; partyIndex: number; toSpeciesId: string }
  | { t: 'money'; amount: number }
  /** A wild creature with BattleSideInit.flee: 'warn' when its flee window opens, 'fled' right before the 'end' event. */
  | { t: 'flee'; side: SideIndex; stage: 'warn' | 'fled' }
  | { t: 'end'; result: BattleResult; winner: SideIndex | -1 }

// ---------------------------------------------------------------------------
// World / maps (generated deterministically from content/world/** by src/shared/world/)
// ---------------------------------------------------------------------------

export interface PropPlacement { prop: string; x: number; y: number; rot: 0 | 1 | 2 | 3; scale?: number; variant?: number }

export interface Warp { x: number; y: number; toMap: string; toX: number; toY: number; facing: Dir; kind: 'door' | 'stairs' | 'edge' | 'cave' }

/** Data-driven species selector, resolved deterministically when the world is built. */
export interface SpeciesPick {
  types?: TypeId[]
  rarities?: Rarity[]
  stages?: number[]
  families?: string[]
  countries?: string[]
  excludeStarters?: boolean
  /** Distinguishes otherwise-identical picks so they choose different species. */
  salt?: string
}

export interface TrainerPartyEntry { species?: string; pick?: SpeciesPick; level: number; moves?: string[] }

export interface TrainerDef {
  id: string
  nameZh: string
  classZh: string
  sprite: string
  party: TrainerPartyEntry[]
  reward: number
  introText: string[]
  defeatText: string[]
  aiLevel: 0 | 1 | 2 | 3
  badge?: string
  items?: Record<string, number>
  music?: string
  rematchable?: boolean
}

export type NpcRole =
  | 'villager' | 'trainer' | 'nurse' | 'clerk' | 'professor' | 'gymLeader' | 'rival'
  | 'questGiver' | 'boxTerminal' | 'champion' | 'mover' | 'tutor'

/** Data-only cutscene/dialogue script executed by the client ScriptRunner. */
export type ScriptStep =
  | { op: 'say'; text: string; speaker?: string; portrait?: string }
  | { op: 'choice'; text: string; options: string[]; branches: ScriptStep[][] }
  | { op: 'setFlag'; flag: string; value?: boolean | number | string }
  | { op: 'ifFlag'; flag: string; equals?: boolean | number | string; then: ScriptStep[]; else?: ScriptStep[] }
  | { op: 'ifBadges'; atLeast: number; then: ScriptStep[]; else?: ScriptStep[] }
  | { op: 'ifItem'; item: string; atLeast?: number; then: ScriptStep[]; else?: ScriptStep[] }
  | { op: 'ifCaught'; species?: string; type?: TypeId; atLeast?: number; then: ScriptStep[]; else?: ScriptStep[] }
  | { op: 'giveItem'; item: string; qty: number }
  | { op: 'takeItem'; item: string; qty: number }
  | { op: 'giveMoney'; amount: number }
  | { op: 'takeMoney'; amount: number; failText?: string }
  | { op: 'giveCreature'; species?: string; pick?: SpeciesPick; level: number; shiny?: boolean }
  | { op: 'chooseStarter' }
  /** lossContinues: a loss does not black out or abort the script (story-scripted fights); lossFlag records win/loss. */
  | { op: 'battle'; trainer: string; lossContinues?: boolean; lossFlag?: string }
  | { op: 'wildBattle'; species?: string; pick?: SpeciesPick; level: number; music?: string }
  | { op: 'heal' }
  | { op: 'shop'; items: string[] }
  | { op: 'openBox' }
  | { op: 'quest'; quest: string; stage: number; done?: boolean }
  | { op: 'warp'; map: string; x: number; y: number; facing: Dir }
  | { op: 'moveNpc'; npc: string; path: Dir[] }
  | { op: 'faceNpc'; npc: string; dir: Dir }
  | { op: 'hideNpc'; npc: string }
  | { op: 'showNpc'; npc: string }
  | { op: 'sfx'; id: string }
  | { op: 'bgm'; id: string }
  | { op: 'wait'; ms: number }
  | { op: 'fade'; out: boolean }
  | { op: 'unlockTown'; town: string }
  | { op: 'setRespawn' }
  | { op: 'random'; chance: number; then: ScriptStep[]; else?: ScriptStep[] }
  | { op: 'ifTime'; times: TimeOfDay[]; then: ScriptStep[]; else?: ScriptStep[] }
  | { op: 'ifWeather'; weather: FieldWeatherKind[]; then: ScriptStep[]; else?: ScriptStep[] }
  | { op: 'ifDex'; caughtAtLeast: number; then: ScriptStep[]; else?: ScriptStep[] }
  | { op: 'triggerEvent'; event: string }
  | { op: 'revealPlace'; place: string }
  | { op: 'research'; species: string; task: string; amount: number }
  | { op: 'end' }

export interface NpcDef {
  id: string
  x: number; y: number
  facing: Dir
  sprite: string
  nameZh: string
  role: NpcRole
  portrait?: string
  script: ScriptStep[]
  trainer?: string
  sightRange?: number
  wander?: number
  hiddenUnlessFlag?: string
  hiddenIfFlag?: string
}

export interface SignDef { x: number; y: number; text: string; kind: 'sign' | 'board' | 'plaque' }

export interface GroundItemDef { id: string; x: number; y: number; item: string; qty: number; hidden: boolean }

export interface EncounterSlot {
  species: string
  minLevel: number
  maxLevel: number
  weight: number
  time?: TimeOfDay[]
  rare?: boolean
}

export type FieldWeatherKind = 'clear' | 'rain' | 'snow' | 'sand' | 'fog' | 'aurora' | 'ash'

export interface RegionDef {
  id: string
  nameZh: string
  biome: BiomeId
  /** 0 = safe … higher = more dangerous / rarer spawns. */
  danger?: number
  music: string
  encounters: EncounterSlot[]
  encounterRate: number
  roamingDensity: number
  weather?: FieldWeatherKind
  isTown?: boolean
  townId?: string
  flySpawn?: { x: number; y: number }
  levelRange?: [number, number]
}

export interface LightDef { x: number; y: number; h: number; color: string; intensity: number; radius: number; nightOnly: boolean }

export interface GameMap {
  id: string
  nameZh: string
  kind: 'overworld' | 'interior' | 'cave'
  /**
   * Unbounded procedural map. When set, the provider is the source of truth for every tile/object at any
   * integer coordinate (negative included). The finite arrays/lists still hold the core continent
   * (0..width-1 x 0..height-1) for legacy code during migration only — new code MUST use the WorldApi
   * accessors (src/shared/world/worldapi.ts).
   */
  infinite?: ChunkProvider
  width: number
  height: number
  terrain: Uint8Array
  elevation: Uint8Array
  region: Uint8Array
  regions: RegionDef[]
  props: PropPlacement[]
  warps: Warp[]
  npcs: NpcDef[]
  signs: SignDef[]
  items: GroundItemDef[]
  lights: LightDef[]
  spawn: { x: number; y: number; facing: Dir }
  outdoor: boolean
  music: string
  parent?: string
}

export interface TownDef {
  id: string
  nameZh: string
  map: string
  x: number
  y: number
  description: string
  /** 'town' = story town with gym/services; 'hamlet' = procedural village; 'landmark' = notable POI (fly target). */
  kind?: 'town' | 'hamlet' | 'landmark'
  levelRange?: [number, number]
}

export interface QuestDef {
  id: string
  nameZh: string
  kind: 'main' | 'side'
  stages: { text: string; hint?: string; target?: { map: string; x: number; y: number } }[]
  reward?: { money?: number; items?: Record<string, number> }
}

export interface BadgeDef { id: string; nameZh: string; type: TypeId; leader: string; town: string }

// ---------------------------------------------------------------------------
// Infinite overworld: deterministic chunks generated on demand from (seed, cx, cy).
// ---------------------------------------------------------------------------

export interface MapChunk {
  cx: number
  cy: number
  size: number               // tiles per side (CONTENT.config.world.genChunk)
  /** Local arrays, index = ly * size + lx; world tile = (cx * size + lx, cy * size + ly). */
  terrain: Uint8Array
  elevation: Uint8Array
  region: Uint8Array         // index into regionIds
  regionIds: string[]
  /** Objects whose anchor tile lies in this chunk; coordinates are absolute world tiles. */
  props: PropPlacement[]
  npcs: NpcDef[]
  signs: SignDef[]
  items: GroundItemDef[]
  warps: Warp[]
  lights: LightDef[]
  places: TownDef[]          // hamlets / landmarks / dungeon mouths discovered here
}

export interface ChunkProvider {
  readonly seed: number
  readonly size: number
  /** The hand-structured story continent (absolute tile rect). */
  readonly core: { x: number; y: number; width: number; height: number }
  /** Deterministic for any integer coords (negative included); cached. */
  chunk(cx: number, cy: number): MapChunk
  /** Cached chunk or null — never generates. */
  peek(cx: number, cy: number): MapChunk | null
  region(id: string): RegionDef | null
  /** Lazily generated interior/dungeon maps referenced by frontier warps (ids are stable strings). */
  interior(mapId: string): GameMap | null
  place(id: string): TownDef | null
  /** Low-cost terrain/elevation sample without generating objects (minimap / world map far away). */
  sample(x: number, y: number): { terrain: number; elevation: number; biome: BiomeId }
  /** Evict cached chunks farther than radiusTiles from every point. */
  retain(points: { x: number; y: number }[], radiusTiles: number): void
}

// ---------------------------------------------------------------------------
// World events, rarity gameplay, research (all defined in content/events/**, content/research.json)
// ---------------------------------------------------------------------------

export interface EventCondition {
  timeOfDay?: TimeOfDay[]
  hourRange?: [number, number]          // in-game hours [from, to); wraps past midnight when from > to
  dayOfWeek?: number[]                   // real weekday 0..6
  realDate?: { month?: number; day?: number }
  weather?: FieldWeatherKind[]
  biomes?: BiomeId[]
  regionDangerAtLeast?: number
  minDistance?: number                   // tiles from the world origin
  maxDistance?: number
  /** true = flag set (truthy), false = unset/falsy, number/string = strict equality. */
  flags?: Record<string, boolean | number | string>
  badgesAtLeast?: number
  dexCaughtAtLeast?: number
  partyHasType?: TypeId
  partyHasSpecies?: string
  hasItem?: string
  chancePerCheck?: number                // rolled each check interval (0..1)
  // ---- extensions (evaluated by src/shared/gameplay/events.ts evaluateCondition) ----
  /** In-game minute of day [from, to) (0..1440); wraps when from > to. */
  minuteRange?: [number, number]
  /** Real local date windows: from = 'MM-DD' (every year) or 'YYYY-MM-DD' (that year only), lasting `days` days. */
  realDateRanges?: { from: string; days: number }[]
  /** Real local hour [from, to); wraps when from > to. */
  realHourRange?: [number, number]
  regionDangerAtMost?: number
  /** Species of the party lead (first creature able to battle). */
  leadSpecies?: string
  partyHasRarity?: Rarity
  /** Every listed species is in dexCaught / none of them is. */
  caught?: string[]
  notCaught?: string[]
  /** World events that must currently be active / must have fired at least once. */
  eventsActive?: string[]
  eventsDone?: string[]
  /** A place (TownDef id or template prefix such as 'monolith') is within the local radius of the player. */
  nearPlace?: string[]
  outdoor?: boolean
  researchLevelAtLeast?: number
  /** OR-composition: at least one sub-condition must hold (in addition to every other field). */
  anyOf?: EventCondition[]
}

/** Runtime multipliers an active event applies (src/shared/gameplay/events.ts eventModifiers). */
export type EventModifierTarget = 'shopPrice' | 'money' | 'exp' | 'catchRate' | 'shiny' | 'encounterRate' | 'fleeChance' | 'friendship'

export type EventEffect =
  | {
    kind: 'spawn'; pick?: SpeciesPick; species?: string; level: [number, number]; count: number; shinyMultiplier?: number; roaming: boolean; aura?: string
    /** level is an offset [lo, hi] added to the area's level band instead of absolute levels. */
    levelFromArea?: boolean
  }
  | { kind: 'weather'; weather: FieldWeatherKind; minutes: number }
  | { kind: 'npc'; npc: Omit<NpcDef, 'x' | 'y'>; offset?: [number, number] }
  | { kind: 'rumor'; text: string }
  | { kind: 'reveal'; place: string }
  | { kind: 'script'; steps: ScriptStep[] }
  | { kind: 'encounterBoost'; types?: TypeId[]; rarities?: Rarity[]; species?: string[]; multiplier: number; minutes: number }
  | { kind: 'setFlag'; flag: string; value?: boolean | number | string }
  // ---- extensions ----
  /** Multiplies a runtime quantity while the event is active (minutes 0 = whole event). */
  | { kind: 'modifier'; target: EventModifierTarget; multiplier: number; minutes: number; types?: TypeId[]; categories?: ItemCategory[] }
  /** Renderer/HUD ambience cue (lightsOut, eclipse, glitch, fireworks, lanterns, ...) for the event's duration. */
  | { kind: 'ambience'; cue: string; minutes: number }
  /** Pop-up trainer near the anchor. Party levels = area level band max + levelOffset. Text fields are text keys. */
  | {
    kind: 'trainer'; id: string; sprite: string; nameZh: string; classZh: string; aiLevel: 0 | 1 | 2 | 3; reward: number
    party: { species?: string; pick?: SpeciesPick; levelOffset: number }[]; introText: string[]; defeatText: string[]; offset?: [number, number]
    /** Tiles the trainer spots the player from (default content/events/spawn.json scheduler.trainerSightRange). */
    sightRange?: number
  }
  /** Ground items scattered around the anchor (picked up like hidden/visible GroundItemDef). */
  | { kind: 'scatter'; item: string; count: number; radius: number; hidden: boolean }

export interface WorldEventDef {
  id: string
  nameZh: string
  description: string
  /** Hidden events are never announced up front; only rumors/clues hint at them. */
  hidden: boolean
  scope: 'global' | 'region' | 'local'
  when: EventCondition
  effects: EventEffect[]
  durationMinutes: number                // in-game minutes the event stays active
  cooldownDays: number                   // in-game days before it can fire again
  repeatable: boolean
  rumor?: string                         // pre-announcement shown when a clue NPC / news board is read
  // ---- extensions ----
  /** auto = scheduler rolls it; script = only ScriptStep triggerEvent; legend = roaming legend proximity (spawns.ts). */
  trigger?: 'auto' | 'script' | 'legend'
  /** Higher first when several events are eligible in one check. */
  priority?: number
  /** Mutually exclusive group: at most one active event per group (e.g. 'weather'). */
  group?: string
  /** When the rumor may be told (defaults to the event's progress gates). */
  rumorWhen?: EventCondition
  /** Category tag for UI filtering: festival / culture / weather / hidden / stele / chain / legend / easter. */
  tag?: string
  /** Mythic chain id this event belongs to (content/events/mythic.json). */
  chain?: string
  /** Roaming UR legend species this encounter event belongs to (generated from content/events/legends.json). */
  legend?: string
}

export type ResearchTaskKind =
  | 'see' | 'catch' | 'defeat' | 'evolve' | 'catchShiny' | 'catchAtTime' | 'catchInWeather' | 'useMoveType' | 'befriend' | 'trade'
  | 'seeAtTime' | 'seeInWeather' | 'catchInBiome' | 'defeatRoaming' | 'chainStep'

export interface ResearchTaskDef {
  id: string
  nameZh: string
  kind: ResearchTaskKind
  /** Matches the event param: exact id, 'own' = one of the species' types, '*' = any non-default value. */
  param?: string                         // e.g. time of day, weather, move type
  thresholds: number[]                   // progress steps
  points: number                         // research points per threshold
}

export interface ResearchFile {
  tasks: ResearchTaskDef[]
  /** Task ids that apply to each rarity tier. */
  byRarity: Record<Rarity, string[]>
  /** Points needed per research level (index = level-1) and rewards per level. */
  levels: { points: number; reward?: { money?: number; items?: Record<string, number> } }[]
  // ---- extensions ----
  /** Per-rarity multiplier on task points. */
  rarityPointMul?: Record<Rarity, number>
  /** Species points at which a species entry counts as complete, per rarity. */
  completePoints?: Record<Rarity, number>
  /** Shiny odds multiplier for species whose research is complete. */
  shinyMultiplierOnComplete?: number
  /** Event params that never satisfy a '*' task param (e.g. 'clear' weather). */
  wildcardIgnore?: string[]
}

/** SaveData.events[eventId]. lastDay = in-game day (clockMinutes / 1440) it last started. */
export interface EventState {
  lastDay: number
  count: number
  /** Absolute in-game minute the active run ends (absent = not active). */
  activeUntil?: number
  startedAt?: number
  /** Where a local/region event started (overworld tile + region id). */
  anchor?: { map: string; x: number; y: number; region?: string }
}

/** SaveData.legends[speciesId]: roaming UR legend progress (src/shared/gameplay/spawns.ts). */
export interface LegendState {
  /** Relocations so far (each flee / escape moves it elsewhere). */
  hops: number
  /** Remaining hp carried between encounters (absent = full). */
  hp?: number
  /** In-game minute until which it stays hidden after fleeing. */
  restUntil?: number
  /** In-game day it was defeated (rests until the next rotation epoch). */
  defeatedDay?: number
  caught?: boolean
  seen?: number
}

export interface World {
  seed: number
  maps: Record<string, GameMap>
  trainers: Record<string, TrainerDef>
  towns: TownDef[]
  quests: QuestDef[]
  badges: BadgeDef[]
  startMap: string
}

// ---------------------------------------------------------------------------
// Save data
// ---------------------------------------------------------------------------

export interface Settings {
  bgmVolume: number
  sfxVolume: number
  quality: 'low' | 'medium' | 'high' | 'ultra'
  pixelScale: number
  dof: boolean
  bloom: boolean
  shadows: boolean
  textSpeed: 'slow' | 'normal' | 'fast' | 'instant'
  showMinimap: boolean
  showNames: boolean
  /** Objective tracker in the HUD / one-time contextual tips (content/tutorial.json). */
  showObjective: boolean
  showTips: boolean
  autoRun: boolean
  touchControls: 'auto' | 'on' | 'off'
  /** Ids of one-time settings migrations (config.settingsMigrations) already applied to this save. */
  migrations?: string[]
}

export interface SaveData {
  version: number
  playerId: string
  name: string
  avatar: string
  createdAt: number
  playTimeSec: number
  money: number
  badges: string[]
  party: Creature[]
  boxes: Creature[][]
  bag: Record<string, number>
  dexSeen: string[]
  dexCaught: string[]
  position: { map: string; x: number; y: number; facing: Dir }
  respawn: { map: string; x: number; y: number; facing: Dir }
  flags: Record<string, boolean | number | string>
  quests: Record<string, { stage: number; done: boolean }>
  trackedQuest?: string
  visitedTowns: string[]
  exploredChunks: Record<string, string>
  repelSteps: number
  clockMinutes: number
  stats: { battlesWon: number; caught: number; steps: number; pvpWins: number; pvpLosses: number; trades: number; shiniesFound: number }
  settings: Settings
  /** Frontier places (hamlets/landmarks/dungeons) discovered in the infinite world, by place id. */
  discoveredPlaces?: string[]
  /** World event state by event id. */
  events?: Record<string, EventState>
  /** Roaming UR legends by species id. */
  legends?: Record<string, LegendState>
  /** Research progress: speciesId -> taskId -> progress count. */
  research?: Record<string, Record<string, number>>
  /** Farthest distance from the origin ever reached (tiles) — drives frontier milestones. */
  maxDistance?: number
  /** Explored overworld cells for the world-map fog of war (compact encoding owned by the client save code). */
  explored?: string
}
