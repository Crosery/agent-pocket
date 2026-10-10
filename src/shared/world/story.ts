// Story & population layer: applies content/world/story/** to a built World — NPCs on named anchors, trainers
// (species picks resolved to ids), one rival variant per starter, per-town services, quests and data scripts,
// then populates the procedural spots (hamlets, POIs, dungeons, wilds): legend chains and bounty quests first
// (story-procgen.ts), then archetype pools by anchor-name rules. Every NPC goes through one placement path
// (occupancy, spacing, no path sealing), so the systems never share an anchor.
// Every name, line, level, reward and flag lives in the JSON; this module only resolves and validates.
//
// Authoring macros (story JSON only; expanded here so the client sees plain ScriptSteps):
//   {op:'include', script, params?}        inline a reusable script from scripts.json with extra {params}
//   {op:'rivalBattle', battle}             ifFlag(<starter flag> === s) -> battle <rival variant for s>, per starter
//   {op:'badgeTiers', tiers:[{atLeast, then}]}  nested ifBadges, highest tier first
//   {op:'tieredShop', town}                badgeTiers of shop ops built from services.json shop tiers (+ town extras)
//   {op:'warpTo', anchor, facing}          warp to the anchor's resolved coordinates
// Strings accept {param} template params and {fn:arg} lookups (type, weakTo, resists, strongVs, item, badge, town,
// trainer) so text stays in sync with the content tables.
import type {
  Dir, GameMap, NpcDef, NpcRole, QuestDef, ScriptStep, SpeciesDef, SpeciesPick, TrainerDef, TrainerPartyEntry, World,
} from '../types.ts'
import { CONTENT, terrainId, typeEffectiveness } from '../content/index.ts'
import { EXCHANGE } from '../gameplay/exchange.ts'
import { worldAnchors, worldBuildInfo } from './index.ts'
import { WORLD_CONTENT } from './data.ts'
import { COLLISION_FREE, COLLISION_WATER, DIR_DX, DIR_DY, DIRS, buildCollision, canStep, inBounds } from './collision.ts'
import { seedFor } from './random.ts'
import { levelForm, resolvePickAvoiding, type PickRules, type StoryPick } from './pick.ts'
import {
  HintIndex, SpotIndex, placeBounties, placeLegends,
  type BountiesFile, type HintConfig, type LegendsFile, type PartyOpts, type PlacedBounty, type PlacedLegend, type PopHost, type SpotInfo,
} from './story-procgen.ts'

import storyJson from '../../../content/world/story/story.json' with { type: 'json' }
import scriptsJson from '../../../content/world/story/scripts.json' with { type: 'json' }
import servicesJson from '../../../content/world/story/services.json' with { type: 'json' }
import rivalJson from '../../../content/world/story/rival.json' with { type: 'json' }
import questsJson from '../../../content/world/story/quests.json' with { type: 'json' }
import npcsTownsJson from '../../../content/world/story/npcs/towns.json' with { type: 'json' }
import npcsStoryJson from '../../../content/world/story/npcs/story.json' with { type: 'json' }
import npcsQuestsJson from '../../../content/world/story/npcs/quests.json' with { type: 'json' }
import npcsTutorialJson from '../../../content/world/story/npcs/tutorial.json' with { type: 'json' }
import npcsBranchesJson from '../../../content/world/story/npcs/branches.json' with { type: 'json' }
import npcsHiddenJson from '../../../content/world/story/npcs/hidden.json' with { type: 'json' }
import trainersRoutesJson from '../../../content/world/story/trainers/routes.json' with { type: 'json' }
import trainersGymsJson from '../../../content/world/story/trainers/gyms.json' with { type: 'json' }
import trainersStoryJson from '../../../content/world/story/trainers/story.json' with { type: 'json' }
import trainersTutorialJson from '../../../content/world/story/trainers/tutorial.json' with { type: 'json' }
import trainersBranchesJson from '../../../content/world/story/trainers/branches.json' with { type: 'json' }
import trainersHiddenJson from '../../../content/world/story/trainers/hidden.json' with { type: 'json' }
import populationJson from '../../../content/world/story/population.json' with { type: 'json' }
import legendsJson from '../../../content/world/story/legends.json' with { type: 'json' }
import bountiesJson from '../../../content/world/story/bounties.json' with { type: 'json' }

// ---------------------------------------------------------------------------
// Story JSON shapes
// ---------------------------------------------------------------------------

/** A ScriptStep or authoring macro as written in JSON (validated after expansion). */
export type StepSpec = { op: string; [k: string]: unknown }

export type FacingSpec = Dir | 'auto'

export interface PlacementSpec {
  /** Anchor name from worldAnchors(world). */
  at: string
  offset?: [number, number]
  /** 'auto' (default) faces the longest clear line of sight, preferring route paths. */
  facing?: FacingSpec
}

export interface NpcSpec extends PlacementSpec {
  id: string
  sprite: string
  nameZh: string
  role: NpcRole
  portrait?: string
  /** Shorthand: one `say` per line (spoken by this NPC) before `script`. */
  lines?: string[]
  script?: StepSpec[]
  trainer?: string
  sightRange?: number
  wander?: number
  hiddenUnlessFlag?: string
  hiddenIfFlag?: string
}

export interface PartySpec {
  species?: string
  /** SpeciesPick plus authoring-only `habitats` (pick.ts). */
  pick?: StoryPick
  /** Rival only: the rival's starter at its level-appropriate evolution stage. */
  rivalStarter?: boolean
  level: number
  moves?: string[]
}

export interface TrainerDefaults {
  aiLevel?: 0 | 1 | 2 | 3
  rewardPerLevel?: number
  sightRange?: number
  music?: string
  role?: NpcRole
  items?: Record<string, number>
  rematchable?: boolean
}

export interface TrainerSpec extends Partial<PlacementSpec> {
  id: string
  nameZh: string
  classZh: string
  sprite: string
  party: PartySpec[]
  reward?: number
  introText: string[]
  defeatText: string[]
  /** Line spoken when talked to after being defeated (default trainer script). */
  after?: string
  aiLevel?: 0 | 1 | 2 | 3
  badge?: string
  items?: Record<string, number>
  music?: string
  rematchable?: boolean
  // NPC placement (an NPC is generated when `at` is set)
  role?: NpcRole
  portrait?: string
  sightRange?: number
  wander?: number
  lines?: string[]
  script?: StepSpec[]
  hiddenUnlessFlag?: string
  hiddenIfFlag?: string
}

export interface TrainerGroup { defaults?: TrainerDefaults; trainers: TrainerSpec[] }

export type RivalBattleSpec = Omit<TrainerSpec, 'id' | 'nameZh' | 'classZh' | 'sprite' | keyof PlacementSpec> & { key: string }

export interface RivalFile {
  /** Trainer id per battle and player starter, with {battle} and {starter} params. */
  idPattern: string
  nameZh: string
  classZh: string
  sprite: string
  portrait?: string
  defaults?: TrainerDefaults
  battles: RivalBattleSpec[]
}

export interface ServicesFile {
  /** Instantiated for every town; {town} = town id, {townName} = town name. */
  npcs: NpcSpec[]
  shop: { tiers: { atLeast: number; items: string[] }[]; extra: Record<string, string[]> }
}

export interface QuestSpec {
  id: string
  nameZh: string
  kind: 'main' | 'side'
  stages: { text: string; hint?: string; target?: string }[]
  reward?: { money?: number; items?: Record<string, number> }
}

export interface StoryMeta {
  pick: PickRules
  flags: { starter: string; trainerWon: string; groundItem: string }
  facing: { lookDistance: number }
  text: { listSeparator: string; trainerNpcName: string }
  trainers: Required<Pick<TrainerDefaults, 'aiLevel' | 'rewardPerLevel' | 'sightRange'>>
  trainerNpc: { role: NpcRole; script: StepSpec[] }
}

/**
 * Populates every anchor whose name matches `anchors` (a regular expression; named groups become text params).
 * 'services' instantiates services.json for the town id in the `town` group; 'npc' / 'trainer' draw an archetype
 * from a pool, filtered by the biome of the spot's region (trainer levels come from the region's levelRange).
 */
