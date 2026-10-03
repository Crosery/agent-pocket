// World events: condition evaluation, the deterministic event scheduler, active-effect resolution and rumors.
// Definitions live in content/events/*.json (GAMEPLAY.events); texts in content/text/zh-CN/events.json.
// Pure and isomorphic: no clocks, no Math.random — callers pass the time, the real date and an IRng.
//
// Runtime API (client):
//   realDateOf(date)                          RealDate from a Date (local time). The only Date use; pass `new Date()`.
//   eventContext(save, env)                   EventContext for this check (save + where the player stands).
//   evaluateCondition(cond, ctx, rng?)        true when every field holds; chancePerCheck is rolled only with an rng.
//   evaluateProgress(cond, ctx)               only the story/progress gates (flags, badges, dex, party, items, events).
//   eventSlot(minutes) / eventRng(seed, m)    check slot index / Rng seeded by (seed, slot) — same save+time => same rolls.
//   tickEvents(state, ctx, rng, opts)         once per new slot: ends expired events, starts eligible 'auto' events.
//   triggerEvent(id, state, ctx, opts)        ScriptStep 'triggerEvent' and legend proximity (trigger 'script'|'legend').
//   endEvent(id, state, minutes)              stop an active event early (e.g. a local event the player walked away from).
//   activeEvents(state, minutes)              currently active events (with defs).
//   eventModifiers(active, at, minutes)       aggregated encounter boosts, multipliers, weather override, ambience cues.
//   modifierValue(mods, target, q?)           product of the matching 'modifier' effects (1 = none).
//   startActions(ev, opts)                    one-shot work when an event starts: flags, rumors, reveals, scripts,
//                                             npcs, trainers (materialised), raw spawn effects, scattered items.
//   availableRumors / pickRumor / rumorFlag   rumor/news-board lines (hidden events are only ever hinted at).
//   resolvePlaceRef(ref, places, from, seen)  'townId' | 'nearest:<template>' -> TownDef (ScriptStep 'revealPlace').
//   eventFocus(def, places, from)             landmark an event gathers at (its when.nearPlace) -> StartOptions.at.
//   festivalCalendar(real, days)              upcoming real-date events for a calendar UI.
//   eventTitle / eventDescription / eventParams   display texts ({species}/{title} for legend events).
//   expandFlag(flag, {year, day})             `{year}`/`{day}` placeholders in event-script flag names.
//   sanitizeEventState(raw)                   repair untrusted SaveData.events.
import type {
  BiomeId, Creature, EventCondition, EventEffect, EventModifierTarget, EventState, FieldWeatherKind, ItemCategory, NpcDef,
  Rarity, SaveData, ScriptStep, TownDef, TrainerDef, TypeId, WorldEventDef,
} from '../types.ts'
import type { IRng } from '../contracts.ts'
import { CONTENT, t, timeOfDayAt, type Content } from '../content/index.ts'
import { Rng, hashString } from '../rng.ts'
import { GAMEPLAY } from './data.ts'
import { pickSpecies } from './picks.ts'
import type { GameplayData, SchedulerRules } from './schema.ts'

/** Calendar structure (not tunable). */
const MINUTES_PER_DAY = 24 * 60
const MINUTES_PER_HOUR = 60
const MS_PER_DAY = 86_400_000

export type EventStateMap = Record<string, EventState>
export type EventAnchor = NonNullable<EventState['anchor']>

// ---------------------------------------------------------------------------------------------- context

export interface RealDate { year: number; month: number; day: number; weekday: number; hour: number; minute: number }

export function realDateOf(d: Date): RealDate {
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), weekday: d.getDay(), hour: d.getHours(), minute: d.getMinutes() }
}

export interface PartyMember { speciesId: string; hp: number }

export interface EventContext {
  /** Absolute in-game minutes (SaveData.clockMinutes). */
  minutes: number
  real: RealDate
  weather: FieldWeatherKind
  biome: BiomeId | null
  regionId: string | null
  regionDanger: number
  /** Tiles from the world origin (worldapi.distanceFromOrigin). */
  distance: number
  outdoor: boolean
  /** Place ids (TownDef ids) within the scheduler's localRadius of the player. */
  nearPlaces: readonly string[]
  flags: Readonly<Record<string, boolean | number | string>>
  badges: number
  dexCaught: readonly string[]
  party: readonly PartyMember[]
  bag: Readonly<Record<string, number>>
  activeEvents: readonly string[]
  doneEvents: readonly string[]
  researchLevel: number
}

