import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT } from '../src/shared/content/index.ts'
import { describeBattleEffects, effectBalance, effectCount, hudEffects, sideSheet, weatherSheet, type BattleStatusSnapshot } from '../src/client/battle/effect-details.ts'
import { BATTLE_UI, validateBattleUi } from '../src/client/battle/config.ts'
import { STAGE } from '../src/client/render/battle/config.ts'

const snapshot: BattleStatusSnapshot = {
  name: '示例智灵',
  abilityId: 'long-context',
  types: ['chat'],
  status: 'burn',
  volatiles: ['focus', 'taunt'],
  stages: { atk: 2, def: -1 },
}

test('battle effect details explain every active status and stage without dropping overflow', () => {
  const rows = describeBattleEffects(snapshot)
  assert.deepEqual(rows.map((row) => row.id), [
    'ability:long-context',
    'status:burn',
    'volatile:focus',
    'volatile:taunt',
    'stage:atk',
    'stage:def',
  ])
  assert.equal(effectCount(snapshot), 5)
  assert.match(rows.find((row) => row.id === 'status:burn')?.description ?? '', /最大上下文/)
  assert.match(rows.find((row) => row.id === 'stage:atk')?.value ?? '', /×2/)
  assert.match(rows.find((row) => row.id === 'stage:def')?.value ?? '', /×0\.67/)
  assert.equal(rows.find((row) => row.id === 'volatile:focus')?.polarity, 'buff')
  assert.equal(rows.find((row) => row.id === 'volatile:taunt')?.polarity, 'debuff')
})

test('the status sheet keeps no glossary wall: stat definitions are tooltips on the stage chips', () => {
  assert.equal(CONTENT.text['battleui.effects.glossary'], undefined)
  const sheet = sideSheet(snapshot)
  for (const chip of sheet.stages) {
    const def = CONTENT.statByKey[chip.id]
    assert.ok(def, chip.id)
    assert.ok(chip.tip.includes(def.desc), `${chip.id}: the tooltip carries the stat definition`)
  }
})

test('the status sheet shows only live state: a one-line status, non-zero stage chips, volatile chips and the ability', () => {
  const sheet = sideSheet(snapshot)
  assert.equal(sheet.status?.id, 'burn')
  assert.equal(sheet.status?.label, '过热')
  assert.match(sheet.status?.line ?? '', /1\/16/)
  assert.deepEqual(sheet.stages.map((c) => [c.id, c.delta, c.factor]), [['atk', '▲2', '×2'], ['def', '▼1', '×0.67']])
  assert.deepEqual(sheet.volatiles.map((c) => c.id), ['focus', 'taunt'])
  assert.equal(sheet.ability?.label, CONTENT.abilities['long-context'].nameZh)
  assert.equal(sheet.quiet, false)
  const calm = sideSheet({ ...snapshot, status: null, volatiles: [], stages: { atk: 0 } })
  assert.equal(calm.quiet, true)
  assert.deepEqual([calm.status, calm.stages, calm.volatiles], [null, [], []])
})

test('every status has a one-line summary that fits half the sheet, and every weather summarises its numbers', () => {
  for (const def of CONTENT.statuses) {
    const line = sideSheet({ name: 'x', abilityId: null, types: [], status: def.id, volatiles: [], stages: {} }).status?.line ?? ''
    assert.ok(line.length > 4 && line.length <= 20, `${def.id}: "${line}"`)
    assert.ok(!line.includes('battleui.'), `${def.id}: text key resolved`)
  }
  for (const w of CONTENT.weathers) {
    const sheet = weatherSheet(w.id)
    assert.ok(sheet && sheet.line.length > 0 && !sheet.line.includes('battleui.'), w.id)
  }
  assert.equal(weatherSheet('overclock')?.line, '算力、代码 ×1.5 · 对齐 ×0.75 · 每回合损耗 1/16')
  assert.equal(weatherSheet(null), null)
})

test('the sheet\'s side accents are the floor-ring colours, so a card and its creature read as one side', () => {
  assert.deepEqual([BATTLE_UI.inspector.sideColors.own, BATTLE_UI.inspector.sideColors.foe], STAGE.markers.colors)
  assert.deepEqual(validateBattleUi(CONTENT).filter((e) => e.includes('inspector')), [])
})

// A worst-ish case per side: one status, four volatiles and six stat stages (11 effects) against a lighter foe (8).
const crowdedOwn: BattleStatusSnapshot = {
  name: '我方', abilityId: 'long-context', types: ['chat'], status: 'burn',
  volatiles: ['confusion', 'focus', 'taunt', 'leech'],
  stages: { atk: 2, def: -1, spa: 3, spe: -2, acc: 1, eva: -1 },
}
const crowdedFoe: BattleStatusSnapshot = {
  name: '对手', abilityId: null, types: ['open', 'chaos'], status: 'paralysis',
  volatiles: ['protect', 'leech', 'flinch'],
  stages: { atk: -2, def: 1, spe: 2, eva: 3 },
}

test('six or more stacked effects per side: every one is described, counted and split into buffs and debuffs', () => {
  for (const [snap, total, buff, debuff] of [[crowdedOwn, 11, 4, 7], [crowdedFoe, 8, 4, 4]] as const) {
    assert.equal(effectCount(snap), total)
    const rows = describeBattleEffects(snap).filter((row) => row.group !== 'ability')
    assert.equal(rows.length, total, 'no effect is dropped from the details')
    assert.ok(rows.every((row) => row.description.length > 0 && row.label.length > 0), 'each carries a label and a description')
    assert.deepEqual(effectBalance(snap), { buff, debuff })
  }
  assert.deepEqual(effectBalance({ ...crowdedOwn, status: null, volatiles: [], stages: {} }), { buff: 0, debuff: 0 })
})

test('HUD tags lead with the status condition, then buffs, then debuffs, and spell out stages', () => {
  const rows = hudEffects(crowdedOwn)
  assert.equal(rows.length, 11)
  assert.equal(rows[0].group, 'status')
  const order = rows.slice(1).map((row) => row.polarity)
  assert.deepEqual(order, [...order].sort((a, b) => Number(a === 'debuff') - Number(b === 'debuff')), 'buffs before debuffs')
  assert.ok(!rows.some((row) => row.group === 'ability'), 'the passive ability is not an effect tag')
  const atk = rows.find((row) => row.id === 'stage:atk')!
  assert.equal(atk.short, '推理+2')
  assert.equal(atk.delta, '+2')
  assert.equal(atk.factor, '×2')
  assert.equal(rows.find((row) => row.id === 'stage:def')!.short, '稳健-1')
  assert.equal(rows.find((row) => row.id === 'stage:def')!.factor, '×0.67')
  assert.equal(rows.find((row) => row.id === 'volatile:focus')!.short, '专注')
})
