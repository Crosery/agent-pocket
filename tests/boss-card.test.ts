// Boss cards (M1b, #59): the contract roll, the badge cap with its exp bank, the teaching bonus, and what
// sanitizeCreature lets a boss card carry that a wild member of the same species may not.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT } from '../src/shared/content/index.ts'
import type { BattleInit, Creature } from '../src/shared/types.ts'
import { Rng } from '../src/shared/rng.ts'
import { createCreature, expForLevel, gainExp, sanitizeCreature } from '../src/shared/creature.ts'
import { gradeOf, gradeRank } from '../src/shared/gameplay/quality.ts'
import { GAMEPLAY } from '../src/shared/gameplay/data.ts'
import {
  bankLevels, bossCardCap, captureSeed, catchUpMul, expCap, isBossCard, partyExpMods, rollBossCard, settleBank,
} from '../src/shared/gameplay/bosscard.ts'
import { BattleEngine } from '../src/shared/battle/engine.ts'

const TIER = GAMEPLAY.instances['deepseek-tide'].tiers.story
const BC = CONTENT.quality.bossCard
const card = (seed = 1, first = true): Creature => rollBossCard(new Rng(seed), 'deepseek', 'story', TIER, { first })

test('rollBossCard: first contract is Lv1, A or better, signature ability and move, boss origin', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const cr = card(seed)
    assert.equal(cr.level, BC.startLevel)
    assert.equal(cr.speciesId, 'deepseek-v4')
    assert.deepEqual(cr.origin, { kind: 'boss', boss: 'deepseek', tier: 'story' })
    assert.equal(cr.abilityId, 'peak-valley')
    assert.ok(cr.moves.some((m) => m.id === 'weight-drop'))
    assert.ok(cr.moves.length <= CONTENT.config.party.maxMoves)
    assert.ok(gradeRank(gradeOf(cr.ivs).id) >= gradeRank('A'), `seed ${seed}: ${gradeOf(cr.ivs).id}`)
    assert.ok(Object.values(cr.ivs).some((v) => v === CONTENT.config.creature.ivMax), 'one perfect IV')
    assert.ok(Object.values(cr.ivs).every((v) => v >= TIER.capture.ivMin))
    assert.ok(isBossCard(cr))
  }
})

test('rollBossCard: same seed, same card; another run counter, another card', () => {
  const seed = (run: number) => captureSeed(123456789, 'deepseek-tide', 'story', run)
  const a = card(seed(1))
  assert.deepEqual(card(seed(1)), a)
  const others = [2, 3, 4, 5].map((run) => card(seed(run)))
  assert.ok(others.some((o) => JSON.stringify(o.ivs) !== JSON.stringify(a.ivs) || o.nature !== a.nature || o.uid !== a.uid))
  assert.notEqual(seed(1), seed(2))
  assert.notEqual(captureSeed(1, 'deepseek-tide', 'story', 1), captureSeed(2, 'deepseek-tide', 'story', 1))
})

test('rollBossCard: later contracts draw the ability by weight and still never go below the IV minimum', () => {
  const seen = new Set<string>()
  for (let seed = 1; seed <= 300; seed++) {
    const cr = card(seed, false)
    seen.add(cr.abilityId)
    assert.ok(Object.values(cr.ivs).every((v) => v >= TIER.capture.ivMin))
  }
  assert.deepEqual([...seen].sort(), ['long-context', 'peak-valley', 'scaling-law'])
})

test('sanitizeCreature: a boss card keeps the signature ability and move, a wild one of the species loses them', () => {
  const cr = card(7)
  const kept = sanitizeCreature(JSON.parse(JSON.stringify(cr)))!
  assert.equal(kept.abilityId, 'peak-valley')
  assert.ok(kept.moves.some((m) => m.id === 'weight-drop'))
  assert.deepEqual(kept.origin, cr.origin)

  const forged = JSON.parse(JSON.stringify({ ...cr, origin: { kind: 'wild' } }))
  const wild = sanitizeCreature(forged)!
  assert.notEqual(wild.abilityId, 'peak-valley')
  assert.ok(!wild.moves.some((m) => m.id === 'weight-drop'))

  // The boss origin of another species keeps its origin but gets none of the allowances: no signature ability or move.
  const wrong = sanitizeCreature(JSON.parse(JSON.stringify({ ...createCreature('o1', 5, { rng: new Rng(2) }), abilityId: 'peak-valley', origin: cr.origin })))!
  assert.notEqual(wrong.abilityId, 'peak-valley')
  assert.equal(wrong.origin?.kind, 'boss')
})

