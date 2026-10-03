// World events: condition evaluation (incl. hour wrap / real dates), scheduler determinism + cooldowns, triggers,
// modifiers, start actions, rumors, places, calendar, save repair and the content validator.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT, validateContent } from '../src/shared/content/index.ts'
import type { EventCondition, TownDef, WorldEventDef } from '../src/shared/types.ts'
import { Rng } from '../src/shared/rng.ts'
import {
  activeEvents, availableRumors, endEvent, evaluateCondition, eventFocus, evaluateProgress, eventContext, eventModifiers, eventRng, eventSlot,
  expandFlag, festivalCalendar, inDateRange, modifierValue, pickRumor, realDateOf, resolvePlaceRef, rumorFlag, sanitizeEventState,
  startActions, tickEvents, triggerEvent, type EventContext, type EventStateMap, type RealDate,
} from '../src/shared/gameplay/events.ts'
import { GAMEPLAY } from '../src/shared/gameplay/data.ts'
import { validateGameplay } from '../src/shared/gameplay/validate.ts'
import type { GameplayData } from '../src/shared/gameplay/schema.ts'

const DAY = 1440
const at = (h: number, m = 0, day = 0) => day * DAY + h * 60 + m
const REAL: RealDate = { year: 2026, month: 10, day: 3, weekday: 6, hour: 15, minute: 0 }
const sp = (type: string) => CONTENT.speciesList.find((s) => s.types.includes(type) && !s.starter)!.id

function ctx(o: Partial<EventContext> = {}): EventContext {
  return {
    minutes: at(12), real: REAL, weather: 'clear', biome: 'meadow', regionId: 'meadow', regionDanger: 0, distance: 0, outdoor: true,
    nearPlaces: [], flags: {}, badges: 0, dexCaught: [], party: [], bag: {}, activeEvents: [], doneEvents: [], researchLevel: 0, ...o,
  }
}
const ok = (cond: EventCondition, o: Partial<EventContext> = {}) => evaluateCondition(cond, ctx(o))

function ev(id: string, o: Partial<WorldEventDef> = {}): WorldEventDef {
  return {
    id, nameZh: `events.ev.${id}.name`, description: '', hidden: false, scope: 'global', when: {}, effects: [], durationMinutes: 60,
    cooldownDays: 0, repeatable: true, ...o,
  }
}

// ------------------------------------------------------------------------------------------- conditions

test('hourRange / minuteRange wrap past midnight; from === to is the whole cycle', () => {
  const night: EventCondition = { hourRange: [22, 4] }
  assert.equal(ok(night, { minutes: at(23) }), true)
  assert.equal(ok(night, { minutes: at(22, 0) }), true)
  assert.equal(ok(night, { minutes: at(3, 59) }), true)
  assert.equal(ok(night, { minutes: at(4, 0) }), false)
  assert.equal(ok(night, { minutes: at(12) }), false)
  assert.equal(ok(night, { minutes: at(23, 30, 41) }), true, 'any day')
  assert.equal(ok({ hourRange: [23, 0] }, { minutes: at(23, 59) }), true)
  assert.equal(ok({ hourRange: [23, 0] }, { minutes: at(0, 0) }), false)
  assert.equal(ok({ hourRange: [5, 5] }, { minutes: at(17) }), true)
  const eerie: EventCondition = { minuteRange: [213, 220] }
  assert.equal(ok(eerie, { minutes: at(3, 33) }), true)
  assert.equal(ok(eerie, { minutes: at(3, 32) }), false)
  assert.equal(ok({ minuteRange: [1430, 5] }, { minutes: at(0, 2) }), true)
  assert.equal(ok({ minuteRange: [1430, 5] }, { minutes: at(23, 49, 2) }), false)
  assert.equal(ok({ timeOfDay: ['night'] }, { minutes: at(2) }), true)
  assert.equal(ok({ timeOfDay: ['night'] }, { minutes: at(12) }), false)
})

