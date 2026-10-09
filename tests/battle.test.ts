import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT, t, type Content } from '../src/shared/content/index.ts'
import type {
  AbilityDef, AbilityEffect, BattleAction, BattleEvent, BattleInit, BattleSideInit, Creature, GameConfig, ItemDef, MoveDef,
  MoveEffect, SideIndex, SpeciesDef, StatusDef, Stats, TypeDef, VolatileDef, WeatherDef,
} from '../src/shared/types.ts'
import { Rng } from '../src/shared/rng.ts'
import { calcStats, createCreature, maxHp } from '../src/shared/creature.ts'
import { BattleEngine, perspective } from '../src/shared/battle/engine.ts'
import { chooseAiAction } from '../src/shared/battle/ai.ts'
import { RULES } from '../src/shared/battle/rules.ts'

// =====================================================================================================
// Synthetic content: exercises every engine parameter without depending on the live roster.
// =====================================================================================================

const stats = (v: number, o: Partial<Stats> = {}): Stats => ({ hp: v, atk: v, def: v, spa: v, spd: v, spe: v, ...o })
const mv = (id: string, o: Partial<MoveDef> = {}, effects: MoveEffect[] = []): MoveDef => ({
  id, nameZh: `招式${id}`, nameEn: id, type: 'n', category: 'physical', power: 40, accuracy: 100, pp: 10, priority: 0, effects,
  description: '', anim: 'hit', ...o,
})
const status = (id: string, o: Partial<StatusDef>): StatusDef => ({ id, nameZh: `状态${id}`, short: id[0], color: '#fff', catchBonus: 1, ...o })
const volatile = (id: string, o: Partial<VolatileDef>): VolatileDef => ({ id, nameZh: `临时${id}`, ...o })
const ability = (id: string, ...effects: AbilityEffect[]): AbilityDef => ({ id, nameZh: `特性${id}`, description: '', effects })
const sp = (id: string, types: string[], o: Partial<SpeciesDef> = {}): SpeciesDef => ({
  id, dexNo: 1, nameZh: `精灵${id}`, nameEn: id, company: '', country: '', category: '', family: id, stage: 1, types,
  rarity: CONTENT.rarities[0].id, baseStats: stats(80), abilities: ['none'], learnset: [{ level: 1, move: 'tackle' }], teachable: [],
  catchRate: 45, baseExp: 60, growth: 'medium', habitats: [], dexEntry: '', releaseDate: '', personality: '', size: 1, ...o,
})
const item = (id: string, effect: ItemDef['effect']): ItemDef => ({
  id, nameZh: `道具${id}`, category: 'misc', price: 0, buyable: false, description: '', effect, usableInBattle: true, usableInField: false,
})

const TYPES: TypeDef[] = ['n', 'a', 'b', 'g'].map((id) => ({ id, nameZh: `${id}系`, color: '#fff' }))
const MOVES: MoveDef[] = [
  mv('tackle'),
  mv('tackle2x', { power: 80 }),
  mv('zap', { type: 'a', category: 'special', power: 60 }),
  mv('hydro', { type: 'b', category: 'special', power: 60 }),
  mv('ghostly', { type: 'g', power: 40 }),
  mv('growl', { category: 'status', power: 0 }, [{ kind: 'stat', stats: { atk: -1 }, chance: 100, target: 'enemy' }]),
  mv('swords', { category: 'status', power: 0 }, [{ kind: 'stat', stats: { atk: 2 }, chance: 100, target: 'self' }]),
  mv('harden', { category: 'status', power: 0, priority: 3 }, [{ kind: 'stat', stats: { def: 6, eva: 6 }, chance: 100, target: 'self' }]),
  mv('sleeper', { category: 'status', power: 0 }, [{ kind: 'status', status: 'sx-sleep', chance: 100, target: 'enemy' }]),
  mv('burner', { category: 'status', power: 0 }, [{ kind: 'status', status: 'sx-burn', chance: 100, target: 'enemy' }]),
  mv('stucker', { category: 'status', power: 0 }, [{ kind: 'status', status: 'sx-stuck', chance: 100, target: 'enemy' }]),
  mv('parer', { category: 'status', power: 0 }, [{ kind: 'status', status: 'sx-para', chance: 100, target: 'enemy' }]),
  mv('confuser', { category: 'status', power: 0 }, [{ kind: 'volatile', volatile: 'sx-confuse', chance: 100, target: 'enemy' }]),
  mv('flincher', { priority: 1 }, [{ kind: 'volatile', volatile: 'sx-flinch', chance: 100, target: 'enemy' }]),
  mv('shield', { category: 'status', power: 0, priority: 4 }, [{ kind: 'volatile', volatile: 'sx-protect', chance: 100, target: 'self' }]),
  mv('leecher', { category: 'status', power: 0 }, [{ kind: 'volatile', volatile: 'sx-leech', chance: 100, target: 'enemy' }]),
  mv('focuser', { category: 'status', power: 0, priority: 2 }, [{ kind: 'volatile', volatile: 'sx-focus', chance: 100, target: 'self' }]),
  mv('taunter', { category: 'status', power: 0, priority: 2 }, [{ kind: 'volatile', volatile: 'sx-taunt', chance: 100, target: 'enemy' }]),
  mv('stormer', { category: 'status', power: 0 }, [{ kind: 'weather', weather: 'sx-storm' }]),
  mv('multi', { power: 20 }, [{ kind: 'multiHit', min: 2, max: 5 }]),
  mv('sonic', { category: 'special', power: 0 }, [{ kind: 'fixedDamage', amount: 'level' }]),
  mv('fixed20', { category: 'special', power: 0 }, [{ kind: 'fixedDamage', amount: 20 }]),
  mv('recoiler', { power: 90 }, [{ kind: 'recoil', fraction: 0.25 }]),
  mv('drainer', { category: 'special', power: 60 }, [{ kind: 'drain', fraction: 0.5 }]),
  mv('healer', { category: 'status', power: 0 }, [{ kind: 'heal', fraction: 0.5 }]),
  mv('cleanser', { category: 'status', power: 0 }, [{ kind: 'cureStatus', target: 'self' }]),
  mv('slasher', { power: 50 }, [{ kind: 'highCrit' }]),
  mv('sureshot', { accuracy: 30 }, [{ kind: 'alwaysHit' }]),
  mv('wild50', { accuracy: 50 }),
  mv('hyper', { category: 'special', power: 120 }, [{ kind: 'recharge' }]),
  mv('boom', { power: 250 }, [{ kind: 'selfFaint' }]),
]
const STATUSES: StatusDef[] = [
  status('sx-burn', { dotFraction: 0.0625, physicalMul: 0.5, catchBonus: 1.5 }),
  status('sx-sleep', { skipChance: 1, durationMin: 2, durationMax: 2, catchBonus: 3 }),
  status('sx-para', { speedMul: 0.01, catchBonus: 1.5 }),
  status('sx-stuck', { skipChance: 1, cureChancePerTurn: 1, catchBonus: 2 }),
]
const VOLATILES: VolatileDef[] = [
  volatile('sx-confuse', { durationMin: 2, durationMax: 2, selfHitChance: 1 }),
  volatile('sx-flinch', { flinch: true }),
  volatile('sx-protect', { protects: true }),
  volatile('sx-leech', { drainFraction: 0.125 }),
  volatile('sx-focus', { critStageAdd: 3 }),
  volatile('sx-taunt', { blocksStatusMoves: true, durationMin: 2, durationMax: 2 }),
]
const WEATHERS: WeatherDef[] = [{
  id: 'sx-storm', nameZh: '测试风暴', color: '#000', powerMul: { b: 1.5, a: 0.5 }, chip: { fraction: 0.0625, exemptTypes: ['b'] },
  heal: { fraction: 0.0625, types: ['b'] }, startText: '{weather}开始了', continueText: '{weather}持续中', endText: '{weather}结束了',
}]
const ABILITIES: AbilityDef[] = [
  ability('none'),
  ability('pinch', { on: 'powerMul', mul: 2, if: { hpBelow: 0.5, moveTypes: ['n'] } }),
  ability('scale', { on: 'damageTakenMul', mul: 0.5, if: { hpFull: true } }),
  ability('swift', { on: 'statMul', stat: 'spe', mul: 100 }),
  ability('stab3', { on: 'stab', value: 3 }),
  ability('keen', { on: 'critStage', add: 1 }),
  ability('sniper', { on: 'critMul', value: 3 }),
  ability('scope', { on: 'accuracyMul', mul: 2, ignoreEvasion: true }),
  ability('prankster', { on: 'priority', add: 5, if: { moveCategory: 'status' } }),
  ability('intim', { on: 'switchIn', target: 'enemy', stats: { atk: -1 } }),
  ability('download', { on: 'switchIn', target: 'self', highestOf: ['atk', 'spa'], stages: 2 }),
  ability('regen', { on: 'switchOut', healFraction: 0.5 }),
  ability('booster', { on: 'turnEnd', stats: { spe: 1 } }),
  ability('leftovers', { on: 'turnEnd', healFraction: 0.25 }),
  ability('shedder', { on: 'turnEnd', cureStatusChance: 1 }),
  ability('vital', { on: 'immune', statuses: ['sx-sleep'], volatiles: ['sx-confuse'] }),
  ability('weakarmor', { on: 'afterHitBy', if: { superEffective: true }, stats: { def: 1 } }),
  ability('poisontouch', { on: 'dealDamage', status: { id: 'sx-burn', chance: 100 }, volatile: { id: 'sx-confuse', chance: 100 } }),
  ability('vampire', { on: 'dealDamage', drainFraction: 0.5 }),
  ability('lifeorb', { on: 'dealDamage', selfDamageFraction: 0.1 }),
  ability('moxie', { on: 'knockOut', stats: { atk: 1 } }),
  ability('absorber', { on: 'absorbType', types: ['a'], healFraction: 0.25 }),
  ability('runaway', { on: 'alwaysEscape' }),
  ability('stall', { on: 'moveLast' }),
  ability('unaware', { on: 'ignoreFoeBoosts' }),
  ability('breaker', { on: 'ignoreProtect' }),
  ability('mirror', { on: 'blockFoeStatusMoves', chance: 100 }),
  ability('clearbody', { on: 'noStatDrops' }),
]
const SPECIES: SpeciesDef[] = [
  sp('sn', ['n']),
  sp('sa', ['a'], { evolvesTo: { id: 'sa2', level: 16 }, learnset: [{ level: 1, move: 'tackle' }, { level: 16, move: 'zap' }] }),
  sp('sa2', ['a'], { dexNo: 2, evolvesFrom: 'sa', stage: 2 }),
  sp('sb', ['b']),
  sp('sg', ['g']),
  sp('fast', ['n'], { baseStats: stats(80, { spe: 200 }) }),
  sp('slow', ['n'], { baseStats: stats(80, { spe: 5 }) }),
  sp('smart', ['n'], { baseStats: stats(80, { atk: 50, spa: 150 }) }),
  sp('rich', ['n'], { baseExp: 255, catchRate: 3 }),
  sp('easy', ['n'], { catchRate: 30 }),
]
const ITEMS: ItemDef[] = [
  item('master', { kind: 'ball', catchMultiplier: 1, bonus: 'master', color: '#f0f' }),
  item('plain', { kind: 'ball', catchMultiplier: 1, color: '#fff' }),
  item('potion', { kind: 'heal', amount: 20 }),
  item('cureall', { kind: 'cure', status: 'all' }),
  item('revive', { kind: 'revive', fraction: 0.5 }),
  item('xatk', { kind: 'battleBoost', stat: 'atk', stages: 2 }),
  item('ether', { kind: 'pp', amount: 'full', all: true }),
  item('doll', { kind: 'escape' }),
  { ...item('bike', { kind: 'key', key: 'bike' }), usableInBattle: false },
]

