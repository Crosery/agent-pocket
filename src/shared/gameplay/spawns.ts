// Rarity-driven spawning: runtime weighting of encounter tables, visible roamers, shiny odds, battle flee
// parameters, roaming UR legends (one per province band) and MYTHIC chain progress. Data: RarityDef.behavior
// (content/rarities.json), content/events/spawn.json (affinities, SSR conditions, legend rules),
// content/events/legends.json, content/events/mythic.json. Pure: every roll goes through the IRng passed in.
//
// Runtime API (client):
//   behaviorOf(rarity) / speciesBehavior(id)          RarityBehavior with defaults filled in.
//   grassWeights(slots, ctx, opts) / pickGrassEncounter(slots, ctx, rng, opts)
//        tall-grass step encounter: time slots, type affinity by time/weather, rarity grass multiplier,
//        distance growth, event encounter boosts, level bonus, shiny roll, flee params.  -> WildPick | null
//   visibleWeights(...) / pickVisibleSpawn(slots, ctx, rng, { present })
//        overworld roamers: per-tier caps per area, SSR only while its species condition holds (time /
//        weather / biome / distance), avoidance + roam speed + cue keys.                -> VisibleSpawn | null
//   resolveSpawnEffect(effect, areaLevel, rng)         event 'spawn' effects            -> VisibleSpawn[]
//   fleeFor(species, mods?)                            BattleSideInit.flee for a wild of that species.
//   shinyChance / rollShinyFor                         base shinyRate x rarity x event x research-complete.
//   speciesSpawnConditions / speciesConditionHolds     SSR-style spawn conditions.
//   bandOf / bandRange / legendEpoch / legendForBand / legendAt / legendsNear / legendPings
//        roaming legends: who roams band b this epoch, where it is now (nominal tile), proximity.
//   onLegendBattleEnd(state, species, result, info)    SaveData.legends update after a legend battle.
//   snapToFree(x, y, isFree, radius)                   nearest walkable tile for a nominal position.
//   chainProgress(chainId, flags) / chainsProgress     MYTHIC chain step state from SaveData.flags.
//   sanitizeLegendState(raw)
import type {
  BattleResult, BattleSideInit, EncounterSlot, EventCondition, LegendState, Rarity, RarityBehavior, SpeciesDef, TypeId,
} from '../types.ts'
import type { IRng } from '../contracts.ts'
import { CONTENT, timeOfDayAt, type Content } from '../content/index.ts'
import { Rng, hashString } from '../rng.ts'
import { GAMEPLAY } from './data.ts'
import { NO_MODIFIERS, dayOf, evaluateCondition, modifierValue, type EventContext, type EventModifiers, type SpawnEffect } from './events.ts'
import { pickSpecies } from './picks.ts'
import { researchComplete, type ResearchState } from './research.ts'
import type { GameplayData, MythicChainDef, MythicChainStep, RoamingLegendDef } from './schema.ts'

const MINUTES_PER_HOUR = 60
const DEG = Math.PI / 180

// ---------------------------------------------------------------------------------------------- behaviour

export interface ResolvedBehavior extends RarityBehavior {
  grassWeightMul: number
  visibleWeightMul: number
  maxVisiblePerArea: number
  requireConditions: boolean
  shinyMultiplier: number
  lifeMinutes: [number, number]
  levelBonus: number
  noticeRadius: number
  cues: NonNullable<RarityBehavior['cues']>
}

const NEUTRAL: RarityBehavior = {
  spawn: ['grass', 'visible'], minDistance: 0, distanceWeightPer1000: 0, fleeChancePerTurn: 0, fleeAfterTurn: 0, roamSpeed: 1, avoidPlayer: false, cue: '',
}