test('real dates: yearly windows wrap the new year, fixed-year windows only that year, exact realDate and weekday', () => {
  const r = (y: number, m: number, d: number, weekday = 0): RealDate => ({ year: y, month: m, day: d, weekday, hour: 10, minute: 0 })
  const ny = { from: '12-31', days: 2 }
  assert.equal(inDateRange(r(2026, 12, 31), ny), true)
  assert.equal(inDateRange(r(2027, 1, 1), ny), true)
  assert.equal(inDateRange(r(2027, 1, 2), ny), false)
  assert.equal(inDateRange(r(2026, 12, 30), ny), false)
  const cny = { from: '2027-02-06', days: 7 }
  assert.equal(inDateRange(r(2027, 2, 12), cny), true)
  assert.equal(inDateRange(r(2027, 2, 13), cny), false)
  assert.equal(inDateRange(r(2028, 2, 6), cny), false)
  assert.equal(inDateRange(r(2026, 2, 28), { from: '02-28', days: 2 }), true)
  assert.equal(inDateRange(r(2026, 3, 1), { from: '02-28', days: 2 }), true, 'non-leap year rolls into March')
  assert.equal(inDateRange(r(2026, 3, 2), { from: '02-28', days: 2 }), false)
  assert.equal(inDateRange(r(2026, 1, 1), { from: 'nonsense', days: 3 }), false)
  assert.equal(ok({ realDate: { month: 10, day: 3 } }), true)
  assert.equal(ok({ realDate: { month: 10, day: 4 } }), false)
  assert.equal(ok({ dayOfWeek: [6] }), true)
  assert.equal(ok({ dayOfWeek: [5] }), false)
  assert.equal(ok({ realHourRange: [22, 2] }, { real: { ...REAL, hour: 1 } }), true)
  assert.equal(ok({ realHourRange: [22, 2] }), false)
  const d = new Date(2026, 9, 3, 15, 30)
  assert.deepEqual(realDateOf(d), { year: 2026, month: 10, day: 3, weekday: d.getDay(), hour: 15, minute: 30 })
})

test('place, weather, region, distance and progress fields', () => {
  assert.equal(ok({ weather: ['fog', 'rain'] }, { weather: 'rain' }), true)
  assert.equal(ok({ weather: ['fog'] }), false)
  assert.equal(ok({ biomes: ['meadow'] }, { biome: null }), false)
  assert.equal(ok({ regionDangerAtLeast: 2, regionDangerAtMost: 3 }, { regionDanger: 2 }), true)
  assert.equal(ok({ regionDangerAtLeast: 2 }, { regionDanger: 1 }), false)
  assert.equal(ok({ minDistance: 100, maxDistance: 200 }, { distance: 150 }), true)
  assert.equal(ok({ minDistance: 100 }, { distance: 99 }), false)
  assert.equal(ok({ outdoor: true }, { outdoor: false }), false)
  assert.equal(ok({ nearPlace: ['monolith'] }, { nearPlaces: ['monolith-3'] }), true)
  assert.equal(ok({ nearPlace: ['monolith'] }, { nearPlaces: ['monolithic-3', 'shrine-1'] }), false)
  assert.equal(ok({ nearPlace: ['agi'] }, { nearPlaces: ['agi'] }), true)
  // flags: true = set (truthy), false = unset/falsy, values = strict equality
  const flags = { a: true, n: 2, s: 'x', z: 0 }
  assert.equal(ok({ flags: { a: true, missing: false, z: false } }, { flags }), true)
  assert.equal(ok({ flags: { n: 2, s: 'x' } }, { flags }), true)
  assert.equal(ok({ flags: { n: 3 } }, { flags }), false)
  assert.equal(ok({ flags: { a: false } }, { flags }), false)
  assert.equal(ok({ flags: { z: true } }, { flags }), false)
  const code = sp('code'), chaos = sp('chaos')
  const party = [{ speciesId: chaos, hp: 0 }, { speciesId: code, hp: 10 }]
  assert.equal(ok({ leadSpecies: code }, { party }), true, 'lead = first conscious')
  assert.equal(ok({ leadSpecies: chaos }, { party }), false)
  assert.equal(ok({ partyHasType: 'chaos', partyHasSpecies: code }, { party }), true)
  assert.equal(ok({ partyHasRarity: CONTENT.species[code].rarity }, { party }), true)
  assert.equal(ok({ badgesAtLeast: 2, dexCaughtAtLeast: 1, hasItem: 'repel' }, { badges: 2, dexCaught: [code], bag: { repel: 1 } }), true)
  assert.equal(ok({ hasItem: 'repel' }, { bag: { repel: 0 } }), false)
  assert.equal(ok({ caught: [code], notCaught: [chaos] }, { dexCaught: [code] }), true)
  assert.equal(ok({ notCaught: [chaos] }, { dexCaught: [chaos] }), false)
  assert.equal(ok({ eventsActive: ['x'], eventsDone: ['y'] }, { activeEvents: ['x'], doneEvents: ['y'] }), true)
  assert.equal(ok({ researchLevelAtLeast: 3 }, { researchLevel: 2 }), false)
  assert.equal(evaluateProgress({ weather: ['fog'], badgesAtLeast: 1 }, ctx({ badges: 1 })), true, 'progress ignores weather')
})

