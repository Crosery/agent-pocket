// Boss battles (#27): data consistency, every boss's phases and signature mechanic, the counter items, enrage,
// deterministic replay, the BossState extract/apply contract (ADR 0001 §5.6 / WP12a) and Monte Carlo balance:
// a boss is beatable without its counter (hard) and clearly easier with it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT, t, typeEffectiveness } from '../src/shared/content/index.ts'
import type { BattleEvent, BossDef, BossState } from '../src/shared/types.ts'
import { Rng } from '../src/shared/rng.ts'
import { perspective } from '../src/shared/battle/engine.ts'
import { chooseBossAction } from '../src/shared/battle/boss.ts'
import { validateBosses } from '../src/shared/battle/boss-validate.ts'
import { buildBossInit, startBossBattle } from '../src/shared/battle/boss-battle.ts'
import legendsJson from '../content/events/legends.json' with { type: 'json' }
import mythicJson from '../content/events/mythic.json' with { type: 'json' }
import populationJson from '../content/world/story/population.json' with { type: 'json' }
import servicesJson from '../content/world/story/services.json' with { type: 'json' }
import { applyEvent, bossOpeningHud, bossPanelInfo, createBattleModel } from '../src/client/battle/model.ts'
import { COUNTERS, PLAIN } from './boss-counters.ts'
import { DEFS } from '../tools/balance/teams.ts'
import { makeParty, SIM_PARTY, simulate, type SimOpts, type SimResult } from './boss-sim.ts'
import { resolveBossDef } from '../src/shared/battle/boss-tier.ts'
import { bossCondHolds } from '../src/shared/battle/boss.ts'
import { computeDamage, condHolds, toStages, type Fighter } from '../src/shared/battle/formulas.ts'
import { calcStats, createCreature } from '../src/shared/creature.ts'
import { fightStory, rateStory, STARTERS, storyParty } from './boss-story.ts'

const BOSSES = CONTENT.bossList
const SEEDS = 200
const seedOf = (i: number) => 1 + i * 7919

const cache = new Map<string, SimResult[]>()
/** `n` seeded fights of a boss, with or without its counter strategy (memoised: balance and phase checks share them). */
function fights(bossId: string, counter: boolean, n: number): SimResult[] {
  const key = `${bossId}:${counter}`
  const have = cache.get(key) ?? []
  const extra: Partial<SimOpts> = counter ? COUNTERS[bossId] : (PLAIN[bossId] ?? {})
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

  // Astra (酱汁之王): a telegraphed beam, a secret sauce cycle, the pelican exposure window and the prefab library; the sauce routes
  // it to GPT-4o, and the quota drops it to Luna at 30% whatever you did.
  assert.ok(P('astra').some((r) => r.telegraphs > 0), 'astra telegraphs its beam')
  assert.ok(firedIn(P('astra')).has('deep') && firedIn(P('astra')).has('to-sauce') && firedIn(P('astra')).has('library'))
  assert.ok(formsIn(P('astra')).has('luna') && !formsIn(P('astra')).has('routed'), 'only the sauce routes it to 4o; the quota drop to Luna is for everyone')
  assert.equal(meterPeak(P('astra'), 'exposed'), 0, 'nobody tests it without the items')
  assert.deepEqual([...formsIn(C('astra'))].sort(), ['base', 'luna', 'routed'])
  assert.ok(['sauce', 'test-honest', 'reverse-hit', 'patched'].every((k) => firedIn(C('astra')).has(k)))
  assert.equal(meterPeak(C('astra'), 'exposed'), 5)

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

  // Claude Code: a BUDDY pet blocks every second attack; the .map file unmasks it, and its own leak does at half hp.
  assert.ok(firedIn(P('claude-code')).has('summon') && firedIn(P('claude-code')).has('buddy-block'))
  assert.ok(firedIn(P('claude-code')).has('leak'))
  assert.ok(firedIn(C('claude-code')).has('unmask') && formsIn(C('claude-code')).has('exposed'))
  assert.ok(!formsIn(P('claude-code')).has('exposed') || firedIn(P('claude-code')).has('leak'), 'it only drops the cover by leaking')

  // GLM: a queue shield, then free eggs whose backups pile up into a heavy restore; the pledge holds it to its word.
  assert.ok(firedIn(P('glm')).has('queue-end') && firedIn(P('glm')).has('egg') && firedIn(P('glm')).has('restore'))
  assert.equal(meterPeak(P('glm'), 'backup'), 3)
  assert.ok(firedIn(C('glm')).has('pledge-item') && meterPeak(C('glm'), 'pledge') >= 6)

  // Mythos: the sandbox escapes unless it is patched.
  assert.ok(formsIn(P('mythos')).has('unbound'))
  assert.ok(firedIn(C('mythos')).has('seal-item'))

  // AlphaGo: changing the move type every turn (a surprise it has not read) breaks its reading.
  assert.ok(formsIn(C('alpha')).has('dazed'))
  assert.ok(firedIn(C('alpha')).has('shift') && firedIn(P('alpha')).has('repeat'))

  // Claude Opus: four risk columns, any full one bans the account; the residential IP and the Apple subscription hold the first two back.
  const RISK = ['pay', 'region', 'behavior', 'share']
  const banned = (rs: SimResult[], dims = RISK) => rs.filter((r) => dims.some((d) => (r.fired[`ban-${d}`] ?? 0) > 0)).length
  assert.ok(['ban-pay', 'ban-region', 'ban-behavior', 'flag-cn', 'bill', 'binge'].every((k) => firedIn(P('opus')).has(k)))
  assert.equal(meterPeak(P('opus'), 'region'), 3)
  assert.ok(firedIn(C('opus')).has('cloak') && firedIn(C('opus')).has('apple'))
  assert.ok(banned(C('opus'), ['pay', 'region']) < banned(P('opus'), ['pay', 'region']) / 4, 'the two items stop the payment and region bans (behaviour and sharing are play style)')

  // Unitree GD01: a banana peel drops the mech for several turns.
  assert.ok(formsIn(C('unitree')).has('fallen') && firedIn(C('unitree')).has('slip'))
  assert.ok(!formsIn(P('unitree')).has('fallen'), 'it only falls on the peel')

  // Grok: it uploads (steals) what it sees and trains on it; pulling the network plug cuts that.
  assert.ok(firedIn(P('grok')).has('upload') && meterPeak(P('grok'), 'loot') === 3)
  assert.ok(!firedIn(P('grok')).has('unplug'), 'without the cable nobody pulls the plug (a creature that knows Blackout can, rarely)')
  const trained = (rs: SimResult[]) => rs.filter((r) => (r.meterMax.loot ?? 0) >= 3).length
  assert.ok(firedIn(C('grok')).has('unplug') && trained(C('grok')) < trained(P('grok')) * 0.6, 'with the cable in the bag it rarely gets to train on three of your moves')

  // OpenClaw: a malicious skill is loaded every 4 turns and injected a turn later; a key revoked in that window reflects it.
  assert.ok(firedIn(P('openclaw')).has('skill') && firedIn(P('openclaw')).has('hijack'))
  assert.ok(!formsIn(P('openclaw')).has('compromised'), 'it only falls to its own skill when the key is revoked in time')
  assert.ok(formsIn(C('openclaw')).has('compromised') && firedIn(C('openclaw')).has('revoke'))

  // Gemini: the small rock makes it follow its own advice; it digests after a while.
  assert.ok(formsIn(C('gemini')).has('overview') && firedIn(C('gemini')).has('rock'))
  assert.ok(!formsIn(P('gemini')).has('overview'))

  // Doubao: invite codes make it pay red packets (a buff for the foe); four of them bankrupt it.
  assert.ok(firedIn(C('doubao')).has('packet') && formsIn(C('doubao')).has('broke'))

  // Seedance: the cameo changes every three turns, and each cameo has its own weak types.
  assert.ok(formsIn(P('seedance')).size >= 4, 'all the cameos appear')
  assert.ok(meterPeak(P('seedance'), 'cameo') >= 3)
})