export function behaviorOf(rarity: Rarity, c: Content = CONTENT): ResolvedBehavior {
  const b = c.rarityById[rarity]?.behavior ?? NEUTRAL
  return {
    ...b,
    grassWeightMul: b.grassWeightMul ?? (b.spawn.includes('grass') ? 1 : 0),
    visibleWeightMul: b.visibleWeightMul ?? (b.spawn.includes('visible') ? 1 : 0),
    maxVisiblePerArea: b.maxVisiblePerArea ?? Infinity,
    requireConditions: b.requireConditions ?? false,
    shinyMultiplier: b.shinyMultiplier ?? 1,
    lifeMinutes: b.lifeMinutes ?? [0, 0],
    levelBonus: b.levelBonus ?? 0,
    noticeRadius: b.noticeRadius ?? 0,
    cues: b.cues ?? {},
  }
}

export function speciesBehavior(speciesId: string, c: Content = CONTENT): ResolvedBehavior {
  return behaviorOf(c.species[speciesId]?.rarity ?? '', c)
}

// ---------------------------------------------------------------------------------------------- conditions

/** Spawn conditions of a species (any one suffices): per-species override, else the union of its types' lists. */
export function speciesSpawnConditions(speciesId: string, g: GameplayData = GAMEPLAY, c: Content = CONTENT): EventCondition[] {
  const own = g.spawn.speciesConditions[speciesId]
  if (own) return own
  return (c.species[speciesId]?.types ?? []).flatMap((ty) => g.spawn.typeConditions[ty] ?? [])
}

/** True when the species may appear now (always true for tiers without requireConditions). */
export function speciesConditionHolds(speciesId: string, ctx: EventContext, g: GameplayData = GAMEPLAY, c: Content = CONTENT): boolean {
  if (!speciesBehavior(speciesId, c).requireConditions) return true
  const conds = speciesSpawnConditions(speciesId, g, c)
  return conds.length === 0 || conds.some((cond) => evaluateCondition(cond, ctx, null, c))
}

// ---------------------------------------------------------------------------------------------- weighting

export interface SpawnOptions {
  mods?: EventModifiers
  research?: ResearchState
  c?: Content
  g?: GameplayData
}

export interface WeightedSlot { slot: EncounterSlot; speciesId: string; rarity: Rarity; weight: number }

/** Highest time-of-day affinity among the species' types x highest weather affinity. */
export function typeAffinity(types: readonly TypeId[], ctx: EventContext, g: GameplayData = GAMEPLAY, c: Content = CONTENT): number {
  const tod = g.spawn.typeAffinity.time[timeOfDayAt(ctx.minutes, c)] ?? {}
  const wx = g.spawn.typeAffinity.weather[ctx.weather] ?? {}
  const best = (table: Record<string, number>) => types.reduce((m, ty) => Math.max(m, table[ty] ?? 1), 1)
  return best(tod) * best(wx)
}

export function distanceMul(b: RarityBehavior, distance: number): number {
  if (distance < b.minDistance) return 0
  return 1 + (Math.max(0, distance) / 1000) * b.distanceWeightPer1000
}

/** Product of the event encounter boosts matching a species (type overlap, rarity or explicit species). */
export function boostMul(sp: SpeciesDef, mods: EventModifiers): number {
  let m = 1
  for (const b of mods.encounterBoosts) {
    const hit = (b.species?.includes(sp.id) ?? false)
      || ((!b.types?.length || sp.types.some((ty) => b.types!.includes(ty))) && (!b.rarities?.length || b.rarities.includes(sp.rarity)) && !b.species?.length)
    if (hit) m *= b.multiplier
  }
  return m
}

const slotActive = (s: EncounterSlot, ctx: EventContext, c: Content): boolean =>
  !s.time || s.time.length === 0 || s.time.includes(timeOfDayAt(ctx.minutes, c))

