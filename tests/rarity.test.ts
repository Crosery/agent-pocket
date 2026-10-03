// Per-rarity gameplay: behaviour table, grass / visible spawn weighting, SSR conditions, shiny odds, event spawns,
// roaming UR legends (bands, rotation, positions, flee/relocate) and MYTHIC chain structure.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT } from '../src/shared/content/index.ts'
import type { EncounterSlot, EventCondition } from '../src/shared/types.ts'
import { Rng } from '../src/shared/rng.ts'
import { NO_MODIFIERS, evaluateCondition, type EventContext, type EventModifiers } from '../src/shared/gameplay/events.ts'
import {
  bandOf, bandRange, behaviorOf, chainProgress, chainsProgress, distanceMul, grassWeights, legendAt, legendForBand, legendPings, legendPool,
  legendPosition, legendsNear, onLegendBattleEnd, pickGrassEncounter, pickVisibleSpawn, resolveSpawnEffect, sanitizeLegendState, shinyChance,
  snapToFree, speciesConditionHolds, speciesSpawnConditions, typeAffinity, visibleWeights, type LegendStateMap,
} from '../src/shared/gameplay/spawns.ts'
import { GAMEPLAY } from '../src/shared/gameplay/data.ts'

const DAY = 1440
const at = (h: number, m = 0, day = 0) => day * DAY + h * 60 + m
function ctx(o: Partial<EventContext> = {}): EventContext {
  return {
    minutes: at(12), real: { year: 2026, month: 10, day: 3, weekday: 6, hour: 12, minute: 0 }, weather: 'clear', biome: 'meadow', regionId: null,
    regionDanger: 0, distance: 500, outdoor: true, nearPlaces: [], flags: {}, badges: 0, dexCaught: [], party: [], bag: {}, activeEvents: [],
    doneEvents: [], researchLevel: 0, ...o,
  }
}
const ofRarity = (r: string, pred: (s: (typeof CONTENT.speciesList)[number]) => boolean = () => true) => CONTENT.speciesList.find((s) => s.rarity === r && !s.starter && pred(s))!
const slot = (species: string, weight = 10): EncounterSlot => ({ species, minLevel: 10, maxLevel: 12, weight })

test('every tier has a behaviour that matches its role', () => {
  const b = Object.fromEntries(CONTENT.rarities.map((r) => [r.id, behaviorOf(r.id)]))
  for (const id of ['N', 'R']) { assert.ok(b[id].spawn.includes('grass')); assert.equal(b[id].grassWeightMul, 1); assert.equal(b[id].fleeChancePerTurn, 0) }
  assert.ok(b.SR.spawn.includes('grass') && b.SR.spawn.includes('visible'))
  assert.ok(b.SR.grassWeightMul < 1 && b.SR.visibleWeightMul > 1 && b.SR.cues.aura)
  assert.equal(b.SSR.grassWeightMul, 0)
  assert.ok(b.SSR.requireConditions && b.SSR.avoidPlayer && b.SSR.fleeChancePerTurn > 0 && b.SSR.cues.aura)
  assert.deepEqual(b.UR.spawn, ['legend'])
  assert.ok(b.UR.fleeChancePerTurn > 0 && b.UR.cues.ping && b.UR.visibleWeightMul === 0)
  assert.deepEqual(b.MYTHIC.spawn, ['event'])
  assert.ok(b.MYTHIC.grassWeightMul === 0 && b.MYTHIC.visibleWeightMul === 0)
  const order = CONTENT.rarities.map((r) => r.behavior!.shinyMultiplier ?? 1)
  assert.ok(order[4] >= order[0], 'legends shine more often than commons')
})

