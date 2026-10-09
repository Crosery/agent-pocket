// Coverage & consistency checks for the battle data tables (types / moves / items).
// Everything is iterated generically from CONTENT; the thresholds below are acceptance criteria, not game data.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { CONTENT, t, validateContent } from '../src/shared/content/index.ts'
import type { BallBonus, ItemCategory, ItemEffect, KeyItemKind, MoveAnim, MoveDef, MoveEffect } from '../src/shared/types.ts'

const MIN_MOVES_PER_TYPE = 14
const STATUS_MOVES_PER_TYPE: [number, number] = [3, 5]
const POWER_BANDS: Record<'early' | 'mid' | 'late', [number, number]> = { early: [30, 50], mid: [60, 85], late: [90, 130] }
const STRENGTHS: [number, number] = [2, 4]
const RESISTANCES: [number, number] = [1, 4]
const MAX_IMMUNITIES = 2
const STATUS_IMMUNITY_ENTRIES: [number, number] = [2, 4]
const MIN_INFLICTORS_PER_STATUS = 2
const MIN_CHIPS = 45
const CHIP_PRICE: [number, number] = [3000, 10000]

// Exhaustive mirrors of schema unions (tsc rejects missing/extra keys), used for runtime shape checks.
const ANIMS: Record<MoveAnim, true> = {
  hit: true, slash: true, beam: true, orb: true, burst: true, wave: true, rain: true, shield: true, heal: true, buff: true,
  debuff: true, glitch: true, code: true, lightning: true, fire: true, ice: true, sound: true, light: true, dark: true,
  wind: true, quake: true, spark: true,
}
const EFFECT_KINDS: Record<MoveEffect['kind'], true> = {
  status: true, stat: true, volatile: true, heal: true, drain: true, recoil: true, multiHit: true, fixedDamage: true,
  weather: true, cureStatus: true, highCrit: true, alwaysHit: true, recharge: true, selfFaint: true,
}
const ITEM_CATEGORIES: Record<ItemCategory, true> = { ball: true, medicine: true, battle: true, key: true, chip: true, evolution: true, misc: true }
const ITEM_EFFECT_KINDS: Record<ItemEffect['kind'], true> = {
  ball: true, heal: true, cure: true, healCure: true, revive: true, pp: true, levelUp: true, evolve: true,
  battleBoost: true, repel: true, escape: true, chip: true, key: true, none: true, bait: true, nature: true,
}
const BALL_BONUSES: Record<BallBonus, true> = { night: true, quick: true, status: true, lowLevel: true, rare: true, master: true }
const KEY_KINDS: Record<KeyItemKind, true> = { bike: true, surf: true, map: true, dex: true, badgeCase: true, pass: true }

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const CJK = /[一-鿿]/
const HEX = /^#[0-9a-f]{6}$/i
const within = (v: number, [lo, hi]: [number, number]) => v >= lo && v <= hi
const has = (m: MoveDef, kind: MoveEffect['kind']) => m.effects.some((e) => e.kind === kind)
const damaging = (m: MoveDef) => m.category !== 'status'

test('content validates cleanly', () => {
  const errs = validateContent()
  assert.deepEqual(errs, [], errs.join('\n'))
})

test('type chart: complete, legal multipliers, balanced', () => {
  const ids = CONTENT.types.map((x) => x.id)
  const m = (a: string, d: string) => CONTENT.typeChart[a]?.[d] ?? 1
  let immunities = 0
  for (const a of ids) {
    assert.ok(CONTENT.typeChart[a], `chart row missing for ${a}`)
    for (const d of ids) {
      assert.ok([0, 0.5, 1, 2].includes(m(a, d)), `${a}->${d} = ${m(a, d)}`)
      if (m(a, d) === 0) immunities++
    }
    const strengths = ids.filter((d) => m(a, d) === 2).length
    const resists = ids.filter((x) => m(x, a) === 0.5).length
    assert.ok(within(strengths, STRENGTHS), `${a}: ${strengths} strengths`)
    assert.ok(within(resists, RESISTANCES), `${a}: ${resists} resistances`)
  }
  assert.ok(immunities <= MAX_IMMUNITIES, `${immunities} immunities in chart`)
  const entries = Object.keys(CONTENT.statusImmunities).length
  assert.ok(within(entries, STATUS_IMMUNITY_ENTRIES), `${entries} statusImmunities entries`)
})

