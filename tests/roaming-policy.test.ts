import assert from 'node:assert/strict'
import test from 'node:test'
import { roamingDisposition } from '../src/shared/gameplay/spawns.ts'

test('country roaming policy keeps domestic creatures neutral', () => {
  assert.equal(roamingDisposition('CN', 4, 99), 'neutral')
  assert.equal(roamingDisposition(' cn ', 40, 1), 'neutral')
})

test('US creatures chase until the strongest party member outlevels them', () => {
  assert.equal(roamingDisposition('US', 8, 8), 'chase')
  assert.equal(roamingDisposition('US', 8, 7), 'chase')
  assert.equal(roamingDisposition('US', 8, 9), 'flee')
})

test('other countries stay neutral until the player has a level advantage', () => {
  assert.equal(roamingDisposition('DE', 8, 8), 'neutral')
  assert.equal(roamingDisposition('JP', 8, 7), 'neutral')
  assert.equal(roamingDisposition(undefined, 8, 9), 'flee')
})
