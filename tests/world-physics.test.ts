// World physics feedback: shared wind field, trample map decay, physical leaves, render.json physics validation.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { CONTENT } from '../src/shared/content/index.ts'
import { RENDER, validateRenderContent, type RenderContent } from '../src/client/render/config.ts'
import { gustAt, updateWind, windState, windUniforms, windVelocity } from '../src/client/render/world/wind.ts'
import { createTrampleField, trampleUniforms } from '../src/client/render/world/trample.ts'
import { createLeafSystem } from '../src/client/render/world/leaves.ts'

const DT = 1 / 30

test('wind: gusts stay in 0..1, travel along the wind direction and pulse the air speed', () => {
  updateWind(0, 1)
  const dir = windUniforms.uWindDir.value
  let lo = Infinity, hi = -Infinity
  for (let t = 0; t < 60; t += 0.7) for (let x = -40; x <= 40; x += 3.3) for (let z = -40; z <= 40; z += 3.3) {
    const g = gustAt(x, z, t)
    assert.ok(g >= 0 && g <= 1 + 1e-9, `gust ${g} out of range`)
    lo = Math.min(lo, g); hi = Math.max(hi, g)
  }
  assert.ok(hi - lo > 0.5, 'gusts have calm gaps and strong fronts')
  // a front keeps its shape while it moves at wind.field.speed along the direction (the slow envelope aside, compare the front itself)
  const F = RENDER.wind.field
  const dt = 1.7
  const a = gustAt(3, 5, 10) / (F.calm + (1 - F.calm) * (0.5 + 0.5 * Math.sin(F.envelopeRate * 10 + F.envelopeSpace * (3 * dir.x + 5 * dir.y))))
  const x2 = 3 + dir.x * F.speed * dt, z2 = 5 + dir.y * F.speed * dt
  const b = gustAt(x2, z2, 10 + dt) / (F.calm + (1 - F.calm) * (0.5 + 0.5 * Math.sin(F.envelopeRate * (10 + dt) + F.envelopeSpace * (x2 * dir.x + z2 * dir.y))))
  assert.ok(Math.abs(a - b) < 1e-6, `front did not travel with the wind: ${a} vs ${b}`)
  // air speed pulses around the base speed, along the wind direction
  const W = RENDER.wind, out = { x: 0, z: 0 }
  let slow = Infinity, fast = -Infinity
  for (let t = 0; t < 40; t += 0.25) {
    windVelocity(7, -3, t, 1, out)
    const s = Math.hypot(out.x, out.z)
    slow = Math.min(slow, s); fast = Math.max(fast, s)
    assert.ok(out.x * dir.x + out.z * dir.y > 0, 'blows with the wind')
  }
  assert.ok(slow >= W.drift.base * (1 - W.drift.gust) - 1e-9 && fast <= W.drift.base * (1 + W.drift.gust) + 1e-9, 'speed stays within base +- gust share')
  assert.ok(fast - slow > 0.2 * W.drift.base, 'and it pulses')
  // storms blow harder
  updateWind(0, 2)
  windVelocity(7, -3, 0, 1, out)
  const storm = Math.hypot(out.x, out.z)
  updateWind(0, 1)
  windVelocity(7, -3, 0, 1, out)
  assert.ok(Math.abs(storm - 2 * Math.hypot(out.x, out.z)) < 1e-9, 'strength multiplier scales the air speed')
  assert.equal(windState.strengthMul, 1)
})

test('trample: grass bends away from the walker, the trail lingers, then springs back; far cells are forgotten', () => {
  const T = RENDER.grass.trample
  const field = createTrampleField()
  try {
    const tex = trampleUniforms.uTrample.value as THREE.DataTexture
    const data = tex.image.data as Uint8Array
    const N = Math.round(T.window * T.cellsPerTile)
    const cell = (gx: number, gz: number) => { const o = (((gz % N) + N) % N * N + ((gx % N) + N) % N) * 4; return { bx: (data[o] - 127) / 127, bz: (data[o + 1] - 127) / 127, sink: data[o + 2] / 255 } }
    const at = (x: number, z: number) => cell(Math.floor(x * T.cellsPerTile), Math.floor(z * T.cellsPerTile))
    const walker = { x: 200.5, y: 0, z: 300.5, r: 1 }
    field.update(1 / 60, walker.x, walker.z, [walker])
    const east = at(walker.x + 0.5, walker.z), west = at(walker.x - 0.5, walker.z)
    assert.ok(east.bx > 0.2 && west.bx < -0.2, `bend must point away from the walker (east ${east.bx}, west ${west.bx})`)
    assert.ok(east.sink > 0, 'and flatten')
    // walker leaves: the bend lingers, then fades
    walker.x += 3
    field.update(1 / 60, walker.x, walker.z, [walker])
    const early = at(200.5 + 0.5, 300.5).sink
    assert.ok(early > 0.5 * east.sink, 'the trail does not vanish the instant the walker is gone')
    let prev = early
    for (let t = 0; t < T.recoverSec * 2; t += 1 / 30) {
      field.update(1 / 30, walker.x, walker.z, [])
      const s = at(200.5 + 0.5, 300.5).sink
      assert.ok(s <= prev + 1e-9, 'recovery only goes one way')
      prev = s
    }
    assert.equal(prev, 0, 'the grass stands up again')
    // a focus jump across the window wipes the stale cells
    field.update(1 / 60, walker.x, walker.z, [walker])
    field.update(1 / 60, walker.x + 5000, walker.z, [])
    assert.equal(at(walker.x, walker.z).sink, 0, 'cells of a far-away spot are gone')
  } finally { field.dispose() }
})

