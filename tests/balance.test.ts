import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT } from '../src/shared/content/index.ts'
import { STORY_CONTENT } from '../src/shared/world/story.ts'

/**
 * Balance guardrails for the current local profile.
 *
 * These are intentionally broad envelopes: they protect the early progression
 * and optional-world economy from silently drifting back to runaway values
 * without freezing individual encounter rewards.
 */
test('progression economy stays inside the intended local balance envelope', () => {
  assert.ok(CONTENT.config.battle.trainerExpMultiplier <= 1.35, 'trainer battles must not over-level the party')
  assert.ok(CONTENT.config.economy.blackoutMoneyLoss <= 0.35, 'blackout must not erase half of a long-session wallet')
  assert.ok(STORY_CONTENT.bounties.reward.moneyPerLevel <= 55, 'repeatable bounties must not outpace story rewards')
  assert.ok(Math.max(...STORY_CONTENT.population.dangerReward) <= 1.6, 'danger scaling must stay below runaway inflation')
})

test('balance changes preserve monotone danger rewards and non-negative progression values', () => {
  const danger = STORY_CONTENT.population.dangerReward
  assert.ok(danger.length > 0)
  for (let i = 1; i < danger.length; i++) {
    assert.ok(danger[i] >= danger[i - 1], `danger reward ${i} must not drop`)
  }
  assert.ok(CONTENT.config.battle.trainerExpMultiplier > 0)
  assert.ok(CONTENT.config.economy.startMoney >= 0)
})