const byId = <T extends { id: string }>(l: T[]): Record<string, T> => Object.fromEntries(l.map((x) => [x.id, x]))

/** Deterministic battle config by default: no random spread, no crits. */
function makeContent(o: { battle?: Partial<GameConfig['battle']>; catch?: Partial<GameConfig['catch']>; immunities?: Record<string, string[]> } = {}): Content {
  const config: GameConfig = {
    ...CONTENT.config,
    battle: { ...CONTENT.config.battle, randomMin: 1, randomMax: 1, critChanceByStage: [0], ...o.battle },
    catch: { ...CONTENT.config.catch, ...o.catch },
  }
  return {
    ...CONTENT, config, types: TYPES, typeById: byId(TYPES), typeChart: { a: { b: 2 }, b: { a: 0.5 }, n: { g: 0 } },
    statusImmunities: o.immunities ?? {}, statuses: STATUSES, statusById: byId(STATUSES), volatiles: VOLATILES, volatileById: byId(VOLATILES),
    weathers: WEATHERS, weatherById: byId(WEATHERS), abilities: byId(ABILITIES), moves: byId(MOVES), moveList: MOVES,
    items: byId(ITEMS), itemList: ITEMS, species: byId(SPECIES), speciesList: SPECIES,
  }
}
const C = makeContent()

function mon(c: Content, species: string, level: number, moves: string[], abilityId = 'none', patch: Partial<Creature> = {}): Creature {
  const cr = createCreature(species, level, { rng: new Rng(level), moves, shiny: false }, c)
  cr.abilityId = abilityId
  cr.ivs = stats(c.config.creature.ivMax)
  Object.assign(cr, patch)
  cr.hp = patch.hp ?? maxHp(cr, c)
  return cr
}

function battle(c: Content, me: Creature[], foe: Creature[], o: Partial<BattleInit> & { foeSide?: Partial<BattleSideInit>; meSide?: Partial<BattleSideInit> } = {}): BattleEngine {
  const { foeSide, meSide, ...rest } = o
  const isWild = rest.isWild ?? true
  const init: BattleInit = {
    seed: 1, isWild, canRun: isWild, canCatch: isWild, biome: 'meadow', timeOfDay: 'day', expGain: false,
    sides: [
      { kind: 'player', name: '小明', party: me, ...meSide },
      { kind: isWild ? 'wild' : 'trainer', name: '对手', trainerClass: isWild ? undefined : '研究员', party: foe, aiLevel: 0, ...foeSide },
    ],
    ...rest,
  }
  const e = new BattleEngine(init, c)
  e.start()
  return e
}

const M = (moveIndex: number): BattleAction => ({ kind: 'move', moveIndex })

function turn(e: BattleEngine, a0: BattleAction | null, a1: BattleAction | null = null): BattleEvent[] {
  if (a0) assert.equal(e.choose(0, a0), null)
  if (a1) assert.equal(e.choose(1, a1), null)
  assert.ok(e.ready(), 'engine should be ready')
  return e.step()
}

const texts = (evs: BattleEvent[]): string[] => evs.flatMap((x) => (x.t === 'msg' ? [x.text] : []))
const damageTo = (evs: BattleEvent[], side: SideIndex): number =>
  evs.reduce((s, x) => (x.t === 'damage' && x.side === side ? s + x.amount : s), 0)
const healOf = (evs: BattleEvent[], side: SideIndex): number => evs.reduce((s, x) => (x.t === 'heal' && x.side === side ? s + x.amount : s), 0)
const has = (evs: BattleEvent[], pred: (x: BattleEvent) => boolean): boolean => evs.some(pred)
const abilityFired = (evs: BattleEvent[], side: SideIndex, id: string): boolean => has(evs, (x) => x.t === 'ability' && x.side === side && x.abilityId === id)
const B = (key: string, params?: Record<string, string | number>, c: Content = C): string => t(`battle.${key}`, params, c)
const moveOrder = (evs: BattleEvent[]): SideIndex[] => evs.flatMap((x) => (x.t === 'move' ? [x.side] : []))

/** Hit damage of `power`-move with a deterministic roll (random 1, no crit), mirroring the formula from content. */
function expectedDamage(c: Content, att: Creature, def: Creature, power: number, physical: boolean, mul = 1): number {
  const f = RULES.damageFormula
  const A = calcStats(att, c)[physical ? 'atk' : 'spa']
  const D = calcStats(def, c)[physical ? 'def' : 'spd']
  const lf = Math.floor((f.levelMul * att.level) / f.levelDivisor + f.levelAdd)
  const base = Math.floor(Math.floor((lf * power * A) / D) / f.divisor) + f.add
  return Math.max(f.minDamage, Math.floor(base * mul))
}

// =====================================================================================================
// Core flow
// =====================================================================================================

test('intro, damage formula and STAB match content constants', () => {
  const a = mon(C, 'sn', 50, ['tackle', 'zap'])
  const b = mon(C, 'sb', 50, ['tackle'])
  const e = battle(C, [a], [b])
  const evs = turn(e, M(0), M(0))
  assert.equal(damageTo(evs, 1), expectedDamage(C, a, b, 40, true, C.config.battle.stab))
  const e2 = battle(C, [mon(C, 'sn', 50, ['zap'])], [mon(C, 'sb', 50, ['growl'])])
  const evs2 = turn(e2, M(0), M(0))
  assert.equal(damageTo(evs2, 1), expectedDamage(C, a, b, 60, false, 2))
  assert.ok(texts(evs2).includes(B('superEffective')))
})

