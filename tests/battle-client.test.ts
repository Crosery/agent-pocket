// Battle client (src/client/battle): pure modules only (config, local channel, presentation model, save ops) plus
// static checks that the client code carries no game data and every battleui text key it uses exists.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { BattleEvent, BattleInit, Creature, SaveData } from '../src/shared/types.ts'
import type { GameContext, GameEvents } from '../src/client/contracts.ts'
import { CONTENT, typeEffectiveness } from '../src/shared/content/index.ts'
import { Rng } from '../src/shared/rng.ts'
import { createCreature, expForLevel, maxHp } from '../src/shared/creature.ts'
import { BattleEngine } from '../src/shared/battle/engine.ts'
import { chooseAiAction } from '../src/shared/battle/ai.ts'
import { BATTLE_UI, validateBattleUi } from '../src/client/battle/config.ts'
import { createLocalChannel, isLocalChannel } from '../src/client/battle/channel.ts'
import {
  applyEvent, catchPlacement, createBattleModel, effCategory, evolutionMoves, expRatio, expSegments, finalResult, levelUpStats, moveEffectiveness, shortName,
} from '../src/client/battle/model.ts'
import { changeMoney, consumeItem, markCaught, markSeen, storeCaught } from '../src/client/battle/saveops.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src/client/battle')
const CLEAR = 'none'
const codeFiles = readdirSync(SRC).filter((f) => f.endsWith('.ts')).map((f) => ({ f, src: readFileSync(join(SRC, f), 'utf8') }))
/** Source without comments (line and block). */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

const species = CONTENT.speciesList
const mk = (rng: Rng, i: number, level: number): Creature => createCreature(species[i % species.length].id, level, { rng })

function wildInit(seed: number, party: Creature[], foe: Creature): BattleInit {
  return {
    seed, sides: [{ kind: 'player', name: 'p', party }, { kind: 'wild', name: 'w', party: [foe] }],
    isWild: true, canRun: true, canCatch: true, biome: CONTENT.biomes[0].id, timeOfDay: 'day', expGain: true,
  }
}

function trainerInit(seed: number, party: Creature[], foes: Creature[]): BattleInit {
  return {
    seed, sides: [{ kind: 'player', name: 'p', party }, { kind: 'trainer', name: 't', party: foes, aiLevel: 2 }],
    isWild: false, canRun: false, canCatch: false, biome: CONTENT.biomes[0].id, timeOfDay: 'day', expGain: true, rewardMoney: 100,
  }
}

function fakeCtx(save: Partial<SaveData> = {}) {
  const emitted: { type: keyof GameEvents; payload: unknown }[] = []
  const P = CONTENT.config.party
  const s = {
    name: 'me', playerId: 'pid', money: 100, party: [] as Creature[], boxes: Array.from({ length: P.boxCount }, () => [] as Creature[]),
    bag: {} as Record<string, number>, dexSeen: [] as string[], dexCaught: [] as string[],
    stats: { battlesWon: 0, caught: 0, steps: 0, pvpWins: 0, pvpLosses: 0, trades: 0, shiniesFound: 0 },
    ...save,
  } as SaveData
  const ctx = {
    save: s,
    data: CONTENT,
    events: { emit: (type: keyof GameEvents, payload: unknown) => { emitted.push({ type, payload }) }, on: () => () => undefined, once: () => () => undefined },
  } as unknown as Pick<GameContext, 'save' | 'events' | 'data'>
  return { ctx, emitted, save: s }
}

// ---------------------------------------------------------------------------
// Content & static checks
// ---------------------------------------------------------------------------

test('battle-ui.json validates against the loaded content', () => {
  assert.deepEqual(validateBattleUi(CONTENT), [])
})

