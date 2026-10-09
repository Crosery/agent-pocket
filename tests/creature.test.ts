import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT, type Content } from '../src/shared/content/index.ts'
import type { MoveDef, SpeciesDef, Stats } from '../src/shared/types.ts'
import { Rng, hashString } from '../src/shared/rng.ts'
import {
  STAT_KEYS, calcStats, createCreature, defaultMoves, evolutionTarget, evolve, expForLevel, expYield, gainExp, healFull,
  maxHp, newUid, rollShiny, sanitizeCreature, toView,
} from '../src/shared/creature.ts'
import { RULES } from '../src/shared/battle/rules.ts'

// ---------------------------------------------------------------- synthetic content (independent of the live roster)

const stats = (v: number): Stats => ({ hp: v, atk: v, def: v, spa: v, spd: v, spe: v })
const move = (id: string, extra: Partial<MoveDef> = {}): MoveDef => ({
  id, nameZh: id, nameEn: id, type: CONTENT.types[0].id, category: 'physical', power: 40, accuracy: 100, pp: 10 + id.length,
  priority: 0, effects: [], description: '', anim: 'hit', ...extra,
})
const species = (id: string, extra: Partial<SpeciesDef>): SpeciesDef => ({
  id, dexNo: 1, nameZh: `${id}名`, nameEn: id, company: '', country: '', category: '', family: 'f', stage: 1, types: [CONTENT.types[0].id],
  rarity: CONTENT.rarities[0].id, baseStats: stats(80), abilities: ['ab1', 'ab2'], learnset: [], teachable: [], catchRate: 45,
  baseExp: 100, growth: 'medium', habitats: [], dexEntry: '', releaseDate: '', personality: '', size: 1, ...extra,
})

function synthetic(): Content {
  const moves = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'tm', 'evo'].map((id) => move(id))
  const list: SpeciesDef[] = [
    species('base', {
      learnset: [{ level: 1, move: 'm1' }, { level: 1, move: 'm2' }, { level: 5, move: 'm3' }, { level: 8, move: 'm4' }, { level: 10, move: 'm5' }, { level: 12, move: 'm1' }, { level: 20, move: 'm6' }],
      teachable: ['tm'], evolvesTo: { id: 'evolved', level: 16 },
    }),
    species('evolved', { dexNo: 2, stage: 2, evolvesFrom: 'base', baseStats: stats(100), abilities: ['ab3', 'ab4'], learnset: [{ level: 0, move: 'evo' }, { level: 1, move: 'm1' }] }),
  ]
  return {
    ...CONTENT,
    moves: Object.fromEntries(moves.map((m) => [m.id, m])),
    moveList: moves,
    species: Object.fromEntries(list.map((s) => [s.id, s])),
    speciesList: list,
  }
}
const SC = synthetic()

// ---------------------------------------------------------------- rng

test('Rng is deterministic, bounded and well distributed', () => {
  const a = new Rng(42)
  const b = new Rng(42)
  for (let i = 0; i < 100; i++) assert.equal(a.next(), b.next())
  assert.notEqual(new Rng(1).next(), new Rng(2).next())
  const r = new Rng(9)
  const counts = [0, 0, 0, 0, 0, 0]
  for (let i = 0; i < 6000; i++) {
    const v = r.int(1, 6)
    assert.ok(v >= 1 && v <= 6 && Number.isInteger(v))
    counts[v - 1]++
  }
  for (const n of counts) assert.ok(n > 800 && n < 1200, `uneven distribution ${counts}`)
  assert.equal(r.chance(0), false)
  assert.equal(r.chance(1), true)
  assert.throws(() => r.pick([]))
  const w = new Rng(3)
  let heavy = 0
  for (let i = 0; i < 1000; i++) if (w.weighted(['a', 'b'], (x) => (x === 'a' ? 9 : 1)) === 'a') heavy++
  assert.ok(heavy > 850 && heavy < 950)
  assert.equal(new Rng(5).seed, 5)
})

test('hashString is stable 32-bit', () => {
  assert.equal(hashString('agent'), hashString('agent'))
  assert.notEqual(hashString('agent'), hashString('agenT'))
  const h = hashString('智灵口袋')
  assert.ok(Number.isInteger(h) && h >= 0 && h < 2 ** 32)
})

// ---------------------------------------------------------------- stats & exp