test('grass weighting: N/R full, SR reduced, SSR/UR/MYTHIC never; time/weather affinity and event boosts multiply', () => {
  const n = ofRarity('N'), sr = ofRarity('SR'), ssr = ofRarity('SSR'), ur = ofRarity('UR'), my = ofRarity('MYTHIC')
  const ws = grassWeights([slot(n.id), slot(sr.id), slot(ssr.id), slot(ur.id), slot(my.id)], ctx())
  const w = Object.fromEntries(ws.map((x) => [x.speciesId, x.weight]))
  assert.deepEqual(Object.keys(w).sort(), [n.id, sr.id].sort())
  const base = (id: string) => 10 * typeAffinity(CONTENT.species[id].types, ctx()) * distanceMul(behaviorOf(CONTENT.species[id].rarity), 500)
  assert.ok(Math.abs(w[n.id] - base(n.id)) < 1e-9)
  assert.ok(Math.abs(w[sr.id] - base(sr.id) * behaviorOf('SR').grassWeightMul) < 1e-9)
  // time slots are honoured
  assert.equal(grassWeights([{ ...slot(n.id), time: ['night'] }], ctx()).length, 0)
  // night affinity: chaos species weigh more at night than at noon
  const chaos = ofRarity('N', (s) => s.types.includes('chaos')) ?? ofRarity('R', (s) => s.types.includes('chaos'))
  const noon = grassWeights([slot(chaos.id)], ctx())[0].weight
  const night = grassWeights([slot(chaos.id)], ctx({ minutes: at(2) }))[0].weight
  assert.ok(night > noon)
  // event encounter boosts (type / rarity / explicit species)
  const mods: EventModifiers = { ...NO_MODIFIERS, encounterBoosts: [{ types: n.types, multiplier: 3, event: 'x' }, { rarities: ['SR'], multiplier: 2, event: 'y' }] }
  const boosted = Object.fromEntries(grassWeights([slot(n.id), slot(sr.id)], ctx(), { mods }).map((x) => [x.speciesId, x.weight]))
  assert.ok(Math.abs(boosted[n.id] - w[n.id] * 3) < 1e-9, 'type boost only (N is not SR)')
  assert.ok(boosted[sr.id] >= w[sr.id] * 2 - 1e-9)
})

test('distance: tiers below minDistance vanish, rarer tiers grow with distance', () => {
  const ssr = behaviorOf('SSR'), sr = behaviorOf('SR')
  assert.equal(distanceMul(ssr, ssr.minDistance - 1), 0)
  assert.ok(distanceMul(sr, 3000) > distanceMul(sr, 0))
  assert.ok(distanceMul(ssr, 3000) / distanceMul(ssr, ssr.minDistance) > distanceMul(sr, 3000) / distanceMul(sr, ssr.minDistance))
})

test('SSR spawn conditions: type-derived OR lists, per-species overrides, gate visible spawns only', () => {
  const sora = CONTENT.species['sora-2']
  assert.ok(sora && sora.rarity === 'SSR')
  assert.deepEqual(speciesSpawnConditions('sora-2'), GAMEPLAY.spawn.speciesConditions['sora-2'])
  assert.equal(speciesConditionHolds('sora-2', ctx()), false)
  assert.equal(speciesConditionHolds('sora-2', ctx({ activeEvents: ['server-outage'] })), true)
  assert.equal(speciesConditionHolds('sora-2', ctx({ weather: 'fog', minutes: at(23) })), true)
  const chaosSsr = ofRarity('SSR', (s) => s.types.length === 1 && s.types[0] === 'chaos' && !GAMEPLAY.spawn.speciesConditions[s.id])
  if (chaosSsr) assert.deepEqual(speciesSpawnConditions(chaosSsr.id), GAMEPLAY.spawn.typeConditions.chaos)
  // every SSR has at least one reachable condition in some situation
  const situations: Partial<EventContext>[] = []
  for (let h = 0; h < 24; h++) for (const weather of ['clear', 'rain', 'fog', 'snow', 'sand', 'aurora', 'ash'] as const) situations.push({ minutes: at(h), weather })
  for (const s of CONTENT.speciesList.filter((x) => x.rarity === 'SSR')) {
    const conds = speciesSpawnConditions(s.id)
    assert.ok(conds.length > 0, s.id)
    const reachable = situations.some((o) => conds.some((cnd: EventCondition) => evaluateCondition(cnd, ctx({ ...o, biome: s.habitats[0], regionDanger: 3, distance: 1000, real: { year: 2026, month: 10, day: 3, weekday: 0, hour: 20, minute: 0 }, nearPlaces: ['monolith-1'], activeEvents: ['server-outage'] }))))
    assert.ok(reachable, `${s.id} can never appear`)
  }
  // SSR appears among visible spawns only while its condition holds
  const slots = [slot('sora-2'), slot(ofRarity('N').id)]
  assert.ok(!visibleWeights(slots, ctx()).some((x) => x.speciesId === 'sora-2'))
  assert.ok(visibleWeights(slots, ctx({ activeEvents: ['server-outage'] })).some((x) => x.speciesId === 'sora-2'))
})