test('every battleui text key used by the client exists, and every defined key is used', () => {
  const all = codeFiles.map((x) => x.src).join('\n')
  const literal = new Set([...all.matchAll(/'((?:battleui|battle)\.[\w.]+)'/g)].map((m) => m[1]))
  const dynamic: Record<string, string[]> = {
    'battleui.cmd.': [...new Set([...BATTLE_UI.commands.normal, ...BATTLE_UI.commands.pvp])],
    'battleui.move.category.': ['physical', 'special', 'status'],
    'battleui.eff.': ['immune', 'weak', 'normal', 'super', 'unknown'],
    'battleui.effects.status.': Object.keys(CONTENT.statusById),
    'battleui.effects.volatile.': Object.keys(CONTENT.volatileById),
    'battleui.effects.statusShort.': Object.keys(CONTENT.statusById),
  }
  for (const prefix of Object.keys(dynamic)) assert.ok(all.includes(`\`${prefix}\${`), `dynamic prefix ${prefix} is used`)
  const used = new Set([...literal, ...Object.entries(dynamic).flatMap(([p, xs]) => xs.map((x) => p + x))])
  for (const k of used) assert.ok(k in CONTENT.text, `missing text key ${k}`)
  const defined = Object.keys(CONTENT.text).filter((k) => k.startsWith('battleui.'))
  for (const k of defined) assert.ok(used.has(k), `unused text key ${k}`)
})

test('client code carries no player-facing text, colors or content ids', () => {
  const ids = new Set<string>([
    ...species.map((s) => s.id), ...CONTENT.moveList.map((m) => m.id), ...CONTENT.itemList.map((i) => i.id),
    ...CONTENT.statuses.map((s) => s.id), ...CONTENT.volatiles.map((v) => v.id), ...CONTENT.weathers.map((w) => w.id),
    ...Object.keys(CONTENT.abilities), ...CONTENT.biomes.map((b) => b.id), ...CONTENT.characters.map((c) => c.id),
    ...CONTENT.audio.bgm.map((b) => b.id),
  ])
  // Contract union members (BattleKind, CommandId, ...) are type vocabulary, not content data;
  // some coincide with bgm/sfx ids (e.g. 'gym', 'run').
  const vocab = new Set<string>([
    'wild', 'trainer', 'gym', 'legend', 'pvp', 'fight', 'bag', 'party', 'run', 'forfeit',
    'fade', 'battle', 'iris', 'immune', 'weak', 'normal', 'super', 'physical', 'special', 'status',
    'slow', 'fast', 'instant',
  ])
  for (const { f, src } of codeFiles) {
    const code = stripComments(src)
    assert.ok(!/[㐀-鿿＀-￯]/.test(code), `${f}: CJK text in code`)
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(code), `${f}: hex colour in code`)
    for (const m of code.matchAll(/'([^'\\\n]+)'/g)) {
      if (m[1] === CLEAR || vocab.has(m[1])) continue
      assert.ok(!ids.has(m[1]), `${f}: content id literal '${m[1]}'`)
    }
  }
})

// ---------------------------------------------------------------------------
// Local channel
// ---------------------------------------------------------------------------