function weigh(slots: readonly EncounterSlot[], ctx: EventContext, mode: 'grass' | 'visible', o: SpawnOptions): WeightedSlot[] {
  const c = o.c ?? CONTENT
  const g = o.g ?? GAMEPLAY
  const mods = o.mods ?? NO_MODIFIERS
  const out: WeightedSlot[] = []
  for (const slot of slots) {
    const sp = c.species[slot.species]
    if (!sp || !(slot.weight > 0) || !slotActive(slot, ctx, c)) continue
    const b = behaviorOf(sp.rarity, c)
    const tierMul = mode === 'grass' ? b.grassWeightMul : b.visibleWeightMul
    if (!(tierMul > 0)) continue
    if (b.requireConditions && !speciesConditionHolds(sp.id, ctx, g, c)) continue
    const cond = b.requireConditions ? g.spawn.visible.conditionBonus : 1
    const w = slot.weight * tierMul * cond * typeAffinity(sp.types, ctx, g, c) * distanceMul(b, ctx.distance) * boostMul(sp, mods)
    if (w > 0) out.push({ slot, speciesId: sp.id, rarity: sp.rarity, weight: w })
  }
  return out
}

export function grassWeights(slots: readonly EncounterSlot[], ctx: EventContext, o: SpawnOptions = {}): WeightedSlot[] {
  return weigh(slots, ctx, 'grass', o)
}

export function visibleWeights(slots: readonly EncounterSlot[], ctx: EventContext, o: SpawnOptions = {}): WeightedSlot[] {
  return weigh(slots, ctx, 'visible', o)
}

// ---------------------------------------------------------------------------------------------- picks

export interface WildPick {
  speciesId: string
  level: number
  shiny: boolean
  rarity: Rarity
  /** Put into BattleSideInit.flee for the wild side (undefined = never flees). */
  flee?: NonNullable<BattleSideInit['flee']>
  /** Persistent aura cue key (null = none) and the other moment cues of its tier. */
  aura: string | null
  cues: ResolvedBehavior['cues']
}

export interface VisibleSpawn extends WildPick {
  roamSpeed: number
  avoidPlayer: boolean
  noticeRadius: number
  /** In-game minutes before it despawns (0 = client default). */
  lifeMinutes: number
  /** Spawned by an event effect with roaming false = stands still. */
  roaming: boolean
}

export function fleeFor(speciesId: string, mods: EventModifiers = NO_MODIFIERS, c: Content = CONTENT): WildPick['flee'] {
  const b = speciesBehavior(speciesId, c)
  if (!(b.fleeChancePerTurn > 0)) return undefined
  const types = c.species[speciesId]?.types ?? []
  const chance = Math.min(1, b.fleeChancePerTurn * modifierValue(mods, 'fleeChance', { types }))
  return chance > 0 ? { chancePerTurn: chance, afterTurn: b.fleeAfterTurn } : undefined
}

export function shinyChance(speciesId: string, o: SpawnOptions & { extraMul?: number } = {}): number {
  const c = o.c ?? CONTENT
  const g = o.g ?? GAMEPLAY
  const b = speciesBehavior(speciesId, c)
  const types = c.species[speciesId]?.types ?? []
  const research = o.research && researchComplete(o.research, speciesId, g, c) ? (g.research.shinyMultiplierOnComplete ?? 1) : 1
  const ev = modifierValue(o.mods ?? NO_MODIFIERS, 'shiny', { types })
  return Math.min(1, c.config.battle.shinyRate * b.shinyMultiplier * research * ev * (o.extraMul ?? 1))
}

export function rollShinyFor(speciesId: string, rng: IRng, o: SpawnOptions & { extraMul?: number } = {}): boolean {
  return rng.chance(shinyChance(speciesId, o))
}

function clampLevel(level: number, c: Content): number {
  return Math.max(1, Math.min(c.config.party.maxLevel, Math.round(level)))
}

function wildPick(speciesId: string, level: number, rng: IRng, o: SpawnOptions & { extraMul?: number }): WildPick {
  const c = o.c ?? CONTENT
  const sp = c.species[speciesId]
  const b = behaviorOf(sp?.rarity ?? '', c)
  const pick: WildPick = {
    speciesId, level: clampLevel(level, c), shiny: rollShinyFor(speciesId, rng, o), rarity: sp?.rarity ?? '',
    aura: b.cues.aura || null, cues: b.cues,
  }
  const flee = fleeFor(speciesId, o.mods ?? NO_MODIFIERS, c)
  if (flee) pick.flee = flee
  return pick
}

