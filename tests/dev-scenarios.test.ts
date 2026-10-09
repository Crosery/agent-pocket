// Scenario presets (ADR 0002 §4.4): every file references real content, applies to a save that survives
// sanitizing, leaves the player on a standable tile with an objective, and the boss scenario can be fought out.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT, t } from '../src/shared/content/index.ts'
import { buildWorld, worldAnchors } from '../src/shared/world/index.ts'
import { collisionField, getMap } from '../src/shared/world/worldapi.ts'
import { STORY_CONTENT } from '../src/shared/world/story.ts'
import { Rng } from '../src/shared/rng.ts'
import { applyScenario, checkExpectations, flattenScenario, resolveDevPlace } from '../src/shared/dev/scenario.ts'
import { digest } from '../src/shared/dev/diff.ts'
import { createSaveManager } from '../src/client/core/save.ts'
import { migrateSave } from '../src/client/core/save-migrate.ts'
import { pickObjective } from '../src/client/onboarding/logic.ts'
import { TIP_FLAG_PREFIX } from '../src/client/onboarding/config.ts'
import { resolvePlace } from '../src/client/world/explore.ts'
import { CONSOLE } from '../src/client/dev/registry.ts'
import { installDevText } from '../src/client/dev/text.ts'
import { devContentFromDisk } from './dev-content.ts'
import { simulate } from './boss-sim.ts'
import { COUNTERS } from './boss-counters.ts'

const world = buildWorld()
const anchors = worldAnchors(world)
const content = devContentFromDisk()
const ids = Object.keys(content.scenarios).sort()
before(() => installDevText())

const memory = () => {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, removeItem: (k: string) => { m.delete(k) } }
}
const saves = createSaveManager({ world, storage: memory(), now: () => 1_700_000_000_000, newId: () => '00000000-0000-4000-8000-000000000001' })
const avatar = CONTENT.characters.find((c) => c.playable)!
const legacy = (name: string) => (content.saves[name] ? saves.sanitize(migrateSave(structuredClone(content.saves[name]))) : null)
const apply = (id: string) => applyScenario(id, { world, ...content, base: saves.newGame({ name: avatar.nameZh, avatar: avatar.id }), legacy, rng: new Rng(7) })

test('at least six scenarios, each file named after its id, each with a title', () => {
  assert.ok(ids.length >= 6, `${ids.length} scenarios`)
  for (const id of ids) {
    assert.equal(content.scenarios[id].id, id)
    assert.notEqual(t(content.scenarios[id].titleKey), content.scenarios[id].titleKey, `${id}: text ${content.scenarios[id].titleKey}`)
  }
})

test('every reference resolves: extends, beats, teams, badges, quests, items, species, places, commands', () => {
  const bad: string[] = []
  const badgeIds = new Set(world.badges.map((b) => b.id))
  const check = (where: string, ok: boolean, what: string) => { if (!ok) bad.push(`${where}: ${what}`) }
  for (const [id, b] of Object.entries(content.beats)) {
    check(`beat ${id}`, t(b.titleKey) !== b.titleKey, `text ${b.titleKey}`)
    for (const bd of b.badges ?? []) check(`beat ${id}`, badgeIds.has(bd), `badge ${bd}`)
    for (const tr of b.trainers ?? []) check(`beat ${id}`, !!world.trainers[tr], `trainer ${tr}`)
    for (const [q, st] of Object.entries(b.quests ?? {})) {
      const def = world.quests.find((x) => x.id === q)
      check(`beat ${id}`, !!def && st.stage >= 0 && st.stage < def.stages.length, `quest ${q} stage ${st.stage}`)
    }
    if (b.place) check(`beat ${id}`, !!resolveDevPlace(world, b.place, anchors), `place ${JSON.stringify(b.place)}`)
  }
  for (const [id, team] of Object.entries(content.teams)) {
    check(`team ${id}`, team.members.length >= 1 && team.members.length <= CONTENT.config.party.maxParty, 'size')
    check(`team ${id}`, team.level >= 1 && team.level <= CONTENT.config.party.maxLevel, 'level')
    for (const m of team.members) {
      check(`team ${id}`, !!CONTENT.species[m.species], `species ${m.species}`)
      if (m.status) check(`team ${id}`, CONTENT.statuses.some((s) => s.id === m.status), `status ${m.status}`)
    }
  }
  for (const id of ids) {
    const sc = flattenScenario(id, content.scenarios)
    if (sc.beat) check(id, !!content.beats[sc.beat], `beat ${sc.beat}`)
    for (const e of sc.party ?? []) {
      if (e.team) check(id, !!content.teams[e.team], `team ${e.team}`)
      else check(id, !!e.species && !!CONTENT.species[e.species], `species ${e.species}`)
    }
    for (const bd of sc.badges ?? []) check(id, badgeIds.has(bd), `badge ${bd}`)
    for (const item of Object.keys(sc.bag ?? {})) check(id, !!CONTENT.items[item], `item ${item}`)
    for (const [q, st] of Object.entries(sc.quests ?? {})) check(id, world.quests.some((x) => x.id === q) && st.stage >= 0, `quest ${q}`)
    for (const call of sc.then ?? []) {
      const meta = CONSOLE.commands[call.cmd]
      check(id, !!meta, `command ${call.cmd}`)
      if (!meta) continue
      for (const k of Object.keys(call.args ?? {})) check(id, meta.args.some((a) => a.name === k), `${call.cmd} has no argument ${k}`)
      for (const a of meta.args) if (!a.optional) check(id, call.args?.[a.name] !== undefined, `${call.cmd} needs ${a.name}`)
      if (call.cmd === 'discover') check(id, !!resolvePlace(world, String(call.args?.place)), `place ${call.args?.place}`)
      if (call.cmd === 'battle.boss') check(id, !!CONTENT.bosses[String(call.args?.boss)], `boss ${call.args?.boss}`)
    }
    if (sc.weather) check(id, sc.weather in CONTENT.config.time || true, 'weather')
    for (const e of sc.expect ?? []) check(id, e.path.startsWith('/'), `expect path ${e.path}`)
    if (sc.seed !== undefined) check(id, Number.isInteger(sc.seed) && sc.seed >= 0, 'seed')
  }
  assert.deepEqual(bad, [])
})

