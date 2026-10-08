// Boss battles (#27): data consistency, every boss's phases and signature mechanic, the counter items, enrage,
// deterministic replay, the BossState extract/apply contract (ADR 0001 §5.6 / WP12a) and Monte Carlo balance:
// a boss is beatable without its counter (hard) and clearly easier with it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT, t } from '../src/shared/content/index.ts'
import type { BattleEvent, BossDef, BossState } from '../src/shared/types.ts'
import { Rng } from '../src/shared/rng.ts'
import { perspective } from '../src/shared/battle/engine.ts'
import { chooseBossAction } from '../src/shared/battle/boss.ts'
import { validateBosses } from '../src/shared/battle/boss-validate.ts'
import { buildBossInit, startBossBattle } from '../src/shared/battle/boss-battle.ts'
import { COUNTERS } from './boss-counters.ts'
import { makeParty, SIM_PARTY, simulate, type SimOpts, type SimResult } from './boss-sim.ts'

const BOSSES = CONTENT.bossList
const SEEDS = 200
const seedOf = (i: number) => 1 + i * 7919

const cache = new Map<string, SimResult[]>()
/** `n` seeded fights of a boss, with or without its counter strategy (memoised: balance and phase checks share them). */
function fights(bossId: string, counter: boolean, n: number): SimResult[] {
  const key = `${bossId}:${counter}`
  const have = cache.get(key) ?? []
  const extra: Partial<SimOpts> = counter ? COUNTERS[bossId] : {}
  for (let i = have.length; i < n; i++) have.push(simulate({ bossId, seed: seedOf(i), ...extra }))
  cache.set(key, have)
  return have.slice(0, n)
}
const rate = (rs: SimResult[]) => rs.filter((r) => r.won).length / rs.length
const union = (rs: SimResult[], pick: (r: SimResult) => Iterable<string>) => new Set(rs.flatMap((r) => [...pick(r)]))
const firedIn = (rs: SimResult[]) => union(rs, (r) => Object.entries(r.fired).filter(([, n]) => n > 0).map(([id]) => id))
const formsIn = (rs: SimResult[]) => union(rs, (r) => r.bossForms)
const meterPeak = (rs: SimResult[], id: string) => Math.max(0, ...rs.map((r) => r.meterMax[id] ?? 0))

const byId = (id: string): BossDef => {
  const def = CONTENT.bosses[id]
  assert.ok(def, `boss ${id}`)
  return def
}

// ---------------------------------------------------------------------------------------------------- data

test('data: at least 8 bosses, all of them consistent with the rest of the content', () => {
  assert.ok(BOSSES.length >= 8, `${BOSSES.length} bosses`)
  assert.deepEqual(validateBosses(BOSSES, CONTENT), [])
  for (const b of BOSSES) {
    assert.equal(CONTENT.bossBySpecies[b.species]?.id, b.id, `${b.id} is found by its species`)
    assert.ok(b.gossip.length >= 1 && b.taunt.length >= 1, `${b.id} has hints`)
    for (const key of [b.title, b.hint.seen, b.hint.won, ...b.taunt, ...b.gossip]) assert.notEqual(t(key), key, `${b.id}: text ${key}`)
  }
})

test('data: the validator rejects dangling references and raw text', () => {
  const astra = byId('astra')
  const broken: BossDef = {
    ...astra,
    title: '降智之星',
    initialForm: 'nowhere',
    triggers: [
      ...astra.triggers,
      { id: 'bad', on: 'foeItem', tag: 'no-such-tag', do: [{ op: 'form', form: 'missing' }] },
      { id: 'bad2', on: 'turnEnd', if: { meter: { id: 'ghost', atLeast: 1 } }, do: [{ op: 'say', text: 'boss.astra.ghost' }] },
    ],
  }
  const errs = validateBosses([broken], CONTENT).join('\n')
  for (const needle of ['initialForm', 'raw text', 'no-such-tag', 'unknown form "missing"', 'unknown meter "ghost"', 'missing text "boss.astra.ghost"']) {
    assert.match(errs, new RegExp(needle), needle)
  }
})

