import { test } from 'node:test'
import assert from 'node:assert/strict'
import { characterFrames, createCharacterAnimation } from '../src/client/render/character-animation.ts'
import { CONTENT } from '../src/shared/content/index.ts'
import { sheetLayout } from '../src/client/render/sprite-utils.ts'
import * as THREE from 'three'
import { createActorImpl, type ActorContext } from '../src/client/render/world/actors.ts'
import { createBattleSprite } from '../src/client/render/battle/sprites.ts'
import type { AssetStore } from '../src/client/contracts.ts'

test('standing cycles through eight dedicated idle poses without entering the walk range', () => {
  const animation = createCharacterAnimation(8, 8, { frames: 8, fps: 4, settleMs: 250 })
  const seen = new Set<number>()
  for (let i = 0; i < 300; i++) {
    animation.update(1 / 60, false, 14, 0)
    seen.add(animation.frame)
  }
  assert.deepEqual([...seen].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7])
  assert.equal(animation.phase, 0, 'idle time does not advance the distance-driven gait')
})

test('walking, a stop, turning and blocked input keep idle and gait clocks separate', () => {
  const animation = createCharacterAnimation(8, 8, { frames: 8, fps: 4, settleMs: 250, phase: 5 })
  animation.update(1, false, 14, 0)
  assert.equal(animation.frame, 0)
  animation.update(0.1, true, 14, 0.2, 1)
  assert.equal(animation.frame, 8)
  animation.update(0, false, 14, 0)
  assert.equal(animation.frame, 0)
  animation.update(0.4, false, 14, 0)
  assert.equal(animation.frame, 0, 'a fresh stop begins on neutral rather than a staggered spawn pose')
  animation.update(0.1, false, 14, 0)
  assert.equal(animation.frame, 1)
  animation.reset()
  assert.equal(animation.frame, 0, 'a turn starts from the new direction neutral')
  for (let i = 0; i < 60; i++) animation.update(1 / 60, true, 14, 0, 1)
  assert.equal(animation.frame, 3, 'held input at a wall still breathes, not frozen walking')
  animation.update(1 / 60, true, 14, 100, 1, 2)
  assert.ok(animation.frame < 8, 'teleport distance cannot start a gait')
  animation.update(0.1, true, 14, 0.3, 1)
  assert.equal(animation.frame, 9, 'real movement resumes a grounded walk')
})

test('legacy sheets, asynchronous textures and separate-idle atlases resolve compatible layouts', () => {
  const sprites = CONTENT.config.sprites
  const legacy = { cols: 4, walkFrames: 4, walkStart: 0, idleFrames: 1 }
  assert.deepEqual(characterFrames(0, sprites), legacy)
  assert.deepEqual(characterFrames(256, sprites), legacy)
  assert.deepEqual(characterFrames(576, sprites), { cols: 9, walkFrames: 8, walkStart: 1, idleFrames: 1 })
  assert.deepEqual(characterFrames(1024, sprites), { cols: 16, walkFrames: 8, walkStart: 8, idleFrames: 8 })
  assert.deepEqual(characterFrames(768, sprites), { cols: 12, walkFrames: 4, walkStart: 8, idleFrames: 8 })
  assert.deepEqual(characterFrames(575, sprites), legacy, 'malformed widths cannot shift the atlas grid')
  const texture = new THREE.Texture()
  texture.image = { width: 576, height: 256 }
  assert.equal(sheetLayout(CONTENT, texture).cols, 9)
  texture.image = { width: 256, height: 256 }
  assert.equal(sheetLayout(CONTENT, texture).cols, 4, 'image-load fallback returns to legacy UVs')
})

test('a separate idle never appears inside the eight-pose walk loop', () => {
  const gait = createCharacterAnimation(8, 1)
  assert.equal(gait.frame, 0)
  gait.update(0.01, true, 8, 0, 1)
  assert.equal(gait.frame, 0, 'blocked input does not start walking')
  const seen: number[] = []
  for (let i = 0; i < 8; i++) {
    gait.update(1 / 8, true, 8)
    seen.push(gait.frame)
  }
  assert.deepEqual(seen, [2, 3, 4, 5, 6, 7, 8, 1])
  gait.update(0.01, false, 8)
  assert.equal(gait.frame, 0, 'stop immediately returns to the grounded standing pose')
})

test('eight-frame and legacy cycles cover the same ground per full gait', () => {
  const legacy = createCharacterAnimation(4)
  const atlas = createCharacterAnimation(8, 1)
  for (let i = 0; i < 10; i++) {
    legacy.update(1 / 60, true, 7, 0.07, 0.72)
    atlas.update(1 / 60, true, 14, 0.07, 0.72)
    assert.ok(Math.abs(legacy.phase / 4 - atlas.phase / 8) < 1e-6)
  }
})

test('walking phase follows displacement and does not tick while a moving actor is stuck', () => {
  const gait = createCharacterAnimation(4)
  gait.update(1 / 60, true, 7, 0.09, 0.72)
  const frame = gait.frame
  for (let i = 0; i < 120; i++) gait.update(1 / 60, true, 7, 0, 0.72)
  assert.equal(gait.frame, frame)
})