function rollSlotLevel(slot: EncounterSlot, rng: IRng, bonus: number): number {
  const lo = Math.min(slot.minLevel, slot.maxLevel), hi = Math.max(slot.minLevel, slot.maxLevel)
  return rng.int(lo, hi) + bonus
}

export function pickGrassEncounter(slots: readonly EncounterSlot[], ctx: EventContext, rng: IRng, o: SpawnOptions = {}): WildPick | null {
  const c = o.c ?? CONTENT
  const list = grassWeights(slots, ctx, o)
  if (!list.length) return null
  const w = rng.weighted(list, (x) => x.weight)
  return wildPick(w.speciesId, rollSlotLevel(w.slot, rng, behaviorOf(w.rarity, c).levelBonus), rng, o)
}

function toVisible(p: WildPick, roaming: boolean, rng: IRng, c: Content): VisibleSpawn {
  const b = behaviorOf(p.rarity, c)
  const [lo, hi] = b.lifeMinutes
  return {
    ...p, roamSpeed: b.roamSpeed, avoidPlayer: b.avoidPlayer, noticeRadius: b.noticeRadius,
    lifeMinutes: hi > 0 ? lo + rng.next() * Math.max(0, hi - lo) : 0, roaming,
  }
}

/**
 * One visible roamer for the area, or null. `present` = visible roamers already in this area per rarity; tiers at
 * their RarityBehavior.maxVisiblePerArea cap are skipped.
 */
export function pickVisibleSpawn(slots: readonly EncounterSlot[], ctx: EventContext, rng: IRng, o: SpawnOptions & { present?: Partial<Record<Rarity, number>> } = {}): VisibleSpawn | null {
  const c = o.c ?? CONTENT
  const present = o.present ?? {}
  const list = visibleWeights(slots, ctx, o).filter((x) => (present[x.rarity] ?? 0) < behaviorOf(x.rarity, c).maxVisiblePerArea)
  if (!list.length) return null
  const w = rng.weighted(list, (x) => x.weight)
  const p = wildPick(w.speciesId, rollSlotLevel(w.slot, rng, behaviorOf(w.rarity, c).levelBonus), rng, o)
  return toVisible(p, true, rng, c)
}

/** Concrete creatures for an event 'spawn' effect (picks resolved, levels from the area band when levelFromArea). */
export function resolveSpawnEffect(effect: SpawnEffect, areaLevel: [number, number], rng: IRng, o: SpawnOptions = {}): VisibleSpawn[] {
  const c = o.c ?? CONTENT
  const g = o.g ?? GAMEPLAY
  const out: VisibleSpawn[] = []
  const lo = effect.levelFromArea ? areaLevel[0] + effect.level[0] : effect.level[0]
  const hi = effect.levelFromArea ? areaLevel[1] + effect.level[1] : effect.level[1]
  for (let i = 0; i < Math.max(0, effect.count); i++) {
    const level = rng.int(Math.min(lo, hi), Math.max(lo, hi))
    const id = effect.species ?? pickSpecies(effect.pick ?? {}, level, rng, g.spawn.pickExcludeRarities, c)
    if (!id || !c.species[id]) continue
    const p = wildPick(id, level, rng, { ...o, extraMul: effect.shinyMultiplier })
    if (effect.aura) p.aura = effect.aura
    out.push(toVisible(p, effect.roaming, rng, c))
  }
  return out
}

// ---------------------------------------------------------------------------------------------- roaming legends

export type LegendStateMap = Record<string, LegendState>
export interface Point { x: number; y: number }