test('calcStats follows the content formula', () => {
  const sp = CONTENT.speciesList[0]
  const ivs = stats(17)
  const level = 37
  const s = calcStats({ speciesId: sp.id, level, ivs })
  const f = RULES.statFormula
  for (const k of STAT_KEYS) {
    const core = Math.floor(((f.baseMul * sp.baseStats[k] + 17) * level) / f.levelDivisor)
    assert.equal(s[k], k === 'hp' ? core + level + f.hpFlat : core + f.otherFlat)
  }
})

test('expForLevel = growth mul * level^exponent', () => {
  for (const [g, { mul }] of Object.entries(CONTENT.config.growth)) {
    for (const lv of [1, 10, 50, 100]) assert.equal(expForLevel(g, lv), Math.floor(mul * lv ** RULES.growthExponent))
  }
})

// ---------------------------------------------------------------- creation

test('createCreature picks the last distinct learnable moves, IVs in range, full hp', () => {
  const cr = createCreature('base', 13, { rng: new Rng(1) }, SC)
  // learnable <= 13 in order: m1 m2 m3 m4 m5 m1 -> last distinct 4: m3 m4 m5 m1
  assert.deepEqual(cr.moves.map((m) => m.id), ['m3', 'm4', 'm5', 'm1'])
  for (const m of cr.moves) assert.equal(m.pp, SC.moves[m.id].pp)
  for (const k of STAT_KEYS) assert.ok(cr.ivs[k] >= 0 && cr.ivs[k] <= SC.config.creature.ivMax)
  assert.equal(cr.hp, maxHp(cr, SC))
  assert.equal(cr.exp, expForLevel('medium', 13, SC))
  assert.equal(cr.friendship, SC.config.creature.startFriendship)
  assert.ok(['ab1', 'ab2'].includes(cr.abilityId))
  assert.deepEqual(createCreature('base', 13, { rng: new Rng(1) }, SC), cr)
  assert.deepEqual(defaultMoves('base', 4, SC), ['m1', 'm2'])
  const custom = createCreature('base', 5, { rng: new Rng(2), moves: ['m6', 'm6', 'nope', 'tm'], shiny: true, ballId: 'x' }, SC)
  assert.deepEqual(custom.moves.map((m) => m.id), ['m6', 'tm'])
  assert.equal(custom.shiny, true)
  assert.equal(custom.ballId, 'x')
  assert.throws(() => createCreature('missing', 5, { rng: new Rng(1) }, SC))
})

test('createCreature works over the live roster', () => {
  const rng = new Rng(77)
  for (const sp of CONTENT.speciesList) {
    const cr = createCreature(sp.id, 1 + (sp.dexNo % 60), { rng })
    assert.ok(cr.moves.length >= 1 && cr.moves.length <= CONTENT.config.party.maxMoves, sp.id)
    assert.ok(cr.hp > 0)
    assert.deepEqual(sanitizeCreature(JSON.parse(JSON.stringify(cr))), cr)
  }
})

test('second ability chance comes from config', () => {
  const rng = new Rng(11)
  let second = 0
  const n = 2000
  for (let i = 0; i < n; i++) if (createCreature('base', 5, { rng }, SC).abilityId === 'ab2') second++
  const p = SC.config.creature.secondAbilityChance
  assert.ok(Math.abs(second / n - p) < 0.05, `${second / n} vs ${p}`)
})

// ---------------------------------------------------------------- progression

test('gainExp levels up, keeps damage taken, learns or offers moves', () => {
  const cr = createCreature('base', 9, { rng: new Rng(3), moves: ['m1', 'm2'] }, SC)
  cr.hp -= 5
  const before = maxHp(cr, SC)
  const r = gainExp(cr, expForLevel('medium', 12, SC) - cr.exp, SC)
  assert.deepEqual(r.levels, [10, 11, 12])
  assert.equal(cr.level, 12)
  assert.deepEqual(r.learned, ['m5'])
  assert.deepEqual(r.learnable, [])
  assert.equal(cr.hp, maxHp(cr, SC) - 5)
  assert.ok(maxHp(cr, SC) > before)
  assert.equal(cr.friendship, SC.config.creature.startFriendship + 3 * SC.config.creature.levelUpFriendship)

  const full = createCreature('base', 19, { rng: new Rng(4), moves: ['m1', 'm2', 'm3', 'm4'] }, SC)
  const r2 = gainExp(full, expForLevel('medium', 20, SC) - full.exp, SC)
  assert.deepEqual(r2.learned, [])
  assert.deepEqual(r2.learnable, ['m6'])
  assert.equal(full.moves.length, 4)

  const top = createCreature('base', SC.config.party.maxLevel, { rng: new Rng(5) }, SC)
  assert.deepEqual(gainExp(top, 10 ** 9, SC).levels, [])
  assert.equal(top.exp, expForLevel('medium', SC.config.party.maxLevel, SC))
})

