// The world map's selected-place card (placeinfo.ts): what a place offers, and a distance a player can read.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SaveData } from '../src/shared/types.ts'
import { CONTENT, t } from '../src/shared/content/index.ts'
import { buildWorld } from '../src/shared/world/index.ts'
import { createSaveManager } from '../src/client/core/save.ts'
import { humanDistance, placeFacts } from '../src/client/ui/screens/placeinfo.ts'
import { SCREENS } from '../src/client/ui/screens/config.ts'

const world = buildWorld()
const memory = () => {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, removeItem: (k: string) => { m.delete(k) } }
}
const saves = createSaveManager({ world, storage: memory(), now: () => 1_700_000_000_000, newId: () => '00000000-0000-4000-8000-000000000001' })
const avatar = CONTENT.characters.find((c) => c.playable)!
const fresh = (): SaveData => saves.newGame({ name: avatar.nameZh, avatar: avatar.id })
const town = (id: string) => world.towns.find((x) => x.id === id)!

test('a town lists the services of its own interiors, its gym and the wild levels', () => {
  const save = fresh()
  const origin = placeFacts(world, save, town('origin'))
  assert.deepEqual(origin.services.sort(), SCREENS.worldMap.panel.services.map((s) => s.id).sort(), 'the start town has a healer and a shop')
  assert.equal(origin.gym, null, 'no gym in the start town')
  assert.deepEqual(origin.levels, town('origin').levelRange)
  const badge = world.badges[0]
  const gymTown = placeFacts(world, save, town(badge.town))
  assert.equal(gymTown.gym?.badge.id, badge.id)
  assert.equal(gymTown.gym?.won, false)
  save.badges.push(badge.id)
  assert.equal(placeFacts(world, save, town(badge.town)).gym?.won, true, 'the badge flips the gym to won')
})

test('an open quest objective marks the place it points at, a finished one does not', () => {
  const save = fresh()
  save.quests.main = { stage: 0, done: false }
  const target = world.quests.find((q) => q.id === 'main')!.stages[0].target!
  const near = world.towns.filter((x) => x.map === world.startMap && Math.hypot(x.x - target.x, x.y - target.y) <= SCREENS.worldMap.panel.questRadius)
  assert.ok(near.length > 0, 'the first objective is in a town')
  assert.ok(near.every((x) => placeFacts(world, save, x).quest))
  save.quests.main = { stage: 0, done: true }
  assert.ok(near.every((x) => !placeFacts(world, save, x).quest))
})

test('distances read in tiles, then in thousands', () => {
  assert.equal(humanDistance(21.4), t('screens.map.distTiles', { n: 21 }))
  const far = SCREENS.worldMap.panel.farAbove
  assert.equal(humanDistance(far - 1), t('screens.map.distTiles', { n: far - 1 }))
  assert.equal(humanDistance(1530), t('screens.map.distFar', { n: '1.5' }))
})