test('sanitizeCreature: a boss card may bank exp up to bankMaxLevels past its level, others may not', () => {
  const cr = card(3)
  cr.exp = expForLevel('slow', cr.level + BC.bankMaxLevels)
  assert.equal(sanitizeCreature(JSON.parse(JSON.stringify(cr)))!.exp, cr.exp)
  cr.exp = expForLevel('slow', cr.level + BC.bankMaxLevels) + 99999
  assert.equal(sanitizeCreature(JSON.parse(JSON.stringify(cr)))!.exp, expForLevel('slow', cr.level + BC.bankMaxLevels))
  const plain = JSON.parse(JSON.stringify({ ...card(3), origin: { kind: 'legacy' }, exp: expForLevel('slow', 12) }))
  assert.equal(sanitizeCreature(plain)!.exp, expForLevel('slow', 2) - 1)
})

test('bossCardCap: badges 0 / 1 / 7 / 8 and beyond', () => {
  assert.equal(bossCardCap(0), 10)
  assert.equal(bossCardCap(1), 14)
  assert.equal(bossCardCap(7), 51)
  assert.equal(bossCardCap(8), 100)
  assert.equal(bossCardCap(40), 100)
  assert.equal(bossCardCap(-3), 10)
})

test('catchUpMul: nothing while level, 1 + perLevel x gap behind, capped at max', () => {
  assert.equal(catchUpMul(0), 1)
  assert.equal(catchUpMul(-4), 1)
  assert.equal(catchUpMul(1), 2)
  assert.equal(catchUpMul(5), 6)
  assert.equal(catchUpMul(11), 12)
  assert.equal(catchUpMul(40), BC.catchUp.max)
})

/** Kills needed for a Lv1 card to reach the party's best (Lv10): the real early foe supply of the review (catchup2.py). */
const KILLS = [50, 28, 37, 61, ...Array(5).fill(35), 57, 75, 67, 74, 102, 57, 71, 107, ...Array(30).fill(96)] as number[]

function killsTo(target: number, onField: boolean): { kills: number; levelAfter: (n: number) => number } {
  const cr = card(11)
  const lead = createCreature('o1', target, { rng: new Rng(5) })
  const levels: number[] = []
  let kills = 0
  for (const each of KILLS) {
    const m = partyExpMods([lead, cr], 0)
    const gain = onField ? Math.max(1, Math.round(each * m.expByParty[1])) : Math.max(1, Math.round(each * m.benchExp[1]))
    gainExp(cr, gain, CONTENT, { levelCap: m.levelCapByParty[1], expCap: m.expCapByParty[1] })
    kills++
    levels.push(cr.level)
    if (cr.level >= target) break
  }
  return { kills, levelAfter: (n) => levels[Math.min(n, levels.length) - 1] }
}

test('teaching bonus: a Lv1 card catches up to a Lv10 party in 9 kills on the field, 14 from the bench', () => {
  assert.equal(killsTo(10, true).kills, 9)
  assert.equal(killsTo(10, false).kills, 14)
})

test('teaching bonus: on the way to the first gym town (4 foes and 5 wilds) the card is about Lv10 / Lv8', () => {
  assert.ok(killsTo(10, true).levelAfter(9) >= 10)
  const bench = killsTo(10, false).levelAfter(9)
  assert.ok(bench >= 7 && bench <= 9, `bench level ${bench}`)
})

test('cap and bank: Lv10 at 0 badges keeps its level, banks at most 12 levels, a badge pays it out', () => {
  const cr = card(5)
  const lead = createCreature('o1', 10, { rng: new Rng(1) })
  cr.level = 10
  cr.exp = expForLevel('slow', 10)
  const m = partyExpMods([lead, cr], 0)
  assert.equal(m.levelCapByParty[1], 10)
  gainExp(cr, 500, CONTENT, { levelCap: m.levelCapByParty[1], expCap: m.expCapByParty[1] })
  assert.equal(cr.level, 10)
  assert.ok(cr.exp > expForLevel('slow', 10))
  assert.ok(bankLevels(cr) >= 1)
  gainExp(cr, 10_000_000, CONTENT, { levelCap: 10, expCap: expCap(cr, 10) })
  assert.equal(cr.level, 10)
  assert.equal(cr.exp, expForLevel('slow', 22))
  assert.equal(bankLevels(cr), 12)

  const r = settleBank(cr, bossCardCap(1))
  assert.equal(r.from, 10)
  assert.equal(r.to, 14)
  assert.equal(cr.level, 14)
  assert.ok(r.learned.includes('axiom-jab') || r.learnable.includes('axiom-jab'), 'the Lv14 move is offered')
})

