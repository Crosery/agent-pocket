// The developer commands, one category at a time, against a fake host (real world and content, stubbed engine).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import type { Creature, SaveData } from '../src/shared/types.ts'
import { CONTENT } from '../src/shared/content/index.ts'
import { buildWorld, worldAnchors } from '../src/shared/world/index.ts'
import { Rng } from '../src/shared/rng.ts'
import { createCreature } from '../src/shared/creature.ts'
import { STORY_CONTENT } from '../src/shared/world/story.ts'
import { createSaveManager } from '../src/client/core/save.ts'
import { RngHub } from '../src/client/core/rng-hub.ts'
import { createDevClock } from '../src/client/dev/clock.ts'
import { COMMANDS } from '../src/client/dev/commands/index.ts'
import { devEnums } from '../src/client/dev/enums.ts'
import { LIST_SOURCES, knownFlags, listEntries } from '../src/client/dev/lists.ts'
import { CONSOLE, createRegistry, DevError, type Registry } from '../src/client/dev/registry.ts'
import { installDevText } from '../src/client/dev/text.ts'
import type { DevHost } from '../src/client/dev/kit.ts'
import { GAME } from '../src/client/world/config.ts'
import { qualityPreset } from '../src/client/render/config.ts'
import { devContentFromDisk } from './dev-content.ts'

const world = buildWorld()
const content = devContentFromDisk()
const anchors = worldAnchors(world)
const mem = new Map<string, string>()
const saves = createSaveManager({ world, storage: { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => { mem.set(k, v) }, removeItem: (k) => { mem.delete(k) } } })
before(() => installDevText())

const noop = new Proxy({}, { get: () => () => {} })

interface Rig { host: DevHost; reg: Registry; calls: { name: string; args: unknown[] }[]; emitted: string[]; save: SaveData }

function rig(over: { gameplay?: boolean } = {}): Rig {
  const calls: Rig['calls'] = []
  const emitted: string[] = []
  const avatar = CONTENT.characters.find((c) => c.playable)!
  const save = saves.newGame({ name: avatar.nameZh, avatar: avatar.id })
  const rec = (name: string) => (...args: unknown[]) => { calls.push({ name, args }); return Promise.resolve() }
  let battleActive = false
  const gameplayHooks = over.gameplay === false ? null : {
    start: (id: string) => { calls.push({ name: 'gp.start', args: [id] }); return true },
    end: (id: string) => { calls.push({ name: 'gp.end', args: [id] }) },
    summon: (sp?: string) => { calls.push({ name: 'gp.summon', args: [sp] }); return true },
  }
  const ctx = {
    save, data: { ...CONTENT, world }, saves, events: { emit: (t: string) => { emitted.push(t) }, on: () => () => {}, once: () => () => {} },
    hud: noop, audio: noop, ui: noop, persist: rec('persist'),
    battle: { evolve: async (i: number, to: string) => { calls.push({ name: 'evolve', args: [i, to] }); return true } },
  }
  const host = {
    ctx, world, rng: new RngHub(5), clock: createDevClock(), content, session: { scenario: null }, tick: () => {},
    overworld: {
      get battleActive() { return battleActive }, mapId: 'overworld', player: { x: 1, y: 1, elev: 0, facing: 'down', map: 'overworld' },
      enterMap: rec('enterMap'), setWeatherOverride: rec('weather'), roamerInfo: () => [{ speciesId: 'o1', level: 7, mood: 'idle', noticed: false, x: 3.2, y: 4.1, target: null, region: 'r' }],
      startWildBattle: (sp: string, lv: number) => { calls.push({ name: 'wild', args: [sp, lv] }); battleActive = false; return Promise.resolve() },
      startTrainerBattle: (id: string) => { calls.push({ name: 'trainer', args: [id] }); return Promise.resolve() },
      devHandles: () => ({ gameplayHooks, rng: new RngHub(1), forceEncounter: (s: unknown) => { calls.push({ name: 'force', args: [s] }) } }),
      setBattle: (on: boolean) => { battleActive = on },
    },
    onboarding: { debugShow: (id: string) => { calls.push({ name: 'tip', args: [id] }) }, objectiveId: '' },
    flyTo: async () => {},
    run: async () => null, dump: () => ({}),
  } as unknown as DevHost
  const reg = createRegistry(host, COMMANDS, { enums: devEnums(content) })
  return { host, reg, calls, emitted, save }
}

