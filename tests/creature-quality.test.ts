// Natures and quality grades (content/quality.json, src/shared/gameplay/quality.ts): table shape, integer nature math,
// IV grade bands, rejection sampling, and the draw order that keeps NPC teams and bosses off the random stream.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT } from '../src/shared/content/index.ts'
import type { Stats, StatKey } from '../src/shared/types.ts'
import { Rng } from '../src/shared/rng.ts'
import { RULES } from '../src/shared/battle/rules.ts'
import { STAT_KEYS, calcStats, createCreature, newUid } from '../src/shared/creature.ts'
import { createBossCreature } from '../src/shared/battle/boss-battle.ts'
import { bestStat, gradeOf, natureArrows, natureMod, revealIsFull, rollIvs, rollNature } from '../src/shared/gameplay/quality.ts'

const Q = CONTENT.quality
const IV_MAX = CONTENT.config.creature.ivMax
const NATURE_STATS: StatKey[] = ['atk', 'def', 'spa', 'spd', 'spe']
const spread = (sum: number): Stats => {
  // Spreads a total over the six stats as evenly as possible (the grade only reads the sum).
  const out = {} as Stats
  STAT_KEYS.forEach((k, i) => { out[k] = Math.floor(sum / 6) + (i < sum % 6 ? 1 : 0) })
  return out
}
const total = (ivs: Stats) => STAT_KEYS.reduce((s, k) => s + ivs[k], 0)

test('nature table: 25 natures, 5 neutral, 20 cover every ordered pair of the five nature stats once', () => {
  assert.equal(Q.natures.length, 25)
  const neutral = Q.natures.filter((n) => n.up === null && n.down === null)
  assert.equal(neutral.length, 5)
  const pairs = Q.natures.filter((n) => n.up !== null).map((n) => `${n.up}>${n.down}`)
  assert.equal(pairs.length, 20)
  for (const n of Q.natures) if (n.up !== null) assert.notEqual(n.up, n.down, n.id)
  const want = NATURE_STATS.flatMap((a) => NATURE_STATS.filter((b) => b !== a).map((b) => `${a}>${b}`))
  assert.deepEqual([...pairs].sort(), want.sort())
  assert.equal(Q.natures.find((n) => n.id === Q.legacyNature)?.up, null)
  assert.equal(Q.natures.find((n) => n.id === Q.npcNature)?.up, null)
})

test('natureMod: integer math, +10% rounds up and -10% rounds down, hp is never touched', () => {
  const up = Q.natures.find((n) => n.up === 'atk' && n.down === 'def')!
  assert.equal(natureMod(7, 'atk', up.id), 8)
  assert.equal(natureMod(7, 'def', up.id), 6)
  assert.equal(natureMod(10, 'atk', up.id), 11) // 10 * 1.1 is 11.000000000000002 in floating point
  assert.equal(natureMod(18, 'atk', up.id), 20)
  assert.equal(natureMod(18, 'def', up.id), 16)
  assert.equal(natureMod(18, 'spa', up.id), 18)
  assert.equal(natureMod(50, 'hp', up.id), 50)
  assert.equal(natureMod(18, 'atk', 'balanced'), 18)
  assert.equal(natureMod(18, 'atk', undefined), 18)
  assert.equal(natureMod(18, 'atk', 'no-such-nature'), 18)
  for (let v = 1; v <= 400; v++) {
    assert.ok(natureMod(v, 'atk', up.id) >= v, `+ never lowers ${v}`)
    assert.ok(natureMod(v, 'def', up.id) <= v, `- never raises ${v}`)
  }
})

test('natureArrows: one up and one down, neutral natures have none', () => {
  const n = Q.natures.find((x) => x.up === 'spa' && x.down === 'spe')!
  assert.deepEqual(natureArrows(n.id), { spa: 'up', spe: 'down' })
  assert.deepEqual(natureArrows('balanced'), {})
  assert.deepEqual(natureArrows(undefined), {})
})

test('calcStats: a neutral nature is the old formula exactly (50 species x Lv1/50/100)', () => {
  const f = RULES.statFormula
  const rng = new Rng(11)
  for (const sp of CONTENT.speciesList.slice(0, 50)) {
    const ivs = {} as Stats
    for (const k of STAT_KEYS) ivs[k] = rng.int(0, IV_MAX)
    for (const level of [1, 50, 100]) {
      const got = calcStats({ speciesId: sp.id, level, ivs, nature: Q.legacyNature })
      const bare = calcStats({ speciesId: sp.id, level, ivs })
      for (const k of STAT_KEYS) {
        const core = Math.floor(((f.baseMul * sp.baseStats[k] + ivs[k]) * level) / f.levelDivisor)
        const old = k === 'hp' ? core + level + f.hpFlat : core + f.otherFlat
        assert.equal(got[k], old, `${sp.id} Lv${level} ${k}`)
        assert.equal(bare[k], old, `${sp.id} Lv${level} ${k} (no nature)`)
      }
    }
  }
})