export interface ContextEnv {
  real: RealDate
  weather: FieldWeatherKind
  biome: BiomeId | null
  regionId?: string | null
  regionDanger?: number
  distance?: number
  outdoor?: boolean
  nearPlaces?: readonly string[]
  /** Overrides derived from SaveData.events when given. */
  activeEvents?: readonly string[]
  researchLevel?: number
}

export type EventSaveView = Pick<SaveData, 'clockMinutes' | 'flags' | 'badges' | 'dexCaught' | 'party' | 'bag'> & Partial<Pick<SaveData, 'events'>>

export function eventContext(save: EventSaveView, env: ContextEnv): EventContext {
  const minutes = save.clockMinutes
  const state = save.events ?? {}
  const active = env.activeEvents ?? Object.keys(state).filter((id) => isActive(state[id], minutes))
  return {
    minutes,
    real: env.real,
    weather: env.weather,
    biome: env.biome,
    regionId: env.regionId ?? null,
    regionDanger: env.regionDanger ?? 0,
    distance: env.distance ?? 0,
    outdoor: env.outdoor ?? true,
    nearPlaces: env.nearPlaces ?? [],
    flags: save.flags,
    badges: save.badges.length,
    dexCaught: save.dexCaught,
    party: save.party.map((cr: Creature) => ({ speciesId: cr.speciesId, hp: cr.hp })),
    bag: save.bag,
    activeEvents: active,
    doneEvents: Object.keys(state).filter((id) => (state[id]?.count ?? 0) > 0),
    researchLevel: env.researchLevel ?? 0,
  }
}

// ---------------------------------------------------------------------------------------------- conditions