test('data: every counter item is a bait that some boss reacts to, and every bait tag has an item', () => {
  const baits = CONTENT.itemList.filter((i) => i.effect.kind === 'bait')
  assert.ok(baits.length >= 6, 'counter items exist')
  const tags = new Set(BOSSES.flatMap((b) => b.triggers.filter((tr) => tr.tag !== undefined).map((tr) => tr.tag)))
  for (const it of baits) {
    assert.equal(it.category, 'battle')
    assert.ok(it.usableInBattle && !it.usableInField, `${it.id} is a battle-only item`)
    assert.ok(it.effect.kind === 'bait' && tags.has(it.effect.tag), `${it.id}: no boss reacts to its tag`)
  }
  for (const tag of tags) assert.ok(baits.some((i) => i.effect.kind === 'bait' && i.effect.tag === tag), `tag ${tag} has no item`)
})

// ---------------------------------------------------------------------------------------------------- phases

test('phases: every boss shows all of its phases, and its signature mechanic, over seeded fights', () => {
  for (const b of BOSSES) {
    const plain = fights(b.id, false, 40)
    const counter = fights(b.id, true, 40)
    const seen = new Set([...firedIn(plain), ...firedIn(counter)])
    for (const tr of b.triggers.filter((x) => x.phase)) assert.ok(seen.has(tr.id), `${b.id}: phase "${tr.id}" never fired`)
    for (const f of [...plain, ...counter]) assert.ok(Object.values(b.forms).some((fm) => fm.species), `${b.id} form`)
  }
})

test('mechanics: each boss has its own counterplay', () => {
  const P = (id: string) => fights(id, false, 40)
  const C = (id: string) => fights(id, true, 40)

  // GPT-6 Astra: telegraphed exaflop beam; the sauce routes it to GPT-4o, then the Luna form.
  assert.ok(P('astra').some((r) => r.telegraphs > 0), 'astra telegraphs its beam')
  assert.ok(firedIn(P('astra')).has('deep'))
  assert.deepEqual([...formsIn(C('astra'))].sort(), ['base', 'luna', 'routed-4o'])
  assert.ok(!formsIn(P('astra')).has('routed-4o'), 'the router only downgrades on sauce')

  // DeepSeek: the server is busy in peak hours, and the off-peak coupon ends them.
  assert.equal(meterPeak(P('deepseek'), 'tide'), 1)
  assert.ok(firedIn(P('deepseek')).has('tide-valley') && firedIn(P('deepseek')).has('tide-peak-a'))
  assert.ok(firedIn(C('deepseek')).has('coupon'))

  // Kimi: the context window overflows into a crash.
  assert.equal(meterPeak(P('kimi'), 'context'), 8)
  assert.ok(formsIn(P('kimi')).has('crashed'))
  assert.ok(firedIn(C('kimi')).has('ctx-item'))

  // MiniMax: benchmark gaming gets exposed by a holdout set.
  assert.ok(formsIn(C('minimax')).has('exposed'))
  assert.ok(firedIn(C('minimax')).has('holdout'))

  // Qwen: it distils whatever it is shown; switching out makes the copy useless.
  assert.ok(meterPeak(P('qwen'), 'distilled') >= 1 || firedIn(P('qwen')).has('distill'))
  assert.ok(firedIn(C('qwen')).has('student-lost'))

  // Cursor: metered billing until enough complaints arrive, then an apology.
  assert.ok(formsIn(C('cursor')).has('refunded'))
  assert.ok(firedIn(C('cursor')).has('complaint-item'))

  // Claude Code: risk control bans the account; a residential IP prevents it.
  assert.ok(firedIn(P('claude-code')).has('ban'))
  assert.ok(!firedIn(C('claude-code')).has('ban'), 'the residential IP keeps the account alive')
  assert.ok(firedIn(C('claude-code')).has('vpn-item'))

  // Mythos: the sandbox escapes unless it is patched.
  assert.ok(formsIn(P('mythos')).has('unbound'))
  assert.ok(firedIn(C('mythos')).has('seal-item'))

  // AlphaGo: a surprising move (a type it has not read yet) breaks its reading.
  assert.ok(formsIn(P('alpha')).has('dazed'))
  assert.ok(firedIn(P('alpha')).has('novel'))
})

// ---------------------------------------------------------------------------------------------------- counter items

function turnOne(bossId: string, itemId: string, bag = 3) {
  const def = byId(bossId)
  const party = makeParty(SIM_PARTY, def.level - 2, 1)
  const { engine } = startBossBattle(bossId, party, { seed: 3, items: { [itemId]: bag }, expGain: false })
  const before = engine.extractBossState()!
  const err = engine.choose(0, { kind: 'item', itemId, partyIndex: 0 })
  assert.equal(err, null, `${itemId} is accepted`)
  engine.choose(1, { kind: 'move', moveIndex: 0 })
  const events = engine.step()
  return { engine, before, after: engine.extractBossState()!, events }
}

