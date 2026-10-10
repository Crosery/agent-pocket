// The 「必要知识」 checklist (content/tutorial.json curriculum): every lesson has a manual page and a trigger that
// can really fire, the facts the lessons state match the rules data, and the exchange desk is sound.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT, t, typeEffectiveness } from '../src/shared/content/index.ts'
import { buildWorld } from '../src/shared/world/index.ts'
import { starterSpecies, walkSteps } from '../src/shared/world/story.ts'
import { EXCHANGE, offersOf, takeOffer, timesAffordable, validateExchange } from '../src/shared/gameplay/exchange.ts'
import { BATTLE_CUES, ON_EVENTS, TUTORIAL, validateCurriculum } from '../src/client/onboarding/config.ts'
import { battleCues, condHolds, enrich, isTallGrassName, lessonLearned, matchPayload, tipLive, type ProgressView } from '../src/client/onboarding/logic.ts'
import type { BattleEvent, ScriptStep } from '../src/shared/types.ts'

const world = buildWorld()
const progress = (o: Partial<ProgressView> = {}): ProgressView => ({
  flags: {}, badges: [], party: [], quests: {}, bag: {}, stats: { battlesWon: 0, caught: 0, steps: 0, pvpWins: 0, pvpLosses: 0, trades: 0, shiniesFound: 0 }, ...o,
})

// What a new player must be taught (issue #25 + the owner's list). Each id must be a lesson with a trigger.
const REQUIRED = [
  'move', 'talk', 'menu', 'objective', 'save', 'hud',
  'battle', 'moveInfo', 'typeChart', 'typeImmune', 'dualType', 'stab', 'stats', 'statStages', 'status', 'catch', 'balls', 'trainerBattle', 'faint', 'levelUp', 'moveLearn', 'evolve',
  'party', 'teamBuild', 'bag', 'shop', 'exchange', 'chips', 'keyItems', 'heal', 'box',
  'gym', 'badge', 'worldMap', 'quests', 'worldEvent', 'rarity', 'timeWeather', 'research', 'dex',
  'online', 'chat', 'trade', 'pvp',
]

test('curriculum: every required topic is a lesson with a manual page and a real trigger', () => {
  assert.deepEqual(validateCurriculum(world), [])
  const ids = TUTORIAL.curriculum.lessons.map((l) => l.id)
  for (const id of REQUIRED) assert.ok(ids.includes(id), `missing lesson ${id}`)
  for (const l of TUTORIAL.curriculum.lessons) {
    assert.ok(t(`tutorial.manual.${l.id}.title`) !== `tutorial.manual.${l.id}.title`, `${l.id} title`)
    assert.ok(t(`tutorial.manual.${l.id}.body`).length >= 20, `${l.id} body`)
    assert.ok((l.tips?.length ?? 0) + (l.npcs?.length ?? 0) >= 1, `${l.id} trigger`)
  }
  for (const g of TUTORIAL.curriculum.groups) assert.ok(TUTORIAL.curriculum.lessons.some((l) => l.group === g.id), `group ${g.id} is empty`)
})

test('tips: only listen to known events, order references resolve, and bodies fit a small card', () => {
  for (const tip of TUTORIAL.tips.list) {
    const tr = tip.trigger
    if (tr.kind === 'on') assert.ok((ON_EVENTS as readonly string[]).includes(tr.on) || (BATTLE_CUES as readonly string[]).includes(tr.on), `${tip.id}: ${tr.on}`)
    assert.ok(t(`${tip.text}.body`).replace(/\{\w+\}/g, 'k').length <= 130, `${tip.id}: tip body too long for the card`)
    assert.ok(t(`${tip.text}.title`).length <= 14, `${tip.id}: title too long`)
  }
  assert.ok(TUTORIAL.tips.layer.staleSec > TUTORIAL.tips.layer.ttlSec, 'stale tips are dropped after they would have expired')
})