const minuteOfDay = (m: number): number => ((Math.floor(m) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
export const dayOf = (minutes: number): number => Math.floor(minutes / MINUTES_PER_DAY)

/** v in [from, to); wraps when from > to; from === to means the whole cycle. */
function inWrapped(v: number, from: number, to: number): boolean {
  if (from === to) return true
  return from < to ? v >= from && v < to : v >= from || v < to
}

const dayNumber = (y: number, m: number, d: number): number => Math.floor(Date.UTC(y, m - 1, d) / MS_PER_DAY)

/** 'MM-DD' or 'YYYY-MM-DD' -> parts (null when malformed). */
export function parseDateRef(s: string): { year?: number; month: number; day: number } | null {
  const m = /^(?:(\d{4})-)?(\d{2})-(\d{2})$/.exec(s)
  if (!m) return null
  const month = Number(m[2]), day = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return m[1] ? { year: Number(m[1]), month, day } : { month, day }
}

export function inDateRange(real: RealDate, r: { from: string; days: number }): boolean {
  const p = parseDateRef(r.from)
  if (!p) return false
  const today = dayNumber(real.year, real.month, real.day)
  const years = p.year !== undefined ? [p.year] : [real.year, real.year - 1]
  return years.some((y) => {
    const start = dayNumber(y, p.month, p.day)
    return today >= start && today < start + Math.max(1, r.days)
  })
}

function flagMatches(v: boolean | number | string | undefined, want: boolean | number | string): boolean {
  if (want === true) return v !== undefined && v !== false && v !== 0 && v !== ''
  if (want === false) return v === undefined || v === false || v === 0 || v === ''
  return v === want
}

const placeMatches = (id: string, ref: string): boolean => id === ref || id.startsWith(`${ref}-`)

function partyTypes(ctx: EventContext, c: Content): Set<TypeId> {
  const out = new Set<TypeId>()
  for (const m of ctx.party) for (const ty of c.species[m.speciesId]?.types ?? []) out.add(ty)
  return out
}

const leadOf = (ctx: EventContext): string | null => ctx.party.find((m) => m.hp > 0)?.speciesId ?? null

/** Story/progress gates of a condition. `ignoreFlagPrefix` skips flags starting with it (rumor gating). */
export function evaluateProgress(cond: EventCondition, ctx: EventContext, c: Content = CONTENT, ignoreFlagPrefix?: string): boolean {
  if (cond.flags) {
    for (const [k, want] of Object.entries(cond.flags)) {
      if (ignoreFlagPrefix && k.startsWith(ignoreFlagPrefix)) continue
      if (!flagMatches(ctx.flags[k], want)) return false
    }
  }
  if (cond.badgesAtLeast !== undefined && ctx.badges < cond.badgesAtLeast) return false
  if (cond.dexCaughtAtLeast !== undefined && ctx.dexCaught.length < cond.dexCaughtAtLeast) return false
  if (cond.caught && !cond.caught.every((id) => ctx.dexCaught.includes(id))) return false
  if (cond.notCaught && cond.notCaught.some((id) => ctx.dexCaught.includes(id))) return false
  if (cond.partyHasSpecies && !ctx.party.some((m) => m.speciesId === cond.partyHasSpecies)) return false
  if (cond.partyHasType && !partyTypes(ctx, c).has(cond.partyHasType)) return false
  if (cond.partyHasRarity && !ctx.party.some((m) => c.species[m.speciesId]?.rarity === cond.partyHasRarity)) return false
  if (cond.leadSpecies && leadOf(ctx) !== cond.leadSpecies) return false
  if (cond.hasItem && !((ctx.bag[cond.hasItem] ?? 0) > 0)) return false
  if (cond.eventsDone && !cond.eventsDone.every((id) => ctx.doneEvents.includes(id))) return false
  if (cond.researchLevelAtLeast !== undefined && ctx.researchLevel < cond.researchLevelAtLeast) return false
  return true
}

/** Time, calendar, weather and place fields. */
function evaluateEnvironment(cond: EventCondition, ctx: EventContext, c: Content): boolean {
  const mod = minuteOfDay(ctx.minutes)
  if (cond.timeOfDay && !cond.timeOfDay.includes(timeOfDayAt(ctx.minutes, c))) return false
  if (cond.hourRange && !inWrapped(Math.floor(mod / MINUTES_PER_HOUR), cond.hourRange[0], cond.hourRange[1])) return false
  if (cond.minuteRange && !inWrapped(mod, cond.minuteRange[0], cond.minuteRange[1])) return false
  if (cond.dayOfWeek && !cond.dayOfWeek.includes(ctx.real.weekday)) return false
  if (cond.realDate) {
    if (cond.realDate.month !== undefined && cond.realDate.month !== ctx.real.month) return false
    if (cond.realDate.day !== undefined && cond.realDate.day !== ctx.real.day) return false
  }
  if (cond.realDateRanges && !cond.realDateRanges.some((r) => inDateRange(ctx.real, r))) return false
  if (cond.realHourRange && !inWrapped(ctx.real.hour, cond.realHourRange[0], cond.realHourRange[1])) return false
  if (cond.weather && !cond.weather.includes(ctx.weather)) return false
  if (cond.outdoor !== undefined && cond.outdoor !== ctx.outdoor) return false
  if (cond.biomes && !(ctx.biome && cond.biomes.includes(ctx.biome))) return false
  if (cond.regionDangerAtLeast !== undefined && ctx.regionDanger < cond.regionDangerAtLeast) return false
  if (cond.regionDangerAtMost !== undefined && ctx.regionDanger > cond.regionDangerAtMost) return false
  if (cond.minDistance !== undefined && ctx.distance < cond.minDistance) return false
  if (cond.maxDistance !== undefined && ctx.distance > cond.maxDistance) return false
  if (cond.nearPlace && !cond.nearPlace.some((ref) => ctx.nearPlaces.some((id) => placeMatches(id, ref)))) return false
  if (cond.eventsActive && !cond.eventsActive.every((id) => ctx.activeEvents.includes(id))) return false
  return true
}

/**
 * Every field must hold (AND); `anyOf` adds an OR group. chancePerCheck is rolled last and only when `rng` is
 * given, so `evaluateCondition(cond, ctx)` answers "could it fire now?" deterministically.
 */
export function evaluateCondition(cond: EventCondition, ctx: EventContext, rng?: IRng | null, c: Content = CONTENT): boolean {
  if (!evaluateEnvironment(cond, ctx, c) || !evaluateProgress(cond, ctx, c)) return false
  if (cond.anyOf && cond.anyOf.length && !cond.anyOf.some((sub) => evaluateCondition(sub, ctx, rng, c))) return false
  if (rng && cond.chancePerCheck !== undefined && !rng.chance(cond.chancePerCheck)) return false
  return true
}

// ---------------------------------------------------------------------------------------------- scheduler

export interface ActiveEvent {
  id: string
  def: WorldEventDef
  startedAt: number
  endsAt: number
  anchor?: EventAnchor
}

export interface TickOptions {
  defs?: readonly WorldEventDef[]
  rules?: SchedulerRules
  /** Player position — recorded as the anchor of events started by this call. */
  anchor?: EventAnchor
  c?: Content
}

export interface TickResult {
  /** New state (the input is never mutated). Persist as SaveData.events. */
  state: EventStateMap
  started: ActiveEvent[]
  ended: ActiveEvent[]
  /** Active after this tick. */
  active: ActiveEvent[]
}

const isActive = (st: EventState | undefined, minutes: number): boolean => st?.activeUntil !== undefined && st.activeUntil > minutes

export function eventSlot(minutes: number, rules: SchedulerRules = GAMEPLAY.spawn.scheduler): number {
  return Math.floor(minutes / Math.max(1, rules.checkEveryMinutes))
}

/** Rng for one check slot: the same seed + slot always rolls the same way (reloads cannot re-roll). */
export function eventRng(seed: number, minutes: number, rules: SchedulerRules = GAMEPLAY.spawn.scheduler): Rng {
  return new Rng(hashString(`events:${seed >>> 0}:${eventSlot(minutes, rules)}`))
}

function defsById(defs: readonly WorldEventDef[]): Map<string, WorldEventDef> {
  return new Map(defs.map((d) => [d.id, d]))
}

function toActive(def: WorldEventDef, st: EventState): ActiveEvent {
  const startedAt = st.startedAt ?? (st.activeUntil ?? 0) - def.durationMinutes
  const out: ActiveEvent = { id: def.id, def, startedAt, endsAt: st.activeUntil ?? startedAt }
  if (st.anchor) out.anchor = { ...st.anchor }
  return out
}

function cloneState(state: EventStateMap): EventStateMap {
  const out: EventStateMap = {}
  for (const [id, st] of Object.entries(state)) out[id] = { ...st, ...(st.anchor ? { anchor: { ...st.anchor } } : {}) }
  return out
}

/** Can `def` start again (ignoring its condition)? */
function canRestart(def: WorldEventDef, st: EventState | undefined, minutes: number, cooldown: boolean): boolean {
  if (!st) return true
  if (isActive(st, minutes)) return false
  if (!def.repeatable && st.count > 0) return false
  if (cooldown && st.count > 0 && dayOf(minutes) - st.lastDay < def.cooldownDays) return false
  return true
}

function startIn(state: EventStateMap, def: WorldEventDef, minutes: number, anchor: EventAnchor | undefined): ActiveEvent {
  const prev = state[def.id]
  const st: EventState = { lastDay: dayOf(minutes), count: (prev?.count ?? 0) + 1, activeUntil: minutes + Math.max(1, def.durationMinutes), startedAt: minutes }
  if (anchor) st.anchor = { ...anchor }
  state[def.id] = st
  return toActive(def, st)
}

export function activeEvents(state: EventStateMap, minutes: number, defs: readonly WorldEventDef[] = GAMEPLAY.events): ActiveEvent[] {
  const out: ActiveEvent[] = []
  for (const d of defs) if (isActive(state[d.id], minutes)) out.push(toActive(d, state[d.id]))
  return out
}

function shuffled<T>(list: readonly T[], rng: IRng): T[] {
  const out = list.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(0, i)
    const tmp = out[i]; out[i] = out[j]; out[j] = tmp
  }
  return out
}

/**
 * One scheduler check. Ends events whose time is up, then considers every 'auto' event that may restart
 * (repeatable / cooldownDays), is not blocked by an active event of the same `group`, and whose condition holds;
 * candidates are shuffled with `rng`, ordered by priority, and each rolls its chancePerCheck until
 * maxStartsPerCheck / maxActive are reached. Same inputs => same result.
 */
export function tickEvents(state: EventStateMap, ctx: EventContext, rng: IRng, opts: TickOptions = {}): TickResult {
  const defs = opts.defs ?? GAMEPLAY.events
  const rules = opts.rules ?? GAMEPLAY.spawn.scheduler
  const c = opts.c ?? CONTENT
  const byId = defsById(defs)
  const next = cloneState(state)
  const now = ctx.minutes
  const ended: ActiveEvent[] = []
  for (const [id, st] of Object.entries(next)) {
    if (st.activeUntil === undefined || st.activeUntil > now) continue
    const def = byId.get(id)
    if (def) ended.push(toActive(def, st))
    delete st.activeUntil
  }
  const active = activeEvents(next, now, defs)
  const groups = new Set(active.map((a) => a.def.group).filter((g): g is string => !!g))
  const live: EventContext = {
    ...ctx,
    activeEvents: active.map((a) => a.id),
    doneEvents: Object.keys(next).filter((id) => next[id].count > 0),
  }
  const eligible = defs.filter((d) => (d.trigger ?? 'auto') === 'auto' && canRestart(d, next[d.id], now, true)
    && !(d.group && groups.has(d.group)) && evaluateCondition(d.when, live, null, c))
  const ordered = shuffled(eligible, rng).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
  const started: ActiveEvent[] = []
  let autoActive = active.filter((a) => (a.def.trigger ?? 'auto') === 'auto').length
  for (const d of ordered) {
    if (started.length >= rules.maxStartsPerCheck || autoActive >= rules.maxActive) break
    if (d.group && groups.has(d.group)) continue
    if (!evaluateCondition(d.when, live, rng, c)) continue
    started.push(startIn(next, d, now, opts.anchor))
    if (d.group) groups.add(d.group)
    autoActive++
  }
  return { state: next, started, ended, active: activeEvents(next, now, defs) }
}

export interface TriggerOptions {
  defs?: readonly WorldEventDef[]
  anchor?: EventAnchor
  /** 'progress' (default, ScriptStep triggerEvent): only story gates; 'all': the whole condition minus chance. */
  check?: 'progress' | 'all'
  c?: Content
}

export interface TriggerResult {
  state: EventStateMap
  started: ActiveEvent | null
  /** Why nothing started. */
  reason?: 'unknown' | 'active' | 'spent' | 'gated'
}

/** Starts an event now regardless of its trigger kind, cooldown and chance (repeatable and gates still apply). */
export function triggerEvent(id: string, state: EventStateMap, ctx: EventContext, opts: TriggerOptions = {}): TriggerResult {
  const defs = opts.defs ?? GAMEPLAY.events
  const c = opts.c ?? CONTENT
  const def = defs.find((d) => d.id === id)
  if (!def) return { state, started: null, reason: 'unknown' }
  const st = state[id]
  if (isActive(st, ctx.minutes)) return { state, started: null, reason: 'active' }
  if (!canRestart(def, st, ctx.minutes, false)) return { state, started: null, reason: 'spent' }
  const ok = opts.check === 'all' ? evaluateCondition(def.when, ctx, null, c) : evaluateProgress(def.when, ctx, c)
  if (!ok) return { state, started: null, reason: 'gated' }
  const next = cloneState(state)
  return { state: next, started: startIn(next, def, ctx.minutes, opts.anchor) }
}

export function endEvent(id: string, state: EventStateMap, minutes: number): EventStateMap {
  if (!isActive(state[id], minutes)) return state
  const next = cloneState(state)
  next[id].activeUntil = minutes
  return next
}

// ---------------------------------------------------------------------------------------------- active effects

export interface EncounterBoost { types?: TypeId[]; rarities?: Rarity[]; species?: string[]; multiplier: number; event: string }
export interface ModifierEntry { target: EventModifierTarget; multiplier: number; types?: TypeId[]; categories?: ItemCategory[]; event: string }

export interface EventModifiers {
  encounterBoosts: EncounterBoost[]
  modifiers: ModifierEntry[]
  /** Latest-started weather override among applicable events (null = none). */
  weather: FieldWeatherKind | null
  /** Ambience cue keys the renderer/HUD should show. */
  ambience: string[]
  /** Event ids that apply at this position. */
  events: string[]
}

export const NO_MODIFIERS: EventModifiers = { encounterBoosts: [], modifiers: [], weather: null, ambience: [], events: [] }

/** Does an active event apply at `at` (scope global / same region / within localRadius of its anchor)? */
export function eventAppliesAt(ev: ActiveEvent, at: EventAnchor | null, rules: SchedulerRules = GAMEPLAY.spawn.scheduler): boolean {
  if (ev.def.scope === 'global' || !ev.anchor) return true
  if (!at || at.map !== ev.anchor.map) return false
  if (ev.def.scope === 'region' && ev.anchor.region && at.region) return ev.anchor.region === at.region
  const r = ev.def.scope === 'region' ? rules.regionRadius : rules.localRadius
  return Math.hypot(at.x - ev.anchor.x, at.y - ev.anchor.y) <= r
}

const effectLive = (ev: ActiveEvent, minutes: number, effMinutes: number): boolean =>
  minutes < (effMinutes > 0 ? Math.min(ev.endsAt, ev.startedAt + effMinutes) : ev.endsAt)

export function eventModifiers(active: readonly ActiveEvent[], at: EventAnchor | null, minutes: number, rules: SchedulerRules = GAMEPLAY.spawn.scheduler): EventModifiers {
  const out: EventModifiers = { encounterBoosts: [], modifiers: [], weather: null, ambience: [], events: [] }
  let weatherAt = -Infinity
  for (const ev of active) {
    if (minutes >= ev.endsAt || !eventAppliesAt(ev, at, rules)) continue
    out.events.push(ev.id)
    for (const e of ev.def.effects) {
      if (e.kind === 'encounterBoost' && effectLive(ev, minutes, e.minutes)) {
        out.encounterBoosts.push({ types: e.types, rarities: e.rarities, species: e.species, multiplier: e.multiplier, event: ev.id })
      } else if (e.kind === 'modifier' && effectLive(ev, minutes, e.minutes)) {
        out.modifiers.push({ target: e.target, multiplier: e.multiplier, types: e.types, categories: e.categories, event: ev.id })
      } else if (e.kind === 'weather' && effectLive(ev, minutes, e.minutes) && ev.startedAt >= weatherAt) {
        out.weather = e.weather
        weatherAt = ev.startedAt
      } else if (e.kind === 'ambience' && effectLive(ev, minutes, e.minutes) && !out.ambience.includes(e.cue)) {
        out.ambience.push(e.cue)
      }
    }
  }
  return out
}

/** Product of matching modifier effects. Qualified effects (types/categories) only match a matching qualifier. */
export function modifierValue(mods: EventModifiers, target: EventModifierTarget, q: { types?: readonly TypeId[]; category?: ItemCategory } = {}): number {
  let m = 1
  for (const e of mods.modifiers) {
    if (e.target !== target) continue
    if (e.types?.length && !(q.types ?? []).some((ty) => e.types!.includes(ty))) continue
    if (e.categories?.length && !(q.category && e.categories.includes(q.category))) continue
    m *= e.multiplier
  }
  return m
}

// ---------------------------------------------------------------------------------------------- start actions

export type SpawnEffect = Extract<EventEffect, { kind: 'spawn' }>

export interface StartActions {
  flags: { flag: string; value: boolean | number | string }[]
  /** Text keys to toast / log (rumor effects). */
  rumors: string[]
  /** Place refs for revealPlace (resolvePlaceRef). */
  reveals: string[]
  scripts: ScriptStep[][]
  /** NPCs to place while the event is active (ids `ev:<event>:<npc>`; names resolved). */
  npcs: NpcDef[]
  /** Pop-up trainers: register `trainer` into world.trainers and place `npc` (role 'trainer'). */
  trainers: { trainer: TrainerDef; npc: NpcDef }[]
  /** Raw spawn effects — resolve each with spawns.resolveSpawnEffect(effect, areaLevel, rng). */
  spawns: SpawnEffect[]
  /** Ground items to drop around the anchor (ids `ev:<event>:item<k>`). */
  items: { id: string; x: number; y: number; item: string; qty: number; hidden: boolean }[]
}

export interface StartOptions {
  /** Level band of the area the event started in (region levelRange). */
  areaLevel: [number, number]
  rng: IRng
  /** Placement origin; defaults to the event anchor (or 0,0). */
  at?: { x: number; y: number }
  rules?: SchedulerRules
  c?: Content
  g?: GameplayData
}

const nsId = (ev: string, id: string): string => `ev:${ev}:${id}`

function ringPoint(origin: { x: number; y: number }, ring: [number, number], rng: IRng): { x: number; y: number } {
  const a = rng.next() * Math.PI * 2
  const r = ring[0] + rng.next() * Math.max(0, ring[1] - ring[0])
  return { x: Math.round(origin.x + Math.cos(a) * r), y: Math.round(origin.y + Math.sin(a) * r) }
}

export function startActions(ev: ActiveEvent, opts: StartOptions): StartActions {
  const c = opts.c ?? CONTENT
  const g = opts.g ?? GAMEPLAY
  const rules = opts.rules ?? g.spawn.scheduler
  const origin = opts.at ?? (ev.anchor ? { x: ev.anchor.x, y: ev.anchor.y } : { x: 0, y: 0 })
  const place = (offset?: [number, number]) => (offset ? { x: origin.x + offset[0], y: origin.y + offset[1] } : ringPoint(origin, rules.placeRing, opts.rng))
  const out: StartActions = { flags: [], rumors: [], reveals: [], scripts: [], npcs: [], trainers: [], spawns: [], items: [] }
  let k = 0
  for (const e of ev.def.effects) {
    switch (e.kind) {
      case 'setFlag': out.flags.push({ flag: e.flag, value: e.value ?? true }); break
      case 'rumor': out.rumors.push(e.text); break
      case 'reveal': out.reveals.push(e.place); break
      case 'script': out.scripts.push(e.steps); break
      case 'spawn': out.spawns.push(e); break
      case 'npc': {
        const p = place(e.offset)
        out.npcs.push({ ...e.npc, id: nsId(ev.id, e.npc.id), nameZh: t(e.npc.nameZh, undefined, c), x: p.x, y: p.y })
        break
      }
      case 'trainer': {
        const p = place(e.offset)
        const top = opts.areaLevel[1]
        const avoid = g.spawn.pickExcludeRarities
        const party = e.party.map((m) => {
          const level = Math.max(1, Math.min(c.config.party.maxLevel, top + m.levelOffset))
          return { species: m.species ?? pickSpecies(m.pick ?? {}, level, opts.rng, avoid, c) ?? c.speciesList[0].id, level }
        })
        const id = nsId(ev.id, e.id)
        const trainer: TrainerDef = {
          id, nameZh: t(e.nameZh, undefined, c), classZh: t(e.classZh, undefined, c), sprite: e.sprite, party, reward: e.reward,
          introText: e.introText.map((k) => t(k, undefined, c)), defeatText: e.defeatText.map((k) => t(k, undefined, c)), aiLevel: e.aiLevel,
        }
        out.trainers.push({ trainer, npc: { id, x: p.x, y: p.y, facing: 'down', sprite: e.sprite, nameZh: trainer.nameZh, role: 'trainer', script: [], trainer: id, sightRange: e.sightRange ?? rules.trainerSightRange } })
        break
      }
      case 'scatter':
        for (let i = 0; i < e.count; i++) {
          const p = ringPoint(origin, [0, e.radius], opts.rng)
          out.items.push({ id: nsId(ev.id, `item${k++}`), x: p.x, y: p.y, item: e.item, qty: 1, hidden: e.hidden })
        }
        break
      default: break
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------- rumors

export interface Rumor {
  event: string
  /** Text key. */
  text: string
  hidden: boolean
  chain?: string
  heard: boolean
}

export function rumorFlag(eventId: string, g: GameplayData = GAMEPLAY): string {
  return `${g.spawn.rumor.flagPrefix}${eventId}`
}

/**
 * Rumors that may be told now: not active, not spent, and `rumorWhen` holds (default: the progress gates of `when`,
 * ignoring `rumor:` flags so a rumor never waits for itself).
 */
export function availableRumors(ctx: EventContext, state: EventStateMap, g: GameplayData = GAMEPLAY, c: Content = CONTENT): Rumor[] {
  const prefix = g.spawn.rumor.flagPrefix
  const out: Rumor[] = []
  for (const d of g.events) {
    if (!d.rumor || !canRestart(d, state[d.id], ctx.minutes, false)) continue
    const told = d.rumorWhen ? evaluateCondition(d.rumorWhen, ctx, null, c) : evaluateProgress(d.when, ctx, c, prefix)
    if (!told) continue
    const r: Rumor = { event: d.id, text: d.rumor, hidden: d.hidden, heard: flagMatches(ctx.flags[rumorFlag(d.id, g)], true) }
    if (d.chain) r.chain = d.chain
    out.push(r)
  }
  return out
}

/** Weighted rumor pick (chain clues > hidden > legends > public, unheard first). Set rumorFlag(r.event) once told. */
export function pickRumor(ctx: EventContext, state: EventStateMap, rng: IRng, g: GameplayData = GAMEPLAY, c: Content = CONTENT): Rumor | null {
  const list = availableRumors(ctx, state, g, c)
  if (!list.length) return null
  const R = g.spawn.rumor
  return rng.weighted(list, (r) => {
    const base = r.chain ? R.chainWeight : g.eventById[r.event]?.trigger === 'legend' ? R.legendWeight : r.hidden ? R.hiddenWeight : R.visibleWeight
    return base * (r.heard ? R.heardWeightMul : 1)
  })
}

// ---------------------------------------------------------------------------------------------- places, calendar, text

const NEAREST = 'nearest:'

/** 'townId' (exact) or 'nearest:<template>' (closest place whose id is `<template>-n`, undiscovered first). */
export function resolvePlaceRef(ref: string, places: readonly TownDef[], from: { x: number; y: number }, discovered: readonly string[] = []): TownDef | null {
  if (!ref.startsWith(NEAREST)) return places.find((p) => p.id === ref) ?? null
  const tpl = ref.slice(NEAREST.length)
  const cands = places.filter((p) => placeMatches(p.id, tpl) && p.id !== tpl)
  const fresh = cands.filter((p) => !discovered.includes(p.id))
  const pool = fresh.length ? fresh : cands
  let best: TownDef | null = null
  let bd = Infinity
  for (const p of pool) {
    const d = Math.hypot(p.x - from.x, p.y - from.y)
    if (d < bd || (d === bd && best && p.id < best.id)) { best = p; bd = d }
  }
  return best
}

/**
 * Where an event's NPCs/trainers/items should gather: the nearest place matching its `when.nearPlace` (e.g. the
 * monolith a stele riddle belongs to). Pass its (x, y) as StartOptions.at; null = use the anchor (player position).
 */
export function eventFocus(def: WorldEventDef, places: readonly TownDef[], from: { x: number; y: number }): TownDef | null {
  const refs = def.when.nearPlace ?? def.when.anyOf?.flatMap((x) => x.nearPlace ?? []) ?? []
  let best: TownDef | null = null
  let bd = Infinity
  for (const p of places) {
    if (!refs.some((r) => placeMatches(p.id, r))) continue
    const d = Math.hypot(p.x - from.x, p.y - from.y)
    if (d < bd) { best = p; bd = d }
  }
  return best
}

/** Template part of a place ref ('nearest:monolith' -> 'monolith'; exact ids -> null). */
export function placeRefTemplate(ref: string): string | null {
  return ref.startsWith(NEAREST) ? ref.slice(NEAREST.length) : null
}

/** Real-date events whose window opens within `days` days from `real` (today included), soonest first. */
export function festivalCalendar(real: RealDate, days: number, g: GameplayData = GAMEPLAY): { event: string; inDays: number }[] {
  const out: { event: string; inDays: number }[] = []
  const today = dayNumber(real.year, real.month, real.day)
  for (const d of g.events) {
    const ranges = d.when.realDateRanges
    if (!ranges || d.hidden) continue
    let best = Infinity
    for (let i = 0; i <= days && best === Infinity; i++) {
      const dt = new Date((today + i) * MS_PER_DAY)
      const r: RealDate = { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate(), weekday: dt.getUTCDay(), hour: 0, minute: 0 }
      if (ranges.some((x) => inDateRange(r, x))) best = i
    }
    if (best !== Infinity) out.push({ event: d.id, inDays: best })
  }
  return out.sort((a, b) => a.inDays - b.inDays || (a.event < b.event ? -1 : 1))
}

/** Text params for an event: {species} / {title} of its roaming legend (title key: events.legend.<species>.title). */
export function eventParams(def: WorldEventDef, c: Content = CONTENT): Record<string, string> {
  const sp = def.legend ? c.species[def.legend] : undefined
  return sp ? { species: sp.nameZh, title: t(`events.legend.${sp.id}.title`, undefined, c) } : {}
}

export function eventTitle(def: WorldEventDef, c: Content = CONTENT): string {
  return t(def.nameZh, eventParams(def, c), c)
}

export function eventDescription(def: WorldEventDef, c: Content = CONTENT): string {
  return t(def.description, eventParams(def, c), c)
}

/**
 * Flag names inside event scripts may contain `{year}` (real local year) and `{day}` (in-game day) so that
 * festival / daily gifts reset: the ScriptRunner must expand every setFlag/ifFlag name with this before use.
 */
export function expandFlag(flag: string, vars: { year: number; day: number }): string {
  return flag.replace(/\{year\}/g, String(vars.year)).replace(/\{day\}/g, String(vars.day))
}

// ---------------------------------------------------------------------------------------------- save repair

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Keeps well-formed entries for known events (unknown ids are dropped). */
export function sanitizeEventState(raw: unknown, g: GameplayData = GAMEPLAY): EventStateMap {
  const out: EventStateMap = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!g.eventById[id] || !v || typeof v !== 'object') continue
    const o = v as Record<string, unknown>
    if (!finite(o.lastDay) || !finite(o.count) || o.count < 0) continue
    const st: EventState = { lastDay: Math.floor(o.lastDay), count: Math.floor(o.count) }
    if (finite(o.activeUntil)) st.activeUntil = o.activeUntil
    if (finite(o.startedAt)) st.startedAt = o.startedAt
    const a = o.anchor as Record<string, unknown> | undefined
    if (a && typeof a === 'object' && typeof a.map === 'string' && finite(a.x) && finite(a.y)) {
      st.anchor = { map: a.map, x: a.x, y: a.y, ...(typeof a.region === 'string' ? { region: a.region } : {}) }
    }
    out[id] = st
  }
  return out
}

/** Stable per-event salt for callers that need their own Rng (e.g. placement): new Rng(eventSalt(seed, ev)). */
export function eventSalt(seed: number, ev: ActiveEvent): number {
  return hashString(`${seed >>> 0}:${ev.id}:${ev.startedAt}`)
}