test('legacy and wild boss-species creatures are not touched by the card rules', () => {
  const lead = createCreature('o1', 12, { rng: new Rng(1) })
  const legacy = createCreature('deepseek-v4', 58, { rng: new Rng(2), origin: { kind: 'legacy' } })
  const m = partyExpMods([lead, legacy], 0)
  assert.deepEqual(m.expByParty, [1, 1])
  assert.deepEqual(m.benchExp, [0, 0])
  assert.deepEqual(m.levelCapByParty, [0, 0])
  assert.deepEqual(m.expCapByParty, [0, 0])
})

test('gainExp without caps behaves as before', () => {
  const a = createCreature('o1', 5, { rng: new Rng(4) })
  const b = JSON.parse(JSON.stringify(a)) as Creature
  const ra = gainExp(a, 1234)
  const rb = gainExp(b, 1234, CONTENT, undefined)
  assert.deepEqual(ra, rb)
  assert.deepEqual(a, b)
  assert.ok(a.level > 5)
  const c = JSON.parse(JSON.stringify(b)) as Creature
  gainExp(c, 0)
  assert.deepEqual(c, b)
})

test('gainExp: levelCap stops the level, expCap stops the exp', () => {
  const a = createCreature('o1', 5, { rng: new Rng(4) })
  const before = a.exp
  gainExp(a, 100_000, CONTENT, { levelCap: 8 })
  assert.equal(a.level, 8)
  assert.equal(a.exp, before + 100_000)
  const b = createCreature('o1', 5, { rng: new Rng(4) })
  gainExp(b, 100_000, CONTENT, { levelCap: 8, expCap: expForLevel('slow', 9) })
  assert.equal(b.level, 8)
  assert.equal(b.exp, expForLevel('slow', 9))
})

// ---------------------------------------------------------------------------------------------------- engine

function winFast(party: Creature[], mods: NonNullable<BattleInit['mods']>): { engine: BattleEngine; events: ReturnType<BattleEngine['step']> } {
  const foe = createCreature('ernie-bot', 3, { rng: new Rng(9), shiny: false })
  const init: BattleInit = {
    seed: 77, isWild: true, canRun: true, canCatch: false, biome: CONTENT.biomes[0].id, timeOfDay: 'day', expGain: true, mods,
    sides: [{ kind: 'player', name: 'p', party }, { kind: 'wild', name: 'w', party: [foe] }],
  }
  const engine = new BattleEngine(init, CONTENT)
  const events = [...engine.start()]
  for (let i = 0; i < 20 && !engine.finished; i++) {
    const req = engine.request(0)
    if (req.kind === 'wait') { engine.step(); continue }
    engine.choose(0, { kind: 'move', moveIndex: 0 })
    events.push(...engine.step())
  }
  return { engine, events }
}

test('engine: a living bench card earns the bench share, a capped one banks instead of levelling', () => {
  const lead = createCreature('o1', 30, { rng: new Rng(1) })
  lead.moves = [{ id: 'token-tackle', pp: 35, ppMax: 35 }]
  const bench = card(4)
  bench.level = 10
  bench.exp = expForLevel('slow', 10)
  const party = [lead, bench]
  const m = partyExpMods(party, 0)
  const { engine, events } = winFast(party, { ...m })
  assert.equal(engine.result, 'win')
  const exps = events.filter((e) => e.t === 'exp')
  const lead0 = exps.find((e) => e.partyIndex === 0)
  const bench1 = exps.find((e) => e.partyIndex === 1)
  assert.ok(lead0 && bench1, 'both slots get an exp event')
  assert.ok(bench1.amount >= 1)
  assert.equal(party[1].level, 10, 'capped at the badge cap')
  assert.ok(party[1].exp > expForLevel('slow', 10), 'the exp is banked')
})

test('engine: without modifiers a bench member earns nothing (unchanged rule)', () => {
  const lead = createCreature('o1', 30, { rng: new Rng(1) })
  lead.moves = [{ id: 'token-tackle', pp: 35, ppMax: 35 }]
  const other = createCreature('phi-3', 5, { rng: new Rng(3) })
  const { events } = winFast([lead, other], {})
  assert.ok(!events.some((e) => e.t === 'exp' && e.partyIndex === 1))
})
