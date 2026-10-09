import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tagOverSprite, type SpriteFootprint } from '../src/client/render/world/overlay.ts'

const tag = { left: 90, right: 130, top: 80, bottom: 92 }
const sprite = (x: number, top: number, bottom: number, on = true): SpriteFootprint => ({ x, top, bottom, on })

test('a name tag over the follower behind the player is flagged, its own sprite is not', () => {
  const player = sprite(110, 96, 150)
  const follower = sprite(112, 40, 100)
  assert.equal(tagOverSprite(tag, [player, follower], 2, 0, 0.42), true)
  assert.equal(tagOverSprite(tag, [player], 1, 0, 0.42), false, 'a sprite never dims its own tag')
})

test('sprites beside, below or hidden never dim the tag', () => {
  assert.equal(tagOverSprite(tag, [sprite(10, 40, 100), sprite(110, 110, 160)], 2, -1, 0.42), false, 'far to the side / entirely below the tag')
  assert.equal(tagOverSprite(tag, [sprite(110, 40, 100, false)], 1, -1, 0.42), false, 'a hidden actor')
})

test('the half-width fraction sets how far beside a sprite the tag still counts as over it', () => {
  const s = [sprite(200, 40, 140)]
  assert.equal(tagOverSprite(tag, s, 1, -1, 0.42), false)
  assert.equal(tagOverSprite(tag, s, 1, -1, 1.2), true)
})