const rejects = (p: Promise<unknown>, key?: string) => assert.rejects(p, (e: Error) => e instanceof DevError && (!key || e.message === CONTENT.text[key] || e.message.startsWith(CONTENT.text[key]?.split('{')[0] ?? '\0')))
const mon = (id = 'o1', lv = 10): Creature => createCreature(id, lv, { rng: new Rng(3) })

// ----------------------------------------------------------------------------- world and jumps

test('world: anchors, places, beats, seed reload', async () => {
  const { reg, calls, save, host } = rig()
  const forge = anchors['town:forge']
  assert.deepEqual(await reg.run('tp.anchor', { anchor: 'town:forge' }), { map: forge.map, x: forge.x, y: forge.y })
  assert.deepEqual(calls.at(-1), { name: 'enterMap', args: [forge.map, forge.x, forge.y, 'down', true] })
  await rejects(reg.run('tp.anchor', { anchor: 'town:nowhere' }), 'dev.err.unknownAnchor')

  const far = 'fx:hamlet:2:20'
  const r = await reg.run('tp.place', { place: far }) as { map: string; x: number }
  assert.equal(r.map, 'overworld')
  assert.deepEqual(save.discoveredPlaces, [far], 'a place you jump to counts as discovered')
  await rejects(reg.run('tp.place', { place: 'fx:hamlet:99:99' }), 'dev.err.unknownPlace')

  const beat = await reg.run('beat.apply', { beat: 'after-gym-3' }) as { at: { map: string } | null; badges: number }
  assert.equal(beat.badges, 3)
  assert.deepEqual(save.quests.main, { stage: 4, done: false })
  assert.equal(save.flags[STORY_CONTENT.meta.flags.trainerWon + 'leader_code'], true)
  assert.ok(beat.at, 'went to the beat place')
  save.badges = []
  assert.equal(((await reg.run('beat.apply', { beat: 'after-gym-3', stay: true })) as { at: unknown }).at, null, 'stay keeps the position')
  await rejects(reg.run('beat.apply', { beat: 'nope' }), 'dev.err.unknownBeat')

  const assigned: string[] = []
  ;(globalThis as Record<string, unknown>).location = { search: '?dev=1&scenario=x&reset=1&skipTitle=1', pathname: '/game', assign: (u: string) => assigned.push(u) }
  const res = await reg.run('world.seed', { seed: 777 }) as { reloading: string }
  assert.ok(res.reloading.includes('seed=777') && res.reloading.includes(`slot=${CONSOLE.limits.reloadSlot}`) && !res.reloading.includes('scenario') && !res.reloading.includes('reset'))
  assert.ok(saves.hasSave(CONSOLE.limits.reloadSlot), 'the game was saved to the developer slot first')
  await new Promise((ok) => setTimeout(ok, 120))
  assert.equal(assigned.length, 1)
  await rejects(reg.run('world.seed', { seed: -5 }))
  assert.equal(host.ctx.save.badges.length, 3)
})

// ----------------------------------------------------------------------------- story and events

test('story: flags coerce and clear, quests move both ways, bounds checked', async () => {
  const { reg, save } = rig()
  await reg.run('flag.set', { flag: 'x:num', value: '12' })
  await reg.run('flag.set', { flag: 'x:bool', value: 'true' })
  await reg.run('flag.set', { flag: 'x:str', value: 'hello' })
  assert.deepEqual([save.flags['x:num'], save.flags['x:bool'], save.flags['x:str']], [12, true, 'hello'])
  await reg.run('flag.set', { flag: 'x:bool' })
  assert.equal('x:bool' in save.flags, false, 'no value clears')
  const main = world.quests.find((q) => q.id === 'main')!
  await reg.run('quest.set', { quest: 'main', stage: 5 })
  assert.deepEqual(save.quests.main, { stage: 5, done: false })
  await reg.run('quest.set', { quest: 'main', stage: 2 })
  assert.deepEqual(save.quests.main, { stage: 2, done: false }, 'stepping back is allowed')
  await reg.run('quest.set', { quest: 'main', stage: main.stages.length - 1, done: true })
  assert.equal(save.quests.main.done, true)
  await rejects(reg.run('quest.set', { quest: 'main', stage: main.stages.length }))
  await rejects(reg.run('quest.set', { quest: 'nope', stage: 0 }), 'dev.err.unknownQuest')
  await reg.run('quest.clear', { quest: 'main' })
  assert.equal(save.quests.main, undefined)
})