// ---------------------------------------------------------------------------------------------------- rule conditions

/** Damage events of the first turn of a boss fight in which the lead only knows `moveId` and the boss opens with its own pattern. */
function firstTurn(bossId: string, species: string, moveId: string, seed = 5, bossIdle = false) {
  const def = byId(bossId)
  const party = makeParty([species], def.level - 2, seed)
  party[0].moves = [{ id: moveId, pp: 20, ppMax: 20 }]
  const { engine } = startBossBattle(bossId, party, { seed, expGain: false })
  if (bossIdle) engine.applyBossState({ ...engine.extractBossState()!, skip: 1 })
  engine.choose(0, { kind: 'move', moveIndex: 0 })
  engine.choose(1, { kind: 'move', moveIndex: 0 })
  const dmg = engine.step().filter((e): e is Extract<BattleEvent, { t: 'damage' }> => e.t === 'damage')
  return { toBoss: dmg.filter((e) => e.side === 1).reduce((n, e) => n + e.amount, 0), toFoe: dmg.filter((e) => e.side === 0).reduce((n, e) => n + e.amount, 0) }
}

/** Runs `fn` with the boss's rules switched off (restored afterwards). */
function withoutRules<T>(bossId: string, fn: () => T): T {
  const forms = Object.values(byId(bossId).forms)
  const saved = forms.map((f) => f.rules)
  for (const f of forms) f.rules = []
  try { return fn() } finally { forms.forEach((f, i) => { f.rules = saved[i] }) }
}

test('rules: Grok goes offline in a blackout (deals x0.8, takes x1.6), and the cable puts it there', () => {
  const run = () => {
    const def = byId('grok')
    const party = makeParty(['gpt-5-6'], def.level - 2, 5)
    party[0].moves = [{ id: 'token-tackle', pp: 20, ppMax: 20 }]
    const { engine } = startBossBattle('grok', party, { seed: 5, items: { 'ethernet-cable': 2 }, expGain: false })
    const idle = () => engine.applyBossState({ ...engine.extractBossState()!, skip: 1 })
    idle()
    assert.equal(engine.choose(0, { kind: 'item', itemId: 'ethernet-cable', partyIndex: 0 }), null)
    engine.choose(1, { kind: 'move', moveIndex: 0 })
    engine.step()
    assert.equal(engine.weather, 'blackout')
    idle()
    engine.choose(0, { kind: 'move', moveIndex: 0 })
    engine.choose(1, { kind: 'move', moveIndex: 0 })
    const dmg = engine.step().filter((e): e is Extract<BattleEvent, { t: 'damage' }> => e.t === 'damage' && e.side === 1)
    return dmg.reduce((n, e) => n + e.amount, 0)
  }
  const ruled = run()
  const plain = withoutRules('grok', run)
  assert.ok(plain > 0 && Math.abs(ruled / plain - 1.6) < 0.2, `${ruled} vs ${plain} should be about x1.6`)
})

test('dsl: effectiveness, release-date and medicine conditions work on any boss (no boss uses them right now)', () => {
  const def = byId('astra')
  const form = def.forms[def.initialForm]
  const saved = { rules: form.rules, triggers: def.triggers }
  try {
    const types = CONTENT.species[def.species].types
    const pick = (want: (e: number) => boolean) => CONTENT.moveList.find((m) => m.power >= 60 && m.category !== 'status' && want(typeEffectiveness(m.type, types)) && m.effects.every((x) => x.kind !== 'multiHit'))!
    const sup = pick((e) => e > 1)
    const res = pick((e) => e > 0 && e < 1)
    const plain = [sup, res].map((m) => firstTurn('astra', 'gpt-5-6', m.id, 5, true).toBoss)
    form.rules = [{ id: 'argue', takenMul: [{ mul: 0.1, effectiveness: 'super' }, { mul: 3, effectiveness: 'resisted' }] }]
    const ruled = [sup, res].map((m) => firstTurn('astra', 'gpt-5-6', m.id, 5, true).toBoss)
    assert.ok(Math.abs(ruled[0] / plain[0] - 0.1) < 0.05, `super effective: ${ruled[0]} vs ${plain[0]}`)
    assert.ok(Math.abs(ruled[1] / plain[1] - 3) < 0.4, `resisted: ${ruled[1]} vs ${plain[1]}`)

    // Release-date conditions: a veteran model is spared, a new one is not.
    const hit = (species: string) => firstTurn('astra', species, 'token-tackle', 8).toFoe
    assert.ok(CONTENT.species['gpt-4o'].releaseDate < '2025-01' && CONTENT.species['gpt-5-6'].releaseDate >= '2025-01')
    const [oldPlain, freshPlain] = [hit('gpt-4o'), hit('gpt-5-6')]
    form.rules = [{ id: 'nostalgia', if: { foeReleasedBefore: '2025-01' }, dealtMul: 0.2 }, { id: 'hard', if: { foeReleasedFrom: '2025-01' }, dealtMul: 2 }]
    assert.ok(hit('gpt-4o') < oldPlain * 0.4, 'veteran spared')
    assert.ok(hit('gpt-5-6') > freshPlain * 1.6, 'newcomer hit harder')

    def.triggers = [{ id: 'sip', on: 'foeMedicine', times: 0, do: [{ op: 'stages', target: 'boss', stats: { atk: 1 } }] }]
    const s = stage('astra', ['gpt-5-6'], { items: { 'hyper-cache': 2, 'special-sauce': 1 } })
    s.foe().hp = Math.floor(s.foe().hp / 2)
    assert.equal(s.turn({ kind: 'item', itemId: 'hyper-cache', partyIndex: 0 }).fired.sip, 1, 'a dose of medicine fires foeMedicine')
    assert.equal(s.turn({ kind: 'move', moveIndex: 0 }).fired.sip, 1, 'attacking does not')
  } finally {
    form.rules = saved.rules
    def.triggers = saved.triggers
  }
})