test('on-triggers: payload matching, derived fields and battle cues', () => {
  assert.ok(matchPayload({ screen: 'shop' }, { screen: 'shop' }))
  assert.ok(!matchPayload({ screen: 'shop' }, { screen: 'bag' }))
  assert.ok(matchPayload({ mapId: { startsWith: 'gym-' } }, { mapId: 'gym-code' }))
  assert.ok(matchPayload({ mapId: { endsWith: '-center' } }, { mapId: 'origin-center' }))
  assert.ok(matchPayload({ n: { min: 2, max: 3 } }, { n: 3 }) && !matchPayload({ n: { min: 2 } }, { n: 1 }))
  const sr = CONTENT.speciesList.find((s) => s.rarity === 'SR')!
  assert.equal(enrich('dex:seen', { speciesId: sr.id }, world).rarityOrder, 2)
  assert.equal(enrich('map:entered', { mapId: 'gym-code' }, world).mapKind, world.maps['gym-code'].kind)
  const events: BattleEvent[] = [
    { t: 'turn', turn: 2 },
    { t: 'damage', side: 1, amount: 9, hp: 1, maxHp: 10, effectiveness: 2, crit: false },
    { t: 'damage', side: 0, amount: 1, hp: 9, maxHp: 10, effectiveness: 0.25, crit: true },
    { t: 'msg', text: t('battle.noEffect') },
    { t: 'stat', side: 0, stat: 'atk', delta: 1 },
    { t: 'status', side: 1, status: 'burn' },
    { t: 'catch', ballId: 'prompt-ball', shakes: 1, success: false },
  ]
  const cues = battleCues(events).map((c) => c.cue)
  for (const c of ['turn', 'superEffective', 'resisted', 'doubleResist', 'crit', 'immune', 'stat', 'status', 'catchFail']) assert.ok(cues.includes(c), c)
  assert.ok(!cues.includes('takenSuper') && !cues.includes('caught'))
})

test('tips respect progress and the manual marks lessons learnt (tip seen or taught by an NPC)', () => {
  const lesson = TUTORIAL.curriculum.lessons.find((l) => l.id === 'typeChart')!
  assert.ok(!lessonLearned(lesson, progress()))
  assert.ok(lessonLearned(lesson, progress({ flags: { 'lesson:typeChart': true } })))
  assert.ok(lessonLearned(lesson, progress({ flags: { 'tip:typeMatchup': true } })))
  const bike = TUTORIAL.tips.list.find((x) => x.id === 'bike')!
  assert.ok(!condHolds((bike.trigger as { needs?: never }).needs, progress()))
  assert.ok(condHolds((bike.trigger as { needs?: never }).needs, progress({ bag: { 'hover-board': 1 } })))
  assert.ok(!tipLive(bike, progress({ badges: ['a', 'b', 'c', 'd'] })), 'veterans past the lesson are not nagged')
  const night = TUTORIAL.tips.list.find((x) => x.id === 'timeWeather')!
  assert.ok(!condHolds((night.trigger as { needs?: never }).needs, progress({ flags: { 'ob:route1': true } }), { timeOfDay: 'day' }))
  assert.ok(condHolds((night.trigger as { needs?: never }).needs, progress({ flags: { 'ob:route1': true } }), { timeOfDay: 'night' }))
})

test('lesson facts agree with the rules data', () => {
  const eff = (a: string, d: string) => typeEffectiveness(a as never, [d as never])
  // starter triangle and the four memory loops quoted by the 属性克制 page
  const loops = [['logic', 'chaos', 'search', 'logic'], ['compute', 'code', 'logic', 'compute'], ['write', 'motion', 'vision', 'write'], ['safety', 'open', 'code', 'safety']]
  for (const loop of loops) for (let i = 0; i < loop.length - 1; i++) assert.equal(eff(loop[i], loop[i + 1]), 2, `${loop[i]} -> ${loop[i + 1]}`)
  assert.equal(eff('chat', 'compute'), 0)
  assert.deepEqual(Object.entries(CONTENT.typeChart).flatMap(([a, row]) => Object.entries(row).filter(([, m]) => m === 0).map(([d]) => `${a}>${d}`)), ['chat>compute'], 'the 免疫 page names the only immunity')
  assert.equal(CONTENT.config.battle.stab, 1.5)
  assert.equal(CONTENT.config.battle.statStageLimit, 6)
  assert.deepEqual(Object.entries(CONTENT.statusImmunities).map(([k, v]) => `${k}:${v}`).sort(), ['burn:compute', 'freeze:code', 'poison:safety', 'sleep:open'])
  assert.equal(CONTENT.rarities.length, 6)
  assert.equal(world.badges.length, 8)
  for (const k of ['hp', 'atk', 'def', 'spa', 'spd', 'spe']) assert.ok(CONTENT.statByKey[k].desc.length > 4, `stat ${k} has a description`)
})