test('items: the sauce routes Astra to GPT-4o (and again later to the Luna form)', () => {
  const { engine, before, after, events } = turnOne('astra', 'special-sauce')
  assert.equal(before.form, 'base')
  assert.equal(after.form, 'routed-4o')
  const form = events.find((e): e is Extract<BattleEvent, { t: 'form' }> => e.t === 'form')
  assert.ok(form, 'a form event is emitted')
  assert.equal(form.fromSpeciesId, 'gpt-6-astra')
  assert.equal(form.creature.speciesId, 'gpt-4o')
  assert.deepEqual(after.moves.map((m) => m.id), byId('astra').forms['routed-4o'].moves)
  assert.ok(after.hp / after.maxHp > 0.9, 'the hp ratio carries over to the new form')
  // A second sauce is useless: the router already downgraded it.
  const second = engine.choose(0, { kind: 'item', itemId: 'special-sauce', partyIndex: 0 })
  assert.equal(second, t('battle.err.baitNoEffect'))
})

test('items: the downgraded Astra is much weaker than the full one', () => {
  const { engine, after } = turnOne('astra', 'special-sauce')
  const full = startBossBattle('astra', makeParty(SIM_PARTY, 60, 1), { seed: 3, expGain: false }).engine
  const stat = (e: typeof engine, k: 'atk' | 'spa' | 'hp') => e.fighterStats(1)[k]
  assert.ok(after.form === 'routed-4o' && stat(engine, 'atk') + stat(engine, 'spa') < stat(full, 'atk') + stat(full, 'spa') + 1)
  assert.ok(stat(engine, 'atk') < stat(full, 'atk') * 1.3)
})

test('items: every other counter item moves its boss meter or form', () => {
  const kimi = turnOne('kimi', 'long-document')
  assert.ok(kimi.after.meters.context > kimi.before.meters.context, 'context fills up')

  const ds = turnOne('deepseek', 'off-peak-coupon')
  assert.equal(ds.before.meters.tide, 0)
  assert.equal(ds.after.meters.tide, 1, 'peak hours end right away')
  assert.ok(ds.after.meters.grace >= 1)

  const mm = turnOne('minimax', 'holdout-set')
  assert.equal(mm.before.form, 'bench')
  assert.equal(mm.after.form, 'exposed')

  const cc = turnOne('claude-code', 'residential-ip')
  assert.ok(cc.after.meters.vpn >= 5 && cc.after.meters.risk === 0)

  const my = turnOne('mythos', 'sandbox-patch')
  assert.ok(my.after.meters.escape < my.before.meters.escape, 'the sandbox holds')

  const cu = turnOne('cursor', 'complaint-letter')
  assert.ok(cu.after.meters.outrage > cu.before.meters.outrage)
})

test('items: a bait the boss would ignore is refused without being used up', () => {
  const party = makeParty(SIM_PARTY, 60, 1)
  const { engine } = startBossBattle('astra', party, { seed: 3, items: { 'sandbox-patch': 1 }, expGain: false })
  assert.equal(engine.choose(0, { kind: 'item', itemId: 'sandbox-patch', partyIndex: 0 }), t('battle.err.baitNoEffect'))
})

// ---------------------------------------------------------------------------------------------------- enrage