export function bandRange(band: number, g: GameplayData = GAMEPLAY): [number, number] {
  const e = g.spawn.legends.bandEdges
  const last = e.length - 1
  if (band < last) return [e[band], e[band + 1]]
  const lo = e[last] + (band - last) * g.spawn.legends.bandStep
  return [lo, lo + g.spawn.legends.bandStep]
}

export function bandOf(distance: number, g: GameplayData = GAMEPLAY): number {
  const e = g.spawn.legends.bandEdges
  const d = Math.max(0, distance)
  for (let b = 0; b < e.length - 1; b++) if (d < e[b + 1]) return b
  return e.length - 1 + Math.floor((d - e[e.length - 1]) / g.spawn.legends.bandStep)
}

export function legendEpoch(minutes: number, g: GameplayData = GAMEPLAY): number {
  return Math.floor(dayOf(minutes) / Math.max(1, g.spawn.legends.rotationDays))
}

export function legendLevel(band: number, def: RoamingLegendDef, g: GameplayData = GAMEPLAY, c: Content = CONTENT): number {
  const L = g.spawn.legends
  const n = L.levelByBand.length
  const base = band < n ? L.levelByBand[band] : L.levelByBand[n - 1] + (band - n + 1) * L.levelPerExtraBand
  return clampLevel(base + def.levelBonus, c)
}

/** Legends that may roam band `band` during this epoch (not caught, not defeated this epoch), sorted by species. */
export function legendPool(band: number, minutes: number, state: LegendStateMap, g: GameplayData = GAMEPLAY): RoamingLegendDef[] {
  const epoch = legendEpoch(minutes, g)
  const rot = Math.max(1, g.spawn.legends.rotationDays)
  return g.legends
    .filter((l) => {
      const st = state[l.species]
      if (l.minBand > band || st?.caught) return false
      return !(st?.defeatedDay !== undefined && Math.floor(st.defeatedDay / rot) === epoch)
    })
    .sort((a, b) => (a.species < b.species ? -1 : a.species > b.species ? 1 : 0))
}

/** The legend roaming `band` this epoch (consecutive bands sharing a pool get distinct legends). */
export function legendForBand(band: number, minutes: number, seed: number, state: LegendStateMap, g: GameplayData = GAMEPLAY): RoamingLegendDef | null {
  const pool = legendPool(band, minutes, state, g)
  if (!pool.length) return null
  const h = hashString(`legend:${seed >>> 0}:${legendEpoch(minutes, g)}`)
  return pool[(h + band) % pool.length]
}

export interface ActiveLegend {
  def: RoamingLegendDef
  species: string
  band: number
  epoch: number
  hop: number
  /** Nominal tile (absolute world coords); snap with snapToFree before placing an actor. */
  x: number
  y: number
  level: number
  /** Carried hp (undefined = full). */
  hp?: number
  /** Hidden after fleeing (restUntil in the future): no ping, cannot appear. */
  resting: boolean
}

function ringRadii(band: number, g: GameplayData): [number, number] {
  const [lo, hi] = bandRange(band, g)
  const m = (hi - lo) * g.spawn.legends.edgeMargin
  return [lo + m, Math.max(lo + m, hi - m)]
}

function hashPoint(key: string, rr: [number, number]): { a: number; r: number } {
  const rng = new Rng(hashString(key))
  const a = rng.next() * Math.PI * 2
  const r = Math.sqrt(rr[0] * rr[0] + rng.next() * (rr[1] * rr[1] - rr[0] * rr[0]))
  return { a, r }
}

