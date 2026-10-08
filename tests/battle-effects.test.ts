import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT } from '../src/shared/content/index.ts'
import { battleStatGlossary, describeBattleEffects, effectCount, type BattleStatusSnapshot } from '../src/client/battle/effect-details.ts'

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
