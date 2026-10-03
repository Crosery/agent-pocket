import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT } from '../src/shared/content/index.ts'
import type { MoveAnim } from '../src/shared/types.ts'
import {
  FX_PRIMITIVES, STAGE, expandSteps, stepDuration, timelineLength, validateBattleStageContent, type VfxStep,
} from '../src/client/render/battle/config.ts'
import { buildDioramaMap } from '../src/client/render/battle/layout.ts'
import { createScheduler, ease, envelope, outAndBack } from '../src/client/render/battle/timeline.ts'

const ALL_ANIMS: Record<MoveAnim, true> = {
  hit: true, slash: true, beam: true, orb: true, burst: true, wave: true, rain: true, shield: true, heal: true, buff: true,
  debuff: true, glitch: true, code: true, lightning: true, fire: true, ice: true, sound: true, light: true, dark: true,
  wind: true, quake: true, spark: true,
}

test('battle-stage.json is consistent with CONTENT and render.json', () => {
  const errs = validateBattleStageContent()
  assert.deepEqual(errs, [], errs.join('\n'))
})

test('every MoveAnim has a VFX timeline and every primitive is exercised', () => {
  for (const a of Object.keys(ALL_ANIMS)) assert.ok(STAGE.timelines.anims[a]?.length, `anim "${a}" has no timeline`)
  const used = new Set<string>()
  const walk = (n: unknown) => {
    if (Array.isArray(n)) n.forEach(walk)
    else if (n && typeof n === 'object') for (const [k, v] of Object.entries(n)) { if (k === 'fx' && typeof v === 'string') used.add(v); else walk(v) }
  }
  walk(STAGE.timelines)
  const unused = FX_PRIMITIVES.filter((p) => !used.has(p))
  assert.deepEqual(unused, [], `primitives never used by any timeline: ${unused.join(', ')}`)
})

test('attack timelines resolve in a snappy window for every category', () => {
  for (const [anim, steps] of Object.entries(STAGE.timelines.anims)) {
    for (const cat of ['physical', 'special', 'status'] as const) {
      const len = timelineLength(expandSteps(steps, cat))
      assert.ok(len >= 0.45 && len <= 1.0, `${anim}/${cat}: ${len.toFixed(2)}s outside 0.45..1.0`)
    }
  }
})

test('snippets expand with time offsets and category filtering', () => {
  const steps: VfxStep[] = [
    { t: 0.2, use: 'lunge', when: ['physical'] },
    { t: 0.1, fx: 'flash', ms: 100, when: ['special'] },
  ]
  const phys = expandSteps(steps, 'physical')
  assert.ok(phys.length >= 1 && phys.every((s) => (s.t ?? 0) >= 0.2 && s.fx !== 'flash'))
  const spec = expandSteps(steps, 'special')
  assert.equal(spec.length, 1)
  assert.equal(spec[0].fx, 'flash')
  assert.equal(stepDuration({ fx: 'flash', ms: 250 }), 0.25)
})

test('diorama maps keep the creature / trainer spots clear and only use known terrain + props', () => {
  const biomes = [...CONTENT.biomes.map((b) => [b.id, false] as const), [CONTENT.biomes[0].id, true] as const]
  for (const [biome, indoor] of biomes) {
    const { map, origin } = buildDioramaMap(biome, indoor)
    assert.equal(map.terrain.length, map.width * map.height)
    for (const id of map.terrain) assert.ok(CONTENT.terrain[id], `${biome}: unknown terrain id ${id}`)
    for (const p of map.props) assert.ok(CONTENT.props[p.prop], `${biome}: unknown prop ${p.prop}`)
    for (const sl of STAGE.slots) {
      for (const [sx, sz] of [sl.creature, sl.trainer]) {
        const tx = Math.floor(origin.x + sx), ty = Math.floor(origin.z + sz)
        const t = CONTENT.terrain[map.terrain[ty * map.width + tx]]
        assert.ok(t.walkable && !t.liquid, `${biome}${indoor ? ' indoor' : ''}: slot spot ${sx},${sz} is on ${t.key}`)
        for (const p of map.props) {
          const [fw, fd] = CONTENT.props[p.prop].footprint
          const inside = tx >= p.x && tx < p.x + fw && ty >= p.y && ty < p.y + fd
          assert.ok(!inside, `${biome}: prop ${p.prop} stands on slot spot ${sx},${sz}`)
        }
      }
    }
    // deterministic
    const again = buildDioramaMap(biome, indoor)
    assert.deepEqual(again.map.props, map.props)
  }
})

test('scheduler resolves waits and tasks in stage time', async () => {
  const s = createScheduler()
  const order: string[] = []
  s.at(0.3, () => order.push('b'))
  s.at(0.1, () => order.push('a'))
  let done = false
  void s.wait(0.25).then(() => { done = true })
  s.advance(0.2)
  assert.deepEqual(order, ['a'])
  s.advance(0.1)
  await Promise.resolve()
  assert.deepEqual(order, ['a', 'b'])
  assert.equal(done, true)
  let flushed = false
  void s.wait(10).then(() => { flushed = true })
  s.flush()
  await Promise.resolve()
  assert.equal(flushed, true)
  assert.equal(s.pending, 0)
})

test('easing helpers stay in range', () => {
  for (let i = 0; i <= 20; i++) {
    const k = i / 20
    assert.ok(ease.inOutCubic(k) >= 0 && ease.inOutCubic(k) <= 1)
    assert.ok(outAndBack(k, 0.35) >= 0 && outAndBack(k, 0.35) <= 1)
    assert.ok(envelope(k, 0.2, 0.3) >= 0 && envelope(k, 0.2, 0.3) <= 1)
  }
  assert.equal(outAndBack(0.35, 0.35), 1)
  assert.ok(Math.abs(outAndBack(1, 0.35)) < 1e-9)
})
