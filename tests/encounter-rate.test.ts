import assert from 'node:assert/strict'
import test from 'node:test'
import { GAME, grassEncounterRate } from '../src/client/world/config.ts'

test('grass encounters use the reduced comfort rate while preserving event modifiers', () => {
  assert.equal(GAME.encounters.grassRateMultiplier, 0.45)
  assert.ok(Math.abs(grassEncounterRate(0.1) - 0.045) < 1e-12)
  assert.ok(Math.abs(grassEncounterRate(0.1, 2) - 0.09) < 1e-12)
  assert.ok(Math.abs(grassEncounterRate(2) - 0.9) < 1e-12)
})