test('idle is frame zero; restarting and changing pace preserve a contiguous cycle', () => {
  const gait = createCharacterAnimation(4)
  gait.update(0.2, true, 7)
  assert.equal(gait.frame, 1)
  gait.update(0.1, true, 11)
  assert.equal(gait.frame, 2)
  gait.update(0, false, 7)
  assert.equal(gait.frame, 0)
  gait.update(0, true, 7)
  assert.equal(gait.frame, 0, 'starting does not snap straight to a contact pose')
})

test('repeated idle updates do not change pose and teleports do not race the walk cycle', () => {
  const gait = createCharacterAnimation(4)
  for (let i = 0; i < 240; i++) gait.update(1 / 60, false, 7)
  assert.equal(gait.frame, 0)
  gait.update(1 / 60, true, 7, 100, 0.72, 2)
  assert.equal(gait.frame, 0)
  gait.update(1, true, 7)
  assert.ok(gait.frame >= 0 && gait.frame < 4)
})

function withCanvas(run: () => void): void {
  const previous = globalThis.document
  globalThis.document = { createElement: () => ({
    width: 0, height: 0,
    getContext: () => ({ createRadialGradient: () => ({ addColorStop() {} }), fillRect() {} }),
  }) } as unknown as Document
  try { run() } finally { globalThis.document = previous }
}

test('world player, NPC and remote actors breathe in every direction despite repeated stopped state updates', () => withCanvas(() => {
  const texture = new THREE.Texture()
  texture.image = { width: 1024, height: 256 }
  const ctx = {
    assets: { characterTexture: () => texture }, root: new THREE.Group(), registry: new Set(), yaw: { value: 0 },
    inGrassAt: () => false, groundAt: () => 0,
    overlay: { createTag: () => ({ setName() {}, update() {}, dispose() {}, bubble() {} }) },
  } as unknown as ActorContext
  for (const kind of ['player', 'npc', 'remote'] as const) {
    const actor = createActorImpl(ctx, { sheet: 'hero_boy', kind })
    actor.setPosition(3.5, 3.5, 0)
    const mesh = actor.object.children[0] as THREE.Mesh
    for (const dir of ['up', 'down', 'left', 'right'] as const) {
      actor.setFacing(dir)
      const seen = new Set<number>()
      for (let i = 0; i < 240; i++) {
        actor.setMoving(false, false)
        actor.update(1 / 60)
        const uv = mesh.geometry.getAttribute('uv')
        seen.add(Math.round(uv.getX(0) * 16))
        assert.equal(Math.round((1 - uv.getY(0)) * 4), CONTENT.config.sprites.sheetRows[dir])
        assert.deepEqual(mesh.scale.toArray(), [1, 1, 1])
        assert.equal(mesh.position.y, 0)
      }
      assert.deepEqual([...seen].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7], `${kind}/${dir}`)
    }
    actor.dispose()
  }
}))

test('an asynchronous world texture resize and same-layout character swap retain grounded idle playback', () => withCanvas(() => {
  const texture = new THREE.Texture()
  texture.image = { width: 256, height: 256 }
  const ctx = {
    assets: { characterTexture: () => texture }, root: new THREE.Group(), registry: new Set(), yaw: { value: 0 },
    inGrassAt: () => false, groundAt: () => 0,
    overlay: { createTag: () => ({ setName() {}, update() {}, dispose() {}, bubble() {} }) },
  } as unknown as ActorContext
  const actor = createActorImpl(ctx, { sheet: 'hero_boy', kind: 'npc' })
  actor.setPosition(2, 2, 0)
  actor.update(0)
  texture.image = { width: 1024, height: 256 }
  const seen = new Set<number>()
  const mesh = actor.object.children[0] as THREE.Mesh
  for (let i = 0; i < 240; i++) {
    actor.setMoving(false, false)
    actor.update(1 / 60)
    seen.add(Math.round(mesh.geometry.getAttribute('uv').getX(0) * 16))
  }
  assert.equal(seen.size, 8)
  actor.setSheet('rival')
  assert.equal(mesh.geometry.getAttribute('uv').getX(0), 0, 'same-sized new sheet also resets the old pose')
  actor.dispose()
}))

test('battle trainers use grounded directional idle frames, including asynchronously loaded atlases', () => withCanvas(() => {
  const texture = new THREE.Texture()
  texture.image = { width: 256, height: 256 }
  const sprite = createBattleSprite('trainer', { characterTexture: () => texture } as unknown as AssetStore, new THREE.Vector3(), 3)
  sprite.setSheet('rival', 'left')
  sprite.present = true
  sprite.update(0.01, 0, 0)
  texture.image = { width: 1024, height: 256 }
  const seen = new Set<number>()
  for (let i = 0; i < 240; i++) {
    sprite.update(1 / 60, i / 60, 0)
    const uv = sprite.mesh.geometry.getAttribute('uv')
    seen.add(Math.round(uv.getX(0) * 16))
    assert.equal(Math.round((1 - uv.getY(0)) * 4), 1)
    assert.deepEqual(sprite.mesh.scale.toArray(), [1, 1, 1])
    assert.equal(sprite.mesh.position.y, 0)
  }
  assert.deepEqual([...seen].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7])
  sprite.setSheet('hero_girl', 'up')
  assert.equal(Math.round((1 - sprite.mesh.geometry.getAttribute('uv').getY(0)) * 4), 3)
  sprite.dispose()
}))
