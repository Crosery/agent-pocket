// Dex research: per-rarity tasks, progress/thresholds/points, levels + rewards, battle-derived events, save repair.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT } from '../src/shared/content/index.ts'
import {
  addTaskProgress, applyResearch, levelRewards, recordResearch, researchComplete, researchFromBattle, researchLevel, researchPoints,
  sanitizeResearch, speciesResearch, taskPoints, tasksFor, type ResearchState,
} from '../src/shared/gameplay/research.ts'
import { GAMEPLAY } from '../src/shared/gameplay/data.ts'

const R = GAMEPLAY.research
const ofRarity = (r: string) => CONTENT.speciesList.find((s) => s.rarity === r && !s.starter)!.id

test('task sets differ by rarity and reference real tasks', () => {
  for (const r of CONTENT.rarities) {
    const ids = tasksFor(ofRarity(r.id)).map((x) => x.id)
    assert.deepEqual(ids, R.byRarity[r.id])
  }
  assert.ok(tasksFor(ofRarity('SSR')).some((x) => x.kind === 'seeAtTime' && x.param === 'night'))
  assert.ok(tasksFor(ofRarity('SSR')).some((x) => x.kind === 'catchInWeather'))
  assert.ok(tasksFor(ofRarity('UR')).some((x) => x.kind === 'defeatRoaming'))
  assert.ok(tasksFor(ofRarity('MYTHIC')).some((x) => x.kind === 'chainStep'))
  assert.ok(tasksFor(ofRarity('N')).some((x) => x.kind === 'catch'))
  assert.deepEqual(tasksFor('missingno'), [])
})

test('progress, thresholds, rarity point multipliers and the cap', () => {
  const n = ofRarity('N'), ur = ofRarity('UR')
  const catchTask = R.tasks.find((x) => x.id === 'catch')!
  let s: ResearchState = {}
  let r = recordResearch(s, n, { kind: 'catch' })
  assert.equal(r.gains.length, 1)
  assert.deepEqual({ from: r.gains[0].from, to: r.gains[0].to, reached: r.gains[0].reached }, { from: 0, to: 1, reached: 1 })
  assert.equal(r.gains[0].points, catchTask.points * (R.rarityPointMul?.N ?? 1))
  s = r.state
  r = recordResearch(s, n, { kind: 'catch', amount: 1 })
  assert.equal(r.gains[0].reached, 0, '2 is between thresholds')
  r = recordResearch(r.state, n, { kind: 'catch', amount: 1000 })
  assert.equal(r.state[n].catch, Math.max(...catchTask.thresholds), 'capped at the last threshold')
  assert.equal(recordResearch(r.state, n, { kind: 'catch' }).gains.length, 0)
  assert.ok(taskPoints(catchTask, ur) > taskPoints(catchTask, n), 'rarer species are worth more')
  assert.deepEqual(s, { [n]: { catch: 1 } }, 'input state untouched by later calls')
})

test('param matching: exact, own type, wildcard ignoring clear weather; befriend uses max', () => {
  const ssr = ofRarity('SSR'), r = ofRarity('R')
  assert.equal(recordResearch({}, ssr, { kind: 'seeAtTime', param: 'day' }).gains.length, 0)
  assert.equal(recordResearch({}, ssr, { kind: 'seeAtTime', param: 'night' }).gains.length, 1)
  assert.equal(recordResearch({}, ssr, { kind: 'catchInWeather', param: 'clear' }).gains.length, 0)
  assert.equal(recordResearch({}, ssr, { kind: 'catchInWeather', param: 'fog' }).gains.length, 1)
  const own = CONTENT.species[r].types[0]
  const other = CONTENT.types.find((t) => !CONTENT.species[r].types.includes(t.id))!.id
  assert.equal(recordResearch({}, r, { kind: 'useMoveType', param: other }).gains.length, 0)
  assert.equal(recordResearch({}, r, { kind: 'useMoveType', param: own }).gains.length, 1)
  let s = recordResearch({}, r, { kind: 'befriend', amount: 150, set: true }).state
  s = recordResearch(s, r, { kind: 'befriend', amount: 90, set: true }).state
  assert.equal(s[r].befriend, 150)
})