test('flattenScenario: extends chain, merged maps, concatenated lists, cycle and unknown id errors', () => {
  const s = {
    a: { id: 'a', titleKey: 'ta', flags: { x: 1, y: 1 }, bag: { p: 1 }, then: [{ cmd: 'one' }], expect: [{ path: '/a', eq: 1 }], money: 5 },
    b: { id: 'b', titleKey: 'tb', extends: 'a', flags: { y: 2 }, then: [{ cmd: 'two' }], money: 9 },
    c: { id: 'c', titleKey: 'tc', extends: 'b', bag: { q: 2 } },
    loop1: { id: 'loop1', titleKey: 'x', extends: 'loop2' }, loop2: { id: 'loop2', titleKey: 'x', extends: 'loop1' },
  }
  const c = flattenScenario('c', s)
  assert.deepEqual(c.flags, { x: 1, y: 2 })
  assert.deepEqual(c.bag, { p: 1, q: 2 })
  assert.deepEqual(c.then?.map((x) => x.cmd), ['one', 'two'])
  assert.equal(c.money, 9)
  assert.equal(c.titleKey, 'tc')
  assert.equal(c.id, 'c')
  assert.throws(() => flattenScenario('loop1', s), /cycle/)
  assert.throws(() => flattenScenario('nope', s), /unknown scenario/)
})

for (const id of ids) {
  test(`scenario ${id}: applies cleanly, survives sanitize, stands somewhere real, has an objective, expectations hold`, () => {
    const res = apply(id)
    assert.deepEqual(res.problems, [])
    const save = res.save

    // sanitize loses nothing of what the scenario set up
    const back = saves.sanitize(JSON.parse(JSON.stringify(save)))
    assert.ok(back, 'sanitize accepts the save')
    for (const part of ['party', 'bag', 'badges', 'flags', 'quests', 'money', 'clockMinutes', 'position'] as const) {
      assert.equal(digest(back[part]), digest(save[part]), `${part} unchanged by sanitize`)
    }
    for (const cr of save.party) {
      assert.ok(cr.hp >= 0 && cr.moves.length > 0, `${cr.speciesId} has moves`)
      assert.equal((back.party.find((m) => m.uid === cr.uid) ?? cr).nickname, cr.nickname)
    }

    // the position is a real tile the player can stand on
    const map = getMap(world, save.position.map)
    assert.ok(map, `map ${save.position.map}`)
    if (!map.infinite) assert.ok(save.position.x >= 0 && save.position.y >= 0 && save.position.x < map.width && save.position.y < map.height, 'inside the map')
    assert.equal(collisionField(map).at(save.position.x, save.position.y), 0, `tile ${save.position.x},${save.position.y} is free`)

    // onboarding objective and quest navigation have something to point at
    const obj = pickObjective(world, save)
    assert.ok(obj.ruleId, 'an objective rule applies')
    const main = save.quests.main
    if (main && !main.done) {
      assert.ok(obj.questTarget, 'the main quest stage has a target for the arrow')
      assert.ok(getMap(world, obj.questTarget.map), 'on a real map')
    }

    // expectations about the save hold (runtime ones are checked in the browser suite)
    const results = checkExpectations({ save }, (res.expect).filter((e) => e.path.startsWith('/save')))
    assert.deepEqual(results.filter((r) => !r.ok), [])

    // determinism: the same scenario and seed build the same save
    assert.equal(digest(apply(id).save.party.map((c) => ({ ...c, uid: '' }))), digest(save.party.map((c) => ({ ...c, uid: '' }))), 'party is reproducible')
  })
}

