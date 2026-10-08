// Overworld motion feel: sprite cards on the soles, camera settling after a stop, follower personal space.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import pipeline from '../assets_src/pipeline.json' with { type: 'json' }
import { CONTENT } from '../src/shared/content/index.ts'
import type { Creature, GameMap } from '../src/shared/types.ts'
import type { CreatureActor, GameContext } from '../src/client/contracts.ts'
import { RENDER } from '../src/client/render/config.ts'
import { createCameraRig } from '../src/client/render/world/camera.ts'
import { createFollower } from '../src/client/world/follower.ts'
import { GAME } from '../src/client/world/config.ts'

const DT = 1 / 60

test('sprite cards stand on the soles: render.json footInset matches the asset pipeline bottom margins', () => {
  assert.equal(RENDER.actors.footInset, pipeline.sheet.bottomMargin)
  assert.equal(RENDER.creatures.footInset, pipeline.creature.bottomMargin)
})

test('camera: after the player stops the view neither drifts on ahead nor swings back past the player', () => {
  const rig = createCameraRig()
  rig.setBounds(null, false)
  const focus = new THREE.Vector3(0, 0, 0)
  rig.snap(focus)
  for (let i = 0; i < 120; i++) { focus.x += CONTENT.config.movement.walkSpeed * DT; rig.update(DT, focus) }
  const atStop = rig.target.x - focus.x
  let maxAhead = atStop, minAhead = atStop
  for (let i = 0; i < 180; i++) {
    rig.update(DT, focus)
    maxAhead = Math.max(maxAhead, rig.target.x - focus.x)
    minAhead = Math.min(minAhead, rig.target.x - focus.x)
  }
  assert.ok(maxAhead - atStop < 0.15, `view kept drifting ${(maxAhead - atStop).toFixed(2)} tiles ahead after the stop`)
  assert.ok(minAhead > -0.05, `view swung ${(-minAhead).toFixed(2)} tiles behind the stopped player`)
  assert.ok(Math.abs(rig.target.x - focus.x) < 0.05, 'view settles on the player')
})

test('follower: a reversal never walks the player through it; it steps round the far (north) side', () => {
  const stub = (): CreatureActor => {
    const a = {
      object: new THREE.Group(), x: 0, y: 0, elev: 0, speciesId: '',
      setPosition(x: number, y: number) { a.x = x; a.y = y },
      setFacingLeft() {}, setMoving() {}, setVisible() {}, setShiny() {}, setAura() {}, bubble() {}, update() {}, dispose() {},
    }
    return a
  }
  const ctx = { data: CONTENT, world: { createCreatureActor: stub, elevationAt: () => 0 } } as unknown as GameContext
  const species = Object.values(CONTENT.species).find((s) => (s.size ?? 1) === 1)!
  const f = createFollower(ctx)
  f.sync({ speciesId: species.id, shiny: false } as Creature, { kind: 'overworld' } as GameMap)
  f.setShown(true)
  let px = 10.5
  const py = 10.5
  f.reset(px, py, 0, 'right')
  const speed = CONTENT.config.movement.walkSpeed
  for (let i = 0; i < 90; i++) { px += speed * DT; f.update(DT, px, py, 0, 'right', false) }
  let minGap = Infinity, crossedNorth = true
  for (let i = 0; i < 150; i++) {
    px -= speed * DT
    f.update(DT, px, py, 0, 'left', false)
    minGap = Math.min(minGap, Math.hypot(f.x - px, f.y - py))
    if (Math.abs(f.x - px) < 0.2 && f.y > py - 0.2) crossedNorth = false
  }
  assert.ok(minGap >= GAME.follower.minGap - 1e-6, `follower came within ${minGap.toFixed(2)} tiles of the player`)
  assert.ok(crossedNorth, 'follower passed the player on the camera side')
  assert.ok(f.x > px + GAME.follower.minGap, 'follower ends up behind the player again')
})

function followerRig(size: number, canStand?: (x: number, y: number) => boolean) {
  const stub = (): CreatureActor => {
    const a = {
      object: new THREE.Group(), x: 0, y: 0, elev: 0, speciesId: '',
      setPosition(x: number, y: number) { a.x = x; a.y = y },
      setFacingLeft() {}, setMoving() {}, setVisible() {}, setShiny() {}, setAura() {}, bubble() {}, update() {}, dispose() {},
    }
    return a
  }
  const ctx = { data: CONTENT, world: { createCreatureActor: stub, elevationAt: () => 0 } } as unknown as GameContext
  const species = Object.values(CONTENT.species).reduce((a, b) => (Math.abs((b.size ?? 1) - size) < Math.abs((a.size ?? 1) - size) ? b : a))
  const f = createFollower(ctx, canStand ? { canStand } : {})
  f.sync({ speciesId: species.id, shiny: false } as Creature, { kind: 'overworld' } as GameMap)
  f.setShown(true)
  return { f, size: species.size ?? 1 }
}