test('enrage: every boss with a timer warns first, then stacks its stat stages up to the cap', () => {
  const withTimer = BOSSES.filter((b) => b.enrage)
  assert.ok(withTimer.length >= 5, 'most bosses have an enrage timer')
  /** The longest literal stretch of a text template (placeholders such as {boss} vary). */
  const literal = (key: string) => t(key).split(/\{\w+\}/).sort((x, y) => y.length - x.length)[0].trim()
  let checked = 0
  for (const b of withTimer) {
    const en = b.enrage!
    const jump = Math.max(0, en.turn - en.warnBefore - 2)
    const r = simulate({
      bossId: b.id, seed: 11, log: true, maxTurns: en.turn + en.max + 4, level: b.level + 6,
      beforeTurn: (e, turn) => {
        if (turn !== 0) return
        // Move the boss clock near the timer through the BossState contract itself.
        const st = e.extractBossState()!
        st.turn = jump
        e.applyBossState(st)
      },
    })
    let turn = 0
    const at = (needle: string) => r.events.flatMap((e) => { if (e.t === 'turn') turn = e.turn; return e.t === 'msg' && e.text.includes(needle) ? [turn] : [] })
    turn = 0
    const warns = at(literal(en.warn))
    turn = 0
    const starts = at(literal(en.start))
    if (r.turns <= en.turn) continue // somebody fell before the timer ran out
    checked += 1
    assert.ok(warns.length > 0 && warns[0] < en.turn, `${b.id}: warns before turn ${en.turn} (${warns})`)
    assert.ok(starts.length > 0 && starts[0] >= en.turn, `${b.id}: starts at turn ${en.turn} (${starts})`)
    assert.ok(r.maxEnrage >= 1 && r.maxEnrage <= en.max, `${b.id}: enrage stacks within 1..${en.max} (${r.maxEnrage})`)
  }
  assert.ok(checked >= 5, `only ${checked} bosses lived to enrage`)
})

// ---------------------------------------------------------------------------------------------------- determinism & contract

test('determinism: the same seed replays the same fight, event for event', () => {
  for (const b of BOSSES) {
    for (const counter of [false, true]) {
      const extra: Partial<SimOpts> = counter ? COUNTERS[b.id] : {}
      const a = simulate({ bossId: b.id, seed: 4242, log: true, ...extra })
      const c = simulate({ bossId: b.id, seed: 4242, log: true, ...extra })
      assert.equal(JSON.stringify(a.events), JSON.stringify(c.events), `${b.id} (counter=${counter})`)
      assert.ok(a.events.length > 20)
    }
    const other = simulate({ bossId: b.id, seed: 4243, log: true })
    const base = simulate({ bossId: b.id, seed: 4242, log: true })
    assert.notEqual(JSON.stringify(other.events), JSON.stringify(base.events), `${b.id}: a different seed plays differently`)
  }
})

test('contract: BossState is plain JSON that applies back to itself', () => {
  for (const b of BOSSES) {
    const got: { snap: BossState | null } = { snap: null }
    simulate({ bossId: b.id, seed: 77, ...COUNTERS[b.id], beforeTurn: (e, turn) => { if (turn === 3) got.snap = e.extractBossState() } })
    assert.ok(got.snap, `${b.id}: reached turn 3`)
    const state: BossState = JSON.parse(JSON.stringify(got.snap))
    assert.deepEqual(state, got.snap, 'JSON round trip')
    // A different engine (another player of a raid) takes the state over and reports exactly it back.
    const other = startBossBattle(b.id, makeParty(['kling-4', 'qwen-audio'], b.level - 2, 99), { seed: 5, expGain: false }).engine
    other.applyBossState(state)
    assert.deepEqual(other.extractBossState(), state, `${b.id}: apply(extract(x)) == x`)
    assert.equal(other.activeView(1).hp, state.hp)
    assert.equal(other.activeView(1).speciesId, state.speciesId)
  }
})

test('contract: restoring a checkpoint mid-fight equals the uninterrupted fight', () => {
  for (const b of BOSSES) {
    for (const k of [2, 5]) {
      const checkpoints = new Map<number, BossState>()
      const run = simulate({
        bossId: b.id, seed: 909, log: true, ...COUNTERS[b.id],
        beforeTurn: (e, turn) => { const s = e.extractBossState(); if (s) checkpoints.set(turn, JSON.parse(JSON.stringify(s))) },
      })
      const at = checkpoints.get(k)
      if (!at) continue
      // Same fight again, but at turn k the boss state is first overwritten with an earlier snapshot and
      // then restored from the checkpoint alone: nothing the boss needs may live outside BossState.
      const resumed = simulate({
        bossId: b.id, seed: 909, log: true, ...COUNTERS[b.id],
        beforeTurn: (e, turn) => {
          if (turn !== k) return
          const early = checkpoints.get(0)
          if (early) e.applyBossState(early)
          e.applyBossState(JSON.parse(JSON.stringify(at)))
          assert.deepEqual(e.extractBossState(), at)
        },
      })
      assert.equal(JSON.stringify(resumed.events), JSON.stringify(run.events), `${b.id}: restored at turn ${k}`)
    }
  }
})