test('moves: ids, text and shapes', () => {
  for (const mv of CONTENT.moveList) {
    const w = `move ${mv.id}`
    assert.match(mv.id, KEBAB, w)
    assert.match(mv.nameZh, CJK, `${w}: nameZh`)
    assert.ok(mv.nameEn.trim().length > 0, `${w}: nameEn`)
    assert.match(mv.description, CJK, `${w}: description`)
    assert.ok(ANIMS[mv.anim], `${w}: anim "${mv.anim}"`)
    assert.ok(Number.isInteger(mv.priority), `${w}: priority`)
    for (const e of mv.effects) {
      assert.ok(EFFECT_KINDS[e.kind], `${w}: effect kind "${e.kind}"`)
      if ('chance' in e) assert.ok(e.chance > 0 && e.chance <= 100, `${w}: chance ${e.chance}`)
      if (e.kind === 'multiHit') assert.ok(e.min >= 2 && e.max >= e.min, `${w}: multiHit range`)
      if (e.kind === 'heal' || e.kind === 'drain' || e.kind === 'recoil') assert.ok(e.fraction > 0 && e.fraction <= 1, `${w}: fraction`)
      if (e.kind === 'stat') assert.ok(Object.keys(e.stats).every((k) => CONTENT.statByKey[k]), `${w}: stat key`)
    }
    if (mv.category === 'status') assert.equal(mv.power, 0, `${w}: status move power`)
  }
})

test('moves: every type has enough moves across tiers', () => {
  for (const { id } of CONTENT.types) {
    const list = CONTENT.moveList.filter((m) => m.type === id)
    const dmg = list.filter((m) => damaging(m) && m.power > 0)
    assert.ok(list.length >= MIN_MOVES_PER_TYPE, `${id}: ${list.length} moves`)
    for (const [band, range] of Object.entries(POWER_BANDS)) assert.ok(dmg.some((m) => within(m.power, range)), `${id}: no ${band} move`)
    assert.ok(dmg.some((m) => m.category === 'physical') && dmg.some((m) => m.category === 'special'), `${id}: needs physical + special`)
    const statusCount = list.filter((m) => m.category === 'status').length
    assert.ok(within(statusCount, STATUS_MOVES_PER_TYPE), `${id}: ${statusCount} status moves`)
  }
})

test('moves: every status, volatile and weather is reachable', () => {
  for (const s of CONTENT.statuses) {
    const n = CONTENT.moveList.filter((m) => m.effects.some((e) => e.kind === 'status' && e.status === s.id && e.target === 'enemy')).length
    assert.ok(n >= MIN_INFLICTORS_PER_STATUS, `status ${s.id}: inflicted by ${n} moves`)
  }
  for (const v of CONTENT.volatiles) {
    assert.ok(CONTENT.moveList.some((m) => m.effects.some((e) => e.kind === 'volatile' && e.volatile === v.id)), `volatile ${v.id} unused`)
  }
  for (const w of CONTENT.weathers) {
    assert.ok(CONTENT.moveList.some((m) => m.effects.some((e) => e.kind === 'weather' && e.weather === w.id)), `weather ${w.id} has no setter`)
  }
})

test('moves: mechanic coverage', () => {
  const L = CONTENT.moveList
  const self = (m: MoveDef, delta: number) =>
    m.effects.some((e) => e.kind === 'stat' && e.target === 'self' && e.chance === 100 && Object.values(e.stats).includes(delta))
  const checks: Record<string, (m: MoveDef) => boolean> = {
    priority: (m) => damaging(m) && m.priority > 0,
    negativePriority: (m) => m.priority < 0,
    multiHit: (m) => has(m, 'multiHit'),
    drain: (m) => has(m, 'drain'),
    recoil: (m) => has(m, 'recoil'),
    highCrit: (m) => has(m, 'highCrit'),
    alwaysHit: (m) => has(m, 'alwaysHit'),
    halfHeal: (m) => m.effects.some((e) => e.kind === 'heal' && e.fraction === 0.5),
    boost1: (m) => self(m, 1),
    boost2: (m) => self(m, 2),
    fixedLevel: (m) => m.effects.some((e) => e.kind === 'fixedDamage' && e.amount === 'level'),
    fixedAmount: (m) => m.effects.some((e) => e.kind === 'fixedDamage' && typeof e.amount === 'number'),
    selfFaint: (m) => has(m, 'selfFaint'),
    recharge: (m) => has(m, 'recharge'),
    cureStatus: (m) => has(m, 'cureStatus'),
  }
  for (const [name, fn] of Object.entries(checks)) assert.ok(L.some(fn), `no move with ${name}`)
})