/** Nominal position of a legend at `minutes` (pattern-driven; `hop` relocates it after each flee). */
export function legendPosition(def: RoamingLegendDef, band: number, minutes: number, seed: number, hop: number, origin: Point, g: GameplayData = GAMEPLAY): Point {
  const L = g.spawn.legends
  const epoch = legendEpoch(minutes, g)
  const rr = ringRadii(band, g)
  const key = `legend:${seed >>> 0}:${def.species}:${epoch}:${hop}`
  const base = hashPoint(key, rr)
  const hours = minutes / MINUTES_PER_HOUR
  let a = base.a
  let r = base.r
  switch (def.pattern) {
    case 'orbit':
      a = base.a + def.speed * DEG * hours
      break
    case 'tide': {
      a = base.a + def.speed * DEG * hours
      const mid = (rr[0] + rr[1]) / 2
      r = mid + ((rr[1] - rr[0]) / 2) * Math.sin((hours / 24) * Math.PI * 2)
      break
    }
    case 'wander':
    case 'blink': {
      const step = def.pattern === 'blink' ? L.hopMinutes / Math.max(1, L.blinkDivisor) : L.hopMinutes
      const k = Math.floor(minutes / Math.max(1, step))
      const p = hashPoint(`${key}:${k}`, rr)
      a = p.a
      r = p.r
      break
    }
  }
  return { x: Math.round(origin.x + Math.cos(a) * r), y: Math.round(origin.y + Math.sin(a) * r) }
}

export function legendAt(band: number, minutes: number, seed: number, origin: Point, state: LegendStateMap, g: GameplayData = GAMEPLAY, c: Content = CONTENT): ActiveLegend | null {
  const def = legendForBand(band, minutes, seed, state, g)
  if (!def) return null
  const st = state[def.species]
  const hop = st?.hops ?? 0
  const p = legendPosition(def, band, minutes, seed, hop, origin, g)
  const out: ActiveLegend = {
    def, species: def.species, band, epoch: legendEpoch(minutes, g), hop, x: p.x, y: p.y, level: legendLevel(band, def, g, c),
    resting: st?.restUntil !== undefined && st.restUntil > minutes,
  }
  if (st?.hp !== undefined) out.hp = st.hp
  return out
}

export type LegendProximity = 'far' | 'sense' | 'appear'

export interface NearLegend { legend: ActiveLegend; distance: number; proximity: LegendProximity }

/** Legends of the player's band and its neighbours with their distance to `at` (resting ones excluded). */
export function legendsNear(origin: Point, at: Point, minutes: number, seed: number, state: LegendStateMap, g: GameplayData = GAMEPLAY, c: Content = CONTENT): NearLegend[] {
  const L = g.spawn.legends
  const band = bandOf(Math.hypot(at.x - origin.x, at.y - origin.y), g)
  const out: NearLegend[] = []
  const seen = new Set<string>()
  for (let b = Math.max(0, band - 1); b <= band + 1; b++) {
    const lg = legendAt(b, minutes, seed, origin, state, g, c)
    if (!lg || lg.resting || seen.has(lg.species)) continue
    seen.add(lg.species)
    const d = Math.hypot(lg.x - at.x, lg.y - at.y)
    out.push({ legend: lg, distance: d, proximity: d <= L.appearRadius ? 'appear' : d <= L.senseRadius ? 'sense' : 'far' })
  }
  return out.sort((a, b) => a.distance - b.distance)
}

export interface LegendPing { species: string; band: number; x: number; y: number; radius: number; cue: string }

/** World-map pings for `bands`: a fuzzed circle (moves every pingSlotMinutes) around each roaming legend. */
export function legendPings(origin: Point, minutes: number, seed: number, state: LegendStateMap, bands: readonly number[], g: GameplayData = GAMEPLAY, c: Content = CONTENT): LegendPing[] {
  const L = g.spawn.legends
  const out: LegendPing[] = []
  const slot = Math.floor(minutes / Math.max(1, L.pingSlotMinutes))
  for (const b of bands) {
    const lg = legendAt(b, minutes, seed, origin, state, g, c)
    if (!lg || lg.resting) continue
    const rng = new Rng(hashString(`ping:${seed >>> 0}:${lg.species}:${slot}`))
    const a = rng.next() * Math.PI * 2
    const r = rng.next() * L.pingFuzz
    out.push({
      species: lg.species, band: b, x: Math.round(lg.x + Math.cos(a) * r), y: Math.round(lg.y + Math.sin(a) * r), radius: L.pingFuzz,
      cue: speciesBehavior(lg.species, c).cues.ping ?? '',
    })
  }
  return out
}