test('start emits wild intro then send-out; trainer intro names the trainer', () => {
  const e = new BattleEngine({
    seed: 3, isWild: true, canRun: true, canCatch: true, biome: 'meadow', timeOfDay: 'day', expGain: false,
    sides: [{ kind: 'player', name: '小明', party: [mon(C, 'sn', 5, ['tackle'])] }, { kind: 'wild', name: '', party: [mon(C, 'sb', 5, ['tackle'])] }],
  }, C)
  const intro = e.start()
  assert.deepEqual(e.start(), [])
  const msgs = texts(intro)
  assert.equal(msgs[0], B('wildAppeared', { name: '精灵sb' }))
  assert.equal(msgs[1], B('sendOut', { name: '精灵sn' }))
  assert.equal(intro.filter((x) => x.t === 'switch').length, 2)
  const tr = battle(C, [mon(C, 'sn', 5, ['tackle'])], [mon(C, 'sb', 5, ['tackle'])], { isWild: false })
  assert.equal(tr.request(0).kind, 'action')
  const tr2 = new BattleEngine({ ...tr.init, seed: 4 }, C)
  const m2 = texts(tr2.start())
  assert.equal(m2[0], B('trainerChallenge', { trainer: B('trainerLabel', { class: '研究员', name: '对手' }) }))
})

test('effectiveness messages: super, not very, no effect', () => {
  const sup = turn(battle(C, [mon(C, 'sa', 30, ['zap'])], [mon(C, 'sb', 30, ['growl'])]), M(0), M(0))
  assert.ok(texts(sup).includes(B('superEffective')))
  assert.ok(has(sup, (x) => x.t === 'damage' && x.side === 1 && x.effectiveness === 2))
  const weak = turn(battle(C, [mon(C, 'sb', 30, ['hydro'])], [mon(C, 'sa', 30, ['growl'])]), M(0), M(0))
  assert.ok(texts(weak).includes(B('notVeryEffective')))
  const none = turn(battle(C, [mon(C, 'sn', 30, ['tackle'])], [mon(C, 'sg', 30, ['growl'])]), M(0), M(0))
  assert.ok(texts(none).includes(B('noEffect')))
  assert.equal(damageTo(none, 1), 0)
})

test('deterministic replay with live content', () => {
  const run = () => {
    const rng = new Rng(99)
    const species = CONTENT.speciesList
    const party = (n: number) => Array.from({ length: n }, (_, i) => createCreature(species[(i * 3) % species.length].id, 10 + i * 3, { rng }))
    const e = new BattleEngine({
      seed: 1234, isWild: false, canRun: false, canCatch: false, biome: CONTENT.biomes[0]?.id ?? 'x', timeOfDay: 'day', expGain: true,
      sides: [{ kind: 'player', name: '甲', party: party(3) }, { kind: 'trainer', name: '乙', party: party(3), aiLevel: 3 }],
    })
    const log: BattleEvent[] = [...e.start()]
    const pick = new Rng(5)
    for (let i = 0; i < 300 && !e.finished; i++) {
      const r = e.request(0)
      if (r.kind === 'switch' || r.kind === 'action') e.choose(0, chooseAiAction(e, 0, pick))
      log.push(...e.step())
    }
    return { log: JSON.stringify(log), result: e.result }
  }
  const a = run()
  const b = run()
  assert.ok(a.result)
  assert.equal(a.log, b.log)
})

test('choose validates actions with Chinese errors', () => {
  const e = battle(C, [mon(C, 'sn', 10, ['tackle']), mon(C, 'sa', 10, ['tackle'], 'none', { hp: 0 })], [mon(C, 'sb', 10, ['tackle'])])
  assert.equal(e.choose(0, M(5)), B('err.badMove'))
  assert.equal(e.choose(0, { kind: 'switch', partyIndex: 0 }), B('err.cantSwitch'))
  assert.equal(e.choose(0, { kind: 'item', itemId: 'bike' }), B('err.badItem'))
  assert.equal(e.choose(0, { kind: 'item', itemId: 'potion' }), B('err.itemNoTarget'))
  assert.equal(e.choose(0, { kind: 'item', itemId: 'revive', partyIndex: 1 }), null)
  assert.equal(e.request(0).kind, 'wait')
  assert.equal(e.choose(0, M(0)), B('err.notYourTurn'))
  const tr = battle(C, [mon(C, 'sn', 10, ['tackle'])], [mon(C, 'sb', 10, ['tackle'])], { isWild: false })
  assert.equal(tr.choose(0, { kind: 'run' }), B('err.cantRun'))
  assert.equal(tr.choose(0, { kind: 'item', itemId: 'master' }), B('err.cantCatch'))
  const empty = battle(C, [mon(C, 'sn', 10, ['tackle'], 'none', { moves: [{ id: 'tackle', pp: 0, ppMax: 10 }, { id: 'growl', pp: 5, ppMax: 10 }] })], [mon(C, 'sb', 10, ['tackle'])])
  assert.equal(empty.choose(0, M(0)), B('err.noPp'))
})

test('forced switch after fainting, then battle continues', () => {
  const weak = mon(C, 'sn', 5, ['tackle'], 'none', { hp: 1 })
  const back = mon(C, 'sa', 30, ['tackle'])
  const e = battle(C, [weak, back], [mon(C, 'fast', 30, ['tackle'])], { isWild: false })
  const evs = turn(e, M(0), M(0))
  assert.ok(has(evs, (x) => x.t === 'faint' && x.side === 0))
  assert.deepEqual(e.request(0), { kind: 'switch', forced: true })
  assert.equal(e.choose(0, M(0)), B('err.mustSwitch'))
  assert.equal(e.choose(0, { kind: 'switch', partyIndex: 0 }), B('err.alreadyActive', { name: '精灵sn' }))
  assert.equal(e.choose(0, { kind: 'switch', partyIndex: 1 }), null)
  const sw = e.step()
  assert.ok(has(sw, (x) => x.t === 'switch' && x.side === 0 && x.partyIndex === 1))
  assert.ok(!has(sw, (x) => x.t === 'turn'))
  assert.equal(e.activeIndex(0), 1)
  assert.equal(e.request(0).kind, 'action')
})

test('trainer replaces fainted creature immediately and pays money on defeat', () => {
  const e = battle(C, [mon(C, 'sn', 50, ['tackle'])], [mon(C, 'sb', 3, ['growl']), mon(C, 'sb', 3, ['growl'])], { isWild: false, rewardMoney: 321 })
  const evs = turn(e, M(0))
  assert.ok(has(evs, (x) => x.t === 'faint' && x.side === 1))
  assert.ok(has(evs, (x) => x.t === 'switch' && x.side === 1 && x.partyIndex === 1))
  assert.equal(e.request(0).kind, 'action')
  const end = turn(e, M(0))
  assert.ok(has(end, (x) => x.t === 'money' && x.amount === 321))
  assert.ok(texts(end).includes(B('youDefeated', { trainer: B('trainerLabel', { class: '研究员', name: '对手' }) })))
  assert.deepEqual(end.at(-1), { t: 'end', result: 'win', winner: 0 })
  assert.equal(e.result, 'win')
})

test('exp is split among participants; level up learns moves and flags evolution', () => {
  const sa = mon(C, 'sa', 15, ['tackle'])
  const sa2 = mon(C, 'sa', 15, ['tackle', 'growl', 'swords', 'harden'])
  const foe = mon(C, 'rich', 32, ['growl'])
  const e = battle(C, [sa, sa2], [foe], { expGain: true, isWild: false, foeSide: { aiLevel: 0 } })
  turn(e, { kind: 'switch', partyIndex: 1 }, M(0))
  turn(e, { kind: 'switch', partyIndex: 0 }, M(0))
  e.party(1)[0].hp = 1
  const evs = turn(e, M(0), M(0))
  const share = Math.floor(Math.floor((255 * 32) / C.config.battle.expDivisor * C.config.battle.trainerExpMultiplier) / 2)
  const exps = evs.filter((x) => x.t === 'exp')
  assert.deepEqual(exps.map((x) => (x.t === 'exp' ? [x.partyIndex, x.amount] : [])), [[0, share], [1, share]])
  assert.ok(has(evs, (x) => x.t === 'levelUp' && x.partyIndex === 0 && x.level === 16))
  assert.ok(has(evs, (x) => x.t === 'learnMove' && x.partyIndex === 0 && x.moveId === 'zap'))
  assert.ok(has(evs, (x) => x.t === 'moveLearnable' && x.partyIndex === 1 && x.moveId === 'zap'))
  assert.ok(has(evs, (x) => x.t === 'evolveReady' && x.partyIndex === 0 && x.toSpeciesId === 'sa2'))
  assert.ok(texts(evs).includes(B('learned', { name: '精灵sa', move: '招式zap' })))
  const iEnd = evs.findIndex((x) => x.t === 'end')
  assert.equal(iEnd, evs.length - 1)
  assert.equal(sa.level, 16)
})

