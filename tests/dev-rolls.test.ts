// BattleInit.debug.rolls (ADR 0002 M8): forced hit / damage / crit / capture rolls; unset leaves the event stream untouched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT } from '../src/shared/content/index.ts'
import type { BattleAction, BattleEvent, BattleInit, Creature, DevBattleRolls } from '../src/shared/types.ts'
import { Rng } from '../src/shared/rng.ts'
import { createCreature } from '../src/shared/creature.ts'
import { BattleEngine } from '../src/shared/battle/engine.ts'

// The weakest plain damaging move that can miss, and a harmless self-buff for the foe: the fight runs long.
const ATTACK = CONTENT.moveList.filter((m) => m.category !== 'status' && m.power > 0 && m.accuracy > 0 && m.accuracy < 100 && m.effects.length === 0 && m.priority === 0).sort((a, b) => a.power - b.power)[0]
const SELF_BUFF = CONTENT.moveList.find((m) => m.category === 'status' && m.effects.length > 0 && m.effects.every((e) => e.kind === 'stat' && e.target === 'self'))!.id
const BALL = CONTENT.itemList.find((i) => i.effect.kind === 'ball' && !('bonus' in i.effect))!.id
const MASTER = CONTENT.itemList.find((i) => i.effect.kind === 'ball' && i.effect.bonus === 'master')!.id
const SPECIES = CONTENT.speciesList.filter((s) => !s.starter)
const bulk = (s: (typeof SPECIES)[number]) => s.baseStats.hp + s.baseStats.def + s.baseStats.spd
const WILD = [...SPECIES].sort((a, b) => bulk(b) - bulk(a))[0].id
const ME = SPECIES[1].id
// A level-45 attacker against the bulkiest level-100 foe: ~10 damage a hit, so the fight outlasts the move's PP (Struggle takes over after).
const TURNS = ATTACK.pp

function mon(species: string, level: number, moves: string[]): Creature {
  return createCreature(species, level, { rng: new Rng(level * 7 + 1), moves }, CONTENT)
}

function engine(seed: number, debug?: BattleInit['debug']): BattleEngine {
  const init: BattleInit = {
    seed, isWild: true, canRun: true, canCatch: true, biome: 'meadow', timeOfDay: 'day', expGain: false,
    sides: [
      { kind: 'player', name: '小明', party: [mon(ME, 45, [ATTACK.id])], items: { [BALL]: 20, [MASTER]: 20 } },
      { kind: 'wild', name: '野生', party: [mon(WILD, 100, [SELF_BUFF])], aiLevel: 0 },
    ],
    ...(debug === undefined ? {} : { debug }),
  }
  const e = new BattleEngine(init, CONTENT)
  e.start()
  return e
}

/** The player takes `action` for up to `turns` turns, or until the battle ends; every event of the fight. */
function fight(e: BattleEngine, turns: number, action: BattleAction = { kind: 'move', moveIndex: 0 }): BattleEvent[] {
  const events: BattleEvent[] = []
  for (let i = 0; i < turns && !e.finished; i++) {
    assert.equal(e.choose(0, action), null)
    events.push(...e.step())
  }
  return events
}

const rolls = (r: DevBattleRolls) => ({ rolls: r })
const hits = (evs: BattleEvent[]) => evs.flatMap((x) => (x.t === 'damage' && x.side === 1 ? [x] : []))
const misses = (evs: BattleEvent[]) => evs.filter((x) => x.t === 'miss')

test('unset debug, an empty debug and empty rolls all leave the event stream byte-identical', () => {
  for (const seed of [1, 7, 4242]) {
    const plain = JSON.stringify(fight(engine(seed), TURNS))
    assert.ok(plain.includes('"damage"'), 'the fight has damage in it')
    assert.equal(JSON.stringify(fight(engine(seed, {}), TURNS)), plain)
    assert.equal(JSON.stringify(fight(engine(seed, rolls({})), TURNS)), plain)
  }
})

test('forced crit: always and never decide every damaging hit', () => {
  const natural = fight(engine(3), TURNS)
  assert.ok(hits(natural).length > 5)
  const always = hits(fight(engine(3, rolls({ crit: 'always' })), TURNS))
  const never = hits(fight(engine(3, rolls({ crit: 'never' })), TURNS))
  assert.equal(always.length, hits(natural).length)
  assert.equal(never.length, hits(natural).length)
  assert.ok(always.every((x) => x.crit))
  assert.ok(never.every((x) => !x.crit))
})

test('forced hit: always lands every move, never lands none', () => {
  const natural = fight(engine(2), TURNS)
  assert.ok(misses(natural).length > 0 && hits(natural).length > 0, 'the move can both hit and miss')
  const always = fight(engine(2, rolls({ hit: 'always' })), TURNS)
  assert.equal(misses(always).length, 0)
  assert.equal(hits(always).length, TURNS)
  const never = fight(engine(2, rolls({ hit: 'never' })), TURNS)
  assert.equal(hits(never).length, 0)
  assert.equal(misses(never).length, TURNS)
})

test('forced damage roll: min is below max, natural lies between', () => {
  const first = (r?: DevBattleRolls) => hits(fight(engine(9, rolls({ hit: 'always', crit: 'never', ...r })), 1))[0].amount
  const lo = first({ damage: 'min' })
  const hi = first({ damage: 'max' })
  const mid = first()
  assert.ok(lo < hi, `min ${lo} < max ${hi}`)
  assert.ok(lo <= mid && mid <= hi)
})

test('forced capture: success catches what a plain ball would not, fail refuses even a master ball', () => {
  const natural = engine(11)
  assert.deepEqual(fight(natural, 1, { kind: 'item', itemId: BALL }).flatMap((x) => (x.t === 'catch' ? [x.success] : [])), [false])

  const win = engine(11, rolls({ catch: 'success' }))
  const winEvents = fight(win, 1, { kind: 'item', itemId: BALL })
  assert.deepEqual(winEvents.flatMap((x) => (x.t === 'catch' ? [x.success] : [])), [true])
  assert.equal(win.result, 'caught')

  assert.equal(fight(engine(11), 1, { kind: 'item', itemId: MASTER }).some((x) => x.t === 'catch' && x.success), true)
  const lose = engine(11, rolls({ catch: 'fail' }))
  const throws = fight(lose, 5, { kind: 'item', itemId: MASTER }).flatMap((x) => (x.t === 'catch' ? [x] : []))
  assert.equal(throws.length, 5)
  assert.ok(throws.every((x) => !x.success && x.shakes === 0))
  assert.notEqual(lose.result, 'caught')
})

test('a forced roll still takes its draw: the rest of the fight is the same as the natural one', () => {
  const shape = (evs: BattleEvent[]) => evs.filter((x) => x.t === 'damage' || x.t === 'miss').map((x) => x.t + (x.t === 'damage' ? x.side : ''))
  const natural = shape(fight(engine(21), TURNS))
  const forced = shape(fight(engine(21, rolls({ crit: 'always', damage: 'max' })), TURNS))
  assert.deepEqual(forced, natural)
})