export interface PopulationRule {
  id: string
  kind: 'npc' | 'trainer' | 'services'
  anchors: string
  /** Fraction (0..1) of matching spots that get someone, chosen by a stable per-seed hash. Default 1. */
  share?: number
  pool?: string
  /** Params: {rule}, {slug} (anchor name made id-safe) and the regex groups. Default "{rule}-{slug}". */
  idPattern?: string
  /** Leave maps that already have an NPC alone (e.g. houses with authored residents). */
  skipIfMapHasNpc?: boolean
  role?: NpcRole
  facing?: FacingSpec
  wander?: number
  sightRange?: [number, number]
  party?: [number, number]
  levelBonus?: number
  /** Party rarities come from the rarity band this many steps above the level's band (stronger picks). */
  rarityShift?: number
  /** Party picks prefer species whose habitats include the spot's biome. */
  habitat?: boolean
  /** Only spots whose region starts at or above / at or below this level. */
  minLevel?: number
  maxLevel?: number
  aiLevel?: 0 | 1 | 2 | 3
  rewardPerLevel?: number
  music?: string
  /** Extra text params; one value is chosen per spot (archetype params override). */
  params?: Record<string, string[]>
  /** One param set per spot, among those whose `minLevel` the spot's region reaches (e.g. tutor offers). */
  paramSets?: { minLevel?: number; params: Record<string, string> }[]
  /** Script for every NPC of this rule (an archetype script wins); trainers default to trainerNpc.script. */
  script?: StepSpec[]
}

export interface NpcArchetype {
  sprite: string
  names: string[]
  role?: NpcRole
  /** Only used where the spot's region biome is listed; omitted = anywhere. */
  biomes?: string[]
  /** One list of lines is chosen per NPC. */
  dialogues: string[][]
  params?: Record<string, string[]>
  script?: StepSpec[]
}

export interface TrainerArchetype {
  classZh: string
  sprite: string
  names: string[]
  biomes?: string[]
  /** Party members cycle through these types (one per member, starting at a hashed offset). */
  types: string[]
  introText: string[][]
  defeatText: string[][]
  after: string[]
  params?: Record<string, string[]>
  script?: StepSpec[]
}

export interface PopulationFile {
  /** Minimum Chebyshev distance between a populated spot and any other NPC. */
  spacing: number
  /** Window radius of the local "does this tile cut a path" check. */
  sealRadius: number
  /** Largest empty dead end (tiles) a populated NPC may seal off. */
  pocketMax: number
  /** Rarities a party member of up to `maxLevel` is picked from (first band that fits). */
  rarityBands: { maxLevel: number; rarities: string[] }[]
  /** Trainer reward multiplier per danger tier of the spot's region (index = tier, last one repeats). */
  dangerReward: number[]
  /** Nearest-feature text params available to every populated / generated NPC (story-procgen.ts). */
  hints: HintConfig
  rules: PopulationRule[]
  npcPools: Record<string, NpcArchetype[]>
  trainerPools: Record<string, TrainerArchetype[]>
}

export interface StoryContent {
  meta: StoryMeta
  scripts: Record<string, StepSpec[]>
  services: ServicesFile
  rival: RivalFile
  quests: QuestSpec[]
  npcGroups: Record<string, NpcSpec[]>
  trainerGroups: Record<string, TrainerGroup>
  population: PopulationFile
  legends: LegendsFile
  bounties: BountiesFile
}

function mergeGroups<T>(label: string, files: Record<string, T>[], problems: string[]): Record<string, T> {
  const out: Record<string, T> = {}
  for (const f of files) {
    for (const [k, v] of Object.entries(f)) {
      if (k in out) problems.push(`${label}: duplicate group "${k}"`)
      out[k] = v
    }
  }
  return out
}

const LOAD_PROBLEMS: string[] = []

export const STORY_CONTENT: StoryContent = {
  meta: storyJson as unknown as StoryMeta,
  scripts: scriptsJson as unknown as Record<string, StepSpec[]>,
  services: servicesJson as unknown as ServicesFile,
  rival: rivalJson as unknown as RivalFile,
  quests: questsJson as unknown as QuestSpec[],
  npcGroups: mergeGroups('npcs', [npcsTownsJson, npcsStoryJson, npcsQuestsJson, npcsTutorialJson, npcsBranchesJson, npcsHiddenJson] as unknown as Record<string, NpcSpec[]>[], LOAD_PROBLEMS),
  trainerGroups: mergeGroups('trainers', [trainersRoutesJson, trainersGymsJson, trainersStoryJson, trainersTutorialJson, trainersBranchesJson, trainersHiddenJson] as unknown as Record<string, TrainerGroup>[], LOAD_PROBLEMS),
  population: populationJson as unknown as PopulationFile,
  legends: legendsJson as unknown as LegendsFile,
  bounties: bountiesJson as unknown as BountiesFile,
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/** Starter species (starter: true), in dex order. */
export function starterSpecies(c = CONTENT): SpeciesDef[] {
  return c.speciesList.filter((s) => s.starter)
}

/**
 * The starter the rival picks against the player's: best type advantage over it, then best resistance to it,
 * then dex order. Falls back to the player's own starter when it is the only one.
 */
export function rivalStarterFor(playerStarter: string, c = CONTENT): SpeciesDef | null {
  const all = starterSpecies(c)
  const p = c.species[playerStarter]
  if (!p) return null
  const others = all.filter((s) => s.id !== p.id)
  if (!others.length) return p
  const offense = (a: SpeciesDef, d: SpeciesDef) => Math.max(...a.types.map((t) => typeEffectiveness(t, d.types, c)))
  let best = others[0]
  for (const s of others.slice(1)) {
    const ds = offense(s, p) - offense(best, p)
    const dr = offense(best, p) === offense(s, p) ? offense(p, best) - offense(p, s) : 0
    if (ds > 0 || (ds === 0 && dr > 0)) best = s
  }
  return best
}

export function rivalTrainerId(battle: string, starter: string, rival: RivalFile = STORY_CONTENT.rival): string {
  return fill(rival.idPattern, { battle, starter })
}

/** Visits every step (depth-first, including then/else/branches). */
export function walkSteps(steps: readonly ScriptStep[], fn: (s: ScriptStep, path: string) => void, path = ''): void {
  steps.forEach((s, i) => {
    const p = `${path}${i}`
    fn(s, p)
    if (s.op === 'ifFlag' || s.op === 'ifBadges' || s.op === 'ifItem' || s.op === 'ifCaught') {
      if (Array.isArray(s.then)) walkSteps(s.then, fn, `${p}.then.`)
      if (Array.isArray(s.else)) walkSteps(s.else, fn, `${p}.else.`)
    } else if (s.op === 'choice' && Array.isArray(s.branches)) {
      s.branches.forEach((b, j) => { if (Array.isArray(b)) walkSteps(b, fn, `${p}.b${j}.`) })
    }
  })
}

const PROBLEMS = new WeakMap<World, string[]>()

/** Problems found while applying the story (unknown anchors, blocked tiles, bad references…). Empty = consistent. */
export function storyProblems(world: World): string[] {
  return PROBLEMS.get(world) ?? []
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

const FILL_PASSES = 4

/** Substitutes {param}s; param values may themselves contain {param}s (resolved up to FILL_PASSES deep). */
function fill(s: string, params: Record<string, string>): string {
  let out = s
  for (let i = 0; i < FILL_PASSES; i++) {
    const next = out.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? params[k] : m))
    if (next === out) break
    out = next
  }
  return out
}

/** Anchor name -> id-safe slug ("wild:wild-meadow-1:3" -> "wild-wild-meadow-1-3"). */
function slugOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

interface PendingNpc {
  spec: NpcSpec
  params: Record<string, string>
  /** Script before param substitution / macro expansion. */
  script: StepSpec[]
  source: string
}

interface Env { params: Record<string, string>; npc: PendingNpc; path: string; depth: number }

const MAX_INCLUDE_DEPTH = 8
const NUMERIC_STEP_FIELDS = ['level', 'qty', 'amount', 'atLeast', 'stage', 'ms'] as const
const AUTO_FACING_ORDER: readonly Dir[] = ['down', 'left', 'right', 'up']

