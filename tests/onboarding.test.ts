import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT, t, typeEffectiveness } from '../src/shared/content/index.ts'
import { buildWorld, worldAnchors } from '../src/shared/world/index.ts'
import { createCreature } from '../src/shared/creature.ts'
import { Rng } from '../src/shared/rng.ts'
import { sanitizeSettings } from '../src/client/core/save-sanitize.ts'
import { TUTORIAL, validateTutorial } from '../src/client/onboarding/config.ts'
import { bearing, condHolds, nearestTarget, pickObjective, tipLive, type ProgressView } from '../src/client/onboarding/logic.ts'

const world = buildWorld()
const anchors = worldAnchors(world)

const progress = (o: Partial<ProgressView> = {}): ProgressView => ({
  flags: {}, badges: [], party: [], quests: {}, stats: { battlesWon: 0, caught: 0, steps: 0, pvpWins: 0, pvpLosses: 0, trades: 0, shiniesFound: 0 }, ...o,
})
const mon = () => createCreature('o1', 5, { rng: new Rng(1) })
const idOf = (p: ProgressView) => pickObjective(world, p).ruleId

test('tutorial content validates against the world and the text tables', () => {
  assert.deepEqual(validateTutorial(world, anchors), [])
})

test('objective follows story progress from starter to gym 1 to the main quest', () => {
  const party = [mon()]
  assert.equal(idOf(progress()), 'starter')
  assert.equal(idOf(progress({ flags: { starter: 'o1' }, party })), 'rival')
  const afterRival = { starter: 'o1', 'rival:lab': true }
  assert.equal(idOf(progress({ flags: afterRival, party })), 'typeLesson', 'the optional type lesson comes first')
  assert.equal(idOf(progress({ flags: { ...afterRival, 'lesson:typeChart': true }, party })), 'route')
  assert.equal(idOf(progress({ flags: { ...afterRival, 'ob:route1': true }, party })), 'catch', 'leaving town skips the optional lesson')
  const caught = progress({ flags: { ...afterRival, 'ob:route1': true }, party, stats: { ...progress().stats, caught: 1 } })
  assert.equal(idOf(caught), 'heal')
  assert.equal(idOf({ ...caught, flags: { ...caught.flags, 'ob:healed': true } }), 'gym1')
  const badge = progress({ flags: { ...afterRival, 'ob:healed': true }, party, badges: ['badge-code'], quests: { main: { stage: 2, done: false } } })
  const next = pickObjective(world, badge)
  assert.equal(next.ruleId, 'next')
  assert.equal(next.params.stage, world.quests.find((q) => q.id === 'main')!.stages[2].text)
  assert.ok(next.questTarget, 'quest stage target drives the arrow')
  const done = pickObjective(world, progress({ flags: afterRival, party, badges: ['b'], quests: { main: { stage: 12, done: true } } }))
  assert.equal(done.textKey, 'tutorial.objective.explore')
})

test('every objective names something the player can walk to and text resolves', () => {
  for (const r of TUTORIAL.objective.rules) {
    assert.ok(t(r.text) !== r.text, `${r.id} text`)
    if (!r.fromQuest) assert.ok(r.target?.length, `${r.id} has a target`)
  }
})

test('arrow resolves through doors: home -> overworld lab door, overworld -> lab interior', () => {
  const home = anchors['origin-home:wake']
  const lab = anchors['town:origin:lab']
  const out = nearestTarget(world, home, [lab])
  assert.ok(out && out.map === 'origin-home', 'points at the exit of the house')
  const rival = anchors['origin-lab:rival']
  const door = nearestTarget(world, { ...lab, x: lab.x + 6 }, [rival])
  assert.ok(door && door.map === lab.map, 'points at the lab door from the street')
  assert.equal(nearestTarget(world, rival, [rival]), rival)
  const b = bearing({ map: 'm', x: 0, y: 0 }, { map: 'm', x: 10, y: 0 })
  assert.ok(Math.abs(b.angle) < 0.1 && Math.abs(b.tiles - 10) <= 1)
})