test('calcStats: a nature moves exactly its two stats', () => {
  const n = Q.natures.find((x) => x.up === 'atk' && x.down === 'spe')!
  const sp = CONTENT.speciesList[0]
  const ivs = spread(90)
  const base = calcStats({ speciesId: sp.id, level: 30, ivs })
  const with_ = calcStats({ speciesId: sp.id, level: 30, ivs, nature: n.id })
  assert.equal(with_.hp, base.hp)
  assert.equal(with_.atk, natureMod(base.atk, 'atk', n.id))
  assert.equal(with_.spe, natureMod(base.spe, 'spe', n.id))
  assert.ok(with_.atk > base.atk && with_.spe < base.spe)
  for (const k of ['def', 'spa', 'spd'] as const) assert.equal(with_[k], base[k])
})

test('gradeOf: band edges of the IV sum', () => {
  const at = (sum: number) => gradeOf(spread(sum)).id
  assert.equal(at(0), 'C')
  assert.equal(at(84), 'C')
  assert.equal(at(85), 'B')
  assert.equal(at(114), 'B')
  assert.equal(at(115), 'A')
  assert.equal(at(144), 'A')
  assert.equal(at(145), 'S')
  assert.equal(at(169), 'S')
  assert.equal(at(170), 'SS')
  assert.equal(at(186), 'SS')
})

test('wild grade distribution over 20000 rolls: C 35.7% / B 46.8% / A 16.5% / S 1.0% (+-1%)', () => {
  const rng = new Rng(2026)
  const n = 20000
  const count: Record<string, number> = {}
  for (let i = 0; i < n; i++) {
    const g = gradeOf(rollIvs(rng)).id
    count[g] = (count[g] ?? 0) + 1
  }
  const share = (id: string) => (count[id] ?? 0) / n
  assert.ok(Math.abs(share('C') - 0.357) <= 0.01, `C ${share('C')}`)
  assert.ok(Math.abs(share('B') - 0.468) <= 0.01, `B ${share('B')}`)
  assert.ok(Math.abs(share('A') - 0.165) <= 0.01, `A ${share('A')}`)
  assert.ok(Math.abs(share('S') - 0.010) <= 0.01, `S ${share('S')}`)
  assert.ok(share('SS') < 0.001, `SS ${share('SS')}`)
})

test('rollIvs: the plain roll is exactly the six old draws (so seeds that never asked for rules keep their IVs)', () => {
  for (const seed of [1, 7, 99]) {
    const a = new Rng(seed)
    const legacy = {} as Stats
    for (const k of STAT_KEYS) legacy[k] = a.int(0, IV_MAX)
    const b = new Rng(seed)
    assert.deepEqual(rollIvs(b), legacy)
    assert.equal(b.next(), a.next(), 'same number of draws')
  }
})

test('rollIvs({ gradeFloor }): every total reaches the floor and the same seed rolls the same spread', () => {
  for (const floor of ['B', 'A', 'S', 'SS']) {
    const min = Q.grades.find((g) => g.id === floor)!.min
    for (let seed = 1; seed <= 60; seed++) {
      const ivs = rollIvs(new Rng(seed), { gradeFloor: floor })
      assert.ok(total(ivs) >= min, `${floor} seed ${seed}: ${total(ivs)}`)
      assert.ok(STAT_KEYS.every((k) => ivs[k] >= 0 && ivs[k] <= IV_MAX))
      assert.deepEqual(rollIvs(new Rng(seed), { gradeFloor: floor }), ivs)
    }
  }
  for (let seed = 1; seed <= 2000; seed++) assert.ok(total(rollIvs(new Rng(seed), { gradeFloor: 'B' })) >= 85)
})

test('rollIvs({ gradeFloor, gradeCap }): a showcase roll lands inside exactly that grade', () => {
  for (const id of Q.grades.map((g) => g.id)) {
    for (let seed = 1; seed <= 40; seed++) {
      const ivs = rollIvs(new Rng(seed), { gradeFloor: id, gradeCap: id })
      assert.equal(gradeOf(ivs).id, id, `${id} seed ${seed}: ${total(ivs)}`)
    }
  }
})

test('rollIvs: perfect forces that many stats to the maximum and min lifts every stat', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const p = rollIvs(new Rng(seed), { perfect: 2 })
    assert.ok(STAT_KEYS.filter((k) => p[k] === IV_MAX).length >= 2)
    const m = rollIvs(new Rng(seed), { min: 10 })
    assert.ok(STAT_KEYS.every((k) => m[k] >= 10 && m[k] <= IV_MAX))
  }
})