class StoryBuilder implements PopHost {
  readonly problems: string[] = [...LOAD_PROBLEMS]
  readonly anchors: Record<string, { map: string; x: number; y: number }>
  readonly pending: PendingNpc[] = []
  /** scripts.json plus scripts generated while populating (include targets). */
  private readonly scripts: Record<string, StepSpec[]>
  readonly spots: SpotIndex
  readonly hints: HintIndex
  legends: PlacedLegend[] = []
  bounties: PlacedBounty[] = []
  private readonly collision = new Map<string, Uint8Array>()
  private readonly preferTerrain: Set<number>
  private readonly starters: SpeciesDef[]
  private readonly rivalBattles: Set<string>
  private readonly rules: { rule: PopulationRule; re: RegExp | null }[]
  /** Sorted anchor names (stable iteration for population). */
  readonly anchorNames: string[]
  private readonly occupied = new Map<string, string>()
  private readonly npcIds = new Set<string>()
  /** Tile indices of every placed NPC, per map. */
  private readonly npcTiles = new Map<string, number[]>()
  /** Dead-end tiles sealed off by populated NPCs, per map (never used for another spot). */
  private readonly sealed = new Map<string, Set<number>>()
  private arrivals: Set<string> | null = null
  private placedCount = 0
  readonly world: World
  readonly sc: StoryContent

  constructor(world: World, sc: StoryContent) {
    this.world = world
    this.sc = sc
    this.anchors = worldAnchors(world)
    this.anchorNames = Object.keys(this.anchors).sort()
    this.scripts = { ...sc.scripts }
    const info = worldBuildInfo(world)
    const features = info.features
    this.spots = new SpotIndex(world, this.anchors, features, info.walkReach)
    this.hints = new HintIndex(sc.population.hints, world, features)
    this.starters = starterSpecies()
    this.rivalBattles = new Set(sc.rival.battles.map((b) => b.key))
    this.preferTerrain = new Set<number>()
    for (const r of WORLD_CONTENT.routes) {
      try { this.preferTerrain.add(terrainId(r.terrain)) } catch { this.problems.push(`route ${r.id}: unknown terrain "${r.terrain}"`) }
    }
    this.rules = sc.population.rules.map((rule) => {
      try { return { rule, re: new RegExp(rule.anchors) } } catch {
        this.problems.push(`population ${rule.id}: bad anchors pattern "${rule.anchors}"`)
        return { rule, re: null }
      }
    })
  }

  // -- text -----------------------------------------------------------------

  text(s: string, params: Record<string, string>, where: string): string {
    const sep = this.sc.meta.text.listSeparator
    const typeNames = (pred: (atk: string) => boolean) => CONTENT.types.filter((t) => pred(t.id)).map((t) => t.nameZh).join(sep)
    return fill(s, params).replace(/\{(\w+):([\w-]+)\}/g, (m, fn: string, arg: string) => {
      let v: string | undefined
      switch (fn) {
        case 'type': v = CONTENT.typeById[arg]?.nameZh; break
        case 'weakTo': if (CONTENT.typeById[arg]) v = typeNames((a) => typeEffectiveness(a, [arg]) > 1); break
        case 'resists': if (CONTENT.typeById[arg]) v = typeNames((a) => typeEffectiveness(a, [arg]) < 1); break
        case 'strongVs': if (CONTENT.typeById[arg]) v = typeNames((d) => typeEffectiveness(arg, [d]) > 1); break
        case 'item': v = CONTENT.items[arg]?.nameZh; break
        case 'badge': v = this.world.badges.find((b) => b.id === arg)?.nameZh; break
        case 'town': v = this.world.towns.find((t) => t.id === arg)?.nameZh; break
        case 'trainer': v = this.world.trainers[arg]?.nameZh; break
      }
      if (v === undefined) { this.problems.push(`${where}: unresolved text lookup ${m}`); return m }
      return v
    })
  }