test('perspective flips sides, foe-relative names and the result', () => {
  const e = battle(C, [mon(C, 'sn', 30, ['tackle'])], [mon(C, 'sb', 20, ['tackle'])], { isWild: false, foeSide: { kind: 'remote', name: '小红', trainerClass: undefined } })
  assert.equal(e.request(1).kind, 'action')
  assert.ok(!e.ready())
  const evs = [...turn(e, M(0), M(0))]
  while (!e.finished) evs.push(...turn(e, M(0), M(0)))
  const p1 = perspective(evs, 1)
  const p0 = perspective(evs, 0)
  assert.deepEqual(p0, evs)
  const m0 = evs.find((x) => x.t === 'move')!
  const m1 = p1.find((x) => x.t === 'move')!
  assert.ok(m0.t === 'move' && m1.t === 'move' && m1.side === 1 - m0.side)
  assert.ok(texts(evs).includes(B('usedMove', { name: '精灵sn', move: '招式tackle' })))
  assert.ok(texts(p1).includes(B('usedMove', { name: B('foeName', { name: '精灵sn' }), move: '招式tackle' })))
  assert.ok(texts(p1).includes(B('usedMove', { name: '精灵sb', move: '招式tackle' })))
  assert.deepEqual(evs.at(-1), { t: 'end', result: 'win', winner: 0 })
  assert.deepEqual(p1.at(-1), { t: 'end', result: 'lose', winner: 1 })
  assert.ok(texts(p1).includes(B('youLost', { trainer: '小明' })))
  assert.ok(!JSON.stringify(evs).includes(B('foeName', { name: '精灵sn' })), 'side-1 text must not leak into absolute events')
})

test('forfeit ends the battle for the quitting side', () => {
  const e = battle(C, [mon(C, 'sn', 10, ['tackle'])], [mon(C, 'sb', 10, ['tackle'])], { isWild: false })
  const evs = turn(e, { kind: 'forfeit' })
  assert.deepEqual(evs.at(-1), { t: 'end', result: 'forfeit', winner: 1 })
  assert.ok(texts(evs).includes(B('youForfeit')))
  assert.equal(e.choose(0, M(0)), B('err.finished'))
  assert.deepEqual(e.step(), [])
})

test('level cap fights at the capped level without changing the real level', () => {
  const big = mon(C, 'sn', 60, ['tackle'])
  const fullMax = maxHp(big, C)
  big.hp = Math.floor(fullMax / 2)
  const e = battle(C, [big], [mon(C, 'sb', 10, ['growl'])], { levelCap: 10, isWild: false })
  const view = e.activeView(0)
  assert.equal(view.level, 10)
  assert.equal(view.maxHp, calcStats({ ...big, level: 10 }, C).hp)
  assert.ok(Math.abs(view.hp / view.maxHp - 0.5) < 0.1)
  turn(e, { kind: 'forfeit' })
  assert.equal(big.level, 60)
  assert.ok(Math.abs(big.hp / fullMax - 0.5) < 0.1)
})

test('struggle when no PP is left: typeless, recoil from max HP', () => {
  const me = mon(C, 'sn', 30, ['tackle'], 'none', { moves: [{ id: 'tackle', pp: 0, ppMax: 10 }] })
  const e = battle(C, [me], [mon(C, 'sg', 30, ['growl'])])
  const evs = turn(e, M(0), M(0))
  assert.ok(has(evs, (x) => x.t === 'move' && x.side === 0 && x.moveId === RULES.struggle.moveId))
  assert.ok(damageTo(evs, 1) > 0, 'struggle ignores type immunity')
  assert.equal(damageTo(evs, 0), Math.floor(maxHp(me, C) * C.config.battle.struggle.recoilFraction))
  assert.ok(texts(evs).includes(B('noMovesLeft', { name: '精灵sn' })))
})

// =====================================================================================================
// Catching & running
// =====================================================================================================

test('master ball always catches and sets engine.caught', () => {
  const target = mon(C, 'rich', 70, ['tackle'])
  const e = battle(C, [mon(C, 'sn', 5, ['tackle'])], [target])
  const evs = turn(e, { kind: 'item', itemId: 'master' })
  assert.ok(has(evs, (x) => x.t === 'catch' && x.success && x.shakes === C.config.catch.shakeChecks && x.ballId === 'master'))
  assert.equal(e.result, 'caught')
  assert.equal(e.caught, target)
  assert.equal(target.ballId, 'master')
  assert.ok(texts(evs).includes(B('caught', { name: '精灵rich' })))
  assert.deepEqual(evs.at(-1), { t: 'end', result: 'caught', winner: 0 })
})

test('catch odds follow hp, status bonus and ball bonuses from config', () => {
  const rate = (o: { status?: string | null; hpFrac?: number; ball?: string; c?: Content; turn?: number }) => {
    const c = o.c ?? C
    let caught = 0
    const n = 300
    for (let s = 0; s < n; s++) {
      const target = mon(c, 'easy', 30, ['growl'])
      target.hp = Math.max(1, Math.floor(maxHp(target, c) * (o.hpFrac ?? 1)))
      target.status = o.status ?? null
      const e = battle(c, [mon(c, 'sn', 5, ['growl'])], [target], { seed: s })
      for (let i = 1; i < (o.turn ?? 1); i++) turn(e, M(0), M(0))
      const evs = turn(e, { kind: 'item', itemId: o.ball ?? 'plain' }, M(0))
      const ev = evs.find((x) => x.t === 'catch')
      assert.ok(ev && ev.t === 'catch' && ev.shakes >= 0 && ev.shakes <= c.config.catch.shakeChecks)
      if (e.result === 'caught') caught++
    }
    return caught / n
  }
  const full = rate({})
  const low = rate({ hpFrac: 0.01 })
  const asleep = rate({ hpFrac: 0.01, status: 'sx-sleep' })
  assert.ok(full < low && low < asleep, `${full} ${low} ${asleep}`)
  // gen-3 overall probability = a / rateMax
  const expectFull = Math.floor(((3 - 2) * 30 * 1) / 3) / RULES.catchFormula.rateMax
  assert.ok(Math.abs(full - expectFull) < 0.05, `${full} vs ${expectFull}`)
  const quick = makeContent()
  quick.items = { ...quick.items, quick: item('quick', { kind: 'ball', catchMultiplier: 1, bonus: 'quick', color: '#0f0' }) }
  const quickNow = rate({ c: quick, ball: 'quick' })
  const quickLate = rate({ c: quick, ball: 'quick', turn: 2 })
  assert.ok(quickNow > quickLate + 0.1, `${quickNow} ${quickLate}`)
})

test('running: speed check, attempt counter, alwaysEscape, escape item', () => {
  const noRun = makeContent({ battle: { runBase: 0, runAttemptBonus: 0 } })
  const slow = battle(noRun, [mon(noRun, 'slow', 10, ['growl'])], [mon(noRun, 'fast', 10, ['growl'])])
  for (let i = 0; i < 5; i++) assert.ok(texts(turn(slow, { kind: 'run' }, M(0))).includes(B('runFailed')))
  assert.equal(slow.finished, false)
  const fast = battle(noRun, [mon(noRun, 'fast', 10, ['growl'])], [mon(noRun, 'slow', 10, ['growl'])])
  const evs = turn(fast, { kind: 'run' })
  assert.ok(texts(evs).includes(B('ranAway')))
  assert.equal(fast.result, 'run')
  const away = battle(noRun, [mon(noRun, 'slow', 10, ['growl'], 'runaway')], [mon(noRun, 'fast', 10, ['growl'])])
  const evs2 = turn(away, { kind: 'run' })
  assert.ok(abilityFired(evs2, 0, 'runaway'))
  assert.equal(away.result, 'run')
  const doll = battle(noRun, [mon(noRun, 'slow', 10, ['growl'])], [mon(noRun, 'fast', 10, ['growl'])])
  turn(doll, { kind: 'item', itemId: 'doll' })
  assert.equal(doll.result, 'run')
  const bonus = makeContent({ battle: { runBase: 0, runAttemptBonus: 100 } })
  const tries = battle(bonus, [mon(bonus, 'slow', 10, ['growl'])], [mon(bonus, 'fast', 10, ['growl'])])
  let n = 0
  while (!tries.finished && n++ < 10) turn(tries, { kind: 'run' }, M(0))
  assert.equal(tries.result, 'run')
  assert.ok(n <= 3)
})