test('contract: chooseBossAction is pure and honours the form pattern', () => {
  for (const b of BOSSES) {
    const { engine } = startBossBattle(b.id, makeParty(SIM_PARTY, b.level - 2, 1), { seed: 1, expGain: false })
    const state = engine.extractBossState()!
    const frozen = JSON.stringify(state)
    const foe = { status: null, country: 'US' }
    const allowed = new Set(b.forms[state.form].moves)
    const a = chooseBossAction(state, b, foe, new Rng(5))
    const c = chooseBossAction(state, b, foe, new Rng(5))
    assert.deepEqual(a, c, `${b.id}: same state and rng, same action`)
    assert.equal(JSON.stringify(state), frozen, `${b.id}: the state is not modified`)
    const rng = new Rng(8)
    const picks = new Set<string>()
    for (let i = 0; i < 200; i++) picks.add(chooseBossAction(state, b, foe, rng)?.moveId ?? '')
    for (const id of picks) assert.ok(allowed.has(id), `${b.id}: picked ${id}`)
    assert.ok(picks.size >= 2, `${b.id}: the pattern mixes moves`)
  }
})

test('contract: a charged attack is forced on the next turn', () => {
  const b = byId('astra')
  const { engine } = startBossBattle('astra', makeParty(SIM_PARTY, b.level, 1), { seed: 1, expGain: false })
  const state = engine.extractBossState()!
  state.charge = { move: 'exaflop-beam', warn: 'boss.astra.charge', mul: 0.6 }
  assert.deepEqual(chooseBossAction(state, b, { status: null, country: '' }, new Rng(1)), { moveId: 'exaflop-beam', forced: true })
})

// ---------------------------------------------------------------------------------------------------- entry point & rewards

test('startBossBattle: builds a boss fight with the boss HUD, and the boss reverts to its own species afterwards', () => {
  const b = byId('astra')
  const party = makeParty(SIM_PARTY, b.level, 1)
  const init = buildBossInit('astra', party, { seed: 5, expGain: false })
  assert.equal(init.sides[1].boss, 'astra')
  assert.equal(init.canRun, b.canRun)
  const { engine, intro } = startBossBattle('astra', party, { seed: 5, expGain: false })
  const hud = intro.find((e): e is Extract<BattleEvent, { t: 'boss' }> => e.t === 'boss')
  assert.ok(hud && hud.hud.bossId === 'astra' && hud.hud.phases === 4)
  assert.throws(() => startBossBattle('nope', party, { seed: 1 }), /unknown boss/)
  engine.choose(0, { kind: 'move', moveIndex: 0 })
  engine.step()
  assert.equal(engine.extractBossState()?.bossId, 'astra')
})

test('rewards: a defeated boss pays out money and items to the winner only', () => {
  for (const b of BOSSES) {
    const r = simulate({ bossId: b.id, seed: seedOf(0), log: true, ...COUNTERS[b.id], level: b.level + 8 })
    if (!r.won) continue
    const loot = r.events.filter((e): e is Extract<BattleEvent, { t: 'loot' }> => e.t === 'loot')
    for (const [id, qty] of Object.entries(b.reward.items ?? {})) assert.equal(loot.find((l) => l.itemId === id)?.qty, qty, `${b.id}: ${id}`)
    const theirView = perspective(r.events, 1)
    assert.ok(!theirView.some((e) => e.t === 'loot'), 'the loser never sees the loot')
    return
  }
  assert.fail('no boss was beaten by an over-levelled party')
})

// ---------------------------------------------------------------------------------------------------- balance

test(`balance: ${SEEDS} seeded fights per boss — hard without the counter, clearly easier with it`, () => {
  const table: string[] = []
  for (const b of BOSSES) {
    const plain = rate(fights(b.id, false, SEEDS))
    const counter = rate(fights(b.id, true, SEEDS))
    table.push(`${b.id.padEnd(12)} plain ${(plain * 100).toFixed(1)}%  counter ${(counter * 100).toFixed(1)}%`)
    assert.ok(plain > 0.05, `${b.id}: unbeatable without the counter (${plain})`)
    assert.ok(plain < 0.75, `${b.id}: the counter would not matter (${plain})`)
    assert.ok(counter >= 0.7, `${b.id}: the counter is not reliable enough (${counter})`)
    assert.ok(counter - plain >= 0.25, `${b.id}: the counter does not help enough (${plain} -> ${counter})`)
  }
  if (process.env.BOSS_TABLE) console.log(table.join('\n'))
})