test('follower: never jumps across the player in one frame (reversals at walk and run, small and big leads)', () => {
  for (const size of [0.75, 1.5]) {
    for (const speed of [CONTENT.config.movement.walkSpeed, CONTENT.config.movement.runSpeed]) {
      const { f } = followerRig(size)
      let px = 10.5, py = 10.5
      f.reset(px, py, 0, 'right')
      let maxSpeed = 0, lx = f.x, ly = f.y
      const step = (vx: number, vy: number, n: number, facing: 'left' | 'right' | 'up' | 'down') => {
        for (let i = 0; i < n; i++) {
          px += vx * speed * DT; py += vy * speed * DT
          f.update(DT, px, py, 0, facing, false)
          maxSpeed = Math.max(maxSpeed, Math.hypot(f.x - lx, f.y - ly) / DT)
          lx = f.x; ly = f.y
        }
      }
      step(1, 0, 90, 'right'); step(-1, 0, 120, 'left'); step(0, 1, 90, 'down'); step(0, -1, 120, 'up'); step(0, 0, 60, 'up')
      assert.ok(maxSpeed < 2.5 * speed + GAME.follower.sidestepSpeed, `size ${size} at ${speed} tiles/s: follower moved ${maxSpeed.toFixed(1)} tiles/s in one frame`)
    }
  }
})

test('follower: walking north (away from the camera) it trails beside the player, not in front of it', () => {
  const C = GAME.follower.cameraClear
  for (const size of [0.75, 1.5]) {
    const { f, size: s } = followerRig(size)
    const px = 10.5
    let py = 20.5
    f.reset(px, py, 0, 'up')
    for (let i = 0; i < 150; i++) { py -= CONTENT.config.movement.walkSpeed * DT; f.update(DT, px, py, 0, 'up', false) }
    assert.ok(f.y > py, 'still behind (south of) the player')
    assert.ok(Math.abs(f.x - px) >= C.base + C.perSize * s - 0.05, `size ${size}: only ${Math.abs(f.x - px).toFixed(2)} tiles aside`)
  }
})

test('follower: in a 1-tile lane it hangs back along the trail instead of covering the player', () => {
  const C = GAME.follower.cameraClear
  const { f, size } = followerRig(1.5, (x) => Math.floor(x) === 10)
  const px = 10.5
  let py = 20.5
  f.reset(px, py, 0, 'up')
  for (let i = 0; i < 180; i++) { py -= CONTENT.config.movement.walkSpeed * DT; f.update(DT, px, py, 0, 'up', false) }
  const spacing = GAME.follower.distance + GAME.follower.distancePerSize * Math.max(0, size - 1)
  assert.equal(Math.floor(f.x), 10, 'stays in the lane')
  // what it cannot swing aside it makes up by hanging back
  const aside = Math.abs(f.x - px) / (C.base + C.perSize * size)
  const want = spacing + (1 - aside) * (C.dropBack.base + C.dropBack.perSize * size)
  assert.ok(aside < 0.5, `swung ${(aside * 100).toFixed(0)}% aside in a 1-tile lane`)
  assert.ok(f.y - py > 0.9 * want, `only ${(f.y - py).toFixed(2)} tiles behind (want ~${want.toFixed(2)})`)
})

test('follower: arriving facing north (teleport, door) the lead starts beside the player, never over them', () => {
  const C = GAME.follower.cameraClear
  for (const size of [0.75, 1, 1.85]) {
    const { f, size: s } = followerRig(size)
    f.reset(10.5, 10.5, 0, 'up')
    assert.ok(Math.abs(f.x - 10.5) >= C.base + C.perSize * s - 1e-6, `size ${size}: spawned only ${Math.abs(f.x - 10.5).toFixed(2)} tiles aside`)
    assert.ok(f.y >= 10.5 - 1e-6, 'and not ahead of the player')
  }
})

test('follower: critically damped spring, it neither overshoots when the player stops nor jolts when it starts', () => {
  const { f } = followerRig(1)
  let px = 10.5
  f.reset(px, 10.5, 0, 'right')
  const speed = CONTENT.config.movement.walkSpeed
  let lastV = 0, maxJump = 0, lx = f.x
  for (let i = 0; i < 120; i++) {
    px += speed * DT
    f.update(DT, px, 10.5, 0, 'right', false)
    const v = (f.x - lx) / DT
    maxJump = Math.max(maxJump, Math.abs(v - lastV))
    lastV = v; lx = f.x
  }
  // accelerations stay bounded: no single frame changes the follower's speed by more than a quarter of the walk speed
  assert.ok(maxJump < speed * 0.25, `speed jumped by ${maxJump.toFixed(2)} tiles/s in one frame`)
  // the trail is sampled every trailSpacing tiles, so its target carries that much grain
  const grain = GAME.follower.trailSpacing * 0.3
  let prev = f.x, overshoot = 0
  for (let i = 0; i < 180; i++) {
    f.update(DT, px, 10.5, 0, 'right', false)
    assert.ok(f.x >= prev - grain, 'follower never moves back towards where it came from')
    overshoot = Math.max(overshoot, f.x - (px - GAME.follower.distance))
    prev = f.x
  }
  assert.ok(overshoot < grain, `overshot its rest spot by ${overshoot.toFixed(3)} tiles`)
  assert.ok(Math.abs(f.x - (px - GAME.follower.distance)) < 0.05, 'settles on the trail target')
})