// =====================================================================================================
// Items
// =====================================================================================================

test('battle items: heal, revive bench, cure, boost, PP', () => {
  const me = mon(C, 'sn', 30, ['tackle', 'growl'])
  const bench = mon(C, 'sa', 30, ['tackle'], 'none', { hp: 0 })
  const e = battle(C, [me, bench], [mon(C, 'sb', 30, ['harden'])])
  me.hp -= 30
  const h = turn(e, { kind: 'item', itemId: 'potion' }, M(0))
  assert.equal(healOf(h, 0), 20)
  assert.ok(texts(h).includes(B('usedItem', { trainer: '小明', item: '道具potion' })))
  turn(e, { kind: 'item', itemId: 'revive', partyIndex: 1 }, M(0))
  assert.equal(bench.hp, Math.floor(maxHp(bench, C) * 0.5))
  turn(e, { kind: 'item', itemId: 'xatk' }, M(0))
  assert.equal(e.stages(0).atk, 2)
  me.moves[1].pp = 0
  me.status = 'sx-burn'
  turn(e, { kind: 'item', itemId: 'ether' }, M(0))
  assert.equal(me.moves[1].pp, me.moves[1].ppMax)
  const c = turn(e, { kind: 'item', itemId: 'cureall' }, M(0))
  assert.equal(me.status, null)
  assert.ok(has(c, (x) => x.t === 'status' && x.side === 0 && x.status === null))
})

test('AI trainer uses heal items when low and the engine tracks its own item counts', () => {
  let used = 0
  for (let seed = 0; seed < 10; seed++) {
    const foe = mon(C, 'sb', 30, ['tackle'])
    foe.hp = 2
    const init = { seed, isWild: false, foeSide: { aiLevel: 2 as const, items: { potion: 1 } } }
    const e = battle(C, [mon(C, 'sn', 30, ['growl'])], [foe], init)
    const evs = turn(e, M(0))
    if (has(evs, (x) => x.t === 'item' && x.side === 1)) {
      used++
      assert.equal(e.itemsLeft(1).potion, 0)
      assert.equal(e.init.sides[1].items!.potion, 1, 'init items must not be mutated')
    }
  }
  assert.ok(used >= 5, `used ${used}`)
})

// =====================================================================================================
// Statuses (generic over StatusDef fields)
// =====================================================================================================

test('status: timed skip (sleep-like) wakes after its duration', () => {
  const e = battle(C, [mon(C, 'fast', 30, ['sleeper', 'growl'])], [mon(C, 'slow', 30, ['tackle'])])
  const t1 = turn(e, M(0), M(0))
  assert.ok(texts(t1).includes(B('statusApplied', { name: B('wildName', { name: '精灵slow' }), status: '状态sx-sleep' })))
  assert.equal(moveOrder(t1).length, 1)
  assert.equal(damageTo(t1, 0), 0)
  const t2 = turn(e, M(1), M(0))
  assert.equal(moveOrder(t2).filter((s) => s === 1).length, 0)
  assert.ok(texts(t2).includes(B('statusSkip', { name: B('wildName', { name: '精灵slow' }), status: '状态sx-sleep' })))
  const t3 = turn(e, M(1), M(0))
  assert.ok(texts(t3).includes(B('statusCured', { name: B('wildName', { name: '精灵slow' }), status: '状态sx-sleep' })))
  assert.ok(damageTo(t3, 0) > 0)
})

test('status: dot fraction at end of turn and physical damage multiplier', () => {
  const a = mon(C, 'fast', 40, ['burner', 'tackle'])
  const b = mon(C, 'slow', 40, ['tackle', 'growl'])
  const e = battle(C, [a], [b])
  const t1 = turn(e, M(0), M(1))
  assert.equal(damageTo(t1, 1), Math.floor(maxHp(b, C) * 0.0625))
  assert.ok(texts(t1).includes(B('statusDot', { name: B('wildName', { name: '精灵slow' }), status: '状态sx-burn' })))
  const t2 = turn(e, M(0), M(0))
  const burned = damageTo(t2, 0)
  const clean = expectedDamage(C, b, a, 40, true, C.config.battle.stab)
  assert.ok(Math.abs(burned - Math.floor(clean * 0.5)) <= 1, `${burned} vs ${clean}`)
})

test('status: speed multiplier reorders turns, cure chance frees immediately, type immunity', () => {
  const e = battle(C, [mon(C, 'slow', 30, ['parer', 'tackle'])], [mon(C, 'fast', 30, ['tackle'])])
  assert.deepEqual(moveOrder(turn(e, M(0), M(0))), [1, 0])
  assert.equal(e.activeView(1).status, 'sx-para')
  assert.deepEqual(moveOrder(turn(e, M(1), M(0))), [0, 1])
  const s = battle(C, [mon(C, 'fast', 30, ['stucker'])], [mon(C, 'slow', 30, ['tackle'])])
  const ev = turn(s, M(0), M(0))
  assert.ok(texts(ev).includes(B('statusCured', { name: B('wildName', { name: '精灵slow' }), status: '状态sx-stuck' })))
  assert.ok(damageTo(ev, 0) > 0)
  const imm = makeContent({ immunities: { 'sx-burn': ['b'] } })
  const ie = battle(imm, [mon(imm, 'fast', 30, ['burner'])], [mon(imm, 'sb', 30, ['growl'])])
  const iev = turn(ie, M(0), M(0))
  assert.ok(texts(iev).includes(B('statusImmune', { name: B('wildName', { name: '精灵sb' }), status: '状态sx-burn' })))
  assert.equal(ie.activeView(1).status, null)
})

// =====================================================================================================
// Volatiles (generic over VolatileDef fields)
// =====================================================================================================

test('volatile: confusion-like self hit with duration', () => {
  const e = battle(C, [mon(C, 'fast', 30, ['confuser', 'growl'])], [mon(C, 'slow', 30, ['tackle'])])
  const t1 = turn(e, M(0), M(0))
  assert.ok(has(t1, (x) => x.t === 'volatile' && x.side === 1 && x.volatile === 'sx-confuse' && x.on))
  assert.ok(damageTo(t1, 1) > 0, 'self hit')
  assert.equal(damageTo(t1, 0), 0)
  const selfHit = expectedDamage(C, e.party(1)[0], e.party(1)[0], C.config.battle.confusionSelfHitPower, true)
  assert.equal(damageTo(t1, 1), selfHit)
  const t2 = turn(e, M(1), M(0))
  assert.ok(texts(t2).includes(B('volatileEnd', { name: B('wildName', { name: '精灵slow' }), volatile: '临时sx-confuse' })))
  const t3 = turn(e, M(1), M(0))
  assert.ok(damageTo(t3, 0) > 0)
})

test('volatile: flinch only when applied before the target acts', () => {
  const e = battle(C, [mon(C, 'slow', 30, ['flincher'])], [mon(C, 'fast', 30, ['tackle'])])
  const evs = turn(e, M(0), M(0))
  assert.deepEqual(moveOrder(evs), [0])
  assert.ok(texts(evs).includes(B('volatileSkip', { name: B('wildName', { name: '精灵fast' }), volatile: '临时sx-flinch' })))
  const late = battle(C, [mon(C, 'slow', 30, ['tackle'])], [mon(C, 'fast', 30, ['tackle'])])
  const lev = turn(late, M(0), M(0))
  assert.equal(moveOrder(lev).length, 2)
})

test('volatile: protect blocks, chain decay makes repeats fail, ignoreProtect bypasses', () => {
  const noChain = makeContent({ battle: { protectChainDecay: 0 } })
  const e = battle(noChain, [mon(noChain, 'sn', 30, ['shield'])], [mon(noChain, 'sb', 30, ['tackle'])])
  const t1 = turn(e, M(0), M(0))
  assert.equal(damageTo(t1, 0), 0)
  assert.ok(texts(t1).includes(B('protected', { name: '精灵sn' }, noChain)))
  const t2 = turn(e, M(0), M(0))
  assert.ok(texts(t2).includes(B('failed')))
  assert.ok(damageTo(t2, 0) > 0)
  const br = battle(C, [mon(C, 'sn', 30, ['shield'])], [mon(C, 'sb', 30, ['tackle'], 'breaker')])
  const b1 = turn(br, M(0), M(0))
  assert.ok(damageTo(b1, 0) > 0)
  assert.ok(abilityFired(b1, 1, 'breaker'))
})