/**
 * Updates SaveData.legends after a battle with a roaming legend. caught -> gone for good; win -> rests until the
 * next rotation epoch; fled / run / lose / draw / forfeit -> keeps its hp, relocates (hop+1) and rests fleeRestMinutes.
 */
export function onLegendBattleEnd(state: LegendStateMap, species: string, result: BattleResult, info: { hpLeft: number; minutes: number }, g: GameplayData = GAMEPLAY): LegendStateMap {
  const prev = state[species] ?? { hops: 0 }
  const st: LegendState = { ...prev, seen: (prev.seen ?? 0) + 1 }
  if (result === 'caught') {
    st.caught = true
    delete st.hp
    delete st.restUntil
  } else if (result === 'win') {
    st.defeatedDay = dayOf(info.minutes)
    st.hops = prev.hops + 1
    delete st.hp
  } else {
    st.hops = prev.hops + 1
    st.restUntil = info.minutes + g.spawn.legends.fleeRestMinutes
    if (info.hpLeft > 0) st.hp = Math.floor(info.hpLeft)
  }
  return { ...state, [species]: st }
}

/** Nearest tile (Chebyshev rings, then distance) within `radius` where isFree(x, y) holds. */
export function snapToFree(x: number, y: number, isFree: (x: number, y: number) => boolean, radius: number): Point | null {
  const cx = Math.round(x), cy = Math.round(y)
  for (let r = 0; r <= radius; r++) {
    let best: Point | null = null
    let bd = Infinity
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r || !isFree(cx + dx, cy + dy)) continue
        const d = dx * dx + dy * dy
        if (d < bd) { bd = d; best = { x: cx + dx, y: cy + dy } }
      }
    }
    if (best) return best
  }
  return null
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export function sanitizeLegendState(raw: unknown, g: GameplayData = GAMEPLAY): LegendStateMap {
  const out: LegendStateMap = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!g.legendBySpecies[id] || !v || typeof v !== 'object') continue
    const o = v as Record<string, unknown>
    const st: LegendState = { hops: finite(o.hops) && o.hops >= 0 ? Math.floor(o.hops) : 0 }
    if (finite(o.hp) && o.hp > 0) st.hp = Math.floor(o.hp)
    if (finite(o.restUntil)) st.restUntil = o.restUntil
    if (finite(o.defeatedDay)) st.defeatedDay = Math.floor(o.defeatedDay)
    if (o.caught === true) st.caught = true
    if (finite(o.seen) && o.seen >= 0) st.seen = Math.floor(o.seen)
    out[id] = st
  }
  return out
}

// ---------------------------------------------------------------------------------------------- mythic chains

const flagOn = (v: unknown): boolean => v !== undefined && v !== false && v !== 0 && v !== ''

export interface ChainProgress {
  chain: MythicChainDef
  /** Steps solved so far (consecutive from the first). */
  solved: number
  total: number
  done: boolean
  /** Next unsolved step (null when done). */
  next: MythicChainStep | null
}

export function chainProgress(chainId: string, flags: Readonly<Record<string, unknown>>, g: GameplayData = GAMEPLAY): ChainProgress | null {
  const chain = g.chainById[chainId]
  if (!chain) return null
  let solved = 0
  while (solved < chain.steps.length && flagOn(flags[chain.steps[solved].flag])) solved++
  const done = flagOn(flags[chain.doneFlag])
  return { chain, solved, total: chain.steps.length, done, next: done || solved >= chain.steps.length ? null : chain.steps[solved] }
}

/** Progress of every chain with at least one solved step (journal / dex UI). */
export function chainsProgress(flags: Readonly<Record<string, unknown>>, g: GameplayData = GAMEPLAY): ChainProgress[] {
  return g.chains.map((ch) => chainProgress(ch.id, flags, g)!).filter((p) => p.solved > 0 || p.done)
}