test('local channel plays a full AI-vs-AI battle and reports engine errors as messages', async () => {
  for (let seed = 1; seed <= 12; seed++) {
    const rng = new Rng(seed)
    const party = [mk(rng, seed, 20), mk(rng, seed + 3, 18), mk(rng, seed + 7, 16)]
    const foes = [mk(rng, seed + 11, 18), mk(rng, seed + 13, 17)]
    const engine = new BattleEngine(seed % 2 ? trainerInit(seed, party, foes) : wildInit(seed, party, foes[0]))
    const ch = createLocalChannel(engine)
    assert.ok(isLocalChannel(ch))
    let batch = await ch.start()
    const events: BattleEvent[] = [...batch.events]
    const bad = await ch.submit({ kind: 'move', moveIndex: 99 })
    assert.equal(bad.events.length, 1)
    assert.equal(bad.events[0].t, 'msg')
    assert.deepEqual(bad.request, batch.request)
    for (let i = 0; i < 500 && batch.request.kind !== 'wait'; i++) {
      batch = await ch.submit(chooseAiAction(engine, 0, rng))
      events.push(...batch.events)
    }
    assert.ok(engine.finished, `seed ${seed} finished`)
    assert.equal(events.at(-1)?.t, 'end')
    const after = await ch.submit({ kind: 'run' })
    assert.deepEqual(after, { events: [], request: { kind: 'wait' } })
    ch.dispose()

    // The presentation model folded from the events matches the engine's final state.
    const model = createBattleModel(engine.init, CLEAR)
    for (const e of events) applyEvent(model, e)
    assert.equal(model.end?.result, engine.result)
    for (const side of [0, 1] as const) {
      const s = model.sides[side]
      assert.equal(s.active, engine.activeIndex(side))
      // A level-up raises the engine's hp after the last damage event; the folded view only follows damage/heal events.
      const leveled = side === 0 && events.some((e) => e.t === 'levelUp' && e.partyIndex === s.active)
      if (!leveled) assert.equal(s.view?.hp, engine.party(side)[s.active].hp)
      engine.party(side).forEach((cr, i) => { if (cr.hp <= 0) assert.equal(s.slots[i]?.state, 'fainted') })
    }
    engine.party(0).forEach((cr, i) => assert.deepEqual(model.progress[i], { level: cr.level, exp: cr.exp }))
    assert.equal(model.weather, engine.weather)
  }
})

// ---------------------------------------------------------------------------
// Model calculations
// ---------------------------------------------------------------------------

test('exp segments fill every crossed level and end at the target ratio', () => {
  const g = species[0].growth
  const at = (lv: number) => expForLevel(g, lv)
  const one = expSegments(g, { level: 10, exp: at(10) }, { level: 10, exp: Math.floor((at(10) + at(11)) / 2) })
  assert.equal(one.length, 1)
  assert.equal(one[0].from, 0)
  assert.ok(one[0].to > 0.4 && one[0].to < 0.6)
  const multi = expSegments(g, { level: 10, exp: at(10) + 1 }, { level: 13, exp: at(13) })
  assert.deepEqual(multi.map((s) => s.level), [10, 11, 12, 13])
  for (const s of multi.slice(0, 3)) assert.equal(s.to, 1)
  assert.equal(multi[1].from, 0)
  assert.equal(multi[3].to, 0)
  assert.equal(expRatio(g, CONTENT.config.party.maxLevel, 0), 1)
})

test('level-up stat deltas grow with level', () => {
  const cr = mk(new Rng(5), 0, 30)
  const d = levelUpStats(cr, 30, 31)
  assert.equal(d.length, 6)
  for (const x of d) assert.ok(x.after >= x.before)
  assert.equal(d.find((x) => x.key === 'hp')?.after, maxHp({ ...cr, level: 31 }))
})

test('effectiveness hints follow the type chart', () => {
  assert.equal(effCategory(0), 'immune')
  assert.equal(effCategory(0.5), 'weak')
  assert.equal(effCategory(1), 'normal')
  assert.equal(effCategory(4), 'super')
  for (const m of CONTENT.moveList) {
    for (const def of CONTENT.types.slice(0, 4)) {
      const got = moveEffectiveness(m, [def.id])
      if (m.category === 'status') { assert.equal(got, null); continue }
      const mul = typeEffectiveness(m.type, [def.id])
      if (m.effects.some((e) => e.kind === 'fixedDamage')) assert.equal(got, mul === 0 ? 'immune' : 'normal')
      else assert.equal(got, effCategory(mul))
    }
  }
})

test('catch placement prefers the party, then the first box with room, else nothing', () => {
  const P = CONTENT.config.party
  const rng = new Rng(9)
  const full = (n: number) => Array.from({ length: n }, (_, i) => mk(rng, i, 5))
  assert.deepEqual(catchPlacement({ party: full(1), boxes: [] }), { where: 'party' })
  const boxes = Array.from({ length: P.boxCount }, () => [] as Creature[])
  boxes[0] = full(P.boxSize)
  assert.deepEqual(catchPlacement({ party: full(P.maxParty), boxes }), { where: 'box', box: 1 })
  const allFull = Array.from({ length: P.boxCount }, () => full(P.boxSize))
  assert.equal(catchPlacement({ party: full(P.maxParty), boxes: allFull }), null)
})

