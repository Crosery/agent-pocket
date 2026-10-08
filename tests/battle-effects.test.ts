import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT } from '../src/shared/content/index.ts'
import { battleStatGlossary, describeBattleEffects, effectBalance, effectCount, hudEffects, type BattleStatusSnapshot } from '../src/client/battle/effect-details.ts'

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

test('the in-game stat glossary names all basic abilities with actionable meanings', () => {
  const glossary = battleStatGlossary()
  assert.deepEqual(glossary.map((row) => row.key), ['hp', 'atk', 'def', 'spa', 'spd', 'spe', 'acc', 'eva'])
  for (const row of glossary) assert.ok(row.description.length > 8, row.key)
  assert.match(glossary.find((row) => row.key === 'hp')?.description ?? '', /归零/)
  assert.match(glossary.find((row) => row.key === 'spe')?.description ?? '', /先手|出手/)
  assert.ok(CONTENT.text['battleui.effects.empty'])
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
