// The sliced world build (buildWorldAsync) hands the thread back between stages but must produce the very same world.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { GameMap, World } from '../src/shared/types.ts'
import { WORLD_BUILD_STEPS, buildWorld, buildWorldAsync, worldAnchors } from '../src/shared/world/index.ts'
import { digest } from '../src/shared/dev/diff.ts'

const SEED = 20261030

function summary(world: World): string {
  const mapSummary = (m: GameMap) => digest({
    size: [m.width, m.height], spawn: m.spawn, terrain: digest(Array.from(m.terrain)), elevation: digest(Array.from(m.elevation)),
    props: m.props, warps: m.warps, signs: m.signs, npcs: m.npcs.length, items: m.items?.length ?? 0, regions: m.regions.map((r) => r.id),
  })
  return digest({
    maps: Object.fromEntries(Object.entries(world.maps).map(([id, m]) => [id, mapSummary(m)])),
    towns: world.towns, badges: world.badges, quests: world.quests.length, trainers: Object.keys(world.trainers).sort(), anchors: worldAnchors(world),
  })
}

test('buildWorldAsync: same world as buildWorld, one hand-back per step, progress ends at 1; a slice budget batches the steps', async () => {
  const sync = buildWorld(SEED)
  let handBacks = 0
  const progress: number[] = []
  const async_ = await buildWorldAsync(SEED, { sliceMs: 0, yieldNow: async () => { handBacks++ }, onProgress: (p) => progress.push(p) })
  assert.equal(summary(async_), summary(sync), 'identical generated world')
  assert.equal(handBacks, WORLD_BUILD_STEPS, 'WORLD_BUILD_STEPS is the real number of steps (update it when a yield is added)')
  assert.equal(progress.at(-1), 1)
  assert.ok(progress.every((p, i) => i === 0 || p >= progress[i - 1]), 'progress never goes back')
  assert.ok(async_.maps[async_.startMap].infinite, 'the unbounded frontier is attached')

  handBacks = 0
  const batched = await buildWorldAsync(SEED, { sliceMs: 1e9, yieldNow: async () => { handBacks++ } })
  assert.equal(handBacks, 0, 'one huge slice never hands back')
  assert.equal(summary(batched), summary(sync))
})