test('picks are deterministic per rng seed; visible caps per tier; flee + cues + aura attached', () => {
  const sr = ofRarity('SR'), n = ofRarity('N')
  const slots = [slot(n.id), slot(sr.id), slot('sora-2')]
  const seq = (seed: number) => { const r = new Rng(seed); return Array.from({ length: 20 }, () => pickGrassEncounter(slots, ctx(), r)) }
  assert.deepEqual(seq(3), seq(3))
  const picks = seq(8)
  assert.ok(picks.every((p) => p && p.speciesId !== 'sora-2'))
  const sp = picks.find((p) => p!.speciesId === sr.id)
  if (sp) { assert.equal(sp.aura, behaviorOf('SR').cues.aura); assert.ok(sp.level >= 10 + behaviorOf('SR').levelBonus) }
  const night = ctx({ activeEvents: ['server-outage'] })
  const rng = new Rng(1)
  for (let i = 0; i < 50; i++) {
    const v = pickVisibleSpawn(slots, night, rng, { present: { SSR: 1, SR: 2 } })!
    assert.equal(v.speciesId, n.id, 'SSR and SR are at their caps')
  }
  let ssr = null
  for (let i = 0; i < 200 && !ssr; i++) { const v = pickVisibleSpawn(slots, night, rng); if (v?.speciesId === 'sora-2') ssr = v }
  assert.ok(ssr, 'SSR roamer appears under its condition')
  assert.ok(ssr.avoidPlayer && ssr.flee && ssr.lifeMinutes > 0 && ssr.aura === behaviorOf('SSR').cues.aura)
})

test('shiny odds: base rate x tier x event modifier x completed research', () => {
  const base = CONTENT.config.battle.shinyRate
  const ur = ofRarity('UR').id, n = ofRarity('N').id
  assert.equal(shinyChance(n), base * behaviorOf('N').shinyMultiplier)
  assert.equal(shinyChance(ur), base * behaviorOf('UR').shinyMultiplier)
  const mods: EventModifiers = { ...NO_MODIFIERS, modifiers: [{ target: 'shiny', multiplier: 8, event: 'x' }] }
  assert.equal(shinyChance(n, { mods }), base * 8)
  const full: Record<string, Record<string, number>> = { [n]: Object.fromEntries(GAMEPLAY.research.tasks.map((t) => [t.id, Math.max(...t.thresholds)])) }
  assert.equal(shinyChance(n, { research: full }), base * (GAMEPLAY.research.shinyMultiplierOnComplete ?? 1))
})

test('event spawn effects resolve picks, area levels and aura overrides', () => {
  const out = resolveSpawnEffect({ kind: 'spawn', pick: { types: ['chaos'] }, level: [1, 2], count: 4, roaming: false, aura: 'aura-illusion', levelFromArea: true }, [20, 25], new Rng(3))
  assert.equal(out.length, 4)
  for (const v of out) {
    assert.ok(CONTENT.species[v.speciesId].types.includes('chaos'))
    assert.ok(!['UR', 'MYTHIC'].includes(v.rarity))
    assert.ok(v.level >= 21 && v.level <= 27 + behaviorOf(v.rarity).levelBonus)
    assert.equal(v.aura, 'aura-illusion')
    assert.equal(v.roaming, false)
  }
  const fixed = resolveSpawnEffect({ kind: 'spawn', species: 'sora-2', level: [30, 30], count: 1, roaming: true }, [1, 2], new Rng(1))
  assert.equal(fixed[0].level, 30)
})

// ------------------------------------------------------------------------------------------- legends

const SEED = 20261002
const ORIGIN = { x: 513, y: 877 }

test('province bands: bandOf/bandRange agree, bands extend forever', () => {
  for (const d of [0, 10, 379, 380, 899, 900, 2599, 2600, 3799, 3800, 50000]) {
    const b = bandOf(d)
    const [lo, hi] = bandRange(b)
    assert.ok(d >= lo && d < hi, `${d} in band ${b} [${lo},${hi})`)
  }
  assert.equal(bandOf(-5), 0)
})