test('anyOf is an OR group; chancePerCheck is rolled only with an rng', () => {
  const c: EventCondition = { anyOf: [{ weather: ['fog'] }, { timeOfDay: ['night'] }] }
  assert.equal(ok(c, { weather: 'fog' }), true)
  assert.equal(ok(c, { minutes: at(1) }), true)
  assert.equal(ok(c), false)
  const never: EventCondition = { chancePerCheck: 0 }
  assert.equal(evaluateCondition(never, ctx()), true, 'no rng => deterministic part only')
  assert.equal(evaluateCondition(never, ctx(), new Rng(1)), false)
  let hits = 0
  const rng = new Rng(5)
  for (let i = 0; i < 1000; i++) if (evaluateCondition({ chancePerCheck: 0.25 }, ctx(), rng)) hits++
  assert.ok(hits > 200 && hits < 300, `${hits}`)
})

// ------------------------------------------------------------------------------------------- scheduler

const DEFS: WorldEventDef[] = [
  ev('a', { when: { chancePerCheck: 0.5 }, cooldownDays: 1, group: 'weather' }),
  ev('b', { when: { chancePerCheck: 0.5 }, group: 'weather' }),
  ev('c', { when: { timeOfDay: ['night'] }, repeatable: false, priority: 5 }),
  ev('d', { trigger: 'script', when: { badgesAtLeast: 1, weather: ['fog'] } }),
  ev('e', { when: {}, priority: -1 }),
]
const RULES = { ...GAMEPLAY.spawn.scheduler, maxStartsPerCheck: 1, maxActive: 3 }

test('tickEvents is deterministic for the same state/context/rng and never mutates its input', () => {
  const state: EventStateMap = { a: { lastDay: 0, count: 1 } }
  const snapshot = JSON.stringify(state)
  const run = (seed: number) => tickEvents(state, ctx({ minutes: at(12, 0, 3) }), new Rng(seed), { defs: DEFS, rules: RULES, anchor: { map: 'overworld', x: 5, y: 6 } })
  assert.deepEqual(run(11), run(11))
  assert.equal(JSON.stringify(state), snapshot)
  const outcomes = new Set(Array.from({ length: 30 }, (_, s) => run(s).started.map((x) => x.id).join(',')))
  assert.ok(outcomes.size > 1, 'different rolls start different events')
  // eventRng is a pure function of (seed, slot)
  assert.equal(eventRng(42, at(5)).next(), eventRng(42, at(5)).next())
  assert.equal(eventSlot(at(5, 0)) === eventSlot(at(5, 0) + 0.5), true)
})