  /** Substitutes params / lookups in every string of a value (step arrays excluded — they are expanded separately). */
  private subst(v: unknown, params: Record<string, string>, where: string, skip?: ReadonlySet<string>): unknown {
    if (typeof v === 'string') return this.text(v, params, where)
    if (Array.isArray(v)) return v.map((x) => this.subst(x, params, where))
    if (isObj(v)) {
      const out: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(v)) out[k] = skip?.has(k) ? x : this.subst(x, params, where)
      return out
    }
    return v
  }

  // -- trainers -------------------------------------------------------------

  /** `params` fill {param}s in the trainer's texts and reach its NPC script (with {id} {after} {name}). */
  addTrainer(spec: TrainerSpec, d: TrainerDefaults, source: string, rivalStarter?: SpeciesDef, params: Record<string, string> = {}): void {
    const g = this.sc.meta.trainers
    const id = spec.id
    if (this.world.trainers[id]) { this.problems.push(`${source}: duplicate trainer id "${id}"`); return }
    const where = `trainer ${id}`
    const used = new Set<string>()
    const party: TrainerPartyEntry[] = spec.party.map((p, i) => {
      let species: string
      if (p.rivalStarter && rivalStarter) species = levelForm(rivalStarter, p.level).id
      else if (p.species && CONTENT.species[p.species]) species = p.species
      else {
        if (p.species) this.problems.push(`${where}: unknown species "${p.species}"`)
        if (p.rivalStarter) this.problems.push(`${where}: rivalStarter outside a rival battle`)
        species = resolvePickAvoiding(p.pick ?? {}, p.level, `${this.world.seed}:${id}:${i}`, used)
      }
      used.add(species)
      return p.moves ? { species, level: p.level, moves: p.moves.slice() } : { species, level: p.level }
    })
    const maxLevel = party.reduce((m, p) => Math.max(m, p.level), 0)
    const t: TrainerDef = {
      id,
      nameZh: this.text(spec.nameZh, params, where),
      classZh: this.text(spec.classZh, params, where),
      sprite: spec.sprite,
      party,
      reward: spec.reward ?? Math.round((d.rewardPerLevel ?? g.rewardPerLevel) * maxLevel),
      introText: spec.introText.map((s) => this.text(s, params, where)),
      defeatText: spec.defeatText.map((s) => this.text(s, params, where)),
      aiLevel: spec.aiLevel ?? d.aiLevel ?? g.aiLevel,
    }
    const badge = spec.badge
    if (badge) t.badge = badge
    const items = spec.items ?? d.items
    if (items) t.items = { ...items }
    const music = spec.music ?? d.music
    if (music) t.music = music
    const rematch = spec.rematchable ?? d.rematchable
    if (rematch !== undefined) t.rematchable = rematch
    this.world.trainers[id] = t

    if (!spec.at) return
    const npcName = fill(this.sc.meta.text.trainerNpcName, { class: t.classZh, name: t.nameZh })
    const npc: NpcSpec = {
      id, at: spec.at, sprite: spec.sprite, nameZh: npcName, role: spec.role ?? d.role ?? this.sc.meta.trainerNpc.role,
      trainer: id, sightRange: spec.sightRange ?? d.sightRange ?? g.sightRange,
    }
    if (spec.offset) npc.offset = spec.offset
    if (spec.facing) npc.facing = spec.facing
    if (spec.portrait) npc.portrait = spec.portrait
    if (spec.wander !== undefined) npc.wander = spec.wander
    if (spec.hiddenIfFlag) npc.hiddenIfFlag = spec.hiddenIfFlag
    if (spec.hiddenUnlessFlag) npc.hiddenUnlessFlag = spec.hiddenUnlessFlag
    if (npc.sightRange === 0) delete npc.sightRange
    const after = spec.after !== undefined ? this.text(spec.after, params, where) : t.defeatText[t.defeatText.length - 1] ?? ''
    const say = (spec.lines ?? []).map((text): StepSpec => ({ op: 'say', text }))
    this.pending.push({
      spec: npc, params: { ...params, id, after, name: t.nameZh },
      script: [...say, ...(spec.script ?? this.sc.meta.trainerNpc.script)], source,
    })
  }

  addRivals(): void {
    const r = this.sc.rival
    for (const p of this.starters) {
      const rs = rivalStarterFor(p.id)
      if (!rs) continue
      for (const b of r.battles) {
        const { key, ...rest } = b
        const spec: TrainerSpec = { ...rest, id: rivalTrainerId(key, p.id, r), nameZh: r.nameZh, classZh: r.classZh, sprite: r.sprite }
        if (r.portrait) spec.portrait = r.portrait
        this.addTrainer(spec, r.defaults ?? {}, `rival ${key}`, rs)
      }
    }
  }

  // -- quests ---------------------------------------------------------------

  addQuests(): void {
    for (const q of this.sc.quests) this.addQuest(q, {}, 'quests')
  }

  /** Adds a QuestDef; stage targets are anchor names, texts take `params` and lookups. */
  addQuest(q: QuestSpec, params: Record<string, string>, source: string): void {
    const where = `${source} quest ${q.id}`
    if (this.world.quests.some((x) => x.id === q.id)) { this.problems.push(`${where}: duplicate id`); return }
    const def: QuestDef = {
      id: q.id, nameZh: this.text(q.nameZh, params, where), kind: q.kind,
      stages: q.stages.map((s, i) => {
        const st: QuestDef['stages'][number] = { text: this.text(s.text, params, where) }
        if (s.hint) st.hint = this.text(s.hint, params, where)
        if (s.target) {
          const a = this.anchors[fill(s.target, params)]
          if (a) st.target = { map: a.map, x: a.x, y: a.y }
          else this.problems.push(`${where} stage ${i}: unknown target anchor "${s.target}"`)
        }
        return st
      }),
    }
    if (q.reward) def.reward = { ...q.reward, ...(q.reward.items ? { items: { ...q.reward.items } } : {}) }
    this.world.quests.push(def)
  }

  /** Makes generated steps includable as `{op:'include', script: id}`. */
  registerScript(id: string, steps: StepSpec[]): void {
    if (this.scripts[id]) { this.problems.push(`script "${id}" registered twice`); return }
    this.scripts[id] = steps
  }

  // -- NPCs -----------------------------------------------------------------

  addNpc(spec: NpcSpec, params: Record<string, string>, source: string): void {
    const s = this.subst(spec, params, `${source} npc ${spec.id}`, new Set(['script'])) as NpcSpec
    const say = (s.lines ?? []).map((text): StepSpec => ({ op: 'say', text }))
    this.pending.push({ spec: s, params, script: [...say, ...(spec.script ?? [])], source })
  }

  /** Services for every story town plus every town id matched by a 'services' population rule (e.g. hamlets). */
  addServices(): void {
    const ids = this.world.towns.filter((t) => (t.kind ?? 'town') === 'town').map((t) => t.id)
    for (const { rule, re } of this.rules) {
      if (rule.kind !== 'services' || !re) continue
      for (const name of this.anchorNames) {
        const m = re.exec(name)
        if (!m) continue
        const town = m.groups?.town
        if (town === undefined) { this.problems.push(`population ${rule.id}: services pattern needs a (?<town>…) group`); break }
        if (!this.world.towns.some((t) => t.id === town)) this.problems.push(`population ${rule.id}: unknown town "${town}" from ${name}`)
        else if (!ids.includes(town)) ids.push(town)
      }
    }
    for (const id of ids) {
      const town = this.world.towns.find((t) => t.id === id)!
      const params = { town: town.id, townName: town.nameZh }
      for (const spec of this.sc.services.npcs) this.addNpc(spec, params, `services(${town.id})`)
    }
  }

  // -- scripts --------------------------------------------------------------

  expand(steps: unknown, env: Env): ScriptStep[] {
    if (!Array.isArray(steps)) { this.problems.push(`${env.path}: expected a step list`); return [] }
    const out: ScriptStep[] = []
    steps.forEach((raw, i) => {
      const path = `${env.path}.${i}`
      if (!isObj(raw) || typeof raw.op !== 'string') { this.problems.push(`${path}: step must be an object with "op"`); return }
      const s = this.subst(raw, env.params, path, new Set(['then', 'else', 'branches', 'tiers'])) as StepSpec
      switch (s.op) {
        case 'include': {
          const id = String(s.script)
          const body = this.scripts[id]
          if (!body) { this.problems.push(`${path}: unknown script "${id}"`); return }
          if (env.depth >= MAX_INCLUDE_DEPTH) { this.problems.push(`${path}: include depth exceeded at "${id}"`); return }
          const extra = isObj(s.params) ? Object.fromEntries(Object.entries(s.params).map(([k, v]) => [k, String(v)])) : {}
          out.push(...this.expand(body, { ...env, params: { ...env.params, ...extra }, path: `${path}<${id}>`, depth: env.depth + 1 }))
          return
        }
        case 'rivalBattle': {
          const key = String(s.battle)
          if (!this.rivalBattles.has(key)) { this.problems.push(`${path}: unknown rival battle "${key}"`); return }
          let chain: ScriptStep[] = []
          for (let k = this.starters.length - 1; k >= 0; k--) {
            const st = this.starters[k].id
            const step: ScriptStep = { op: 'ifFlag', flag: this.sc.meta.flags.starter, equals: st, then: [{ op: 'battle', trainer: rivalTrainerId(key, st, this.sc.rival), ...(s.lossContinues ? { lossContinues: true } : {}), ...(typeof s.lossFlag === 'string' ? { lossFlag: s.lossFlag } : {}) }] }
            if (chain.length) step.else = chain
            chain = [step]
          }
          out.push(...chain)
          return
        }
        case 'badgeTiers': {
          const tiers = Array.isArray(s.tiers) ? s.tiers.filter(isObj) : []
          out.push(...this.tierChain(tiers.map((t, j) => ({ atLeast: Number(t.atLeast), steps: this.expand(t.then, { ...env, path: `${path}.tier${j}` }) }))))
          return
        }
        case 'tieredShop': {
          const town = String(s.town)
          const extra = this.sc.services.shop.extra[town] ?? []
          const acc: string[] = []
          const tiers = this.sc.services.shop.tiers.map((t) => {
            for (const it of t.items) if (!acc.includes(it)) acc.push(it)
            const items = [...acc, ...extra.filter((x) => !acc.includes(x))]
            return { atLeast: t.atLeast, steps: [{ op: 'shop', items } as ScriptStep] }
          })
          out.push(...this.tierChain(tiers))
          return
        }
        case 'warpTo': {
          const a = this.anchors[String(s.anchor)]
          if (!a) { this.problems.push(`${path}: unknown warp anchor "${String(s.anchor)}"`); return }
          out.push({ op: 'warp', map: a.map, x: a.x, y: a.y, facing: s.facing as Dir })
          return
        }
      }
      const step = { ...s } as Record<string, unknown>
      // Template params are strings; numeric step fields written as "{param}" become numbers again.
      for (const k of NUMERIC_STEP_FIELDS) {
        const v = step[k]
        if (typeof v === 'string' && /^-?\d+$/.test(v)) step[k] = Number(v)
      }
      if ('then' in raw) step.then = this.expand(raw.then, { ...env, path: `${path}.then` })
      if ('else' in raw) step.else = this.expand(raw.else, { ...env, path: `${path}.else` })
      if (Array.isArray(raw.branches)) step.branches = raw.branches.map((b, j) => this.expand(b, { ...env, path: `${path}.b${j}` }))
      if (step.op === 'say') {
        if (step.speaker === undefined) {
          step.speaker = env.npc.spec.nameZh
          if (env.npc.spec.portrait && step.portrait === undefined) step.portrait = env.npc.spec.portrait
        } else if (step.speaker === '') delete step.speaker
      }
      if ((step.op === 'giveCreature' || step.op === 'wildBattle') && isObj(step.pick)) {
        // Keyed by the pick itself so the same pick meets the same species from every script path; `salt` separates.
        step.species = resolvePickAvoiding(step.pick as StoryPick, Number(step.level), `${this.world.seed}:script:${JSON.stringify(step.pick)}`, new Set())
        delete step.pick
      }
      out.push(step as unknown as ScriptStep)
    })
    return out
  }

  private tierChain(tiers: { atLeast: number; steps: ScriptStep[] }[]): ScriptStep[] {
    const sorted = tiers.slice().sort((a, b) => b.atLeast - a.atLeast)
    let chain: ScriptStep[] | null = null
    for (let k = sorted.length - 1; k >= 0; k--) {
      const t = sorted[k]
      if (t.atLeast <= 0 && chain === null) { chain = t.steps; continue }
      const step: ScriptStep = { op: 'ifBadges', atLeast: t.atLeast, then: t.steps }
      if (chain) step.else = chain
      chain = [step]
    }
    return chain ?? []
  }

  // -- placement ------------------------------------------------------------

  private col(map: GameMap): Uint8Array {
    let c = this.collision.get(map.id)
    if (!c) { c = buildCollision(map); this.collision.set(map.id, c) }
    return c
  }

  private autoFacing(map: GameMap, x: number, y: number, range: number): Dir {
    const col = this.col(map)
    let best: Dir = AUTO_FACING_ORDER[0]
    let bestScore = -1
    for (const d of AUTO_FACING_ORDER) {
      let free = 0
      let hit = 0
      for (let k = 1; k <= range; k++) {
        const tx = x + DIR_DX[d] * k, ty = y + DIR_DY[d] * k
        if (!inBounds(map, tx, ty) || col[ty * map.width + tx] !== 0) break
        free++
        if (!hit && this.preferTerrain.has(map.terrain[ty * map.width + tx])) hit = range + 1 - k
      }
      const score = hit * (range + 1) + free
      if (score > bestScore) { best = d; bestScore = score }
    }
    return best
  }

  private warpTargets(): Set<string> {
    const out = new Set<string>()
    for (const m of Object.values(this.world.maps)) {
      out.add(`${m.id}:${m.spawn.x},${m.spawn.y}`)
      for (const w of m.warps) out.add(`${w.toMap}:${w.toX},${w.toY}`)
    }
    return out
  }

  private arrivalTiles(): Set<string> {
    if (!this.arrivals) this.arrivals = this.warpTargets()
    return this.arrivals
  }

  /** Places every pending NPC not placed yet, reporting anything that makes its tile unsuitable. */
  place(): void {
    const targets = this.arrivalTiles()
    const occupied = this.occupied
    const ids = this.npcIds
    for (; this.placedCount < this.pending.length; this.placedCount++) {
      const p = this.pending[this.placedCount]
      const s = p.spec
      const where = `${p.source} npc ${s.id}`
      if (ids.has(s.id)) { this.problems.push(`${where}: duplicate NPC id`); continue }
      ids.add(s.id)
      const a = this.anchors[s.at]
      if (!a) { this.problems.push(`${where}: unknown anchor "${s.at}"`); continue }
      const map = this.world.maps[a.map]
      const x = a.x + (s.offset?.[0] ?? 0), y = a.y + (s.offset?.[1] ?? 0)
      if (!map || !inBounds(map, x, y)) { this.problems.push(`${where}: ${s.at} offset out of bounds`); continue }
      const key = `${map.id}:${x},${y}`
      const i = y * map.width + x
      if (this.col(map)[i] !== 0) this.problems.push(`${where}: tile ${key} is not walkable`)
      if (map.warps.some((w) => w.x === x && w.y === y)) this.problems.push(`${where}: stands on a warp at ${key}`)
      if (targets.has(key)) this.problems.push(`${where}: stands on an arrival tile ${key}`)
      if (map.items.some((it) => it.x === x && it.y === y)) this.problems.push(`${where}: stands on a ground item at ${key}`)
      if (map.signs.some((sg) => sg.x === x && sg.y === y)) this.problems.push(`${where}: stands on a sign at ${key}`)
      const other = occupied.get(key)
      if (other) this.problems.push(`${where}: tile ${key} already taken by ${other}`)
      occupied.set(key, s.id)

      const facing: Dir = s.facing && s.facing !== 'auto' ? s.facing : this.autoFacing(map, x, y, s.sightRange || this.sc.meta.facing.lookDistance)
      const npc: NpcDef = {
        id: s.id, x, y, facing, sprite: s.sprite, nameZh: s.nameZh, role: s.role,
        script: this.expand(p.script, { params: p.params, npc: p, path: `npc ${s.id}`, depth: 0 }),
      }
      if (s.portrait) npc.portrait = s.portrait
      if (s.trainer) npc.trainer = s.trainer
      if (s.sightRange) npc.sightRange = s.sightRange
      if (s.wander) npc.wander = s.wander
      if (s.hiddenUnlessFlag) npc.hiddenUnlessFlag = s.hiddenUnlessFlag
      if (s.hiddenIfFlag) npc.hiddenIfFlag = s.hiddenIfFlag
      map.npcs.push(npc)
      const tiles = this.npcTiles.get(map.id)
      if (tiles) tiles.push(i)
      else this.npcTiles.set(map.id, [i])
    }
  }

  // -- population -----------------------------------------------------------

  /**
   * Fills the procedural spots (after the authored NPCs are placed): legend chains, then bounties, then the
   * population rules in JSON order. Each spot holds at most one NPC — whoever claims it first.
   */
  populate(): void {
    const pop = this.sc.population
    this.validatePopulation()
    this.validateProcgen()
    const features = worldBuildInfo(this.world).features
    this.legends = placeLegends(this, this.sc.legends, features)
    this.bounties = placeBounties(this, this.sc.bounties)
    const missing = new Set<string>()
    for (const { rule, re } of this.rules) {
      if (!re || rule.kind === 'services') continue
      const pool: (NpcArchetype | TrainerArchetype)[] | undefined = rule.kind === 'trainer' ? pop.trainerPools[rule.pool ?? ''] : pop.npcPools[rule.pool ?? '']
      if (!pool?.length) continue
      const used = new Map<string, Set<number>>()
      for (const name of this.anchorNames) {
        const m = re.exec(name)
        if (!m) continue
        const roll = (salt: string) => seedFor(this.world.seed, `${rule.id}|${name}|${salt}`)
        if (roll('share') / 2 ** 32 >= (rule.share ?? 1)) continue
        const spot = this.spots.info(name)
        if (!spot) continue
        if (rule.minLevel !== undefined && spot.levelRange[0] < rule.minLevel) continue
        if (rule.maxLevel !== undefined && spot.levelRange[0] > rule.maxLevel) continue
        const sets = (rule.paramSets ?? []).filter((ps) => (ps.minLevel ?? 0) <= spot.levelRange[0])
        if (rule.paramSets && !sets.length) continue
        if (!this.claimSpot(spot.map, spot.x, spot.y, rule.skipIfMapHasNpc)) continue
        const biome = spot.biome
        const choices = pool.map((_, i) => i).filter((i) => !pool[i].biomes || pool[i].biomes!.includes(biome))
        if (!choices.length) {
          if (!missing.has(`${rule.id}:${biome}`)) this.problems.push(`population ${rule.id}: pool "${rule.pool}" has no archetype for biome "${biome}" (${name})`)
          missing.add(`${rule.id}:${biome}`)
          continue
        }
        const groups: Record<string, string> = {}
        for (const [k, v] of Object.entries(m.groups ?? {})) if (v !== undefined) groups[k] = v
        // Variety: within one site (or region / map) prefer archetypes not used there yet.
        const groupKey = `${spot.map.id}|${groups.site ?? groups.region ?? groups.town ?? ''}`
        const seen = used.get(groupKey) ?? new Set<number>()
        used.set(groupKey, seen)
        const fresh = choices.filter((i) => !seen.has(i))
        const from = fresh.length ? fresh : choices
        const ai = from[roll('archetype') % from.length]
        seen.add(ai)
        const arch = pool[ai]
        const region = spot.region
        const placeName = region?.townId ? (this.world.towns.find((t) => t.id === region.townId)?.nameZh ?? region.nameZh) : (region?.nameZh ?? spot.map.nameZh)
        const params: Record<string, string> = {
          ...this.hints.params(spot), ...groups, rule: rule.id, slug: slugOf(name), place: placeName,
          biome: CONTENT.biomeById[biome]?.nameZh ?? biome, siteName: this.spots.siteName(groups.site ?? '') ?? placeName,
        }
        for (const [k, vals] of Object.entries({ ...rule.params, ...arch.params })) if (vals.length) params[k] = vals[roll(`param:${k}`) % vals.length]
        if (sets.length) Object.assign(params, sets[roll('paramSet') % sets.length].params)
        const id = fill(rule.idPattern ?? '{rule}-{slug}', params)
        params.id = id
        const pickOf = <T>(list: readonly T[], salt: string): T => list[roll(salt) % list.length]
        const source = `population/${rule.id}`
        if (rule.kind === 'npc') {
          const na = arch as NpcArchetype
          const spec: NpcSpec = { id, at: name, sprite: na.sprite, nameZh: pickOf(na.names, 'name'), role: na.role ?? rule.role ?? 'villager', lines: pickOf(na.dialogues, 'say') }
          const script = na.script ?? rule.script
          if (script) spec.script = script
          if (rule.wander) spec.wander = rule.wander
          if (rule.facing) spec.facing = rule.facing
          this.addNpc(spec, params, source)
        } else {
          const ta = arch as TrainerArchetype
          if (!region?.levelRange) { this.problems.push(`${source}: ${name} has no level range`); continue }
          const party = this.party(spot, {
            size: rule.party ?? [1, 1], types: ta.types, levelBonus: rule.levelBonus, rarityShift: rule.rarityShift, habitat: rule.habitat,
            salt: `${rule.id}|${name}`, pickSalt: rule.id,
          })
          const spec: TrainerSpec = {
            id, at: name, nameZh: pickOf(ta.names, 'name'), classZh: ta.classZh, sprite: ta.sprite, party,
            introText: pickOf(ta.introText, 'intro'), defeatText: pickOf(ta.defeatText, 'defeat'), after: pickOf(ta.after, 'after'),
            reward: this.trainerReward(spot, party.reduce((mx, p) => Math.max(mx, p.level), 0), rule.rewardPerLevel),
          }
          if (rule.sightRange) spec.sightRange = rule.sightRange[0] + roll('sight') % (Math.max(rule.sightRange[0], rule.sightRange[1]) - rule.sightRange[0] + 1)
          if (rule.facing) spec.facing = rule.facing
          const script = ta.script ?? rule.script
          if (script) spec.script = script
          const d: TrainerDefaults = {}
          if (rule.aiLevel !== undefined) d.aiLevel = rule.aiLevel
          if (rule.music) d.music = rule.music
          if (rule.role) d.role = rule.role
          this.addTrainer(spec, d, source, undefined, params)
        }
        this.place()
      }
    }
  }

  /**
   * Party for a trainer at `spot`: levels within the spot's band (+ levelBonus) with the ace at the top, one type
   * per member cycling through `types` from a hashed offset, rarities from the level's band (+ rarityShift).
   */
  party(spot: SpotInfo, o: PartyOpts): PartySpec[] {
    const roll = (salt: string) => seedFor(this.world.seed, `${o.salt}|${salt}`)
    const cap = CONTENT.config.party.maxLevel
    const [r0, r1] = spot.levelRange
    const lo = Math.min(cap, Math.max(1, r0 + (o.levelBonus ?? 0)))
    const hi = Math.min(cap, Math.max(lo, r1 + (o.levelBonus ?? 0)))
    const [pMin, pMax] = o.size
    const size = Math.max(1, pMin + roll('size') % (Math.max(pMin, pMax) - pMin + 1))
    const levels = Array.from({ length: size }, (_, i) => (i === size - 1 ? hi : lo + roll(`level${i}`) % (hi - lo + 1))).sort((x, y) => x - y)
    const t0 = roll('type')
    return levels.map((level, i) => {
      const pick: StoryPick = { types: [o.types[(t0 + i) % o.types.length]], rarities: this.raritiesFor(level, o.rarityShift ?? 0), salt: `${o.pickSalt ?? o.salt}${i}` }
      if (o.habitat && spot.biome) pick.habitats = [spot.biome]
      return { level, pick }
    })
  }

  /** rewardPerLevel × ace level × the danger multiplier of the spot's region. */
  trainerReward(spot: SpotInfo, level: number, perLevel?: number): number {
    const mul = this.sc.population.dangerReward
    const m = mul.length ? mul[Math.min(mul.length - 1, Math.max(0, spot.danger))] : 1
    return Math.round((perLevel ?? this.sc.meta.trainers.rewardPerLevel) * level * m)
  }

  private raritiesFor(level: number, shift = 0): string[] {
    const bands = this.sc.population.rarityBands
    if (!bands.length) return []
    let k = bands.findIndex((b) => level <= b.maxLevel)
    if (k < 0) k = bands.length - 1
    return bands[Math.min(bands.length - 1, k + Math.max(0, shift))].rarities.slice()
  }

  // PopHost: spot claims shared by legends, bounties and the population rules.
  canClaim(name: string): boolean {
    const s = this.spots.info(name)
    return !!s && this.spotCheck(s.map, s.x, s.y) !== null
  }

  claim(name: string): boolean {
    const s = this.spots.info(name)
    return !!s && this.claimSpot(s.map, s.x, s.y)
  }

  /** Commits a spot check: the dead ends it would seal are never used by another spot. */
  private claimSpot(map: GameMap, x: number, y: number, skipIfMapHasNpc?: boolean): boolean {
    const sealed = this.spotCheck(map, x, y, skipIfMapHasNpc)
    if (!sealed) return false
    if (sealed.length) {
      const set = this.sealed.get(map.id) ?? new Set<number>()
      for (const k of sealed) set.add(k)
      this.sealed.set(map.id, set)
    }
    return true
  }

  /**
   * A procedural spot is used only when an NPC there blocks nothing: free tile, spaced out, no path cut.
   * Returns the dead-end tiles it would seal (possibly none), or null when the spot is unusable.
   */
  private spotCheck(map: GameMap, x: number, y: number, skipIfMapHasNpc?: boolean): number[] | null {
    if (!inBounds(map, x, y)) return null
    const W = map.width
    const i = y * W + x
    if (this.col(map)[i] !== COLLISION_FREE) return null
    const tiles = this.npcTiles.get(map.id) ?? []
    if (skipIfMapHasNpc && tiles.length) return null
    const key = `${map.id}:${x},${y}`
    if (this.occupied.has(key) || this.arrivalTiles().has(key)) return null
    if (map.warps.some((w) => w.x === x && w.y === y) || map.items.some((it) => it.x === x && it.y === y) || map.signs.some((sg) => sg.x === x && sg.y === y)) return null
    if (this.world.towns.some((t) => t.map === map.id && t.x === x && t.y === y)) return null
    const spacing = this.sc.population.spacing
    for (const j of tiles) {
      const tx = j % W, ty = (j - tx) / W
      if (Math.max(Math.abs(tx - x), Math.abs(ty - y)) < spacing) return null
    }
    if (this.sealed.get(map.id)?.has(i)) return null
    return this.sealedBy(map, x, y, tiles)
  }

  /**
   * Tiles an NPC on (x,y) would seal off, or null when it would cut a path. Its passable neighbours must stay
   * mutually connected inside a small window without it (walking, and again with surf) — local connectivity
   * implies global. A side that is not connected may only be a tiny dead end with nothing in it (`pocketMax`).
   */
  private sealedBy(map: GameMap, x: number, y: number, npcTiles: readonly number[]): number[] | null {
    const col = this.col(map)
    const W = map.width
    const r = this.sc.population.sealRadius
    const blocked = new Set(npcTiles)
    blocked.add(y * W + x)
    const sealed: number[] = []
    for (const surf of [false, true]) {
      const opts = { surf }
      const passable = (v: number) => v === COLLISION_FREE || (surf && v === COLLISION_WATER)
      const ends: number[] = []
      for (const d of DIRS) {
        const nx = x + DIR_DX[d], ny = y + DIR_DY[d]
        if (!inBounds(map, nx, ny) || blocked.has(ny * W + nx) || !passable(col[ny * W + nx])) continue
        if (canStep(map, col, nx, ny, x, y, opts) || canStep(map, col, x, y, nx, ny, opts)) ends.push(ny * W + nx)
      }
      if (ends.length < 2) continue
      const flood = (start: number, inside: (nx: number, ny: number) => boolean, limit: number): Set<number> => {
        const seen = new Set<number>([start])
        const stack = [start]
        while (stack.length && seen.size <= limit) {
          const j = stack.pop()!
          const jx = j % W, jy = (j - jx) / W
          for (const d of DIRS) {
            const nx = jx + DIR_DX[d], ny = jy + DIR_DY[d]
            const k = ny * W + nx
            if (!inBounds(map, nx, ny) || !inside(nx, ny) || seen.has(k) || blocked.has(k)) continue
            if (!canStep(map, col, jx, jy, nx, ny, opts)) continue
            seen.add(k)
            stack.push(k)
          }
        }
        return seen
      }
      const parts: number[] = []
      const covered = new Set<number>()
      for (const e of ends) {
        if (covered.has(e)) continue
        parts.push(e)
        for (const k of flood(e, (nx, ny) => Math.abs(nx - x) <= r && Math.abs(ny - y) <= r, Infinity)) covered.add(k)
      }
      if (parts.length < 2) continue
      let open = 0
      for (const e of parts) {
        const pocket = this.inertPocket(map, flood(e, () => true, this.sc.population.pocketMax))
        if (pocket) sealed.push(...pocket)
        else if (++open > 1) return null
      }
    }
    return sealed
  }

  /** The flooded tiles when they form a small dead end with nothing anyone needs; otherwise null. */
  private inertPocket(map: GameMap, tiles: Set<number>): number[] | null {
    if (tiles.size > this.sc.population.pocketMax) return null
    const W = map.width
    const arrivals = this.arrivalTiles()
    const npcs = new Set(this.npcTiles.get(map.id) ?? [])
    for (const k of tiles) {
      const x = k % W, y = (k - x) / W
      if (arrivals.has(`${map.id}:${x},${y}`) || this.sealed.get(map.id)?.has(k)) return null
      if (map.warps.some((w) => w.x === x && w.y === y) || map.items.some((it) => it.x === x && it.y === y) || map.signs.some((sg) => sg.x === x && sg.y === y)) return null
      if (this.world.towns.some((t) => t.map === map.id && t.x === x && t.y === y)) return null
      // An existing NPC next to the pocket might need it to be talked to.
      for (const d of DIRS) if (inBounds(map, x + DIR_DX[d], y + DIR_DY[d]) && npcs.has((y + DIR_DY[d]) * W + x + DIR_DX[d])) return null
    }
    return [...tiles]
  }

  /** Reference checks for legends.json, bounties.json and the hint config (scripts are checked after expansion). */
  private validateProcgen(): void {
    const bad = (msg: string) => this.problems.push(msg)
    const h = this.sc.population.hints
    if (h.directions.length !== 8) bad('population.hints: directions needs 8 entries (N NE E SE S SW W NW)')
    if (!h.distances.length) bad('population.hints: distances is empty')
    for (const [k, t] of Object.entries(h.targets)) {
      for (const tpl of t.pois ?? []) if (!WORLD_CONTENT.pois.templates[tpl]) bad(`population.hints.targets.${k}: unknown POI template "${tpl}"`)
    }
    if (!this.sc.population.dangerReward.length) bad('population: dangerReward is empty')
    const arch = (where: string, a: { sprite: string; names: string[]; lines: string[][] }) => {
      if (!CONTENT.characterById[a.sprite]) bad(`${where}: unknown sprite "${a.sprite}"`)
      if (!a.names.length) bad(`${where}: no names`)
      if (!a.lines.length || a.lines.some((l) => !l.length)) bad(`${where}: empty lines`)
    }
    const regex = (where: string, src: string | undefined) => { try { new RegExp(src ?? '') } catch { bad(`${where}: bad pattern "${src}"`) } }
    const lf = this.sc.legends
    const ids = new Set<string>()
    for (const c of lf.chains) {
      const w = `legends ${c.id}`
      if (ids.has(c.id)) bad(`${w}: duplicate id`)
      ids.add(c.id)
      regex(w, c.sites)
      regex(w, c.final)
      if (!(c.steps[0] >= 2 && c.steps[0] <= c.steps[1])) bad(`${w}: steps must be [min>=2, max]`)
      arch(`${w} keeper`, { ...c.keeper, lines: c.keeper.lines ?? [['-']] })
      arch(`${w} seer`, { ...c.seer, lines: c.seer.lines ?? [['-']] })
      if (!c.lore.length || c.lore.some((l) => !l.length)) bad(`${w}: empty lore`)
      if (!c.encounter.some((st) => st.op === 'wildBattle')) bad(`${w}: encounter has no wildBattle`)
    }
    const bf = this.sc.bounties
    const item = (where: string, id: string, buyable = false) => {
      const it = CONTENT.items[id]
      if (!it) bad(`${where}: unknown item "${id}"`)
      else if (buyable && !it.buyable) bad(`${where}: item "${id}" is not buyable`)
    }
    for (const g of bf.givers) regex('bounties.givers', g)
    for (const b of bf.reward.items) for (const pool of b.pool) for (const id of Object.keys(pool)) item('bounties.reward', id)
    for (const [k, kind] of Object.entries(bf.kinds)) {
      const w = `bounties.${k}`
      if (!kind.names.length || !kind.stages.length) bad(`${w}: needs names and stages`)
      kind.giver.forEach((a, i) => arch(`${w}.giver[${i}]`, a))
      if (!kind.giver.length) bad(`${w}: no giver archetypes`)
      if (kind.target) regex(w, kind.targets)
      if (kind.target === 'npc') { if (!kind.partner?.length || !kind.scripts.partner) bad(`${w}: npc target needs partner archetypes and a partner script`) }
      kind.partner?.forEach((a, i) => arch(`${w}.partner[${i}]`, a))
      if (kind.target === 'trainer' && (!kind.trainer?.length || !kind.scripts.target)) bad(`${w}: trainer target needs trainer archetypes and a target script`)
      for (const t of kind.trainer ?? []) {
        if (!CONTENT.characterById[t.sprite]) bad(`${w}: unknown sprite "${t.sprite}"`)
        for (const ty of t.types) if (!CONTENT.typeById[ty]) bad(`${w}: unknown type "${ty}"`)
      }
      for (const id of kind.parcels ?? []) item(`${w}.parcels`, id)
      for (const b of kind.fetch?.bands ?? []) for (const id of b.items) item(`${w}.fetch`, id, true)
    }
  }

  private validatePopulation(): void {
    const pop = this.sc.population
    const bad = (msg: string) => this.problems.push(`population: ${msg}`)
    const range = (v: unknown, what: string) => {
      if (v === undefined) return
      if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => Number.isInteger(n) && n >= 0) || v[0] > v[1]) bad(`${what} must be [min, max]`)
    }
    if (!pop.rarityBands.length) bad('rarityBands is empty')
    for (const b of pop.rarityBands) for (const r of b.rarities) if (!CONTENT.rarityById[r]) bad(`rarityBands: unknown rarity "${r}"`)
    for (const { rule } of this.rules) {
      const w = `rule ${rule.id}`
      if (!['npc', 'trainer', 'services'].includes(rule.kind)) bad(`${w}: unknown kind "${rule.kind}"`)
      if (rule.kind === 'npc' && !pop.npcPools[rule.pool ?? '']?.length) bad(`${w}: unknown or empty npc pool "${rule.pool}"`)
      if (rule.kind === 'trainer' && !pop.trainerPools[rule.pool ?? '']?.length) bad(`${w}: unknown or empty trainer pool "${rule.pool}"`)
      if (rule.share !== undefined && !(rule.share >= 0 && rule.share <= 1)) bad(`${w}: share must be within 0..1`)
      range(rule.sightRange, `${w}: sightRange`)
      range(rule.party, `${w}: party`)
      if (rule.party && (rule.party[0] < 1 || rule.party[1] > CONTENT.config.party.maxParty)) bad(`${w}: party size outside 1..${CONTENT.config.party.maxParty}`)
      for (const [k, v] of Object.entries(rule.params ?? {})) if (!v.length) bad(`${w}: param "${k}" has no values`)
    }
    const common = (where: string, a: NpcArchetype | TrainerArchetype) => {
      if (!CONTENT.characterById[a.sprite]) bad(`${where}: unknown sprite "${a.sprite}"`)
      if (!a.names.length) bad(`${where}: no names`)
      for (const b of a.biomes ?? []) if (!CONTENT.biomeById[b]) bad(`${where}: unknown biome "${b}"`)
      for (const [k, v] of Object.entries(a.params ?? {})) if (!v.length) bad(`${where}: param "${k}" has no values`)
    }
    for (const [pool, list] of Object.entries(pop.npcPools)) {
      list.forEach((a, i) => {
        common(`npcPools.${pool}[${i}]`, a)
        if (!a.dialogues.length || a.dialogues.some((d) => !d.length)) bad(`npcPools.${pool}[${i}]: empty dialogue`)
      })
    }
    for (const [pool, list] of Object.entries(pop.trainerPools)) {
      list.forEach((a, i) => {
        const where = `trainerPools.${pool}[${i}]`
        common(where, a)
        if (!a.types.length) bad(`${where}: no types`)
        for (const t of a.types) if (!CONTENT.typeById[t]) bad(`${where}: unknown type "${t}"`)
        if (!a.introText.length || !a.defeatText.length || !a.after.length || [...a.introText, ...a.defeatText].some((l) => !l.length)) bad(`${where}: missing lines`)
      })
    }
  }

  // -- validation -----------------------------------------------------------

  validate(): void {
    const w = this.world
    const npcIds = new Set<string>()
    for (const m of Object.values(w.maps)) for (const n of m.npcs) npcIds.add(n.id)
    const quests = new Map(w.quests.map((q) => [q.id, q]))
    const bgm = new Set(CONTENT.audio.bgm.map((b) => b.id))
    const sfx = new Set(CONTENT.audio.sfx)
    const dirs = new Set<string>(AUTO_FACING_ORDER)
    for (const [id, t] of Object.entries(w.trainers)) {
      const where = `trainer ${id}`
      if (!CONTENT.characterById[t.sprite]) this.problems.push(`${where}: unknown sprite "${t.sprite}"`)
      if (!t.party.length) this.problems.push(`${where}: empty party`)
      for (const p of t.party) {
        if (!CONTENT.species[p.species ?? '']) this.problems.push(`${where}: unresolved species "${p.species}"`)
        if (!(p.level >= 1 && p.level <= CONTENT.config.party.maxLevel)) this.problems.push(`${where}: level ${p.level} out of range`)
        for (const mv of p.moves ?? []) if (!CONTENT.moves[mv]) this.problems.push(`${where}: unknown move "${mv}"`)
      }
      if (t.party.length > CONTENT.config.party.maxParty) this.problems.push(`${where}: party larger than ${CONTENT.config.party.maxParty}`)
      if (t.badge && !w.badges.some((b) => b.id === t.badge)) this.problems.push(`${where}: unknown badge "${t.badge}"`)
      for (const it of Object.keys(t.items ?? {})) if (!CONTENT.items[it]) this.problems.push(`${where}: unknown item "${it}"`)
      if (t.music && !bgm.has(t.music)) this.problems.push(`${where}: unknown music "${t.music}"`)
    }
    for (const q of w.quests) {
      for (const it of Object.keys(q.reward?.items ?? {})) if (!CONTENT.items[it]) this.problems.push(`quest ${q.id}: unknown reward item "${it}"`)
    }
    for (const m of Object.values(w.maps)) {
      for (const n of m.npcs) {
        const where = `npc ${n.id}`
        if (!CONTENT.characterById[n.sprite]) this.problems.push(`${where}: unknown sprite "${n.sprite}"`)
        if (n.portrait && !CONTENT.characterById[n.portrait]) this.problems.push(`${where}: unknown portrait "${n.portrait}"`)
        if (n.trainer && !w.trainers[n.trainer]) this.problems.push(`${where}: unknown trainer "${n.trainer}"`)
        const step = (s: ScriptStep, path: string): void => {
          const at = `${where} step ${path} (${s.op})`
          const bad = (msg: string) => this.problems.push(`${at}: ${msg}`)
          const item = (id: string) => { if (!CONTENT.items[id]) bad(`unknown item "${id}"`) }
          const qty = (v: unknown) => { if (typeof v !== 'number' || !(v > 0)) bad(`quantity must be > 0`) }
          const str = (v: unknown, name: string) => { if (typeof v !== 'string' || !v) bad(`missing ${name}`) }
          const list = (v: unknown, name: string) => { if (!Array.isArray(v)) bad(`${name} must be a step list`) }
          switch (s.op) {
            case 'say': str(s.text, 'text'); if (s.portrait && !CONTENT.characterById[s.portrait]) bad(`unknown portrait "${s.portrait}"`); break
            case 'choice':
              str(s.text, 'text')
              if (!Array.isArray(s.options) || !Array.isArray(s.branches) || s.options.length !== s.branches.length || s.options.length < 2) bad('options/branches mismatch')
              break
            case 'setFlag': str(s.flag, 'flag'); break
            case 'ifFlag': str(s.flag, 'flag'); list(s.then, 'then'); break
            case 'ifBadges': if (typeof s.atLeast !== 'number') bad('atLeast must be a number'); list(s.then, 'then'); break
            case 'ifItem': item(s.item); list(s.then, 'then'); break
            case 'ifCaught':
              if (s.species && !CONTENT.species[s.species]) bad(`unknown species "${s.species}"`)
              if (s.type && !CONTENT.typeById[s.type]) bad(`unknown type "${s.type}"`)
              list(s.then, 'then')
              break
            case 'giveItem': case 'takeItem': item(s.item); qty(s.qty); break
            case 'giveMoney': case 'takeMoney': qty(s.amount); break
            case 'giveCreature': case 'wildBattle':
              if (!s.species || !CONTENT.species[s.species]) bad(`unresolved species "${s.species}"`)
              if (!(s.level >= 1 && s.level <= CONTENT.config.party.maxLevel)) bad(`level ${s.level} out of range`)
              if (s.op === 'wildBattle' && s.music && !bgm.has(s.music)) bad(`unknown music "${s.music}"`)
              break
            case 'battle': if (!w.trainers[s.trainer]) bad(`unknown trainer "${s.trainer}"`); break
            case 'bossBattle': if (!CONTENT.bosses[s.boss]?.tiers?.[s.tier]) bad(`unknown boss tier "${s.boss}:${s.tier}"`); break
            case 'shop': if (!Array.isArray(s.items) || !s.items.length) bad('empty shop'); else s.items.forEach(item); break
            case 'quest': {
              const q = quests.get(s.quest)
              if (!q) bad(`unknown quest "${s.quest}"`)
              else if (!(Number.isInteger(s.stage) && s.stage >= 0 && s.stage < q.stages.length)) bad(`stage ${s.stage} out of range`)
              break
            }
            case 'warp': {
              const tm = w.maps[s.map]
              if (!tm || !inBounds(tm, s.x, s.y)) bad(`bad warp target ${s.map} ${s.x},${s.y}`)
              if (!dirs.has(s.facing)) bad(`bad facing "${s.facing}"`)
              break
            }
            case 'moveNpc':
              if (!npcIds.has(s.npc)) bad(`unknown npc "${s.npc}"`)
              if (!Array.isArray(s.path) || s.path.some((d) => !dirs.has(d))) bad('bad path')
              break
            case 'faceNpc': if (!npcIds.has(s.npc)) bad(`unknown npc "${s.npc}"`); if (!dirs.has(s.dir)) bad(`bad dir "${s.dir}"`); break
            case 'hideNpc': case 'showNpc': if (!npcIds.has(s.npc)) bad(`unknown npc "${s.npc}"`); break
            case 'sfx': if (!sfx.has(s.id)) bad(`unknown sfx "${s.id}"`); break
            case 'bgm': if (!bgm.has(s.id)) bad(`unknown bgm "${s.id}"`); break
            case 'wait': if (typeof s.ms !== 'number' || s.ms < 0) bad('bad ms'); break
            case 'fade': if (typeof s.out !== 'boolean') bad('fade.out must be boolean'); break
            case 'unlockTown': if (!w.towns.some((t) => t.id === s.town)) bad(`unknown town "${s.town}"`); break
            case 'exchange': if (!EXCHANGE.desks[s.desk]) bad(`unknown exchange desk "${s.desk}"`); break
            case 'teach': if (typeof s.lesson !== 'string' || !s.lesson) bad('teach needs a lesson id'); break
            case 'openTypeChart':
              if (s.type !== undefined && !CONTENT.typeById[s.type]) bad(`unknown type "${s.type}"`)
              if (s.view !== undefined && !['type', 'grid', 'loops'].includes(s.view)) bad(`unknown chart view "${s.view}"`)
              break
            case 'chooseStarter': case 'heal': case 'openBox': case 'setRespawn': case 'end': break
            default: bad('unknown op')
          }
        }
        walkSteps(n.script, step)
      }
    }
  }
}