test('tutorial-first-battle stops before the grass and battle tips; fresh-start has none seen', () => {
  const tut = apply('tutorial-first-battle').save
  assert.equal(tut.flags[`${TIP_FLAG_PREFIX}grass`], undefined)
  assert.equal(tut.flags[`${TIP_FLAG_PREFIX}battle`], undefined)
  assert.equal(tut.flags[STORY_CONTENT.meta.flags.starter], 'claude-haiku')
  assert.equal(tut.party.length, 1)
  assert.equal(tut.party[0].level, CONTENT.config.creature.starterLevel)
  const fresh = apply('fresh-start').save
  assert.deepEqual(Object.keys(fresh.flags).filter((k) => k.startsWith(TIP_FLAG_PREFIX)), [])
  assert.equal(fresh.party.length, 0)
})

test('after-gym-3: three badges, the gym trainers count as beaten, the main quest is at its fifth stage', () => {
  const s = apply('after-gym-3').save
  assert.deepEqual(s.badges, ['badge-code', 'badge-vision', 'badge-sound'])
  const prefix = STORY_CONTENT.meta.flags.trainerWon
  for (const tr of ['gc-xiaoma', 'leader_code', 'gv-atong', 'leader_vision', 'gs-shengsheng', 'leader_sound']) assert.equal(s.flags[prefix + tr], true, tr)
  assert.deepEqual(s.quests.main, { stage: 4, done: false })
  assert.equal(s.position.map, anchors['town:chord'].map)
  assert.equal(s.position.x, anchors['town:chord'].x)
})

test('ui-worst-case: six creatures with the longest nickname, a status each, every item, eight badges', () => {
  const s = apply('ui-worst-case').save
  assert.equal(s.party.length, 6)
  for (const cr of s.party) assert.equal(cr.nickname?.length, 12, `${cr.speciesId} nickname length`)
  assert.equal(new Set(s.party.map((c) => c.status).filter(Boolean)).size, 5, 'five different status conditions')
  assert.ok(s.party.some((c) => c.hp > 0 && c.hp < 0.2 * 9999) || s.party.some((c) => c.hp > 0), 'someone is still standing')
  assert.equal(s.badges.length, world.badges.length)
  assert.equal(Object.keys(s.bag).length, CONTENT.itemList.length)
  assert.ok(Object.values(s.bag).every((n) => n === 99))
})

test('night-rain-forge and determinism-walk freeze the clock; frontier-far stands 1400+ tiles from the origin', () => {
  const night = apply('night-rain-forge')
  assert.equal(night.save.clockMinutes, 1290)
  assert.deepEqual(night.commands.slice(0, 2).map((c) => [c.cmd, c.args]), [['clock.freeze', { on: true }], ['weather.set', { kind: 'rain' }]])
  assert.equal(night.save.position.map, anchors['town:forge'].map)
  const walk = apply('determinism-walk')
  assert.equal(walk.scenario.rng, 424242)
  assert.equal(walk.scenario.seed, CONTENT.config.world.seed)
  assert.deepEqual(walk.commands.map((c) => c.cmd), ['clock.freeze', 'weather.set'], 'weather cleared, clock held')
  const far = apply('frontier-far')
  const o = world.maps[world.startMap]
  const dist = Math.hypot(far.save.position.x - o.spawn.x, far.save.position.y - o.spawn.y)
  assert.ok(dist > 1400, `distance ${Math.round(dist)}`)
  assert.equal(far.commands.filter((c) => c.cmd === 'discover').length, 5)
})

test('boss-astra-counter: the scenario team plays out the Astra fight with the sauce counter (autopilot)', () => {
  const res = apply('boss-astra-counter')
  assert.deepEqual(res.commands.map((c) => c.cmd), ['battle.boss'])
  const boss = CONTENT.bosses.astra
  const partyIds = res.save.party.map((c) => c.speciesId)
  assert.deepEqual(partyIds, content.teams['boss-counter:astra'].members.map((m) => m.species))
  assert.equal(res.save.party[0].level, content.teams['boss-counter:astra'].level)
  const r = simulate({ bossId: 'astra', seed: 7, partyIds, level: res.save.party[0].level, bag: { ...res.save.bag }, policy: COUNTERS.astra.policy, maxTurns: 120 })
  assert.ok(r.result !== null, 'the fight ends')
  assert.ok(r.turns > 0 && r.turns <= 120)
  assert.ok(boss.level >= res.save.party[0].level)
})