test('priority, maxStartsPerCheck, groups, cooldown, repeatable and expiry', () => {
  // Night: 'c' (priority 5) always wins the single start.
  let r = tickEvents({}, ctx({ minutes: at(1) }), new Rng(3), { defs: DEFS, rules: RULES })
  assert.deepEqual(r.started.map((x) => x.id), ['c'])
  assert.equal(r.state.c.activeUntil, at(1) + 60)
  assert.deepEqual(r.active.map((x) => x.id), ['c'])
  // While active it is not restarted; non-repeatable never again after it ended.
  r = tickEvents(r.state, ctx({ minutes: at(1, 30) }), new Rng(4), { defs: DEFS, rules: RULES })
  assert.ok(!r.started.some((x) => x.id === 'c'))
  r = tickEvents(r.state, ctx({ minutes: at(2, 30, 5) }), new Rng(5), { defs: DEFS, rules: { ...RULES, maxStartsPerCheck: 5 } })
  assert.ok(r.ended.some((x) => x.id === 'c'))
  assert.equal(r.state.c.activeUntil, undefined)
  assert.ok(!r.started.some((x) => x.id === 'c'))
  // Group 'weather': at most one of a/b at a time.
  let groupBoth = 0
  for (let s = 0; s < 40; s++) {
    const g = tickEvents({}, ctx(), new Rng(s), { defs: DEFS, rules: { ...RULES, maxStartsPerCheck: 5 } })
    const ids = g.started.map((x) => x.id)
    if (ids.includes('a') && ids.includes('b')) groupBoth++
    assert.ok(!ids.includes('d'), 'script-trigger events never auto-start')
  }
  assert.equal(groupBoth, 0)
  // Cooldown: 'a' ended on day 3 with cooldown 1 -> not on day 3, eligible on day 4.
  const cooled: EventStateMap = { a: { lastDay: 3, count: 1 }, b: { lastDay: 3, count: 1, activeUntil: at(23, 0, 3) } }
  const only = (minutes: number) => tickEvents(cooled, ctx({ minutes }), new Rng(1), { defs: [DEFS[0]], rules: RULES })
  for (let s = 0; s < 10; s++) assert.equal(only(at(13, s, 3)).started.length, 0)
  let later = 0
  for (let s = 0; s < 20; s++) later += tickEvents(cooled, ctx({ minutes: at(13, 0, 4) }), new Rng(s), { defs: [DEFS[0]], rules: RULES }).started.length
  assert.ok(later > 0)
})

test('maxActive caps auto events', () => {
  const many = Array.from({ length: 6 }, (_, i) => ev(`m${i}`))
  let state: EventStateMap = {}
  for (let i = 0; i < 6; i++) state = tickEvents(state, ctx({ minutes: at(10, i) }), new Rng(i), { defs: many, rules: { ...RULES, maxActive: 3 } }).state
  assert.equal(activeEvents(state, at(10, 6), many).length, 3)
})

test('triggerEvent ignores environment, cooldown and chance but respects progress gates and repeatable', () => {
  const d = DEFS[3]
  assert.equal(triggerEvent('nope', {}, ctx()).reason, 'unknown')
  assert.equal(triggerEvent(d.id, {}, ctx(), { defs: DEFS }).reason, 'gated')
  const r = triggerEvent(d.id, {}, ctx({ badges: 1 }), { defs: DEFS, anchor: { map: 'overworld', x: 1, y: 2 } })
  assert.equal(r.started?.id, 'd')
  assert.deepEqual(r.state.d.anchor, { map: 'overworld', x: 1, y: 2 })
  assert.equal(triggerEvent(d.id, r.state, ctx({ badges: 1 }), { defs: DEFS }).reason, 'active')
  assert.equal(triggerEvent(d.id, {}, ctx({ badges: 1 }), { defs: DEFS, check: 'all' }).reason, 'gated', "'all' also checks weather")
  const spent = triggerEvent('c', { c: { lastDay: 0, count: 1 } }, ctx(), { defs: DEFS })
  assert.equal(spent.reason, 'spent')
  const ended = endEvent('d', r.state, at(12, 5))
  assert.equal(activeEvents(ended, at(12, 5), DEFS).length, 0)
  const empty: EventStateMap = {}
  assert.equal(endEvent('d', empty, 0), empty, 'ending an inactive event returns the same state')
})

// ------------------------------------------------------------------------------------------- effects