test('ScriptStep research adds to one task id; MYTHIC chain completes its research', () => {
  const my = ofRarity('MYTHIC')
  let s: ResearchState = {}
  assert.deepEqual(addTaskProgress(s, my, 'catch-night', 1).gains, [], 'task not in the tier set')
  for (let i = 0; i < 5; i++) s = addTaskProgress(s, my, 'mythic-chain', 1).state
  assert.equal(s[my]['mythic-chain'], 5)
  assert.ok(researchComplete(s, my))
  const page = speciesResearch(s, my)
  assert.equal(page.complete, true)
  assert.equal(page.tasks.find((t) => t.def.id === 'mythic-chain')!.next, null)
})

test('research levels: cumulative thresholds, rewards aggregated, every reward item exists', () => {
  assert.deepEqual(researchLevel(0), { level: 0, nextAt: R.levels[0].points, prevAt: 0 })
  assert.equal(researchLevel(R.levels[0].points).level, 1)
  assert.equal(researchLevel(R.levels[0].points - 1).level, 0)
  const max = researchLevel(1e9)
  assert.equal(max.level, R.levels.length)
  assert.equal(max.nextAt, null)
  const rw = levelRewards(0, 2)
  assert.equal(rw.money, (R.levels[0].reward?.money ?? 0) + (R.levels[1].reward?.money ?? 0))
  assert.deepEqual(levelRewards(3, 3), { money: 0, items: {} })
  for (const lv of R.levels) for (const id of Object.keys(lv.reward?.items ?? {})) assert.ok(CONTENT.items[id], id)
})

test('battle -> research events -> applyResearch (levels, rewards, completion)', () => {
  const ssr = ofRarity('SSR'), ur = ofRarity('UR')
  const items = researchFromBattle({
    seen: [ssr, ssr], defeated: [], result: 'caught', caught: { speciesId: ssr, shiny: true }, foeMoves: [{ species: ssr, type: CONTENT.species[ssr].types[0] }],
    timeOfDay: 'night', weather: 'fog', biome: 'swamp',
  })
  const kinds = items.filter((x) => x.species === ssr).map((x) => x.event.kind)
  for (const k of ['see', 'seeAtTime', 'seeInWeather', 'useMoveType', 'catch', 'catchAtTime', 'catchInWeather', 'catchInBiome', 'catchShiny']) assert.ok(kinds.includes(k as never), k)
  assert.equal(kinds.filter((k) => k === 'see').length, 1, 'seen once per battle')
  const r = applyResearch({}, items)
  assert.ok(r.pointsAfter > r.pointsBefore)
  assert.equal(researchPoints(r.state), r.pointsAfter)
  assert.equal(r.levelAfter, researchLevel(r.pointsAfter).level)
  assert.deepEqual(r.rewards, levelRewards(r.levelBefore, r.levelAfter))
  const roam = researchFromBattle({ seen: [ur], defeated: [ur], result: 'win', foeMoves: [], timeOfDay: 'day', weather: 'clear', biome: null, roamingLegend: true })
  assert.ok(roam.some((x) => x.event.kind === 'defeatRoaming'))
  assert.ok(!roam.some((x) => x.event.kind === 'catch'))
  // grinding a common species to completion reports it once
  const n = ofRarity('N')
  const grind = Array.from({ length: 60 }, () => [{ species: n, event: { kind: 'catch' as const } }, { species: n, event: { kind: 'defeat' as const } }, { species: n, event: { kind: 'see' as const } }, { species: n, event: { kind: 'catchAtTime' as const, param: 'night' } }]).flat()
  const done = applyResearch({}, grind)
  assert.deepEqual(done.completed, [n])
  assert.deepEqual(applyResearch(done.state, grind).completed, [])
})

test('sanitizeResearch keeps positive integer progress for known species/tasks', () => {
  const n = ofRarity('N')
  assert.deepEqual(sanitizeResearch({ [n]: { catch: 3.9, see: -1, bogus: 2 }, missingno: { catch: 1 }, x: 5 }), { [n]: { catch: 3 } })
  assert.deepEqual(sanitizeResearch([]), {})
})