test('events: start, end and summon go through the gameplay hooks; reset forgets all state', async () => {
  const { reg, calls, save } = rig()
  const id = Object.keys((await import('../src/shared/gameplay/data.ts')).GAMEPLAY.eventById)[0]
  assert.deepEqual(await reg.run('event.start', { event: id }), { event: id, started: true })
  await reg.run('event.end', { event: id })
  await reg.run('legend.summon', {})
  assert.deepEqual(calls.map((c) => c.name), ['gp.start', 'gp.end', 'gp.summon'])
  await rejects(reg.run('event.start', { event: 'nope' }), 'dev.err.unknownEvent')
  save.events = { a: { lastDay: 1, count: 2 }, b: { lastDay: 3, count: 1 } }
  assert.deepEqual(await reg.run('event.reset'), { cleared: 2 })
  assert.deepEqual(save.events, {})
  await rejects(rig({ gameplay: false }).reg.run('event.start', { event: id }), 'dev.err.noHooks')
})

// ----------------------------------------------------------------------------- party, items

test('party: add, edit with clipping report, heal, remove, box, team, evolve', async () => {
  const { reg, calls, save } = rig()
  const added = await reg.run('party.add', { species: 'o1', level: 12 }) as { placed: string }
  assert.equal(added.placed, 'party')
  assert.equal(save.party[0].level, 12)
  await rejects(reg.run('party.add', { species: 'nope' }), 'dev.err.unknownSpecies')

  const ok = await reg.run('party.set', { index: 0, field: 'nickname', value: 'Dev' }) as { now: string; clipped: string[] }
  assert.equal(ok.now, 'Dev')
  assert.equal(save.party[0].nickname, 'Dev')
  const lvl = await reg.run('party.set', { index: 0, field: 'level', value: '9999' }) as { now: number; clipped: string[] }
  assert.equal(lvl.now, CONTENT.config.party.maxLevel, 'level clamped by sanitizeCreature')
  assert.ok(lvl.clipped.some((p) => p === '/level'), 'the clipped field is reported')
  const st = await reg.run('party.set', { index: 0, field: 'status', value: 'poison' }) as { now: string }
  assert.equal(st.now, 'poison')
  const bad = await reg.run('party.set', { index: 0, field: 'status', value: 'not-a-status' }) as { now: unknown }
  assert.equal(bad.now, null, 'an unknown status does not survive sanitize')
  await rejects(reg.run('party.set', { index: 0, field: 'bogus', value: '1' }))
  await rejects(reg.run('party.set', { index: 5, field: 'level', value: '3' }), 'dev.err.noMember')

  save.party[0].hp = 1
  await reg.run('party.heal')
  assert.ok(save.party[0].hp > 1)
  save.party.push(mon('claude-haiku'))
  assert.deepEqual(await reg.run('party.toBox', { index: 1 }), { box: 0 })
  assert.equal(save.party.length, 1)
  assert.equal(save.boxes[0].length, 1)
  assert.deepEqual(await reg.run('party.remove', { index: 0 }), { size: 0 })

  const team = await reg.run('party.team', { team: 'plain' }) as { size: number }
  assert.equal(team.size, content.teams.plain.members.length)
  assert.equal(save.party[0].level, content.teams.plain.level)
  await reg.run('party.team', { team: 'worst-case', level: 33 })
  assert.equal(save.party[0].level, 33)
  assert.equal(save.party[0].nickname?.length, 12)
  await rejects(reg.run('party.team', { team: 'nope' }), 'dev.err.unknownTeam')

  save.party = [mon('o1', 5)]
  const evo = CONTENT.species.o1.evolvesTo
  if (evo) {
    const e = await reg.run('party.evolve', { index: 0 }) as { to: string }
    assert.equal(e.to, evo.id)
    assert.deepEqual(calls.at(-1), { name: 'evolve', args: [0, evo.id] })
    assert.ok(save.party[0].level >= evo.level)
  }
  save.party = [mon('alpha', 5)]
  if (!CONTENT.species.alpha.evolvesTo) await rejects(reg.run('party.evolve', { index: 0 }), 'dev.err.noEvolution')
})