test('eventModifiers honours scope, effect windows and qualifiers; startActions materialises npcs/trainers/items', () => {
  const defs: WorldEventDef[] = [
    ev('g', { effects: [{ kind: 'encounterBoost', types: ['code'], multiplier: 3, minutes: 0 }, { kind: 'modifier', target: 'shopPrice', multiplier: 1.5, minutes: 0, categories: ['ball'] }, { kind: 'weather', weather: 'snow', minutes: 30 }] }),
    ev('l', { scope: 'local', effects: [{ kind: 'modifier', target: 'shopPrice', multiplier: 2, minutes: 0 }, { kind: 'ambience', cue: 'glitch', minutes: 0 }, { kind: 'weather', weather: 'fog', minutes: 0 }] }),
  ]
  let state: EventStateMap = {}
  state = triggerEvent('g', state, ctx({ minutes: 100 }), { defs }).state
  state = triggerEvent('l', state, ctx({ minutes: 110 }), { defs, anchor: { map: 'overworld', x: 0, y: 0 } }).state
  const active = activeEvents(state, 120, defs)
  const near = eventModifiers(active, { map: 'overworld', x: 3, y: 4 }, 120)
  const far = eventModifiers(active, { map: 'overworld', x: 500, y: 0 }, 120)
  assert.deepEqual(near.events.sort(), ['g', 'l'])
  assert.deepEqual(far.events, ['g'])
  assert.equal(near.weather, 'fog', 'latest-started weather wins')
  assert.equal(far.weather, 'snow')
  assert.equal(eventModifiers(active, { map: 'overworld', x: 500, y: 0 }, 140).weather, null, 'global weather expired after its 30 minutes')
  assert.deepEqual(eventModifiers(active, null, 120).events, ['g'], 'no position: only global events apply')
  assert.deepEqual(near.ambience, ['glitch'])
  assert.equal(modifierValue(near, 'shopPrice', { category: 'ball' }), 3)
  assert.equal(modifierValue(near, 'shopPrice', { category: 'medicine' }), 2)
  assert.equal(modifierValue(far, 'shopPrice', { category: 'medicine' }), 1)
  assert.equal(far.encounterBoosts[0].multiplier, 3)

  const real = GAMEPLAY.eventById['benchmark-tournament']
  const run = triggerEvent(real.id, {}, ctx({ badges: 5 }), { anchor: { map: 'overworld', x: 100, y: 100 } })
  const acts = startActions(run.started!, { areaLevel: [20, 30], rng: new Rng(9) })
  assert.equal(acts.trainers.length, 3)
  for (const tr of acts.trainers) {
    assert.ok(tr.trainer.id.startsWith('ev:benchmark-tournament:'))
    assert.equal(tr.npc.trainer, tr.trainer.id)
    assert.ok(tr.trainer.party.every((m) => m.level >= 30 && CONTENT.species[m.species!]))
    assert.ok(Math.hypot(tr.npc.x - 100, tr.npc.y - 100) <= GAMEPLAY.spawn.scheduler.placeRing[1] + 1)
    assert.ok(!tr.trainer.nameZh.startsWith('events.'), 'names resolved')
  }
  const rain = startActions(triggerEvent('token-rain', {}, ctx()).started!, { areaLevel: [5, 9], rng: new Rng(1), at: { x: 0, y: 0 } })
  assert.equal(rain.items.length, 7)
  assert.equal(new Set(rain.items.map((x) => x.id)).size, 7)
  const oss = startActions(triggerEvent('opensource-release', {}, ctx({ badges: 1 })).started!, { areaLevel: [5, 9], rng: new Rng(1), at: { x: 10, y: 10 } })
  assert.equal(oss.npcs.length, 1)
  assert.deepEqual([oss.npcs[0].x, oss.npcs[0].y], [12, 11])
  assert.equal(oss.npcs[0].id, 'ev:opensource-release:evangelist')
  assert.equal(oss.spawns.length, 1)
  assert.ok(oss.rumors.length === 1 && oss.rumors[0] in CONTENT.text)
})

// ------------------------------------------------------------------------------------------- rumors, places, calendar