test('evolution target and evolve', () => {
  const cr = createCreature('base', 15, { rng: new Rng(6), moves: ['m1'] }, SC)
  assert.equal(evolutionTarget(cr, SC), null)
  cr.level = 16
  cr.abilityId = 'ab2'
  assert.equal(evolutionTarget(cr, SC), 'evolved')
  const max = maxHp(cr, SC)
  cr.hp = Math.floor(max / 2)
  evolve(cr, 'evolved', SC)
  assert.equal(cr.speciesId, 'evolved')
  assert.equal(cr.abilityId, 'ab4')
  assert.ok(Math.abs(cr.hp / maxHp(cr, SC) - 0.5) < 0.05)
  assert.ok(cr.moves.some((m) => m.id === 'evo'))
  assert.equal(evolutionTarget(cr, SC), null)
})

test('healFull, toView, expYield, rollShiny, newUid', () => {
  const cr = createCreature('base', 20, { rng: new Rng(8) }, SC)
  cr.hp = 1
  cr.status = CONTENT.statuses[0]?.id ?? null
  cr.moves[0].pp = 0
  healFull(cr, SC)
  assert.equal(cr.hp, maxHp(cr, SC))
  assert.equal(cr.status, null)
  assert.equal(cr.moves[0].pp, cr.moves[0].ppMax)
  const v = toView(cr, SC)
  assert.equal(v.maxHp, maxHp(cr, SC))
  assert.equal(v.level, 20)
  const b = SC.config.battle
  assert.equal(expYield(cr, false, SC), Math.floor((100 * 20) / b.expDivisor))
  assert.equal(expYield(cr, true, SC), Math.floor(((100 * 20) / b.expDivisor) * b.trainerExpMultiplier))
  const rng = new Rng(10)
  let shiny = 0
  for (let i = 0; i < 20000; i++) if (rollShiny(rng)) shiny++
  assert.ok(shiny / 20000 < CONTENT.config.battle.shinyRate * 3 + 0.001)
  const uid = newUid(new Rng(1))
  assert.equal(uid.length, RULES.creature.uidLength)
  assert.match(uid, /^[0-9a-z]+$/)
  assert.notEqual(newUid(new Rng(1)), newUid(new Rng(2)))
})

// ---------------------------------------------------------------- sanitize

test('sanitizeCreature rejects garbage and unknown species', () => {
  assert.equal(sanitizeCreature(null, SC), null)
  assert.equal(sanitizeCreature('x', SC), null)
  assert.equal(sanitizeCreature([], SC), null)
  assert.equal(sanitizeCreature({ uid: 'abc', speciesId: 'missing', level: 5 }, SC), null)
  assert.equal(sanitizeCreature({ uid: 'bad uid!', speciesId: 'base', level: 5 }, SC), null)
  assert.equal(sanitizeCreature({ uid: 'abc', speciesId: 'base', level: 'high' }, SC), null)
})