test('evolution moves are the new stage moves not yet known', () => {
  const from = species.find((s) => s.evolvesTo && CONTENT.species[s.evolvesTo.id])
  if (!from?.evolvesTo) return
  const to = CONTENT.species[from.evolvesTo.id]
  const cr = mk(new Rng(3), species.indexOf(from), from.evolvesTo.level)
  const want = to.learnset.filter((e) => (e.level === 0 || e.level === cr.level) && CONTENT.moves[e.move] && !cr.moves.some((m) => m.id === e.move))
  assert.deepEqual(evolutionMoves(cr, to.id), [...new Set(want.map((e) => e.move))])
})

// ---------------------------------------------------------------------------
// Save operations
// ---------------------------------------------------------------------------

test('save ops: dex, bag, money and stored captures emit events and count stats', () => {
  const { ctx, emitted, save } = fakeCtx({ bag: { x: 2 } })
  const id = species[0].id
  assert.equal(markSeen(ctx, id), true)
  assert.equal(markSeen(ctx, id), false)
  assert.equal(markCaught(ctx, id), true)
  assert.equal(markCaught(ctx, id), false)
  assert.equal(markSeen(ctx, 'not-a-species'), false)
  assert.deepEqual(emitted.map((e) => e.type), ['dex:seen', 'dex:caught'])
  assert.equal(consumeItem(ctx, 'x'), true)
  assert.equal(consumeItem(ctx, 'x'), true)
  assert.equal(consumeItem(ctx, 'x'), false)
  assert.equal(save.bag.x, undefined)
  assert.equal(changeMoney(ctx, -500), -100)
  assert.equal(save.money, 0)
  const cr = { ...mk(new Rng(1), 2, 5), otName: '', otId: '', shiny: true }
  assert.deepEqual(storeCaught(ctx, cr), { where: 'party' })
  assert.equal(save.party[0], cr)
  assert.equal(cr.otName, 'me')
  assert.equal(cr.otId, 'pid')
  assert.equal(save.stats.caught, 1)
  assert.equal(save.stats.shiniesFound, 1)
})

test('stored captures overflow into boxes', () => {
  const P = CONTENT.config.party
  const rng = new Rng(2)
  const { ctx, save } = fakeCtx({ party: Array.from({ length: P.maxParty }, (_, i) => mk(rng, i, 5)) })
  const cr = mk(rng, 9, 5)
  assert.deepEqual(storeCaught(ctx, cr), { where: 'box', box: 0 })
  assert.equal(save.boxes[0][0], cr)
  assert.equal(save.party.length, P.maxParty)
})

test('final result: shown end, else engine, else fled (local) / forfeited (PvP) — never a blackout draw', () => {
  assert.equal(finalResult('win', 'lose', false), 'win')
  assert.equal(finalResult(undefined, 'caught', false), 'caught')
  assert.equal(finalResult(undefined, null, false), 'run')
  assert.equal(finalResult(undefined, undefined, true), 'forfeit')
})

test('card names drop their parenthetical and never come back empty', () => {
  assert.equal(shortName('Llama 4 (Scout / Maverick)'), 'Llama 4')
  assert.equal(shortName('GPT-5.6（日 / 地 / 月）'), 'GPT-5.6')
  assert.equal(shortName('ChatGPT（超级应用）'), 'ChatGPT')
  assert.equal(shortName('GPT-5'), 'GPT-5')
  assert.equal(shortName('（只有括号）'), '（只有括号）')
  for (const sp of Object.values(CONTENT.species)) {
    assert.ok(shortName(sp.nameZh).length > 0, sp.id)
    assert.ok(shortName(sp.nameZh).length <= sp.nameZh.length, sp.id)
  }
})