test('rumors: hidden events are hinted only through rumors; rumor flags never gate their own rumor', () => {
  const base = ctx({ badges: 6, dexCaught: Array.from({ length: 45 }, (_, i) => CONTENT.speciesList[i].id) })
  const list = availableRumors(base, {})
  const ids = list.map((r) => r.event)
  assert.ok(ids.includes('mythos-1'), 'chain start after 6 badges')
  assert.ok(ids.includes('alpha-1'))
  assert.ok(!ids.includes('mythos-2'), 'next step needs the previous flag')
  assert.ok(ids.includes('retired-gathering'), 'rumor:<id> flag in `when` is ignored for its own rumor')
  assert.ok(list.some((r) => r.hidden) && list.some((r) => !r.hidden))
  const after = availableRumors({ ...base, flags: { 'mythic:glasswing:s1': true } }, {}).map((r) => r.event)
  assert.ok(after.includes('mythos-2') && !after.includes('mythos-1'))
  const heard = { ...base, flags: { [rumorFlag('mythos-1')]: true } }
  assert.equal(availableRumors(heard, {}).find((r) => r.event === 'mythos-1')?.heard, true)
  const a = pickRumor(base, {}, new Rng(4)), b = pickRumor(base, {}, new Rng(4))
  assert.deepEqual(a, b)
  assert.equal(pickRumor(ctx(), { 'hello-world': { lastDay: 0, count: 1 } }, new Rng(1), { ...GAMEPLAY, events: [GAMEPLAY.eventById['hello-world']] }), null, 'spent non-repeatable')
})

test('resolvePlaceRef: exact ids and nearest undiscovered template matches', () => {
  const place = (id: string, x: number, y: number): TownDef => ({ id, nameZh: id, map: 'overworld', x, y, description: '' })
  const places = [place('agi', 0, 0), place('monolith-1', 10, 0), place('monolith-2', 20, 0), place('monolithic-9', 1, 0), place('shrine-1', 2, 0)]
  assert.equal(resolvePlaceRef('agi', places, { x: 99, y: 99 })?.id, 'agi')
  assert.equal(resolvePlaceRef('nope', places, { x: 0, y: 0 }), null)
  assert.equal(resolvePlaceRef('nearest:monolith', places, { x: 0, y: 0 })?.id, 'monolith-1')
  assert.equal(resolvePlaceRef('nearest:monolith', places, { x: 0, y: 0 }, ['monolith-1'])?.id, 'monolith-2')
  assert.equal(resolvePlaceRef('nearest:monolith', places, { x: 0, y: 0 }, ['monolith-1', 'monolith-2'])?.id, 'monolith-1', 'falls back to discovered')
  assert.equal(resolvePlaceRef('nearest:datacenter', places, { x: 0, y: 0 }), null)
  assert.equal(eventFocus(GAMEPLAY.eventById['stele-strawberry'], places, { x: 18, y: 0 })?.id, 'monolith-2')
  assert.equal(eventFocus(GAMEPLAY.eventById['token-rain'], places, { x: 0, y: 0 }), null)
})

test('festival calendar and live festivals (2026-10-03 = National Day)', () => {
  const cal = festivalCalendar(REAL, 30)
  assert.deepEqual(cal[0], { event: 'national-day', inDays: 0 })
  assert.equal(cal.find((x) => x.event === 'programmer-day')?.inDays, 21)
  assert.equal(cal.find((x) => x.event === 'halloween')?.inDays, 28)
  const r = tickEvents({}, ctx({ minutes: at(9) }), new Rng(2), { rules: { ...GAMEPLAY.spawn.scheduler, maxStartsPerCheck: 1 } })
  assert.deepEqual(r.started.map((x) => x.id), ['national-day'], 'festival (priority 5, chance 1) starts first')
  const spring = { year: 2027, month: 2, day: 9, weekday: 2, hour: 9, minute: 0 }
  assert.ok(evaluateCondition(GAMEPLAY.eventById['spring-festival'].when, ctx({ real: spring })))
  assert.ok(!evaluateCondition(GAMEPLAY.eventById['spring-festival'].when, ctx({ real: { ...spring, year: 2028 } })))
})