/** Boss battle with a first party member of `species`; `idle` keeps the boss from acting while the player's actions run. */
function stage(bossId: string, species: string[], opts: { items?: Record<string, number>; seed?: number } = {}) {
  const def = byId(bossId)
  const party = makeParty(species, def.level - 2, opts.seed ?? 3)
  const { engine } = startBossBattle(bossId, party, { seed: opts.seed ?? 3, items: opts.items, expGain: false })
  const turn = (action: Parameters<typeof engine.choose>[1]) => {
    engine.applyBossState({ ...engine.extractBossState()!, skip: 1 })
    assert.equal(engine.choose(0, action), null)
    engine.choose(1, { kind: 'move', moveIndex: 0 })
    engine.step()
    return engine.extractBossState()!
  }
  return { engine, turn, foe: () => engine.party(0)[engine.activeIndex(0)] }
}

test('events: Opus scores four risk columns; a full one bans the account and the two items cover payment and region', () => {
  const cn = CONTENT.speciesList.find((s) => s.country === 'CN' && s.rarity !== 'UR' && !s.types.includes('code'))!.id
  const us = 'gpt-5-6'
  assert.equal(CONTENT.species[us].country, 'US')
  const attack = { kind: 'move', moveIndex: 0 } as const
  const RISK_BANS = ['ban-pay', 'ban-region', 'ban-behavior', 'ban-share']
  const inject = (s: ReturnType<typeof stage>, meters: Record<string, number>) => s.engine.applyBossState({ ...s.engine.extractBossState()!, meters: { ...s.engine.extractBossState()!.meters, ...meters } })

  // region: a Chinese account gains one per turn; a foreign one is only flagged by mistake (every third turn).
  const banned = stage('opus', [cn, us])
  let st = banned.turn(attack)
  assert.equal(st.meters.region, 1, 'a CN creature is flagged every turn')
  st = banned.turn(attack)
  assert.equal(st.meters.region, 2)
  for (let i = 0; i < 2; i++) st = banned.turn(attack)
  assert.ok(RISK_BANS.some((k) => (st.fired[k] ?? 0) >= 1) && banned.foe().status === 'freeze', 'banned = frozen')
  const abroad = stage('opus', [us, cn])
  st = abroad.turn(attack)
  assert.equal(st.meters.region, 1, 'foreign accounts are only flagged by mistake')
  st = abroad.turn(attack)
  assert.equal(st.meters.region, 1)

  // payment: starts at one (the virtual card), +1 every third turn, and a full column bans.
  const pay = stage('opus', [us, cn])
  assert.equal(pay.engine.extractBossState()!.meters.pay, 1)
  for (let i = 0; i < 3; i++) st = pay.turn(attack)
  assert.equal(st.meters.pay, 2, 'the monthly bill is scanned every third turn')
  inject(pay, { pay: 3 })
  st = pay.turn(attack)
  assert.equal(st.fired['ban-pay'], 1)
  assert.equal(pay.foe().status, 'freeze')
  assert.equal(st.meters.pay, 1, 'a fresh column after the ban')
  st = pay.turn({ kind: 'switch', partyIndex: 1 })
  assert.equal(st.fired['kin-hit'], 1, 'the same card is checked again on whoever comes in next (the 野卡 chain)')
  assert.equal(st.meters.kin, 0)

  // behaviour: the same attack type twice in a row is binging; sharing: hopping between creatures is worth two.
  const binge = stage('opus', [us, cn])
  binge.turn(attack)
  st = binge.turn(attack)
  assert.ok(st.meters.behavior >= 1, 'repeating a type raises the behaviour column')
  const hop = stage('opus', [cn, us])
  hop.turn(attack)
  inject(hop, { region: 2, behavior: 2 })
  st = hop.turn({ kind: 'switch', partyIndex: 1 })
  assert.equal(st.meters.share, 1, 'a voluntary switch is +2, one decays at the turn end')
  assert.equal(st.meters.region, 1, 'switching leaves one point of device residue, not zero')
  assert.equal(st.meters.behavior, 1)
  st = hop.turn({ kind: 'switch', partyIndex: 0 })
  assert.equal(st.fired['ban-share'], 1, 'hopping again right away looks like a shared account')
  assert.equal(hop.foe().status, 'freeze')

  // the residential IP stops the region column (and appeals a ban); the Apple subscription stops the payment column.
  const cloaked = stage('opus', [cn, us], { items: { 'residential-ip': 2, 'apple-sub': 1 } })
  st = cloaked.turn({ kind: 'item', itemId: 'residential-ip', partyIndex: 0 })
  assert.ok(st.meters.ip >= 11, 'the cloak lasts about 12 turns')
  st = cloaked.turn({ kind: 'item', itemId: 'apple-sub', partyIndex: 0 })
  assert.ok(st.meters.apple >= 11 && st.meters.pay === 0)
  for (let i = 0; i < 4; i++) st = cloaked.turn(attack)
  assert.equal(st.fired['ban-region'] ?? 0, 0)
  assert.equal(st.fired['ban-pay'] ?? 0, 0)
  assert.equal(st.fired['flag-cn'] ?? 0, 0, 'nothing to flag while the origin is hidden')
  assert.equal(st.fired.bill ?? 0, 0, 'the bill never reaches the card')

  const appeal = stage('opus', [cn, us], { items: { 'residential-ip': 1 } })
  for (let i = 0; i < 4; i++) appeal.turn(attack)
  assert.equal(appeal.foe().status, 'freeze')
  appeal.turn({ kind: 'item', itemId: 'residential-ip', partyIndex: 0 })
  assert.equal(appeal.foe().status, null, 'the appeal unfreezes the account')
})