test('leaves: shed from canopies, fall and land, lie there and fade; the live count honours the tier cap', () => {
  const sys = createLeafSystem(60)
  const kind = Object.keys(RENDER.leaves.kinds)[0]
  const def = RENDER.leaves.kinds[kind]
  const canopy = { x: 10, y: 0, z: 10, r: 1.4, h: 3, key: def.props[0] }
  const focus = new THREE.Vector3(10, 0, 10)
  const light = new THREE.Color(1, 1, 1)
  try {
    sys.setGround(() => 0, () => false)
    sys.setLimit(25)
    sys.setLevels({ [kind]: 1 })
    sys.setCanopies([canopy])
    let t = 0, peak = 0, landed = 0
    const aFade = sys.mesh.geometry.getAttribute('aFade') as THREE.BufferAttribute
    const m = new THREE.Matrix4(), p = new THREE.Vector3()
    for (; t < 40; t += DT) {
      updateWind(t, 1)
      sys.update(DT, t, focus, light)
      peak = Math.max(peak, sys.stats.live)
      assert.ok(sys.stats.live <= 25, `tier cap exceeded: ${sys.stats.live}`)
    }
    assert.ok(peak > 5, `canopy shed only ${peak} leaves`)
    for (let i = 0; i < sys.mesh.count; i++) {
      if (aFade.getX(i) <= 0) continue
      sys.mesh.getMatrixAt(i, m)
      p.setFromMatrixPosition(m)
      assert.ok(p.y >= -0.02 && p.y <= canopy.h + 0.5, `leaf at height ${p.y}`)
      assert.ok(Math.hypot(p.x - canopy.x, p.z - canopy.z) < RENDER.leaves.cull, 'leaf drifted beyond the cull range')
      if (p.y < 0.1) landed++
    }
    assert.ok(landed > 0, 'some leaves lie on the ground')
    // trees go away: everything lands, rests and fades
    sys.setCanopies([])
    sys.setLevels({})
    // (the ambient level eases out, so a few more may still be shed first)
    const settle = RENDER.leaves.rest[1] + RENDER.leaves.fade + RENDER.leaves.cull + 30
    const t1 = t
    while (sys.stats.live > 0 && t - t1 < settle) { t += DT; updateWind(t, 1); sys.update(DT, t, focus, light) }
    assert.equal(sys.stats.live, 0, `${sys.stats.live} leaves still alive ${(t - t1).toFixed(0)} s after the trees went away`)
    // tier off: nothing spawns
    sys.setLimit(0)
    sys.setLevels({ [kind]: 1 })
    sys.setCanopies([canopy])
    for (let i = 0; i < 300; i++) { t += DT; sys.update(DT, t, focus, light) }
    assert.equal(sys.stats.live, 0, 'limit 0 keeps the system off')
  } finally { sys.dispose() }
})

test('render.json physics sections: every quality tier is defined and bad data is reported', () => {
  assert.deepEqual(validateRenderContent(), [])
  const bad: RenderContent = structuredClone(RENDER)
  delete bad.physics.tiers.low
  bad.footsteps.terrain.path = 'nonexistent'
  bad.footsteps.classes.dirt.puff = 'noPuff'
  bad.leaves.kinds.petals.props = ['no_such_prop']
  bad.reflections.alpha = 3
  bad.physics.tiers.high.ripples = 99
  const errs = validateRenderContent(bad, CONTENT)
  for (const needle of ['physics.tiers: missing quality "low"', 'unknown class "nonexistent"', 'unknown puff "noPuff"', 'unknown prop "no_such_prop"', 'reflections.alpha', 'at most 24 rings']) {
    assert.ok(errs.some((e) => e.includes(needle)), `validation missed: ${needle}\n${errs.join('\n')}`)
  }
  // the low tier turns the expensive effects off
  const low = RENDER.physics.tiers.low
  assert.ok(!low.reflections && !low.trample && low.leaves === 0 && low.ripples === 0 && low.printPool === 0, 'lowest tier disables the costly effects')
})