test('items: give / take, money, badges, dex', async () => {
  const { reg, save } = rig()
  assert.deepEqual(await reg.run('item.give', { item: 'special-sauce', qty: 3 }), { item: 'special-sauce', have: 3 })
  assert.deepEqual(await reg.run('item.give', { item: 'special-sauce', qty: -2 }), { item: 'special-sauce', have: 1 })
  assert.deepEqual(await reg.run('item.give', { item: 'special-sauce' }), { item: 'special-sauce', have: 2 }, 'default quantity is 1')
  await rejects(reg.run('item.give', { item: 'nope' }), 'dev.err.unknownItem')
  assert.deepEqual(await reg.run('money.set', { money: 4321 }), { money: 4321 })
  assert.equal(save.money, 4321)
  await reg.run('badge.set', { badge: 'badge-sound' })
  await reg.run('badge.set', { badge: 'badge-code' })
  assert.deepEqual(save.badges, ['badge-sound', 'badge-code'])
  await reg.run('badge.set', { badge: 'badge-sound', on: false })
  assert.deepEqual(save.badges, ['badge-code'])
  await rejects(reg.run('badge.set', { badge: 'badge-x' }), 'dev.err.unknownBadge')
  const all = await reg.run('dex.fill', { mode: 'all' }) as { seen: number; caught: number }
  assert.equal(all.caught, CONTENT.speciesList.length)
  const none = await reg.run('dex.fill', { mode: 'none' }) as { seen: number }
  assert.equal(none.seen, 0)
  const type = CONTENT.speciesList[0].types[0]
  const some = await reg.run('dex.fill', { mode: 'type', type }) as { caught: number }
  assert.equal(some.caught, CONTENT.speciesList.filter((s) => s.types.includes(type)).length)
  await rejects(reg.run('dex.fill', { mode: 'type' }), 'dev.err.missingArg')
})

// ----------------------------------------------------------------------------- battle, environment, encounters, onboarding

test('battle: wild, trainer and boss start (and refuse while a fight is on)', async () => {
  const { reg, calls, host } = rig()
  assert.deepEqual(await reg.run('battle.wild', { species: 'o1', level: 8 }), { species: 'o1', level: 8 })
  const trainer = Object.keys(world.trainers)[0]
  await reg.run('battle.trainer', { trainer })
  const boss = await reg.run('battle.boss', { boss: 'astra' }) as { species: string; level: number }
  assert.equal(boss.species, CONTENT.bosses.astra.species)
  assert.equal(boss.level, CONTENT.bosses.astra.level)
  assert.equal(((await reg.run('battle.boss', { boss: 'astra', level: 40 })) as { level: number }).level, 40)
  assert.deepEqual(calls.map((c) => c.name), ['wild', 'trainer', 'wild', 'wild'])
  await rejects(reg.run('battle.wild', { species: 'nope' }), 'dev.err.unknownSpecies')
  await rejects(reg.run('battle.trainer', { trainer: 'nope' }), 'dev.err.unknownTrainer')
  await rejects(reg.run('battle.boss', { boss: 'nope' }))
  ;(host.overworld as unknown as { setBattle(on: boolean): void }).setBattle(true)
  await rejects(reg.run('battle.wild', { species: 'o1' }), 'dev.err.battleBusy')
})

test('environment: settings by type, LOD overrides on the live preset, encounter rate / repel / forced next', async () => {
  const { reg, emitted, save, calls } = rig()
  assert.deepEqual(await reg.run('settings.set', { key: 'quality', value: 'low' }), { key: 'quality', value: 'low' })
  assert.equal(save.settings.quality, 'low')
  await reg.run('settings.set', { key: 'shadows', value: 'false' })
  assert.equal(save.settings.shadows, false)
  await reg.run('settings.set', { key: 'pixelScale', value: '3' })
  assert.equal(save.settings.pixelScale, 3)
  assert.equal(emitted.filter((e) => e === 'settings:changed').length, 3)
  await rejects(reg.run('settings.set', { key: 'nope', value: '1' }))
  await rejects(reg.run('settings.set', { key: 'pixelScale', value: 'wide' }))

  const preset = qualityPreset('low') as unknown as Record<string, number>
  const was = preset.viewRadius
  try {
    await reg.run('render.tune', { key: 'viewRadius', value: 11 })
    assert.equal(preset.viewRadius, 11)
    await rejects(reg.run('render.tune', { key: 'bogus', value: 1 }))
    await rejects(reg.run('render.tune', { key: 'viewRadius', value: -1 }))
  } finally { preset.viewRadius = was }

  const rate = GAME.encounters.grassRateMultiplier
  try {
    await reg.run('encounter.rate', { mult: 5 })
    assert.equal(GAME.encounters.grassRateMultiplier, 5)
  } finally { GAME.encounters.grassRateMultiplier = rate }
  await reg.run('encounter.repel', {})
  assert.equal(save.repelSteps, 99999)
  await reg.run('encounter.repel', { on: false })
  assert.equal(save.repelSteps, 0)
  await reg.run('encounter.next', { species: 'o1', level: 7, shiny: true })
  assert.deepEqual(calls.at(-1), { name: 'force', args: [{ species: 'o1', level: 7, shiny: true }] })
})