test('createCreature draws IVs, ability, shiny, then the nature, and only draws a nature when none is given', () => {
  const sp = CONTENT.speciesList.find((s) => s.abilities.length > 1)!
  const given = Q.natures[7].id
  const a = new Rng(5)
  newUid(a)
  const ivs = {} as Stats
  for (const k of STAT_KEYS) ivs[k] = a.int(0, IV_MAX)
  a.chance(CONTENT.config.creature.secondAbilityChance)
  a.chance(CONTENT.config.battle.shinyRate)
  const afterShiny = a.next()
  const a2 = new Rng(5)
  newUid(a2)
  for (const k of STAT_KEYS) a2.int(0, IV_MAX)
  a2.chance(CONTENT.config.creature.secondAbilityChance)
  a2.chance(CONTENT.config.battle.shinyRate)
  const wantNature = rollNature(a2)

  const free = new Rng(5)
  const wild = createCreature(sp.id, 10, { rng: free })
  assert.deepEqual(wild.ivs, ivs)
  assert.equal(wild.nature, wantNature)

  const fixed = new Rng(5)
  const npc = createCreature(sp.id, 10, { rng: fixed, nature: given })
  assert.deepEqual(npc.ivs, ivs)
  assert.equal(npc.nature, given)
  assert.equal(fixed.next(), afterShiny, 'no draw is spent on a given nature')
})

test('NPC-owned creatures (trainer teams, boss bodies) keep their IVs and spend no random draw on the nature', () => {
  const sp = CONTENT.speciesList[3]
  for (const seed of [3, 4, 5, 6]) {
    const legacy = new Rng(seed)
    newUid(legacy)
    const ivs = {} as Stats
    for (const k of STAT_KEYS) ivs[k] = legacy.int(0, IV_MAX)
    if (sp.abilities.length > 1) legacy.chance(CONTENT.config.creature.secondAbilityChance)
    legacy.chance(CONTENT.config.battle.shinyRate)
    const rng = new Rng(seed)
    const cr = createCreature(sp.id, 20, { rng, nature: Q.npcNature })
    assert.deepEqual(cr.ivs, ivs)
    assert.equal(cr.nature, 'balanced')
    assert.equal(rng.next(), legacy.next())
  }
  for (const boss of CONTENT.bossList.slice(0, 3)) {
    const cr = createBossCreature(boss.id, boss.level, new Rng(9))
    assert.equal(cr.nature, 'balanced')
  }
})

test('createCreature: gradeFloor, perfectIvs, ivMin and origin are honoured', () => {
  const sp = CONTENT.speciesList[0]
  for (let seed = 1; seed <= 30; seed++) {
    const cr = createCreature(sp.id, 5, { rng: new Rng(seed), gradeFloor: 'B', origin: { kind: 'starter' } })
    assert.ok(total(cr.ivs) >= 85)
    assert.deepEqual(cr.origin, { kind: 'starter' })
  }
  const flat = createCreature(sp.id, 5, { rng: new Rng(1), ivMin: 12, perfectIvs: 1 })
  assert.ok(STAT_KEYS.every((k) => flat.ivs[k] >= 12))
  assert.ok(STAT_KEYS.some((k) => flat.ivs[k] === IV_MAX))
  assert.equal(createCreature(sp.id, 5, { rng: new Rng(1) }).origin, undefined)
})

test('bestStat: first on ties', () => {
  assert.equal(bestStat({ hp: 3, atk: 31, def: 31, spa: 0, spd: 0, spe: 5 }), 'atk')
  assert.equal(bestStat({ hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }), 'hp')
})

test('revealIsFull: new species, first catch, boss card or grade A+ get the full card; the rest a chip', () => {
  const sp = CONTENT.speciesList[0]
  const mk = (sum: number) => { const cr = createCreature(sp.id, 5, { rng: new Rng(1) }); cr.ivs = spread(sum); return cr }
  const quiet = { newSpecies: false, firstCatch: false }
  assert.equal(revealIsFull(mk(100), quiet), false)
  assert.equal(revealIsFull(mk(114), quiet), false)
  assert.equal(revealIsFull(mk(115), quiet), true)
  assert.equal(revealIsFull(mk(100), { ...quiet, newSpecies: true }), true)
  assert.equal(revealIsFull(mk(100), { ...quiet, firstCatch: true }), true)
  const boss = mk(100)
  boss.origin = { kind: 'boss', boss: CONTENT.bossList[0].id }
  assert.equal(revealIsFull(boss, quiet), true)
})