test('one legend per band per epoch: distinct for consecutive bands, caught ones leave the pool, defeated ones rest an epoch', () => {
  const minutes = at(10, 0, 4)
  const picks = [0, 1, 2, 3].map((b) => legendForBand(b, minutes, SEED, {})!.species)
  assert.equal(new Set(picks.slice(1)).size, 3, 'bands sharing a pool get distinct legends')
  assert.deepEqual(picks, [0, 1, 2, 3].map((b) => legendForBand(b, minutes, SEED, {})!.species), 'deterministic')
  const first = picks[1]
  assert.ok(!legendPool(1, minutes, { [first]: { hops: 0, caught: true } }).some((l) => l.species === first))
  const day = Math.floor(minutes / DAY)
  const rested: LegendStateMap = { [first]: { hops: 1, defeatedDay: day } }
  assert.ok(!legendPool(1, minutes, rested).some((l) => l.species === first))
  const nextEpoch = minutes + GAMEPLAY.spawn.legends.rotationDays * DAY
  assert.ok(legendPool(1, nextEpoch, rested).some((l) => l.species === first))
  for (const l of GAMEPLAY.legends) assert.ok(!legendPool(Math.max(0, l.minBand - 1), minutes, {}).includes(l) || l.minBand === 0)
})

test('legend positions stay inside their band, move with their pattern and relocate after a hop', () => {
  for (const def of GAMEPLAY.legends) {
    const band = Math.max(def.minBand, 1)
    const [lo, hi] = bandRange(band)
    for (const m of [at(0), at(7, 30), at(13, 0, 2), at(22, 0, 9)]) {
      const p = legendPosition(def, band, m, SEED, 0, ORIGIN)
      const d = Math.hypot(p.x - ORIGIN.x, p.y - ORIGIN.y)
      assert.ok(d >= lo - 1 && d <= hi + 1, `${def.species} ${def.pattern} at ${d} not in [${lo},${hi}]`)
      assert.deepEqual(p, legendPosition(def, band, m, SEED, 0, ORIGIN))
    }
    const a = legendPosition(def, band, at(1), SEED, 0, ORIGIN), b = legendPosition(def, band, at(9), SEED, 0, ORIGIN)
    assert.notDeepEqual(a, b, `${def.species} should move over 8 hours`)
    assert.notDeepEqual(legendPosition(def, band, at(1), SEED, 0, ORIGIN), legendPosition(def, band, at(1), SEED, 1, ORIGIN), 'hop relocates')
  }
})

test('proximity, pings, flee/relocate/rest, defeat, catch', () => {
  const minutes = at(14, 0, 1)
  const lg = legendAt(1, minutes, SEED, ORIGIN, {})!
  assert.ok(lg && lg.level >= GAMEPLAY.spawn.legends.levelByBand[1])
  const near = legendsNear(ORIGIN, { x: lg.x + 3, y: lg.y }, minutes, SEED, {})
  const hit = near.find((x) => x.legend.species === lg.species)!
  assert.equal(hit.proximity, 'appear')
  const sense = legendsNear(ORIGIN, { x: lg.x + GAMEPLAY.spawn.legends.appearRadius + 5, y: lg.y }, minutes, SEED, {}).find((x) => x.legend.species === lg.species)
  assert.equal(sense?.proximity, 'sense')
  const pings = legendPings(ORIGIN, minutes, SEED, {}, [0, 1, 2])
  const ping = pings.find((p) => p.species === lg.species)!
  assert.ok(Math.hypot(ping.x - lg.x, ping.y - lg.y) <= GAMEPLAY.spawn.legends.pingFuzz + 1)
  assert.equal(ping.cue, behaviorOf('UR').cues.ping)
  // flee: keeps hp, relocates (hop+1), rests, no ping while resting
  let st = onLegendBattleEnd({}, lg.species, 'fled', { hpLeft: 77.6, minutes })
  assert.deepEqual(st[lg.species], { hops: 1, seen: 1, restUntil: minutes + GAMEPLAY.spawn.legends.fleeRestMinutes, hp: 77 })
  assert.ok(legendAt(1, minutes, SEED, ORIGIN, st)!.resting)
  assert.ok(!legendPings(ORIGIN, minutes, SEED, st, [1]).some((p) => p.species === lg.species))
  const back = legendAt(1, minutes + GAMEPLAY.spawn.legends.fleeRestMinutes + 1, SEED, ORIGIN, st)
  if (back?.species === lg.species) {
    assert.equal(back.hp, 77)
    assert.notDeepEqual([back.x, back.y], [legendAt(1, minutes + GAMEPLAY.spawn.legends.fleeRestMinutes + 1, SEED, ORIGIN, {})!.x, legendAt(1, minutes + GAMEPLAY.spawn.legends.fleeRestMinutes + 1, SEED, ORIGIN, {})!.y])
  }
  st = onLegendBattleEnd(st, lg.species, 'win', { hpLeft: 0, minutes })
  assert.equal(st[lg.species].defeatedDay, 1)
  assert.equal(st[lg.species].hp, undefined)
  st = onLegendBattleEnd(st, lg.species, 'caught', { hpLeft: 10, minutes })
  assert.equal(st[lg.species].caught, true)
  assert.notEqual(legendForBand(1, minutes + 30 * DAY, SEED, st)?.species, lg.species)
  assert.deepEqual(sanitizeLegendState({ [lg.species]: { hops: 2.5, hp: -1, caught: true, junk: 1 }, missingno: { hops: 1 } }), { [lg.species]: { hops: 2, caught: true } })
})