test('volatile: leech drain, crit stage add, status-move block', () => {
  const e = battle(C, [mon(C, 'fast', 30, ['leecher'])], [mon(C, 'slow', 30, ['growl'])])
  const me = e.party(0)[0]
  me.hp -= 20
  const t1 = turn(e, M(0), M(0))
  const drained = Math.floor(maxHp(e.party(1)[0], C) * 0.125)
  assert.equal(damageTo(t1, 1), drained)
  assert.equal(healOf(t1, 0), drained)
  const crit = makeContent({ battle: { critChanceByStage: [0, 0, 0, 1] } })
  const f = battle(crit, [mon(crit, 'sn', 30, ['focuser', 'tackle'])], [mon(crit, 'sb', 30, ['growl'])])
  turn(f, M(0), M(0))
  const t2 = turn(f, M(1), M(0))
  assert.ok(has(t2, (x) => x.t === 'damage' && x.side === 1 && x.crit))
  const tt = battle(C, [mon(C, 'sn', 30, ['growl', 'tackle'])], [mon(C, 'sb', 30, ['taunter'])])
  turn(tt, M(1), M(0))
  assert.equal(tt.choose(0, M(0)), B('err.blocked', { name: '精灵sn', volatile: '临时sx-taunt' }))
})

// =====================================================================================================
// Weather (generic over WeatherDef)
// =====================================================================================================

test('weather: start text, type power, chip with exemption, heal, timed end', () => {
  const w = makeContent({ battle: { weatherTurns: 2 } })
  const a = mon(w, 'sn', 30, ['stormer', 'tackle'])
  const b = mon(w, 'sb', 30, ['hydro', 'growl'])
  const e = battle(w, [a], [b])
  b.hp -= 10
  const t1 = turn(e, M(0), M(1))
  assert.ok(has(t1, (x) => x.t === 'weather' && x.weather === 'sx-storm'))
  assert.ok(texts(t1).includes('测试风暴开始了'))
  assert.ok(texts(t1).includes('测试风暴持续中'))
  assert.equal(damageTo(t1, 0), Math.floor(maxHp(a, w) * 0.0625))
  assert.equal(damageTo(t1, 1), 0)
  assert.equal(healOf(t1, 1), Math.floor(maxHp(b, w) * 0.0625))
  assert.equal(e.weather, 'sx-storm')
  a.hp = maxHp(a, w)
  const t2 = turn(e, M(1), M(0))
  const boosted = damageTo(t2, 0)
  assert.equal(boosted, expectedDamage(w, b, a, 60, false, w.config.battle.stab * 1.5))
  assert.ok(texts(t2).includes('测试风暴结束了'))
  assert.equal(e.weather, 'none')
  const field = battle(w, [mon(w, 'sb', 30, ['growl'])], [mon(w, 'sb', 30, ['growl'])], { weather: 'sx-storm' })
  for (let i = 0; i < 5; i++) turn(field, M(0), M(0))
  assert.equal(field.weather, 'sx-storm', 'field weather lasts the whole battle')
})

// =====================================================================================================
// Move effects
// =====================================================================================================

test('move effects: multi hit, fixed damage, recoil, drain, heal, cure, recharge, self faint', () => {
  const mh = turn(battle(C, [mon(C, 'sn', 30, ['multi'])], [mon(C, 'sb', 30, ['growl'])]), M(0), M(0))
  const hits = mh.filter((x) => x.t === 'damage' && x.side === 1).length
  assert.ok(hits >= 2 && hits <= 5)
  assert.ok(texts(mh).includes(B('hitTimes', { count: hits })))

  const fx = turn(battle(C, [mon(C, 'sn', 23, ['sonic', 'fixed20'])], [mon(C, 'sb', 30, ['growl'])]), M(0), M(0))
  assert.equal(damageTo(fx, 1), 23)

  const rc = turn(battle(C, [mon(C, 'sn', 30, ['recoiler'])], [mon(C, 'sb', 30, ['growl'])]), M(0), M(0))
  assert.equal(damageTo(rc, 0), Math.floor(damageTo(rc, 1) * 0.25))

  const de = battle(C, [mon(C, 'sn', 30, ['drainer'])], [mon(C, 'sb', 30, ['growl'])])
  de.party(0)[0].hp = 1
  const dr = turn(de, M(0), M(0))
  assert.equal(healOf(dr, 0), Math.floor(damageTo(dr, 1) * 0.5))

  const he = battle(C, [mon(C, 'sn', 30, ['healer', 'cleanser'])], [mon(C, 'sb', 30, ['growl'])])
  const hm = he.party(0)[0]
  hm.hp = 1
  assert.equal(healOf(turn(he, M(0), M(0)), 0), Math.floor(maxHp(hm, C) * 0.5))
  hm.status = 'sx-burn'
  turn(he, M(1), M(0))
  assert.equal(hm.status, null)
  hm.hp = maxHp(hm, C)
  assert.ok(texts(turn(he, M(0), M(0))).includes(B('hpFull', { name: '精灵sn' })))

  const hy = battle(C, [mon(C, 'fast', 30, ['hyper'])], [mon(C, 'sb', 60, ['growl'])])
  turn(hy, M(0), M(0))
  assert.equal(hy.request(0).kind, 'wait')
  assert.equal(hy.choose(1, M(0)), null)
  assert.ok(hy.ready())
  const r2 = hy.step()
  assert.ok(texts(r2).includes(B('mustRecharge', { name: '精灵fast' })))
  assert.equal(hy.request(0).kind, 'action')

  const bo = battle(C, [mon(C, 'sn', 30, ['boom']), mon(C, 'sa', 30, ['tackle'])], [mon(C, 'sb', 5, ['growl']), mon(C, 'sb', 5, ['growl'])], { isWild: false })
  const be = turn(bo, M(0), M(0))
  assert.ok(has(be, (x) => x.t === 'faint' && x.side === 0))
  assert.ok(has(be, (x) => x.t === 'faint' && x.side === 1))
  assert.equal(bo.request(0).kind, 'switch')
})

test('move effects: highCrit and alwaysHit', () => {
  const crit = makeContent({ battle: { critChanceByStage: [0, 1] } })
  const ev = turn(battle(crit, [mon(crit, 'sn', 30, ['slasher'])], [mon(crit, 'sb', 30, ['growl'])]), M(0), M(0))
  assert.ok(has(ev, (x) => x.t === 'damage' && x.side === 1 && x.crit))
  assert.ok(texts(ev).includes(B('crit')))
  for (let seed = 0; seed < 20; seed++) {
    const e = battle(C, [mon(C, 'sn', 30, ['sureshot'])], [mon(C, 'sb', 30, ['growl'])], { seed })
    assert.ok(!has(turn(e, M(0), M(0)), (x) => x.t === 'miss'))
  }
  let misses = 0
  for (let seed = 0; seed < 40; seed++) {
    const e = battle(C, [mon(C, 'sn', 30, ['wild50'])], [mon(C, 'sb', 30, ['growl'])], { seed })
    if (has(turn(e, M(0), M(0)), (x) => x.t === 'miss')) misses++
  }
  assert.ok(misses > 5 && misses < 35, `misses ${misses}`)
})

// =====================================================================================================
// Abilities — every AbilityEffect variant
// =====================================================================================================

const duel = (c: Content, aAb: string, bAb: string, aMoves: string[], bMoves: string[], o: { aSp?: string; bSp?: string; seed?: number } = {}) =>
  battle(c, [mon(c, o.aSp ?? 'sn', 40, aMoves, aAb)], [mon(c, o.bSp ?? 'sn', 40, bMoves, bAb)], { seed: o.seed ?? 1 })

test('ability: powerMul (conditional, announced) and damageTakenMul', () => {
  const base = damageTo(turn(duel(C, 'none', 'none', ['tackle'], ['growl']), M(0), M(0)), 1)
  const e = duel(C, 'pinch', 'none', ['tackle'], ['growl'])
  e.party(0)[0].hp = 1
  const pinch = turn(e, M(0), M(0))
  assert.ok(abilityFired(pinch, 0, 'pinch'))
  // powerMul scales the move's power before the integer chain, so it equals a move of double power exactly (no tolerance).
  const doubled = damageTo(turn(duel(C, 'none', 'none', ['tackle2x'], ['growl']), M(0), M(0)), 1)
  assert.equal(damageTo(pinch, 1), doubled)
  const full = duel(C, 'pinch', 'none', ['tackle'], ['growl'])
  assert.equal(damageTo(turn(full, M(0), M(0)), 1), base)
  const scaled = turn(duel(C, 'none', 'scale', ['tackle'], ['growl']), M(0), M(0))
  assert.ok(Math.abs(damageTo(scaled, 1) - base / 2) <= 2)
  assert.ok(abilityFired(scaled, 1, 'scale'))
})