test('sanitizeCreature clamps and repairs every field', () => {
  const ivMax = SC.config.creature.ivMax
  const raw = {
    uid: 'u1', speciesId: 'base', level: 999, exp: -5, ivs: { hp: 999, atk: -3, def: 'x', spa: 10.7, spd: 5, spe: 5 },
    moves: [{ id: 'm1', pp: 999 }, { id: 'm1', pp: 1 }, { id: 'hacked' }, { id: 'evo', pp: 3 }, { id: 'tm', pp: -1 }, { id: 'm2' }, { id: 'm3' }],
    hp: 99999, status: 'nope', statusTurns: 50, abilityId: 'ab4', shiny: 'yes', friendship: 9999, ballId: 'm1',
    caughtMap: 'route/1', otName: '  玩家\u0000\u202e名字很长很长很长很长很长很长很长  ', otId: 'p-1', nickname: '', heldItem: 'nope', extra: 'drop me',
  }
  const cr = sanitizeCreature(raw, SC)!
  assert.ok(cr)
  assert.equal(cr.level, SC.config.party.maxLevel)
  assert.equal(cr.exp, expForLevel('medium', SC.config.party.maxLevel, SC))
  assert.deepEqual(cr.ivs, { hp: ivMax, atk: 0, def: 0, spa: 10, spd: 5, spe: 5 })
  assert.deepEqual(cr.moves.map((m) => m.id), ['m1', 'tm', 'm2', 'm3'])
  assert.equal(cr.moves[0].pp, SC.moves.m1.pp)
  assert.equal(cr.moves[1].pp, 0)
  assert.equal(cr.hp, maxHp(cr, SC))
  assert.equal(cr.status, null)
  assert.equal(cr.statusTurns, 0)
  assert.equal(cr.abilityId, 'ab1')
  assert.equal(cr.shiny, false)
  assert.equal(cr.friendship, RULES.creature.friendshipMax)
  assert.equal(cr.ballId, '')
  assert.equal(cr.caughtMap, 'route/1')
  assert.ok(!cr.otName.includes('\u0000') && !cr.otName.includes('\u202e'))
  assert.ok([...cr.otName].length <= SC.config.net.nameMaxLen)
  assert.equal(cr.nickname, undefined)
  assert.equal(cr.heldItem, undefined)
  assert.ok(!('extra' in cr))

  const noMoves = sanitizeCreature({ uid: 'u2', speciesId: 'base', level: 13, moves: 'x' }, SC)!
  assert.deepEqual(noMoves.moves.map((m) => m.id), defaultMoves('base', 13, SC))
  const fainted = sanitizeCreature({ uid: 'u3', speciesId: 'base', level: 5, hp: 0, status: SC.statuses[0]?.id }, SC)!
  assert.equal(fainted.hp, 0)
  assert.equal(fainted.status, null)
  // Evolved creatures may keep moves from their pre-evolution learnset.
  const evo = sanitizeCreature({ uid: 'u4', speciesId: 'evolved', level: 30, moves: [{ id: 'm6' }, { id: 'evo' }] }, SC)!
  assert.deepEqual(evo.moves.map((m) => m.id), ['m6', 'evo'])
})

test('sanitizeCreature repairs nature, origin and finetuned', () => {
  const base = { uid: 'q1', speciesId: 'base', level: 5 }
  const legacy = SC.quality.legacyNature
  assert.equal(sanitizeCreature({ ...base }, SC)!.nature, legacy)
  assert.equal(sanitizeCreature({ ...base, nature: 'no-such-nature' }, SC)!.nature, legacy)
  assert.equal(sanitizeCreature({ ...base, nature: 42 }, SC)!.nature, legacy)
  const picked = SC.quality.natures.find((n) => n.up === 'spa' && n.down === 'def')!.id
  assert.equal(sanitizeCreature({ ...base, nature: picked }, SC)!.nature, picked)

  assert.equal(sanitizeCreature({ ...base, origin: { kind: 'hacked' } }, SC)!.origin, undefined)
  assert.equal(sanitizeCreature({ ...base, origin: 'wild' }, SC)!.origin, undefined)
  assert.deepEqual(sanitizeCreature({ ...base, origin: { kind: 'wild', at: 1700000000000.9, extra: 1 } }, SC)!.origin, { kind: 'wild', at: 1700000000000 })
  const bossId = SC.bossList[0].id
  assert.deepEqual(sanitizeCreature({ ...base, origin: { kind: 'boss', boss: bossId, tier: 'story', run: 'r-1' } }, SC)!.origin, { kind: 'boss', boss: bossId, tier: 'story', run: 'r-1' })
  assert.deepEqual(sanitizeCreature({ ...base, origin: { kind: 'boss', boss: 'no-such-boss' } }, SC)!.origin, { kind: 'boss' })
  assert.deepEqual(sanitizeCreature({ ...base, origin: { kind: 'legacy', tier: 'bad tier!' } }, SC)!.origin, { kind: 'legacy' })

  const max = SC.quality.finetune.loraMaxPerCreature
  assert.equal(sanitizeCreature({ ...base, finetuned: 99 }, SC)!.finetuned, max)
  assert.equal(sanitizeCreature({ ...base, finetuned: -4 }, SC)!.finetuned, 0)
  assert.equal(sanitizeCreature({ ...base, finetuned: 2.9 }, SC)!.finetuned, 2)
  assert.equal(sanitizeCreature({ ...base, finetuned: 'x' }, SC)!.finetuned, undefined)
})

test('sanitizeCreature round-trips a valid creature unchanged', () => {
  const cr = createCreature('base', 23, { rng: new Rng(12), otName: '小明', otId: 'p1', caughtMap: 'overworld' }, SC)
  cr.nickname = '小智'
  cr.hp = 3
  assert.deepEqual(sanitizeCreature(JSON.parse(JSON.stringify(cr)), SC), cr)
})