test('snapToFree finds the nearest free tile', () => {
  const free = (x: number, y: number) => x === 3 && y === 1
  assert.deepEqual(snapToFree(0, 0, free, 5), { x: 3, y: 1 })
  assert.equal(snapToFree(0, 0, free, 2), null)
  assert.deepEqual(snapToFree(3, 1, free, 0), { x: 3, y: 1 })
})

// ------------------------------------------------------------------------------------------- mythic chains

test('each MYTHIC species has a hidden chain of >= 4 steps across different biomes / times / weathers', () => {
  for (const s of CONTENT.speciesList.filter((x) => x.rarity === 'MYTHIC')) {
    const ch = GAMEPLAY.chains.find((c) => c.species === s.id)
    assert.ok(ch, s.id)
    assert.ok(ch.steps.length >= 4)
    const evs = ch.steps.map((st) => GAMEPLAY.eventById[st.event])
    assert.ok(evs.every((e) => e.hidden && e.chain === ch.id))
    const settings = new Set(evs.map((e) => JSON.stringify([e.when.biomes ?? null, e.when.timeOfDay ?? e.when.hourRange ?? e.when.minuteRange ?? null, e.when.weather ?? null, e.when.eventsActive ?? null])))
    assert.equal(settings.size, evs.length, `${ch.id}: every step has its own setting`)
    const biomes = new Set(evs.flatMap((e) => e.when.biomes ?? []))
    assert.ok(biomes.size >= 3, `${ch.id}: ${[...biomes]}`)
    // step k requires step k-1's flag and is guarded by its own
    ch.steps.forEach((st, k) => {
      const flags = evs[k].when.flags ?? {}
      if (k > 0) assert.equal(flags[ch.steps[k - 1].flag], true, `${st.event} needs ${ch.steps[k - 1].flag}`)
      assert.equal(flags[st.flag], false, `${st.event} guarded by its own flag`)
    })
    const kinds = new Set(JSON.stringify(evs).match(/"op":"(\w+)"/g))
    for (const op of ['setFlag', 'revealPlace', 'research', 'wildBattle']) assert.ok([...kinds].some((k) => k.includes(op)), `${ch.id} uses ${op}`)
  }
  assert.ok(JSON.stringify(GAMEPLAY.events).includes('"op":"triggerEvent"'))
})

test('chainProgress follows flags in order', () => {
  const ch = GAMEPLAY.chains[0]
  assert.deepEqual([chainProgress(ch.id, {})!.solved, chainProgress(ch.id, {})!.next?.event], [0, ch.steps[0].event])
  const two = { [ch.steps[0].flag]: true, [ch.steps[1].flag]: true, [ch.steps[3].flag]: true }
  const p = chainProgress(ch.id, two)!
  assert.equal(p.solved, 2, 'stops at the first unsolved step')
  assert.equal(p.next?.event, ch.steps[2].event)
  assert.ok(chainProgress(ch.id, { [ch.doneFlag]: true })!.done)
  assert.equal(chainProgress('nope', {}), null)
  assert.deepEqual(chainsProgress(two).map((x) => x.chain.id), [ch.id])
})