test('ability: statMul speed, moveLast, priority', () => {
  assert.deepEqual(moveOrder(turn(duel(C, 'swift', 'none', ['tackle'], ['tackle'], { aSp: 'slow', bSp: 'fast' }), M(0), M(0))), [0, 1])
  assert.deepEqual(moveOrder(turn(duel(C, 'stall', 'none', ['tackle'], ['tackle'], { aSp: 'fast', bSp: 'slow' }), M(0), M(0))), [1, 0])
  assert.deepEqual(moveOrder(turn(duel(C, 'prankster', 'none', ['growl'], ['tackle'], { aSp: 'slow', bSp: 'fast' }), M(0), M(0))), [0, 1])
  assert.deepEqual(moveOrder(turn(duel(C, 'prankster', 'none', ['tackle'], ['tackle'], { aSp: 'slow', bSp: 'fast' }), M(0), M(0))), [1, 0])
})

test('ability: stab, critStage, critMul', () => {
  const plain = damageTo(turn(duel(C, 'none', 'none', ['zap'], ['growl'], { aSp: 'sa' }), M(0), M(0)), 1)
  const boosted = damageTo(turn(duel(C, 'stab3', 'none', ['zap'], ['growl'], { aSp: 'sa' }), M(0), M(0)), 1)
  assert.ok(Math.abs(boosted - plain * 2) <= 2, `${boosted} vs ${plain}`)
  const crit = makeContent({ battle: { critChanceByStage: [0, 1] } })
  assert.ok(has(turn(duel(crit, 'keen', 'none', ['tackle'], ['growl']), M(0), M(0)), (x) => x.t === 'damage' && x.side === 1 && x.crit))
  const always = makeContent({ battle: { critChanceByStage: [1] } })
  const normal = damageTo(turn(duel(always, 'none', 'none', ['tackle'], ['growl']), M(0), M(0)), 1)
  const sniper = damageTo(turn(duel(always, 'sniper', 'none', ['tackle'], ['growl']), M(0), M(0)), 1)
  assert.ok(Math.abs(sniper - normal * (3 / always.config.battle.critMultiplier)) <= 2, `${sniper} vs ${normal}`)
})

test('ability: accuracyMul with ignoreEvasion; ignoreFoeBoosts', () => {
  for (let seed = 0; seed < 15; seed++) {
    const e = duel(C, 'scope', 'none', ['tackle'], ['harden'], { seed })
    const evs = turn(e, M(0), M(0))
    assert.equal(e.stages(1).eva, C.config.battle.statStageLimit)
    assert.ok(!has(evs, (x) => x.t === 'miss'))
  }
  const ref = damageTo(turn(duel(C, 'unaware', 'none', ['tackle'], ['focuser']), M(0), M(0)), 1)
  const ua = duel(C, 'unaware', 'none', ['tackle'], ['harden'])
  assert.equal(damageTo(turn(ua, M(0), M(0)), 1), ref)
})

test('ability: switchIn stats on enemy and highestOf on self; switchOut heal', () => {
  const e = battle(C, [mon(C, 'sn', 30, ['tackle'], 'intim')], [mon(C, 'sn', 30, ['tackle'])])
  assert.equal(e.stages(1).atk, -1)
  const d = battle(C, [mon(C, 'smart', 30, ['tackle'], 'download')], [mon(C, 'sn', 30, ['tackle'])])
  assert.equal(d.stages(0).spa, 2)
  assert.equal(d.stages(0).atk, 0)
  const regen = mon(C, 'sn', 30, ['tackle'], 'regen')
  const r = battle(C, [regen, mon(C, 'sa', 30, ['tackle'])], [mon(C, 'sb', 30, ['growl'])], { isWild: false })
  regen.hp = 1
  const evs = turn(r, { kind: 'switch', partyIndex: 1 }, M(0))
  assert.ok(abilityFired(evs, 0, 'regen'))
  assert.equal(regen.hp, 1 + Math.floor(maxHp(regen, C) * 0.5))
})

test('ability: turnEnd stats, heal and status cure', () => {
  const sp = duel(C, 'booster', 'none', ['growl'], ['growl'])
  turn(sp, M(0), M(0))
  assert.equal(sp.stages(0).spe, 1)
  const lf = duel(C, 'leftovers', 'none', ['growl'], ['growl'])
  lf.party(0)[0].hp = 1
  assert.equal(healOf(turn(lf, M(0), M(0)), 0), Math.floor(maxHp(lf.party(0)[0], C) * 0.25))
  const sh = duel(C, 'none', 'shedder', ['burner'], ['growl'])
  const evs = turn(sh, M(0), M(0))
  assert.ok(abilityFired(evs, 1, 'shedder'))
  assert.equal(sh.activeView(1).status, null)
})

test('ability: immune statuses and volatiles', () => {
  const e = duel(C, 'none', 'vital', ['sleeper', 'confuser'], ['growl'])
  const t1 = turn(e, M(0), M(0))
  assert.ok(abilityFired(t1, 1, 'vital'))
  assert.equal(e.activeView(1).status, null)
  turn(e, M(1), M(0))
  assert.deepEqual(e.volatiles(1), [])
})

test('ability: afterHitBy, knockOut, absorbType', () => {
  const w = turn(duel(C, 'none', 'weakarmor', ['zap'], ['growl'], { aSp: 'sa', bSp: 'sb' }), M(0), M(0))
  assert.ok(has(w, (x) => x.t === 'stat' && x.side === 1 && x.stat === 'def' && x.delta === 1))
  const ko = battle(C, [mon(C, 'sn', 60, ['tackle'], 'moxie')], [mon(C, 'sb', 2, ['growl']), mon(C, 'sb', 2, ['growl'])], { isWild: false })
  const kev = turn(ko, M(0))
  assert.ok(abilityFired(kev, 0, 'moxie'))
  assert.equal(ko.stages(0).atk, 1)
  const ab = duel(C, 'none', 'absorber', ['zap'], ['growl'], { aSp: 'sa' })
  ab.party(1)[0].hp = 1
  const aev = turn(ab, M(0), M(0))
  assert.equal(damageTo(aev, 1), 0)
  assert.equal(healOf(aev, 1), Math.floor(maxHp(ab.party(1)[0], C) * 0.25))
  assert.ok(texts(aev).includes(B('absorbed', { name: B('wildName', { name: '精灵sn' }) })))
})

test('ability: dealDamage status/volatile, drain and self damage', () => {
  const pt = duel(C, 'poisontouch', 'none', ['tackle'], ['growl'])
  const evs = turn(pt, M(0), M(0))
  assert.equal(pt.activeView(1).status, 'sx-burn')
  assert.ok(pt.volatiles(1).includes('sx-confuse'))
  assert.ok(abilityFired(evs, 0, 'poisontouch'))
  const vp = duel(C, 'vampire', 'none', ['tackle'], ['growl'])
  vp.party(0)[0].hp = 1
  const v = turn(vp, M(0), M(0))
  assert.equal(healOf(v, 0), Math.max(1, Math.floor(damageTo(v, 1) * 0.5)))
  const lo = duel(C, 'lifeorb', 'none', ['tackle'], ['growl'])
  const l = turn(lo, M(0), M(0))
  assert.equal(damageTo(l, 0), Math.floor(maxHp(lo.party(0)[0], C) * 0.1))
  assert.ok(abilityFired(l, 0, 'lifeorb'))
  assert.ok(texts(l).includes(B('abilitySelfDamage', { name: '精灵sn', ability: '特性lifeorb' })))
})

test('ability: blockFoeStatusMoves and noStatDrops', () => {
  const m = duel(C, 'none', 'mirror', ['growl'], ['growl'])
  const evs = turn(m, M(0), M(0))
  assert.ok(abilityFired(evs, 1, 'mirror'))
  assert.equal(m.stages(1).atk, 0)
  const cb = duel(C, 'none', 'clearbody', ['growl'], ['swords'])
  const c2 = turn(cb, M(0), M(0))
  assert.equal(cb.stages(1).atk, 2)
  assert.ok(texts(c2).includes(B('statDropBlocked', { name: B('wildName', { name: '精灵sn' }) })))
})

// =====================================================================================================
// AI & fuzz over the live content
// =====================================================================================================

/** Live-roster parties; half of them get random moves and abilities from the whole live content to exercise every effect. */
function livePartyFactory(rng: Rng) {
  const roster = CONTENT.speciesList
  const moves = CONTENT.moveList.map((m) => m.id)
  const abilities = Object.keys(CONTENT.abilities)
  return (n: number, lo: number, hi: number): Creature[] =>
    Array.from({ length: n }, () => {
      const remix = rng.chance(0.5)
      const picked = remix ? Array.from({ length: CONTENT.config.party.maxMoves }, () => rng.pick(moves)) : undefined
      const cr = createCreature(rng.pick(roster).id, rng.int(lo, hi), { rng, moves: picked })
      if (remix && abilities.length) cr.abilityId = rng.pick(abilities)
      return cr
    })
}