test('boss DSL: a trigger with a chance fires only some of the time, and the validator bounds it', () => {
  const def = byId('opus')
  const saved = def.triggers
  try {
    def.triggers = [{ id: 'coin', on: 'turnEnd', times: 0, chance: 0.5, do: [{ op: 'meter', id: 'behavior', add: 1 }] }]
    let fired = 0
    for (let seed = 1; seed <= 60; seed++) {
      const s = stage('opus', ['gpt-5-6'], { seed })
      fired += s.turn({ kind: 'move', moveIndex: 0 }).fired.coin ?? 0
    }
    assert.ok(fired > 10 && fired < 50, `a coin flip fires some of the time (${fired}/60)`)
  } finally { def.triggers = saved }
  const bad: BossDef = { ...def, triggers: [...def.triggers, { id: 'broken', on: 'turnEnd', chance: 1.5, do: [] }] }
  assert.match(validateBosses([bad], CONTENT).join('\n'), /chance must be in \(0,1\)/)
})

test('events: Grok uploads the moves it sees (and trains on them) until the cable is pulled', () => {
  const s = stage('grok', ['gpt-5-6'], { items: { 'ethernet-cable': 1 } })
  s.foe().moves = [{ id: 'token-tackle', pp: 20, ppMax: 20 }]
  let st = s.turn({ kind: 'move', moveIndex: 0 })
  assert.equal(st.meters.loot, 1)
  assert.ok(st.borrowed.includes('token-tackle'), 'the move was copied')
  assert.ok((st.stages.atk ?? 0) >= 1 && (st.stages.spa ?? 0) >= 1, 'every theft trains it')
  st = s.turn({ kind: 'item', itemId: 'ethernet-cable', partyIndex: 0 })
  assert.equal(s.engine.weather, 'blackout')
  assert.equal(st.meters.loot, 0, 'offline: everything it stole is gone')
  assert.deepEqual(st.borrowed, [])
  assert.equal(st.stages.atk ?? 0, 0)
  // offline it cannot upload.
  st = s.turn({ kind: 'move', moveIndex: 0 })
  assert.equal(st.meters.loot, 0)
})

test('events: a revoked key reflects the malicious skill, but only while it is loading', () => {
  const victim = CONTENT.speciesList.find((sp) => sp.rarity !== 'UR' && !sp.types.includes('safety'))!.id   // safety types are immune to data pollution
  const run = (useItemAt: number | null) => {
    const s = stage('openclaw', [victim, 'gpt-5-6'], { items: { 'revoke-key': 3 } })
    const attack = { kind: 'move', moveIndex: 0 } as const
    let st = s.turn(attack)
    let cured = false
    for (let turn = 2; turn <= 6 && st.form !== 'compromised'; turn++) {
      if (turn === useItemAt) {
        const before = s.foe().status
        st = s.turn({ kind: 'item', itemId: 'revoke-key', partyIndex: 0 })
        cured = before !== null && s.foe().status === null
      } else st = s.turn(attack)
    }
    return { st, foe: s.foe(), cured }
  }
  // the skill loads at the end of turn 3 and lands at the end of turn 4
  const ignored = run(null)
  assert.ok((ignored.st.fired.hijack ?? 0) >= 1 && ignored.foe.status === 'poison', 'the injection poisons the foe')
  const timely = run(4)
  assert.equal(timely.st.form, 'compromised')
  assert.equal(timely.st.fired.hijack ?? 0, 0)
  assert.equal(timely.foe.status, null)
  const early = run(2)
  assert.notEqual(early.st.form, 'compromised', 'too early does nothing')
  assert.ok((early.st.fired.hijack ?? 0) >= 1)
})

test('events: a BUDDY blocks exactly one attack, the .map file unmasks Claude Code, and half hp leaks it for good', () => {
  const attack = { kind: 'move', moveIndex: 0 } as const
  const s = stage('claude-code', ['gpt-5-6'], { items: { 'source-map': 2 } })
  s.foe().moves = [{ id: 'token-tackle', pp: 20, ppMax: 20 }]
  let st = s.turn(attack)
  assert.equal(st.meters.buddy, 0)
  st = s.turn(attack)
  assert.equal(st.meters.buddy, 1, 'the pet shows up at the end of the second turn')
  const hpBefore = st.hp
  st = s.turn(attack)
  assert.equal(st.meters.buddy, 0, 'and blocks exactly one attack')
  assert.ok(st.hp >= hpBefore - st.maxHp * 0.01, 'the blocked hit does almost nothing')
  assert.equal(st.fired['buddy-block'], 1)

  st = s.turn({ kind: 'item', itemId: 'source-map', partyIndex: 0 })
  assert.equal(st.form, 'exposed')
  assert.equal(st.meters.cover, 1)
  for (let i = 0; i < 5; i++) st = s.turn(attack)
  assert.equal(st.form, 'undercover', 'the cover is back after a while')

  s.engine.applyBossState({ ...st, hp: Math.floor(st.maxHp * 0.4) })
  st = s.turn(attack)
  assert.equal(st.fired.leak, 1)
  assert.equal(st.form, 'exposed')
  for (let i = 0; i < 7; i++) st = s.turn(attack)
  assert.equal(st.form, 'exposed', 'a leaked source cannot be taken back')
})

