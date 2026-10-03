// World-event modifiers that reach battles and shops: BattleInit.mods (exp per party slot, catch rate, level-up
// friendship) in the BattleEngine, and the 'shop' ScriptStep passing per-item event prices to Screens.shop.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT } from '../src/shared/content/index.ts'
import type { BattleEvent, BattleInit, Creature, ScriptStep } from '../src/shared/types.ts'
import type { GameContext } from '../src/client/contracts.ts'
import { Rng } from '../src/shared/rng.ts'
import { createCreature, expForLevel } from '../src/shared/creature.ts'
import { RULES } from '../src/shared/battle/rules.ts'
import { BattleEngine } from '../src/shared/battle/engine.ts'
import { createScriptRunner, type ScriptHost } from '../src/client/world/script.ts'
import { shopBuyPrice } from '../src/client/ui/screens/logic.ts'

const ATTACK = CONTENT.moveList.filter((m) => m.category !== 'status' && m.power >= 60 && m.accuracy >= 100 && m.effects.length === 0)
  .sort((a, b) => b.power - a.power)[0].id
const WILD = CONTENT.speciesList.find((s) => s.rarity === CONTENT.rarities[0].id && !s.starter)!.id
const ME = CONTENT.speciesList.find((s) => !s.starter && s.id !== WILD)!.id
const BALL = CONTENT.itemList.find((it) => it.effect.kind === 'ball' && it.effect.bonus !== 'master')!.id

function mon(species: string, level: number, moves?: string[]): Creature {
  return createCreature(species, level, { rng: new Rng(level * 7 + 1), moves }, CONTENT)
}

function battle(mods: BattleInit['mods'], o: { myLevel?: number; foeLevel?: number } = {}): { e: BattleEngine; me: Creature } {
  const me = mon(ME, o.myLevel ?? 40, [ATTACK])
  const init: BattleInit = {
    seed: 11, isWild: true, canRun: true, canCatch: true, biome: 'meadow', timeOfDay: 'day', expGain: true,
    sides: [
      { kind: 'player', name: 'p', party: [me], items: { [BALL]: 5 } },
      { kind: 'wild', name: 'w', party: [mon(WILD, o.foeLevel ?? 3)], aiLevel: 0 },
    ],
    ...(mods ? { mods } : {}),
  }
  const e = new BattleEngine(init, CONTENT)
  e.start()
  return { e, me }
}

function fight(e: BattleEngine, action: Parameters<BattleEngine['choose']>[1], max = 20): BattleEvent[] {
  const out: BattleEvent[] = []
  for (let i = 0; i < max && !e.finished; i++) {
    assert.equal(e.choose(0, action), null)
    out.push(...e.step())
  }
  return out
}

const expOf = (evs: BattleEvent[]) => evs.flatMap((x) => (x.t === 'exp' ? [x.amount] : []))

test('mods.expByParty scales the exp a party slot gains; no mods = unchanged', () => {
  const base = expOf(fight(battle(undefined).e, { kind: 'move', moveIndex: 0 }))
  assert.equal(base.length, 1)
  const boosted = expOf(fight(battle({ expByParty: [1.5] }).e, { kind: 'move', moveIndex: 0 }))
  assert.deepEqual(boosted, [Math.max(1, Math.round(base[0] * 1.5))])
})

test('mods.friendship scales level-up friendship gain', () => {
  const step = CONTENT.config.creature.levelUpFriendship
  const max = RULES.creature.friendshipMax
  const run = (mods: BattleInit['mods']) => {
    const b = battle(mods)
    b.me.exp = expForLevel(CONTENT.species[ME].growth, b.me.level + 1, CONTENT) - 1 // any exp gain levels up once
    const f0 = b.me.friendship
    const evs = fight(b.e, { kind: 'move', moveIndex: 0 })
    return { gained: b.me.friendship - f0, levels: evs.filter((x) => x.t === 'levelUp').length, f0 }
  }
  const plain = run(undefined)
  assert.equal(plain.levels, 1)
  assert.equal(plain.gained, Math.min(max - plain.f0, step))
  const doubled = run({ friendship: 2 })
  assert.equal(doubled.levels, 1)
  assert.equal(doubled.gained, Math.min(max - doubled.f0, step * 2))
})

test('mods.catchRate scales the catch formula (0 never catches, huge always catches)', () => {
  const never = battle({ catchRate: 0 })
  const a = fight(never.e, { kind: 'item', itemId: BALL }, 3)
  assert.ok(a.some((x) => x.t === 'catch' && !x.success))
  assert.notEqual(never.e.result, 'caught')
  const sure = battle({ catchRate: 1e6 })
  fight(sure.e, { kind: 'item', itemId: BALL }, 1)
  assert.equal(sure.e.result, 'caught')
})

test("shop step passes event price multipliers to Screens.shop; buy price rounds and never drops below 1", async () => {
  const item = CONTENT.itemList.find((it) => it.buyable && it.price > 10)!
  assert.equal(shopBuyPrice(item), item.price)
  assert.equal(shopBuyPrice(item, 0.7), Math.round(item.price * 0.7))
  assert.equal(shopBuyPrice({ ...item, price: 1 }, 0.1), 1)
  const calls: unknown[][] = []
  const ctx = {
    data: CONTENT, save: { flags: {} },
    screens: { async shop(...args: unknown[]) { calls.push(args) } },
  } as unknown as GameContext
  const host = (mul?: (id: string) => number): ScriptHost => ({
    ctx, async moveNpc() {}, faceNpc() {}, setNpcHidden() {}, async trainerBattle() { return 'win' }, async wildBattle() { return 'win' },
    async blackout() {}, async warp() {}, playerPlace: () => ({ map: 'm', x: 0, y: 0, facing: 'down' }), playMusic() {}, onWorldChanged() {},
    ...(mul ? { shopPriceMul: (it) => mul(it.id) } : {}),
  })
  const steps: ScriptStep[] = [{ op: 'shop', items: [item.id] }]
  await createScriptRunner(host()).run(steps, null)
  await createScriptRunner(host(() => 1)).run(steps, null)
  await createScriptRunner(host(() => 0.7)).run(steps, null)
  assert.deepEqual(calls, [[[item.id], undefined], [[item.id], undefined], [[item.id], { priceMul: { [item.id]: 0.7 } }]])
})