test('AI actions are always accepted by the engine (all levels, both sides)', () => {
  for (let seed = 0; seed < 40; seed++) {
    const rng = new Rng(seed)
    const party = livePartyFactory(rng)
    const level = (seed % 4) as 0 | 1 | 2 | 3
    const potion = CONTENT.itemList.find((i) => i.usableInBattle && i.effect.kind === 'heal')
    const e = new BattleEngine({
      seed, isWild: false, canRun: false, canCatch: false, biome: 'x', timeOfDay: 'day', expGain: false,
      sides: [
        { kind: 'player', name: '甲', party: party(rng.int(1, 3), 5, 40) },
        { kind: 'trainer', name: '乙', party: party(rng.int(1, 3), 5, 40), aiLevel: level, items: potion ? { [potion.id]: 2 } : {} },
      ],
    })
    e.start()
    for (let i = 0; i < 400 && !e.finished; i++) {
      const r0 = e.request(0)
      if (r0.kind !== 'wait') {
        const a = chooseAiAction(e, 0, rng)
        assert.equal(e.choose(0, a), null, `side0 ${JSON.stringify(a)} rejected`)
      }
      if (e.request(1).kind !== 'wait') {
        const a = chooseAiAction(e, 1, rng)
        assert.equal(e.choose(1, a), null, `side1 L${level} ${JSON.stringify(a)} rejected`)
      }
      e.step()
    }
    assert.ok(e.finished, `seed ${seed} did not finish`)
  }
})

test('AI level 1+ prefers super effective moves', () => {
  let good = 0
  for (let seed = 0; seed < 20; seed++) {
    const e = battle(C, [mon(C, 'sb', 30, ['growl'])], [mon(C, 'sa', 30, ['tackle', 'zap'])], { seed, foeSide: { aiLevel: 1 } })
    const a = chooseAiAction(e, 1, new Rng(seed), C)
    if (a.kind === 'move' && a.moveIndex === 1) good++
  }
  assert.ok(good >= 18, `chose zap ${good}/20`)
  const e3 = battle(C, [mon(C, 'sb', 30, ['growl'], 'none', { hp: 5 })], [mon(C, 'sn', 30, ['growl', 'tackle', 'swords'])], { foeSide: { aiLevel: 3 } })
  const k = chooseAiAction(e3, 1, new Rng(1), C)
  assert.deepEqual(k, { kind: 'move', moveIndex: 1 }, 'level 3 takes the KO')
})

test('fuzz: 200 random battles over live content finish with well-formed events', () => {
  const battleItems = CONTENT.itemList.filter((i) => i.usableInBattle)
  for (let seed = 0; seed < 200; seed++) {
    const rng = new Rng(1000 + seed)
    const party = livePartyFactory(rng)
    const wild = rng.chance(0.5)
    const me = party(rng.int(1, 4), 2, 60)
    const foe = party(wild ? 1 : rng.int(1, 4), 2, 60)
    const e = new BattleEngine({
      seed, isWild: wild, canRun: wild, canCatch: wild, biome: 'x', timeOfDay: rng.pick(['dawn', 'day', 'dusk', 'night'] as const),
      expGain: rng.chance(0.7), levelCap: rng.chance(0.2) ? rng.int(5, 30) : undefined, rewardMoney: wild ? undefined : 100,
      weather: rng.chance(0.3) && CONTENT.weathers.length ? rng.pick(CONTENT.weathers).id : undefined,
      sides: [
        { kind: 'player', name: '玩家', party: me },
        { kind: wild ? 'wild' : 'trainer', name: '训练家', trainerClass: '道馆主', party: foe, aiLevel: wild ? undefined : rng.int(0, 3) as 0 | 1 | 2 | 3 },
      ],
    })
    const events = [...e.start()]
    let steps = 0
    while (!e.finished && steps++ < 600) {
      const r = e.request(0)
      if (r.kind === 'switch') {
        const opts = e.party(0).map((_, i) => i).filter((i) => e.party(0)[i].hp > 0 && i !== e.activeIndex(0))
        assert.equal(e.choose(0, { kind: 'switch', partyIndex: rng.pick(opts) }), null)
      } else if (r.kind === 'action') {
        const roll = rng.next()
        let err: string | null = 'x'
        if (roll < 0.08 && r.canSwitch) err = e.choose(0, { kind: 'switch', partyIndex: rng.int(0, e.party(0).length - 1) })
        else if (roll < 0.16 && r.canItem && battleItems.length) err = e.choose(0, { kind: 'item', itemId: rng.pick(battleItems).id, partyIndex: rng.int(0, e.party(0).length - 1) })
        else if (roll < 0.19 && r.canRun) err = e.choose(0, { kind: 'run' })
        if (err !== null) err = e.choose(0, M(rng.int(0, CONTENT.config.party.maxMoves - 1)))
        // Fall back to the first move the engine accepts (taunt can block status moves that still have PP).
        for (let i = 0; err !== null && i < e.party(0)[e.activeIndex(0)].moves.length; i++) err = e.choose(0, M(i))
        assert.equal(typeof err === 'string' ? err.startsWith('battle.') : false, false, `raw key error ${err}`)
      }
      assert.ok(e.ready(), `seed ${seed}: engine not ready with request ${JSON.stringify(e.request(0))}`)
      events.push(...e.step())
    }
    assert.ok(e.finished, `seed ${seed} did not finish`)
    assert.equal(events.filter((x) => x.t === 'end').length, 1)
    assert.equal(events.at(-1)!.t, 'end')
    for (const x of events) {
      if (x.t === 'msg') {
        assert.ok(!x.text.startsWith('battle.') && !/\{\w+\}/.test(x.text), `seed ${seed}: bad text "${x.text}"`)
      }
      if (x.t === 'damage' || x.t === 'heal') assert.ok(x.amount >= 0 && x.hp >= 0 && x.hp <= x.maxHp, `seed ${seed}: ${JSON.stringify(x)}`)
    }
    for (const cr of [...me, ...foe]) assert.ok(cr.hp >= 0 && cr.hp <= maxHp(cr), 'hp restored within real max hp')
    for (const x of perspective(events, 1)) if (x.t === 'msg') assert.ok(!/\{\w+\}/.test(x.text))
  }
})

// =====================================================================================================
// Content conventions the engine relies on
// =====================================================================================================

test('battle text, rules and content conventions', () => {
  const required = ['wildAppeared', 'sendOut', 'usedMove', 'superEffective', 'notVeryEffective', 'noEffect', 'crit', 'fainted', 'statUp.1', 'statDown.1',
    'statusApplied', 'caught', 'gainedExp', 'levelUp', 'learned', 'catchFailDefault', 'err.notYourTurn']
  for (const k of required) assert.ok(`battle.${k}` in CONTENT.text, `missing battle.${k}`)
  assert.ok(CONTENT.typeById[RULES.struggle.displayType], 'struggle display type must exist')
  assert.ok(RULES.ai.wildLevelByRarityOrder.every((n) => Number.isInteger(n) && n >= 0 && n <= 3))
  assert.ok(RULES.ai.noise.length >= 4)
  assert.deepEqual([...RULES.actionOrder].sort(), ['item', 'move', 'run', 'switch'])
  assert.ok(Object.values(RULES.ai.featureLevel).every((n) => n >= 0 && n <= 3))
  const chances: [string, number][] = []
  for (const m of CONTENT.moveList) for (const e of m.effects) if ('chance' in e) chances.push([`move ${m.id}`, e.chance])
  for (const a of Object.values(CONTENT.abilities)) {
    for (const e of a.effects) {
      if (e.on === 'blockFoeStatusMoves') chances.push([`ability ${a.id}`, e.chance])
      if (e.on === 'dealDamage') {
        if (e.status) chances.push([`ability ${a.id}`, e.status.chance])
        if (e.volatile) chances.push([`ability ${a.id}`, e.volatile.chance])
      }
    }
  }
  // `chance` fields are percentages (1..100); `*Chance` fields are fractions (0..1).
  for (const [where, ch] of chances) assert.ok(ch >= 1 && ch <= 100, `${where}: chance ${ch} must be a percentage`)
  for (const s of CONTENT.statuses) for (const v of [s.skipChance, s.cureChancePerTurn]) if (v !== undefined) assert.ok(v >= 0 && v <= 1, `status ${s.id}`)
})