test('onboarding: reset forgets tips, lessons and progress flags only; show pops a tip', async () => {
  const { reg, calls, save } = rig()
  Object.assign(save.flags, { 'tip:move': true, 'lesson:move': true, 'intro:mom': true, 'ob:route1': true, starter: 'o1', 'trainer:x': true })
  assert.deepEqual(await reg.run('onboard.reset'), { cleared: 4 })
  assert.deepEqual(Object.keys(save.flags).sort(), ['starter', 'trainer:x'])
  await reg.run('onboard.show', { tip: 'grass' })
  assert.deepEqual(calls.at(-1), { name: 'tip', args: ['grass'] })
  await rejects(reg.run('onboard.show', { tip: 'nope' }), 'dev.err.unknownTip')
})

// ----------------------------------------------------------------------------- lists

test('lists: every source answers, filters by id or name, caps, and reflects state', () => {
  const { host, save } = rig()
  for (const s of LIST_SOURCES) assert.ok(Array.isArray(listEntries(host, s)), s)
  for (const s of ['anchors', 'places', 'species', 'items', 'quests', 'flags', 'events', 'bosses', 'trainers', 'badges', 'statuses', 'weathers', 'scenarios', 'beats', 'teams', 'tips', 'roamers']) {
    assert.ok(listEntries(host, s).length > 0, `${s} is not empty`)
  }
  assert.deepEqual(listEntries(host, 'nope'), [])
  assert.ok(listEntries(host, 'anchors', 'town:forge').every((e) => e.id.includes('town:forge')))
  assert.ok(listEntries(host, 'species', 'claude').some((e) => e.id === 'claude-haiku'))
  assert.equal(listEntries(host, 'species', '', 3).length, 3)
  assert.equal(listEntries(host, 'items', 'special-sauce')[0].info?.have, 0)
  save.bag['special-sauce'] = 4
  assert.equal(listEntries(host, 'items', 'special-sauce')[0].info?.have, 4)
  save.flags['custom:flag'] = 7
  const flag = listEntries(host, 'flags', 'custom:flag')[0]
  assert.deepEqual([flag.id, flag.info?.value, flag.info?.known], ['custom:flag', 7, false])
  assert.ok(knownFlags().includes('tip:grass') && knownFlags().includes('rival:lab'), 'flags are scanned out of story and tutorial content')
  assert.equal(listEntries(host, 'tips', 'grass')[0].info?.seen, false)
  save.flags['tip:grass'] = true
  assert.equal(listEntries(host, 'tips', 'grass')[0].info?.seen, true)
  assert.deepEqual(listEntries(host, 'roamers')[0].info, { x: 3, y: 4, mood: 'idle' })
})

test('scenario: open reloads through the scenario URL, check reports the loaded scenario\'s expectations', async () => {
  const { reg, host } = rig()
  const assigned: string[] = []
  ;(globalThis as Record<string, unknown>).location = { search: '?dev=1', pathname: '/game', assign: (u: string) => assigned.push(u) }
  const res = await reg.run('scenario.open', { id: 'fresh-start' }) as { reloading: string }
  assert.equal(res.reloading, '/game?dev=1&scenario=fresh-start')
  await new Promise((ok) => setTimeout(ok, 120))
  assert.deepEqual(assigned, [res.reloading])
  await rejects(reg.run('scenario.open', { id: 'nope' }))
  assert.deepEqual(await reg.run('scenario.check'), { scenario: null, ok: true, results: [] })
  host.session.scenario = 'fresh-start'
  host.dump = () => ({ runtime: { map: 'elsewhere' }, save: {} })
  const r = await reg.run('scenario.check') as { scenario: string; ok: boolean; results: { path: string; ok: boolean }[] }
  assert.equal(r.scenario, 'fresh-start')
  assert.ok(r.results.length > 0 && typeof r.ok === 'boolean')
})

after(() => { delete (globalThis as Record<string, unknown>).location })
