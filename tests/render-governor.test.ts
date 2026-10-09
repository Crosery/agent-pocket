import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RENDER, governedPreset, governedScaleBias, qualityPreset, validateRenderContent } from '../src/client/render/config.ts'
import { createGovernor, type GovernorConfig } from '../src/client/render/governor.ts'

const CFG: GovernorConfig = RENDER.governor

/** Feeds `windows` full windows of identical frames; returns the levels the governor reported. */
function run(g: ReturnType<typeof createGovernor>, windows: number, interval: number, work: number, clock: { t: number }): number[] {
  const out: number[] = []
  for (let w = 0; w < windows; w++) {
    for (let i = 0; i < CFG.windowFrames; i++) {
      clock.t += interval / 1000
      const r = g.feed(interval, work, clock.t)
      if (r !== null) out.push(r)
    }
  }
  return out
}

test('governor: steady 60 fps with cheap frames never changes the level', () => {
  const g = createGovernor(CFG, RENDER.governor.steps.length)
  const clock = { t: 100 }
  assert.deepEqual(run(g, 30, 16.7, 4, clock), [])
  assert.equal(g.level, 0)
})

test('governor: sustained slow windows shed one step at a time, with a cooldown between steps', () => {
  const g = createGovernor(CFG, 4)
  const clock = { t: 100 }
  const seen = run(g, 12, 38, 30, clock)
  assert.deepEqual(seen.slice(0, 2), [1, 2], 'steps shed in order')
  assert.ok(g.level >= 2)
  // two windows of ~3.4 s each are needed per step, and the cooldown (5 s) sits between steps
  assert.ok(seen.length < 12)
})

test('governor: a single slow window (a streaming hitch) does not shed', () => {
  const g = createGovernor(CFG, 4)
  const clock = { t: 100 }
  run(g, 1, 38, 30, clock)
  run(g, 1, 16.7, 4, clock)
  run(g, 1, 38, 30, clock)
  assert.equal(g.level, 0)
})

test('governor: frames capped at 30 Hz by power saving but cheap to draw are not treated as slow', () => {
  const g = createGovernor(CFG, 4)
  const clock = { t: 100 }
  assert.deepEqual(run(g, 20, 33.4, 5, clock), [])
})

test('governor: long gaps (tab switch, loading) are not measured', () => {
  const g = createGovernor(CFG, 4)
  const clock = { t: 100 }
  for (let i = 0; i < CFG.windowFrames * 6; i++) { clock.t += 1; assert.equal(g.feed(CFG.skipAboveMs + 1, 50, clock.t), null) }
  assert.equal(g.level, 0)
})

test('governor: headroom restores a step, but shedding right after a restore locks the level', () => {
  const g = createGovernor(CFG, 4)
  const clock = { t: 100 }
  run(g, 8, 38, 30, clock)
  const shed = g.level
  assert.ok(shed >= 1)
  const up = run(g, CFG.upWindows + 6, 16.7, 3, clock)
  assert.ok(up.length >= 1 && g.level < shed, 'restores one step after upWindows fast windows')
  const afterRestore = g.level
  run(g, 4, 38, 30, clock) // slow again right away: shed once more ...
  assert.ok(g.level > afterRestore)
  const locked = g.level
  run(g, CFG.upWindows * 2, 16.7, 3, clock) // ... and now the upLock keeps it there for a while
  assert.equal(g.level, locked)
})

test('governor: disabled or with no steps it stays at level 0', () => {
  const off = createGovernor({ ...CFG, enabled: false }, 4)
  const none = createGovernor(CFG, 0)
  const clock = { t: 100 }
  assert.deepEqual(run(off, 10, 60, 50, clock), [])
  assert.deepEqual(run(none, 10, 60, 50, clock), [])
})

test('governor steps layer onto the tier and leave level 0 untouched', () => {
  const high = qualityPreset('high')
  assert.equal(governedPreset(high, 0), high)
  const g1 = governedPreset(high, 1)
  assert.equal(g1.shadowHz, RENDER.governor.steps[0].shadowHz)
  assert.equal(g1.viewRadius, high.viewRadius, 'untouched keys read through')
  const all = governedPreset(high, RENDER.governor.steps.length)
  assert.equal(all.dof, false)
  assert.equal(all.bloom, false)
  assert.equal(governedScaleBias(0), 0)
  assert.ok(governedScaleBias(RENDER.governor.steps.length) >= 1)
  assert.equal(high.dof, true, 'the tier itself is never modified')
})

test('render.json governor and device sections validate; bad data is reported', () => {
  assert.deepEqual(validateRenderContent(), [])
  const bad = { ...RENDER, governor: { ...RENDER.governor, upBelowMs: RENDER.governor.downAboveMs + 1, steps: [{ nope: 1 } as never] }, device: { ...RENDER.device, touchMinInternalHeight: 0 } }
  const errs = validateRenderContent(bad)
  assert.ok(errs.some((e) => e.includes('flap')), errs.join('\n'))
  assert.ok(errs.some((e) => e.includes('unknown key')))
  assert.ok(errs.some((e) => e.includes('touchMinInternalHeight')))
})