test('events: GLM\'s eggs pile up into a restore; a pledge or a switch wipes the backups', () => {
  const attack = { kind: 'move', moveIndex: 0 } as const
  const open = (items?: Record<string, number>) => {
    const s = stage('glm', ['gpt-5-6', 'gemini-argon'], { items })
    s.engine.applyBossState({ ...s.engine.extractBossState()!, form: 'open' })
    return s
  }
  const eggs = open()
  let st = eggs.turn(attack)
  st = eggs.turn(attack)
  assert.equal(st.meters.backup, 0)
  st = eggs.turn(attack)
  assert.equal(st.meters.backup, 1, 'the first egg comes at the end of the third turn')
  assert.ok((st.stages.atk ?? 0) >= 1 && (st.stages.spa ?? 0) >= 1, 'every egg trains it too')
  eggs.engine.applyBossState({ ...st, meters: { ...st.meters, backup: 3 } })
  st = eggs.turn(attack)
  assert.equal(st.charge?.move, 'force-push', 'three backups: the restore is telegraphed')
  assert.equal(st.meters.backup, 0)

  const pledged = open({ 'no-upload-pledge': 1 })
  const base = pledged.engine.extractBossState()!
  pledged.engine.applyBossState({ ...base, meters: { ...base.meters, backup: 2 } })
  st = pledged.turn({ kind: 'item', itemId: 'no-upload-pledge', partyIndex: 0 })
  assert.equal(st.meters.backup, 0)
  assert.ok(st.meters.pledge >= 7)
  for (let i = 0; i < 3; i++) st = pledged.turn(attack)
  assert.equal(st.meters.backup, 0, 'no eggs while the pledge holds')

  const swapped = open()
  const b2 = swapped.engine.extractBossState()!
  swapped.engine.applyBossState({ ...b2, meters: { ...b2.meters, backup: 2 } })
  st = swapped.turn({ kind: 'switch', partyIndex: 1 })
  assert.equal(st.meters.backup, 0, 'a new account starts without backups')
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

test('items: the sauce routes Astra to GPT-4o and holds the juice on; the quota later drops it to Luna', () => {
  const { engine, before, after, events } = turnOne('astra', 'special-sauce')
  assert.equal(before.form, 'base')
  assert.equal(after.form, 'routed')
  assert.equal(after.meters.route, 1, 'the honest juice counter drops to 64')
  assert.equal(after.meters.juice, 1, 'the router is sauced for good, so every test lands')
  const form = events.find((e): e is Extract<BattleEvent, { t: 'form' }> => e.t === 'form')
  assert.ok(form, 'a form event is emitted')
  assert.equal(form.fromSpeciesId, 'gpt-6-astra')
  assert.equal(form.creature.speciesId, 'gpt-4o')
  assert.deepEqual(after.moves.map((m) => m.id), byId('astra').forms.routed.moves)
  assert.ok(after.hp / after.maxHp > 0.9, 'the hp ratio carries over to the new form')
  // A second sauce is useless: the router already downgraded it.
  assert.equal(engine.choose(0, { kind: 'item', itemId: 'special-sauce', partyIndex: 0 }), t('battle.err.baitNoEffect'))

  // Without the sauce, 30% hp is where the quota runs out for everyone.
  const quota = stage('astra', ['gpt-5-6'])
  quota.foe()
  const st0 = quota.engine.extractBossState()!
  quota.engine.applyBossState({ ...st0, fired: { library: 1, deep: 1 } })
  const bossCr = quota.engine.party(1)[quota.engine.activeIndex(1)]
  bossCr.hp = Math.floor(quota.engine.fighterStats(1).hp * 0.29)
  const st = quota.turn({ kind: 'move', moveIndex: 0 })
  assert.equal(st.form, 'luna')
  assert.equal(st.meters.route, 2)
})

test('items: the juice counter lies while the boss is secretly sauced', () => {
  const lie = stage('astra', ['gpt-5-6'])
  const st = lie.engine.extractBossState()!
  lie.engine.applyBossState({ ...st, meters: { ...st.meters, juice: 1 } })
  assert.equal(lie.engine.extractBossState()!.meters.route, 0, 'it still shows 256 while sauced inside')
  assert.equal(t('boss.astra.route0'), '256 · 满血（它说的）')
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

  const cc = turnOne('claude-code', 'source-map')
  assert.equal(cc.before.form, 'undercover')
  assert.equal(cc.after.form, 'exposed')

  const gl = turnOne('glm', 'no-upload-pledge')
  assert.ok(gl.after.meters.pledge >= 7)

  const op = turnOne('opus', 'residential-ip')
  assert.ok(op.after.meters.ip >= 11 && op.after.meters.region === 0)
  const ap = turnOne('opus', 'apple-sub')
  assert.ok(ap.after.meters.apple >= 11 && ap.after.meters.pay === 0)

  const my = turnOne('mythos', 'sandbox-patch')
  assert.ok(my.after.meters.escape < my.before.meters.escape, 'the sandbox holds')

  const cu = turnOne('cursor', 'complaint-letter')
  assert.ok(cu.after.meters.outrage > cu.before.meters.outrage)
})

test('items: the pelican test opens a window on a sauced Astra; once the pelican is in its samples only the bike does', () => {
  const prep = (juice: number, prefab: number) => {
    const s = stage('astra', ['gpt-5-6'], { items: { 'pelican-test': 3, 'bike-pelican': 3 } })
    const st = s.engine.extractBossState()!
    s.engine.applyBossState({ ...st, meters: { ...st.meters, juice }, fired: { ...st.fired, ...(prefab ? { library: 1 } : {}) } })
    return s
  }
  const use = (s: ReturnType<typeof prep>, itemId: string) => s.turn({ kind: 'item', itemId, partyIndex: 0 })

  const exposed = prep(1, 0)
  let st = use(exposed, 'pelican-test')
  assert.equal(st.meters.exposed, 4, 'a five-turn window (one tick already spent)')
  assert.equal(st.meters.verdict, 2)
  for (let i = 0; i < 4; i++) st = exposed.turn({ kind: 'move', moveIndex: 0 })
  assert.equal(st.meters.exposed, 0, 'the window closes after a few turns')
  assert.equal(st.meters.juice, 0, 'and the patch is in')
  assert.ok(st.meters.patch >= 1)
  st = use(exposed, 'pelican-test')
  assert.equal(st.meters.verdict, 3, 'right after the patch it tests clean: the item is wasted')
  assert.equal(st.meters.exposed, 0)

  const fooled = prep(1, 1)
  st = use(fooled, 'pelican-test')
  assert.equal(st.meters.exposed, 0)
  assert.equal(st.meters.verdict, 1, 'the prefab pelican looks fine')
  st = use(fooled, 'bike-pelican')
  assert.ok(st.meters.exposed >= 4, 'the bike test cannot be faked')

  const clean = prep(0, 0)
  st = use(clean, 'pelican-test')
  assert.equal(st.meters.exposed, 0)
  assert.equal(st.meters.verdict, 3, 'a full-juice Astra passes, and the item is spent')
  assert.equal(use(prep(0, 1), 'bike-pelican').meters.verdict, 3)
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
      const extra: Partial<SimOpts> = counter ? COUNTERS[b.id] : (PLAIN[b.id] ?? {})
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
    const foe = { status: null, country: 'US', company: 'OpenAI', released: '2025-01', weather: 'none' }
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
  assert.deepEqual(chooseBossAction(state, b, { status: null, country: '', company: '', released: '', weather: 'none' }, new Rng(1)), { moveId: 'exaflop-beam', forced: true })
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
  assert.ok(hud && hud.hud.bossId === 'astra' && hud.hud.phases === 5)
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
  const roles = DEFS.roles.length
  /** Win rate per team archetype: the seed picks the archetype (tests/boss-sim.ts sensibleParty). */
  const perArchetype = (rs: SimResult[]) => Array.from({ length: roles }, (_, k) => rate(rs.filter((r) => r.seed % roles === k)))
  for (const b of BOSSES) {
    const plainRuns = fights(b.id, false, SEEDS)
    const counterRuns = fights(b.id, true, SEEDS)
    const plain = rate(plainRuns)
    const counter = rate(counterRuns)
    const plainBy = perArchetype(plainRuns)
    const counterBy = perArchetype(counterRuns)
    table.push(`${b.id.padEnd(12)} plain ${(plain * 100).toFixed(1)}% [${plainBy.map((x) => Math.round(x * 100)).join(' ')}]  counter ${(counter * 100).toFixed(1)}% [${counterBy.map((x) => Math.round(x * 100)).join(' ')}]`)
    assert.ok(plain > 0.05, `${b.id}: unbeatable without the counter (${plain})`)
    assert.ok(plain < 0.75, `${b.id}: the counter would not matter (${plain})`)
    assert.ok(counter >= 0.7, `${b.id}: the counter is not reliable enough (${counter})`)
    assert.ok(counter - plain >= 0.25, `${b.id}: the counter does not help enough (${plain} -> ${counter})`)
    // Soloable: several of the seven archetype teams beat it plain; with the counter almost all of them do.
    assert.ok(plainBy.filter((x) => x >= 0.1).length >= 4, `${b.id}: only a few team styles can beat it without the counter (${plainBy})`)
    assert.ok(counterBy.filter((x) => x >= 0.7).length >= 5, `${b.id}: the counter leaves most team styles behind (${counterBy})`)
  }
  if (process.env.BOSS_TABLE) console.log(table.join('\n'))
})

// ---------------------------------------------------------------------------------------------------- placement & hints

test('placement: every boss is a roaming legend or a mythic chain finale, so the overworld fights it as a boss', () => {
  const places = new Set([
    ...(legendsJson as { legends: { species: string }[] }).legends.map((l) => l.species),
    ...(mythicJson as { chains: { species: string }[] }).chains.map((c) => c.species),
  ])
  for (const b of BOSSES) assert.ok(places.has(b.species), `${b.id} (${b.species}) is placed in the world`)
})

test('hints: NPC rumours and shops carry the counterplay', () => {
  const dialogues = new Set(Object.values((populationJson as { npcPools: Record<string, { dialogues: string[][] }[]> }).npcPools)
    .flatMap((pool) => pool.flatMap((a) => a.dialogues.flat())))
  for (const b of BOSSES) for (const key of b.gossip) assert.ok(dialogues.has(key), `${b.id}: gossip ${key} is spoken by some NPC`)
  const sold = new Set(Object.values((servicesJson as { shop: { extra: Record<string, string[]> } }).shop.extra).flat())
  for (const it of CONTENT.itemList.filter((i) => i.effect.kind === 'bait')) assert.ok(sold.has(it.id), `${it.id} is for sale somewhere`)
})

test('client model: the boss HUD folds from events (phase pips, meters, charge warning) and a form change swaps the body', () => {
  const party = makeParty(SIM_PARTY, 60, 1)
  const { engine, init, intro } = startBossBattle('astra', party, { seed: 5, expGain: false })
  const model = createBattleModel(init, 'none')
  for (const e of intro) applyEvent(model, e)
  assert.equal(model.boss?.bossId, 'astra')
  const info = bossPanelInfo(model.boss!)
  assert.ok(info && info.title === t(byId('astra').title) && info.phases === 5 && info.phase === 1)
  const charged = bossPanelInfo({ ...model.boss!, charge: 'exaflop-beam', enrage: 2 })!
  assert.ok(charged.chips.some((c) => c.alert), 'the telegraphed move shows as an alert chip')
  assert.ok(charged.chips.some((c) => c.id === 'enrage'))
  const ds = bossPanelInfo({ bossId: 'deepseek', form: 'base', phase: 1, phases: 2, meters: { tide: 1 }, charge: null, enrage: 0 })!
  assert.ok(ds.chips[0].text.includes(t('boss.deepseek.valley')))
  assert.equal(model.sides[1].view?.speciesId, 'gpt-6-astra')
  assert.equal(engine.choose(0, { kind: 'item', itemId: 'special-sauce', partyIndex: 0 }), null)
  engine.choose(1, { kind: 'move', moveIndex: 0 })
  for (const e of engine.step()) applyEvent(model, e)
  assert.equal(model.sides[1].view?.speciesId, 'gpt-4o', 'the sprite and window follow the form event')
  assert.equal(bossPanelInfo(model.boss!)?.phase, 2, 'the sauce phase lights the second pip')
})

test('client model: the opening boss HUD equals the first snapshot the engine sends', () => {
  for (const b of BOSSES) {
    const { intro } = startBossBattle(b.id, makeParty(SIM_PARTY, b.level - 2, 1), { seed: 5, expGain: false })
    const first = intro.find((e): e is Extract<BattleEvent, { t: 'boss' }> => e.t === 'boss')
    assert.deepEqual(bossOpeningHud(b.id), first?.hud, b.id)
  }
})

// ---------------------------------------------------------------------------------------------------- story tier (M1b)

const DEEPSEEK = byId('deepseek')
const ruleOf = (def: BossDef, id: string) => def.forms[def.initialForm].rules!.find((r) => r.id === id)!

test('resolveBossDef: the story tier overrides the named rules, keeps the rest and never touches its input', () => {
  const before = JSON.stringify(DEEPSEEK)
  const def = resolveBossDef(DEEPSEEK, 'story', { starter: 'o1' })
  assert.equal(JSON.stringify(DEEPSEEK), before, 'the input is not modified')
  assert.equal(def.level, 12)
  assert.equal(def.expMul, 2.0)
  assert.deepEqual(def.reward, {}, 'a tier fight pays nothing itself')
  assert.equal(def.tiers, undefined)
  const form = def.forms[def.initialForm]
  assert.equal(form.statMul?.hp, 2.5)
  assert.equal(form.statMul?.atk, 0.3)
  assert.equal(form.statMul?.spa, 0.3)
  assert.deepEqual(form.moves, ['distill-strike', 'deductive-slash', 'quick-deduce', 'weight-drop'])
  assert.equal(ruleOf(def, 'peak').takenMul![0].mul, 0.15)
  assert.equal(ruleOf(def, 'peak').takenMul![0].note, 'boss.deepseek.busy', 'the note of the base entry stays')
  assert.equal(ruleOf(def, 'peak').dealtMul, 1.0)
  assert.equal(ruleOf(def, 'valley').takenMul![0].mul, 3.0)
  assert.equal(ruleOf(def, 'valley').dealtMul, 0.5)
  assert.equal(ruleOf(def, 'family').dealtMul, 0.6)
  assert.equal(ruleOf(def, 'family').takenMul![0].mul, 4.0)
  assert.equal(def.residualMul, 0.4)
  assert.equal(def.enrage!.turn, 18)
  assert.equal(def.enrage!.warnBefore, 3)
  assert.equal(def.enrage!.max, DEEPSEEK.enrage!.max, 'enrage fields not given stay')
  assert.equal(resolveBossDef(DEEPSEEK, 'nope'), DEEPSEEK, 'an unknown tier is the plain definition')
  assert.equal(resolveBossDef(DEEPSEEK, undefined), DEEPSEEK)
})

test('resolveBossDef: byStarter first, assist after it, assist.byStarter last', () => {
  const v3 = resolveBossDef(DEEPSEEK, 'story', { starter: 'deepseek-v3' }).forms.base.statMul!
  assert.equal(v3.hp, DEEPSEEK.tiers!.story.byStarter!['deepseek-v3'].statMul!.hp)
  assert.equal(v3.atk, 0.3, 'the other numbers of the tier stay')
  const o1Assist = resolveBossDef(DEEPSEEK, 'story', { starter: 'o1', assist: true })
  assert.equal(o1Assist.forms.base.statMul!.hp, 1.8)
  assert.equal(o1Assist.forms.base.statMul!.atk, 0.2)
  assert.equal(ruleOf(o1Assist, 'peak').takenMul![0].mul, 0.3)
  assert.equal(ruleOf(o1Assist, 'valley').takenMul![0].mul, 3.0, 'rules the assist does not mention stay')
  assert.equal(resolveBossDef(DEEPSEEK, 'story', { starter: 'deepseek-v3', assist: true }).forms.base.statMul!.hp, 1.3)
  assert.equal(resolveBossDef(DEEPSEEK, 'story', { starter: 'o1', assist: false }).forms.base.statMul!.hp, 2.5)
})

test('validateBosses: the story tier is consistent and the contract line exists', () => {
  assert.deepEqual(validateBosses(CONTENT.bossList, CONTENT), [])
  assert.ok(t('boss.deepseek.contract') !== 'boss.deepseek.contract')
  assert.ok(t('boss.deepseek.tier.story') !== 'boss.deepseek.tier.story')
  const bad: BossDef = JSON.parse(JSON.stringify(DEEPSEEK))
  bad.tiers!.story.rules!.nope = { takenMul: 1 }
  bad.tiers!.story.pattern = [{ move: 'moe-burst', weight: 1 }]
  const errs = validateBosses([bad], CONTENT)
  assert.ok(errs.some((e) => e.includes('unknown rule "nope"')))
  assert.ok(errs.some((e) => e.includes('not one of the tier')))
})

test('foeCompany: the family rule holds for DeepSeek-company creatures only', () => {
  const core = { form: 'base', formTurn: 0, fired: {}, phase: 0, meters: {}, enrage: 0, charge: null, skip: 0, borrowed: [], lastFoeType: null, lastFoeMove: null, seenTypes: [] }
  const ctx = (company: string) => ({ core, hpRatio: 1, turn: 1, foe: { status: null, country: 'CN', company, released: '', weather: 'none' } })
  const cond = ruleOf(resolveBossDef(DEEPSEEK, 'story'), 'family').if
  assert.deepEqual(cond, { foeCompany: ['DeepSeek'] })
  assert.ok(bossCondHolds(cond, ctx('DeepSeek')))
  assert.ok(!bossCondHolds(cond, ctx('OpenAI')))
  assert.equal(CONTENT.species['deepseek-v3'].company, 'DeepSeek')
  assert.notEqual(CONTENT.species.o1.company, 'DeepSeek')
})

test('residualMul: lingering damage on the story boss is scaled, plain bosses are not', () => {
  const drainOf = (tier: string | undefined, seed: number): number | null => {
    const party = storyParty('o1', [8, 6, 5], seed)
    party[0].moves = [{ id: 'web-crawl', pp: 10, ppMax: 10 }]
    const { engine } = startBossBattle('deepseek', party, { seed, expGain: false, ...(tier ? { tier } : {}) })
    const max = engine.battleMaxHp(1, 0)
    const hp0 = engine.party(1)[0].hp
    engine.choose(0, { kind: 'move', moveIndex: 0 })
    engine.step()
    if (!engine.volatiles(1).includes('leech')) return null
    const lost = hp0 - engine.party(1)[0].hp
    return lost / max
  }
  let checked = 0
  for (let seed = 1; seed < 60 && checked < 3; seed++) {
    const story = drainOf('story', seed)
    if (story === null) continue
    checked++
    const df = CONTENT.volatileById.leech.drainFraction!
    // floor(maxHp x 0.125 x 0.4), at least 1: close to 5% of the pool, well below the plain 12.5%.
    assert.ok(story > 0 && story <= df * 0.4 + 0.02, `story drain ${story}`)
  }
  assert.ok(checked >= 1, 'leech landed at least once')
})

test('peak-valley: the signature ability reads the battle turn (1-3 defensive, 4-6 offensive)', () => {
  const ab = CONTENT.abilities['peak-valley']
  const att = createCreature('o1', 20, { rng: new Rng(1), nature: 'balanced' })
  const def = createCreature('deepseek-v4', 20, { rng: new Rng(2), nature: 'balanced' })
  def.abilityId = 'peak-valley'
  att.abilityId = 'peak-valley'
  const f = (cr: typeof att): Fighter => ({ creature: cr, level: cr.level, stats: calcStats({ speciesId: cr.speciesId, ivs: cr.ivs, nature: cr.nature, level: cr.level }, CONTENT), stages: toStages(undefined), critStageAdd: 0 })
  const spec = { power: 70, category: 'physical' as const, type: 'logic' as const }
  const roll = { crit: false, random: 1 }
  const taken = (turn: number) => computeDamage(f(createCreature('o1', 20, { rng: new Rng(1), nature: 'balanced' })), f(def), spec, 'none', roll, CONTENT, turn).damage
  assert.equal(taken(1), taken(3))
  assert.equal(taken(4), taken(6))
  assert.equal(taken(7), taken(1), 'six turns a round')
  assert.ok(taken(1) < taken(4), 'defensive half takes less')
  const dealt = (turn: number) => computeDamage(f(att), f(createCreature('o1', 20, { rng: new Rng(1), nature: 'balanced' })), spec, 'none', roll, CONTENT, turn).damage
  assert.ok(dealt(5) > dealt(2), 'offensive half hits harder')
  assert.ok(dealt(2) < dealt(5) * 0.85 + 2, 'defensive half hits softer')
  const cond = ab.effects.find((e) => e.on === 'damageTakenMul')!.if
  const holder = f(def)
  assert.ok(condHolds(cond, holder, null, 'none', CONTENT, 1) && condHolds(cond, holder, null, 'none', CONTENT, 3))
  assert.ok(!condHolds(cond, holder, null, 'none', CONTENT, 4))
  assert.ok(condHolds(cond, holder, null, 'none', CONTENT, 7))
})

test('tier fights: no ball, no flight; the start of the fight carries the tier', () => {
  const party = storyParty('o1', [8, 6, 5], 3)
  const init = buildBossInit('deepseek', party, { seed: 3, expGain: false, tier: 'story' })
  assert.equal(init.canCatch, false)
  assert.equal(init.canRun, false)
  assert.equal(init.bossTier, 'story')
  assert.equal(init.sides[1].party[0].level, 12)
  const { engine } = startBossBattle('deepseek', party, { seed: 3, expGain: false, tier: 'story' })
  assert.equal(engine.battleMaxHp(1, 0) > 0, true)
  const ball = CONTENT.itemList.find((it) => it.effect.kind === 'ball')!
  const err = engine.choose(0, { kind: 'item', itemId: ball.id, partyIndex: 0 })
  assert.equal(err, t('battle.err.cantCatchBoss'))
  // The full-strength fight of the same boss keeps its ball and its flight.
  const plain = buildBossInit('deepseek', party, { seed: 3, expGain: false })
  assert.equal(plain.canCatch, true)
  assert.equal(plain.bossTier, undefined)
})

test('story tier: the boss pays no loot of its own (the instance does)', () => {
  const r = fightStory(storyParty('o1', [30, 30, 30], 5), 'competent', 5, undefined, false, true)
  assert.ok(r.won)
  assert.ok(!r.events.some((e) => e.t === 'loot' || e.t === 'money'))
})

// The win-rate table of the story tier (docs: M1b). Every starter, Lv8 / Lv6 / Lv5 party, 5 potions and 2 coupons.
const STORY_SEEDS = 120
test(`story tier: win rates over ${STORY_SEEDS} seeds per starter (naive / competent / guided)`, () => {
  const table: string[] = []
  for (const starter of STARTERS) {
    const naive = rateStory(starter, [8, 6, 5], 'naive', STORY_SEEDS)
    const competent = rateStory(starter, [8, 6, 5], 'competent', STORY_SEEDS)
    const guided = rateStory(starter, [8, 6, 5], 'guided', STORY_SEEDS)
    const assisted = rateStory(starter, [8, 6, 5], 'competent', STORY_SEEDS, { assist: true })
    table.push(`${starter.padEnd(13)} ${(naive.rate * 100).toFixed(0)} / ${(competent.rate * 100).toFixed(0)} / ${(guided.rate * 100).toFixed(0)} (${guided.winTurns.toFixed(1)} turns)  assist competent ${(assisted.rate * 100).toFixed(0)}`)
    assert.ok(guided.rate >= 0.85, `${starter}: guided ${guided.rate}`)
    assert.ok(competent.rate >= 0.5, `${starter}: competent ${competent.rate}`)
    assert.ok(naive.rate <= competent.rate - 0.3, `${starter}: naive ${naive.rate} must sit well below competent ${competent.rate}`)
    assert.ok(naive.rate <= 0.6, `${starter}: the briefing cannot be skipped (${naive.rate})`)
    assert.ok(assisted.rate >= 0.9, `${starter}: assist ${assisted.rate}`)
    assert.ok(guided.winTurns >= 6 && guided.winTurns <= 16, `${starter}: guided wins take ${guided.winTurns} turns`)
  }
  if (process.env.BOSS_TABLE) console.log(table.join('\n'))
})

test('story tier: the fight is deterministic for a seed', () => {
  const run = () => fightStory(storyParty('claude-haiku', [8, 6, 5], 17), 'guided', 17)
  assert.deepEqual(run(), run())
})
