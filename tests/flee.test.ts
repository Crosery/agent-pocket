// Wild flee (BattleSideInit.flee) in the BattleEngine: window, roll, status scaling, determinism, PvP/trainer immunity.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT, t } from '../src/shared/content/index.ts'
import type { BattleEvent, BattleInit, BattleSideInit, Creature } from '../src/shared/types.ts'
import { Rng } from '../src/shared/rng.ts'
import { createCreature } from '../src/shared/creature.ts'
import { BattleEngine, perspective } from '../src/shared/battle/engine.ts'
import { fleeFor } from '../src/shared/gameplay/spawns.ts'

// A self-buff status move: the player never damages the wild, so only flee/run can end the battle.
const SELF_BUFF = CONTENT.moveList.find((m) => m.category === 'status' && m.effects.length > 0 && m.effects.every((e) => e.kind === 'stat' && e.target === 'self'))!.id
const WILD = CONTENT.speciesList.find((s) => s.rarity === CONTENT.rarities[0].id && !s.starter)!.id
const ME = CONTENT.speciesList.find((s) => !s.starter && s.id !== WILD)!.id

function mon(species: string, level: number, moves?: string[], patch: Partial<Creature> = {}): Creature {
  const cr = createCreature(species, level, { rng: new Rng(level * 7 + 1), moves }, CONTENT)
  return Object.assign(cr, patch)
}

function engine(o: { seed?: number; flee?: BattleSideInit['flee']; foeKind?: BattleSideInit['kind']; foe?: Creature } = {}): BattleEngine {
  const wild = (o.foeKind ?? 'wild') === 'wild'
  const init: BattleInit = {
    seed: o.seed ?? 7, isWild: wild, canRun: wild, canCatch: wild, biome: 'meadow', timeOfDay: 'day', expGain: false,
    sides: [
      { kind: 'player', name: '小明', party: [mon(ME, 100, [SELF_BUFF])] },
      { kind: o.foeKind ?? 'wild', name: '野生', party: [o.foe ?? mon(WILD, 3)], aiLevel: 0, ...(o.flee ? { flee: o.flee } : {}) },
    ],
  }
  const e = new BattleEngine(init, CONTENT)
  e.start()
  return e
}

/** Plays up to `max` turns of the player using SELF_BUFF; returns every event and the turn the battle ended on. */
function play(e: BattleEngine, max: number): { events: BattleEvent[]; endTurn: number | null } {
  const events: BattleEvent[] = []
  for (let i = 0; i < max && !e.finished; i++) {
    assert.equal(e.choose(0, { kind: 'move', moveIndex: 0 }), null)
    if (e.init.sides[1].kind === 'remote') assert.equal(e.choose(1, { kind: 'move', moveIndex: 0 }), null)
    events.push(...e.step())
  }
  return { events, endTurn: e.finished ? e.turn : null }
}

const texts = (evs: BattleEvent[]) => evs.flatMap((x) => (x.t === 'msg' ? [x.text] : []))

test('a sure flee ends the battle with result "fled" right after the window opens', () => {
  const e = engine({ flee: { chancePerTurn: 1, afterTurn: 2 } })
  const { events, endTurn } = play(e, 10)
  assert.equal(endTurn, 2)
  assert.equal(e.result, 'fled')
  const flee = events.filter((x) => x.t === 'flee')
  assert.deepEqual(flee, [{ t: 'flee', side: 1, stage: 'warn' }, { t: 'flee', side: 1, stage: 'fled' }])
  const end = events.find((x) => x.t === 'end')
  assert.deepEqual(end, { t: 'end', result: 'fled', winner: -1 })
  const name = t('battle.wildName', { name: CONTENT.species[WILD].nameZh })
  assert.ok(texts(events).includes(t('battle.fleeWarn', { name })))
  assert.ok(texts(events).includes(t('battle.foeFled', { name })))
  // The 'fled' marker comes right before 'end'.
  const i = events.findIndex((x) => x.t === 'flee' && x.stage === 'fled')
  assert.ok(events.slice(i + 1).some((x) => x.t === 'end'))
})

test('no rolls before afterTurn, and chance 0 / absent flee never flees', () => {
  const late = engine({ flee: { chancePerTurn: 1, afterTurn: 5 } })
  const r = play(late, 4)
  assert.equal(r.endTurn, null)
  assert.ok(!r.events.some((x) => x.t === 'flee'))
  assert.equal(play(late, 1).endTurn, 5)
  for (const flee of [undefined, { chancePerTurn: 0, afterTurn: 1 }]) {
    const e = engine({ flee })
    assert.equal(play(e, 12).endTurn, null)
  }
})

test('battles without flee consume the same rng stream as before (event streams identical)', () => {
  const a = play(engine({ seed: 99 }), 8).events
  const b = play(engine({ seed: 99, flee: { chancePerTurn: 0, afterTurn: 0 } }), 8).events
  assert.deepEqual(a, b)
})

test('flee rolls are deterministic per seed and match chancePerTurn roughly', () => {
  const turnOf = (seed: number) => play(engine({ seed, flee: { chancePerTurn: 0.5, afterTurn: 1 } }), 40).endTurn
  for (const seed of [1, 2, 3]) assert.equal(turnOf(seed), turnOf(seed))
  let fledFirst = 0
  const N = 200
  for (let seed = 0; seed < N; seed++) if (turnOf(seed) === 1) fledFirst++
  assert.ok(fledFirst > N * 0.35 && fledFirst < N * 0.65, `fled on turn 1 in ${fledFirst}/${N}`)
})

test('a creature that cannot act (status skipChance 1) cannot flee either', () => {
  const sleep = CONTENT.statuses.find((s) => (s.skipChance ?? 0) >= 1 && s.cureChancePerTurn === undefined)!
  const e = engine({ flee: { chancePerTurn: 1, afterTurn: 1 }, foe: mon(WILD, 3, undefined, { status: sleep.id, statusTurns: 50 }) })
  const r = play(e, 6)
  assert.equal(r.endTurn, null)
  assert.ok(r.events.some((x) => x.t === 'flee' && x.stage === 'warn'))
  assert.ok(!r.events.some((x) => x.t === 'flee' && x.stage === 'fled'))
})

test('trainer and PvP sides ignore flee', () => {
  for (const foeKind of ['trainer', 'remote'] as const) {
    const e = engine({ foeKind, flee: { chancePerTurn: 1, afterTurn: 1 } })
    const r = play(e, 3)
    assert.ok(!r.events.some((x) => x.t === 'flee'), foeKind)
    assert.notEqual(e.result, 'fled')
  }
})

test('perspective() flips the flee side for the other viewer', () => {
  const evs: BattleEvent[] = [{ t: 'flee', side: 1, stage: 'fled' }]
  assert.deepEqual(perspective(evs, 1), [{ t: 'flee', side: 0, stage: 'fled' }])
})

test('fleeFor() reads RarityBehavior: tiers with flee chance get BattleSideInit.flee', () => {
  for (const r of CONTENT.rarities) {
    const sp = CONTENT.speciesList.find((s) => s.rarity === r.id)
    if (!sp) continue
    const f = fleeFor(sp.id)
    const b = r.behavior!
    if (b.fleeChancePerTurn > 0) assert.deepEqual(f, { chancePerTurn: b.fleeChancePerTurn, afterTurn: b.fleeAfterTurn })
    else assert.equal(f, undefined)
  }
})