test('eventContext derives party/badges/active events from a save; expandFlag; sanitizeEventState', () => {
  const save = {
    clockMinutes: at(1, 0, 2), flags: { x: true }, badges: ['b1', 'b2'], dexCaught: ['a'], bag: { repel: 2 },
    party: [{ speciesId: sp('code'), hp: 0 }, { speciesId: sp('chaos'), hp: 5 }] as never[],
    events: { k: { lastDay: 2, count: 1, activeUntil: at(2, 0, 2) }, old: { lastDay: 0, count: 3 } },
  }
  const c = eventContext(save, { real: REAL, weather: 'fog', biome: 'swamp' })
  assert.equal(c.badges, 2)
  assert.deepEqual(c.activeEvents, ['k'])
  assert.deepEqual([...c.doneEvents].sort(), ['k', 'old'])
  assert.equal(c.party.length, 2)
  assert.equal(expandFlag('gift:spring:{year}:{day}', { year: 2027, day: 12 }), 'gift:spring:2027:12')
  const clean = sanitizeEventState({ 'national-day': { lastDay: 3.7, count: 2, activeUntil: 99, anchor: { map: 'o', x: 1, y: 2 } }, bogus: { lastDay: 1, count: 1 }, 'token-rain': { lastDay: 'x', count: 1 } })
  assert.deepEqual(clean, { 'national-day': { lastDay: 3, count: 2, activeUntil: 99, anchor: { map: 'o', x: 1, y: 2 } } })
  assert.deepEqual(sanitizeEventState(null), {})
})

// ------------------------------------------------------------------------------------------- content

test('content: >= 45 authored events, >= 18 hidden, every UR has a legend event, validator clean', () => {
  const authored = GAMEPLAY.events.filter((e) => e.trigger !== 'legend')
  assert.ok(authored.length >= 45, `${authored.length}`)
  assert.ok(authored.filter((e) => e.hidden).length >= 18)
  for (const s of CONTENT.speciesList.filter((x) => x.rarity === 'UR')) assert.ok(GAMEPLAY.events.some((e) => e.legend === s.id), s.id)
  assert.deepEqual(validateGameplay(GAMEPLAY, CONTENT), [])
  assert.deepEqual(validateContent(), [])
})

test('validator catches broken references', () => {
  const broken: WorldEventDef = ev('broken', {
    nameZh: 'raw 名字', rumor: 'events.ev.nope.rumor',
    when: { biomes: ['atlantis'], flags: { 'bad flag': true }, eventsActive: ['ghost'], weather: ['plasma' as never], hourRange: [0, 30] },
    effects: [
      { kind: 'spawn', species: 'missingno', level: [5, 3], count: 0, roaming: true, aura: 'aura-rainbow' },
      { kind: 'script', steps: [{ op: 'say', text: 'hello' }, { op: 'triggerEvent', event: 'ghost' }, { op: 'revealPlace', place: 'nearest:atlantis' }, { op: 'giveItem', item: 'unobtainium', qty: 1 }, { op: 'research', species: 'missingno', task: 'nope', amount: 1 }] },
      { kind: 'modifier', target: 'gravity' as never, multiplier: 2, minutes: 0 },
      { kind: 'ambience', cue: 'disco', minutes: 0 },
    ],
  })
  const g: GameplayData = { ...GAMEPLAY, events: [...GAMEPLAY.events, broken], eventById: { ...GAMEPLAY.eventById, broken } }
  const errs = validateGameplay(g, CONTENT).join('\n')
  for (const needle of ['raw text', 'missing text "events.ev.nope.rumor"', 'unknown biome "atlantis"', 'malformed flag "bad flag"', 'unknown event "ghost"',
    'unknown field weather "plasma"', 'range', 'unknown species "missingno"', 'spawn count', 'undeclared aura cue', 'unknown place ref "nearest:atlantis"',
    'unknown item "unobtainium"', 'unknown research task "nope"', 'unknown modifier target', 'undeclared ambience cue "disco"']) {
    assert.ok(errs.includes(needle), `expected "${needle}" in:\n${errs}`)
  }
})
