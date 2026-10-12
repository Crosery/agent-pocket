import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GAMEPLAY } from '../src/shared/gameplay/data.ts'
import type { ActiveEvent } from '../src/shared/gameplay/events.ts'
import { eventBenefits } from '../src/client/world/event-details.ts'

const active = (id: string): ActiveEvent => ({
  id, def: GAMEPLAY.eventById[id], startedAt: 100, endsAt: 100 + GAMEPLAY.eventById[id].durationMinutes,
})

test('shop surcharges are costs and discounts are gains', () => {
  const ev = active('gpu-shortage')
  ev.def = { ...ev.def, effects: [{ kind: 'modifier', target: 'shopPrice', multiplier: 1.5, minutes: 0 }] }
  assert.deepEqual(eventBenefits(ev, 101).map((b) => b.kind), ['cost'])
  ev.def = { ...ev.def, effects: [{ kind: 'modifier', target: 'shopPrice', multiplier: 0.8, minutes: 0 }] }
  assert.deepEqual(eventBenefits(ev, 101).map((b) => b.kind), ['gain'])
})

test('expired timed effects and ended events no longer claim bonuses', () => {
  const ev = active('token-rain')
  ev.def = { ...ev.def, effects: [
    { kind: 'modifier', target: 'exp', multiplier: 2, minutes: 5 },
    { kind: 'modifier', target: 'money', multiplier: 1.5, minutes: 0 },
  ] }
  const beforeExpiry = eventBenefits(ev, 104)
  assert.equal(beforeExpiry.length, 2)
  assert.deepEqual(eventBenefits(ev, 105), [beforeExpiry[1]])
  assert.deepEqual(eventBenefits(ev, ev.endsAt), [])
})