test('items: ids, text, categories and usage flags', () => {
  for (const it of CONTENT.itemList) {
    const w = `item ${it.id}`
    assert.match(it.id, KEBAB, w)
    assert.match(it.nameZh, CJK, `${w}: nameZh`)
    assert.match(it.description, CJK, `${w}: description`)
    assert.ok(ITEM_CATEGORIES[it.category], `${w}: category`)
    assert.ok(ITEM_EFFECT_KINDS[it.effect.kind], `${w}: effect kind`)
    assert.ok(Number.isInteger(it.price) && it.price >= 0, `${w}: price`)
    if (it.buyable) assert.ok(it.price > 0, `${w}: buyable items need a price`)
    assert.notEqual(t(`items.category.${it.category}`), `items.category.${it.category}`, `${w}: category label missing`)
    const e = it.effect
    if (e.kind === 'ball') {
      assert.equal(it.category, 'ball', w)
      assert.match(e.color, HEX, `${w}: color`)
      assert.ok(e.catchMultiplier > 0, `${w}: multiplier`)
      assert.ok(it.usableInBattle && !it.usableInField, `${w}: balls are battle-only`)
    }
    if (e.kind === 'key') assert.ok(it.category === 'key' && !it.buyable && !it.usableInBattle, `${w}: key item flags`)
    if (e.kind === 'battleBoost') assert.ok(it.usableInBattle && !it.usableInField && e.stages > 0, `${w}: battle item flags`)
    if (e.kind === 'repel' || e.kind === 'escape') assert.ok(it.usableInField && !it.usableInBattle, `${w}: field item flags`)
    if (e.kind === 'repel') assert.ok(e.steps > 0, `${w}: steps`)
    if (e.kind === 'none') assert.ok(!it.buyable && it.price > 0 && !it.usableInBattle && !it.usableInField, `${w}: sellable flags`)
  }
})

test('items: chips reference existing moves and cover every type', () => {
  const chips = CONTENT.itemList.filter((i) => i.effect.kind === 'chip')
  assert.ok(chips.length >= MIN_CHIPS, `${chips.length} chips`)
  const covered = new Set<string>()
  for (const it of chips) {
    const e = it.effect as Extract<ItemEffect, { kind: 'chip' }>
    const mv = CONTENT.moves[e.move]
    assert.ok(mv, `${it.id}: move "${e.move}" missing`)
    assert.equal(it.id, `chip-${e.move}`)
    assert.equal(it.category, 'chip')
    assert.ok(within(it.price, CHIP_PRICE), `${it.id}: price ${it.price}`)
    assert.ok(it.usableInField && !it.usableInBattle, `${it.id}: chip flags`)
    covered.add(mv.type)
  }
  for (const { id } of CONTENT.types) assert.ok(covered.has(id), `no chip for type ${id}`)
})

test('items: every status has a cure, every ball bonus and key kind has an item', () => {
  const effects = CONTENT.itemList.map((i) => i.effect)
  for (const s of CONTENT.statuses) assert.ok(effects.some((e) => e.kind === 'cure' && e.status === s.id), `no cure for ${s.id}`)
  assert.ok(effects.some((e) => e.kind === 'cure' && e.status === 'all'), 'no cure-all item')
  for (const b of Object.keys(BALL_BONUSES)) assert.ok(effects.some((e) => e.kind === 'ball' && e.bonus === b), `no ball with bonus ${b}`)
  for (const k of Object.keys(KEY_KINDS)) assert.ok(effects.some((e) => e.kind === 'key' && e.key === k), `no key item ${k}`)
  assert.ok(CONTENT.itemList.some((i) => i.effect.kind === 'ball' && i.buyable && !i.effect.bonus), 'no plain buyable ball')
})

let python = true
try { execFileSync('python3', ['--version'], { stdio: 'ignore' }) } catch { python = false }
test('docs/typechart.md matrix is in sync with content/types.json', { skip: !python && 'python3 unavailable' }, () => {
  execFileSync('python3', [new URL('../tools/data/typechart_md.py', import.meta.url).pathname, '--check'], { stdio: 'pipe' })
})