test('type lesson: the three practice dummies give every starter a super effective and a resisted target', () => {
  const trainer = world.trainers['lesson-types']
  assert.ok(trainer, 'practice trainer exists')
  assert.equal(trainer.party.length, 3)
  assert.equal(trainer.aiLevel, 0)
  for (const starter of starterSpecies()) {
    const outcomes = trainer.party.map((p) => Math.max(...starter.types.map((ty) => typeEffectiveness(ty, CONTENT.species[p.species!].types))))
    assert.ok(outcomes.includes(2) && outcomes.some((o) => o > 0 && o < 1), `${starter.id} sees ${outcomes}`)
  }
  const aide = world.maps['origin-lab'].npcs.find((n) => n.id === 'aide-types')!
  const ops: string[] = []
  walkSteps(aide.script, (s) => { ops.push(s.op) })
  assert.ok(ops.includes('battle') || ops.includes('choice'), 'offers the practice fight')
  const flat = JSON.stringify(aide.script)
  assert.match(flat, /lesson-types|type-lesson/)
  assert.match(flat, /"teach"/)
})

test('shops: the clerk offers the exchange desk and teaches shop + exchange; nurse and box teach too', () => {
  const taught = (npc: string, map: string) => {
    const found: string[] = []
    const ops: string[] = []
    walkSteps(world.maps[map].npcs.find((n) => n.id === npc)!.script as ScriptStep[], (s) => { ops.push(s.op); if (s.op === 'teach') found.push(s.lesson) })
    return { found, ops }
  }
  const clerk = taught('clerk-origin', 'origin-shop')
  assert.ok(clerk.ops.includes('exchange'))
  assert.deepEqual(clerk.found.sort(), ['exchange', 'shop'])
  assert.deepEqual(taught('nurse-origin', 'origin-center').found, ['heal'])
  assert.deepEqual(taught('box-origin', 'origin-center').found, ['box'])
})

test('exchange: data is sound, unlocks by badges, takes materials and counts what was taken', () => {
  assert.deepEqual(validateExchange(CONTENT.items), [])
  const offers = offersOf('general')
  assert.ok(offers.length >= 8)
  assert.ok(offers.some((o) => (o.atLeastBadges ?? 0) === 0), 'something is open from the start')
  assert.ok(offers.some((o) => (o.atLeastBadges ?? 0) >= 4), 'high-tier offers are earned')
  const o = offers.find((x) => x.id === 'shard-cache')!
  const save = { bag: { 'data-shard': 5 } as Record<string, number>, badges: [] as string[], flags: {} as Record<string, boolean | number | string> }
  assert.equal(timesAffordable(o, save), 2)
  assert.ok(takeOffer(o, save, 2))
  assert.equal(save.bag['super-cache'], 2)
  assert.equal(save.bag['data-shard'], 1)
  assert.equal(save.flags[`${EXCHANGE.flagPrefix}${o.id}`], 2)
  assert.ok(!takeOffer(o, save, 1), 'not enough shards left')
  const gated = offers.find((x) => (x.atLeastBadges ?? 0) >= 4)!
  const rich = { bag: Object.fromEntries(Object.keys(gated.give).map((k) => [k, 9])), badges: [] as string[], flags: {} }
  assert.equal(timesAffordable(gated, rich), 0, 'locked without badges')
  assert.ok(timesAffordable(gated, { ...rich, badges: ['1', '2', '3', '4'] }) > 0)
})

test('the tall-grass tip fires for the terrain name the overworld reports', () => {
  const grass = CONTENT.terrain.filter((x) => x.tallGrass)
  assert.ok(grass.length > 0)
  for (const g of grass) assert.ok(isTallGrassName(g.nameZh), g.nameZh)
  const plain = CONTENT.terrain.find((x) => !x.tallGrass && x.walkable)!
  assert.ok(!isTallGrassName(plain.nameZh), plain.nameZh)
})

test('boss lessons: the new lessons have manual pages and a trigger, the removed cards are not taught any more', () => {
  for (const id of ['bossMechanic', 'bait', 'capture', 'grade']) {
    const l = TUTORIAL.curriculum.lessons.find((x) => x.id === id)
    assert.ok(l, id)
    assert.ok(`tutorial.manual.${id}.body` in CONTENT.text, `${id} manual`)
    assert.ok((l.tips?.length ?? 0) + (l.npcs?.length ?? 0) > 0, `${id} trigger`)
  }
  for (const lesson of TUTORIAL.curriculum.lessons) for (const gone of ['signs', 'fly', 'tradePvp', 'center', 'objective', 'menuHint']) assert.ok(!lesson.tips?.includes(gone), `${lesson.id} still teaches ${gone}`)
})