test('tips: each shows once, expires with the lesson, conditions are data-driven', () => {
  const p = progress()
  const move = TUTORIAL.tips.list.find((x) => x.id === 'move')!
  assert.ok(tipLive(move, p))
  assert.ok(!tipLive(move, progress({ flags: { 'tip:move': true } })), 'already shown')
  assert.ok(!tipLive(move, progress({ flags: { starter: 'o1' } })), 'moving was learnt long ago')
  assert.ok(condHolds({ minStat: { battlesWon: 1 } }, progress({ stats: { ...p.stats, battlesWon: 2 } })))
  for (const id of ['move', 'talk', 'grass', 'battle', 'battleEffects', 'statGlossary', 'typeMatchup', 'catch', 'menu']) {
    assert.ok(TUTORIAL.tips.list.some((x) => x.id === id), id)
  }
  for (const tip of TUTORIAL.tips.list) {
    assert.ok(t(`${tip.text}.body`).length > 4, `${tip.id} body`)
  }
  assert.match(t('tutorial.tip.statGlossary.body'), /上下文/)
  assert.match(t('tutorial.tip.statGlossary.body'), /推理/)
  assert.match(t('tutorial.tip.battleEffects.body'), /状态详情/)
  assert.match(t('tutorial.tip.typeMatchup.body'), /×2/)
  assert.match(t('tutorial.tip.typeMatchup.body'), /×0\.5/)
  assert.match(t('tutorial.tip.typeMatchup.body'), /×0/)
  assert.equal(typeEffectiveness('code', ['logic']), 2, 'code should beat logic')
  assert.equal(typeEffectiveness('logic', ['chat']), 2, 'logic should beat chat')
  assert.equal(typeEffectiveness('chat', ['compute']), 0, 'chat should not affect compute')
})

test('settings: objective and tips default on and can be switched off', () => {
  const d = sanitizeSettings({}, CONTENT)
  assert.equal(d.showObjective, true)
  assert.equal(d.showTips, true)
  const off = sanitizeSettings({ showObjective: false, showTips: false }, CONTENT)
  assert.equal(off.showObjective, false)
  assert.equal(off.showTips, false)
})

test('first rival battle: a loss continues the story instead of blacking out', () => {
  const script = world.maps['origin-lab'].npcs.find((n) => n.id === 'rival-lab')!.script
  const flat: { op: string; lossContinues?: boolean; lossFlag?: string; trainer?: string }[] = []
  const walk = (steps: unknown[]) => { for (const s of steps as { op: string; then?: unknown[]; else?: unknown[] }[]) { flat.push(s); if (s.then) walk(s.then); if (s.else) walk(s.else) } }
  walk(script)
  const battles = flat.filter((s) => s.op === 'battle')
  assert.ok(battles.length >= 3, 'one battle per starter')
  for (const b of battles) {
    assert.equal(b.lossContinues, true, `${b.trainer} loss continues`)
    assert.equal(b.lossFlag, 'rival:lab-lost')
  }
  assert.ok(flat.some((s) => s.op === 'heal'), 'party is healed after the loss')
})

test('conditions: device is live state, expires may be a list, the retired cards are gone', () => {
  const p = progress()
  assert.ok(condHolds({ device: ['keyboard', 'gamepad'] }, p, { device: 'keyboard' }))
  assert.ok(!condHolds({ device: ['keyboard', 'gamepad'] }, p, { device: 'touch' }))
  assert.ok(!condHolds({ device: ['touch'] }, p), 'no device reported: not a touch player')
  const move = TUTORIAL.tips.list.find((x) => x.id === 'move')!
  assert.deepEqual(move.trigger.kind === 'free' && move.trigger.needs, { device: ['keyboard', 'gamepad'] }, 'phones learn to move from the stick animation')
  const caught = TUTORIAL.tips.list.find((x) => x.id === 'catch')!
  assert.ok(Array.isArray(caught.expires))
  assert.ok(!tipLive(caught, progress({ flags: { 'ds:ernie': true } })), 'any entry of an expires list ends the tip (the story already taught catching)')
  assert.ok(tipLive(caught, progress()))
  for (const id of ['objective', 'menuHint', 'signs', 'fly', 'tradePvp', 'center']) assert.ok(!TUTORIAL.tips.list.some((x) => x.id === id), `${id} is retired`)
  assert.equal(TUTORIAL.objective.hideQuestCardUntilFlag, 'ds:gateOpen')
})