const APPLIED = new WeakSet<World>()

/** Adds the story layer (NPCs, trainers, quests) to a freshly built world. Idempotent per World object. */
export function applyStory(world: World, sc: StoryContent = STORY_CONTENT): void {
  if (APPLIED.has(world)) return
  APPLIED.add(world)
  const b = new StoryBuilder(world, sc)
  for (const [group, g] of Object.entries(sc.trainerGroups)) {
    for (const spec of g.trainers) b.addTrainer(spec, g.defaults ?? {}, `trainers/${group}`)
  }
  b.addRivals()
  b.addQuests()
  b.addServices()
  for (const [group, list] of Object.entries(sc.npcGroups)) for (const spec of list) b.addNpc(spec, {}, `npcs/${group}`)
  b.place()
  b.populate()
  b.validate()
  PROBLEMS.set(world, b.problems)
  FEATURES.set(world, { legends: b.legends, bounties: b.bounties })
}

export interface StoryFeatures { legends: PlacedLegend[]; bounties: PlacedBounty[] }

const FEATURES = new WeakMap<World, StoryFeatures>()

/** Legend chains (tablet / final anchors) and bounties (quest, kind, giver / target anchors) placed for a world. */
export function storyFeatures(world: World): StoryFeatures {
  return FEATURES.get(world) ?? { legends: [], bounties: [] }
}
