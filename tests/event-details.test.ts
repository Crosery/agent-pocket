import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT } from '../src/shared/content/index.ts'
import { GAMEPLAY } from '../src/shared/gameplay/data.ts'
import type { ActiveEvent } from '../src/shared/gameplay/events.ts'
import { eventBenefits } from '../src/client/world/event-details.ts'

const active = (id: string): ActiveEvent => ({
  id, def: GAMEPLAY.eventById[id], startedAt: 100, endsAt: 100 + GAMEPLAY.eventById[id].durationMinutes,
})

test('Token rain details show the real 1.5x bonus and collectable loot, not a guaranteed automatic payout', () => {
  const benefits = eventBenefits(active('token-rain'), 101)
  assert.ok(benefits.some(b => b.label === '对战奖金' && b.value === '×1.5' && b.kind === 'gain'))
  assert.ok(benefits.some(b => b.label === '附近可拾取' && b.value === `${CONTENT.items['data-shard'].nameZh} ×6`))
  assert.ok(benefits.some(b => b.label === '附近可搜寻（隐藏）' && b.value === `${CONTENT.items['gold-token'].nameZh} ×1`))
})

test('negative effects and category restrictions remain visible instead of being advertised as rewards', () => {
  const benefits = eventBenefits(active('gpu-shortage'), 101)
  assert.ok(benefits.some(b => b.label === '捕捉球、药品 · 商店售价' && b.value === '×1.5' && b.kind === 'cost'))
  assert.ok(benefits.some(b => b.label.includes('出现权重') && b.value === '×0.3' && b.kind === 'cost'))
})

test('discounts, rare-encounter boosts and trainer winnings use actual event rules', () => {
  assert.ok(eventBenefits(active('distillation-wave'), 101).some(b => b.label === '捕捉球 · 商店售价' && b.value === '×0.8' && b.kind === 'gain'))
  const benefits = eventBenefits(active('benchmark-tournament'), 101)
  assert.ok(benefits.some(b => b.label === '对战经验' && b.value === '×1.3'))
  assert.ok(benefits.some(b => b.value.includes('基础奖金 3000')))
})

test('NPC and quiz rewards list their real items and quantities as conditional, never automatic payouts', () => {
  const spring = eventBenefits(active('spring-festival'), 101)
  assert.ok(spring.some(b => b.label.includes('条件奖励') && b.value === '888 Token 币'))
  assert.ok(spring.some(b => b.label.includes('条件奖励') && b.value === `${CONTENT.items['rare-ball'].nameZh} ×2`))
  const quiz = eventBenefits(active('pi-day'), 101)
  assert.ok(quiz.some(b => b.label.includes('条件奖励') && b.value === `${CONTENT.items['rare-dataset'].nameZh} ×1`))
})

test('expired timed effects and ended events no longer claim bonuses', () => {
  const ev = active('token-rain')
  ev.def = { ...ev.def, effects: [
    { kind: 'modifier', target: 'exp', multiplier: 2, minutes: 5 },
    { kind: 'modifier', target: 'money', multiplier: 1.5, minutes: 0 },
  ] }
  assert.equal(eventBenefits(ev, 104).length, 2)
  assert.deepEqual(eventBenefits(ev, 105), [{ label: '对战奖金', value: '×1.5', kind: 'gain' }])
  assert.deepEqual(eventBenefits(ev, ev.endsAt), [])
})

test('all activity benefit labels and selectors resolve without leaking translation keys', () => {
  for (const def of GAMEPLAY.events) {
    const benefits = eventBenefits({ id: def.id, def, startedAt: 0, endsAt: def.durationMinutes }, 1)
    for (const b of benefits) {
      assert.ok(!b.label.includes('hud.events.') && !b.value.includes('hud.events.'), `${def.id}: ${b.label} ${b.value}`)
      assert.ok(b.label && b.value)
    }
  }
})
