import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { RENDER } from '../src/client/render/config.ts'
import { billboardPointToWorld, spriteOpaqueTop } from '../src/client/render/sprite-utils.ts'
import { createActorImpl, type ActorContext } from '../src/client/render/world/actors.ts'

test('character head anchors exclude transparent atlas rows and the sole pivot', () => {
  const previous = globalThis.document
  globalThis.document = { createElement: () => ({
    width: 0, height: 0,
    getContext: () => ({ createRadialGradient: () => ({ addColorStop() {} }), fillRect() {} }),
  }) } as unknown as Document
  try {
    const data = new Uint8ClampedArray(1024 * 256 * 4)
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 16; col++) {
        for (let y = 12 + row; y < 62; y++) {
          data[((row * 64 + y) * 1024 + col * 64 + 32) * 4 + 3] = 255
        }
      }
    }
    const texture = new THREE.Texture()
    texture.image = { width: 1024, height: 256, getContext: () => ({ getImageData: () => ({ data }) }) }
    const ctx = {
      assets: { characterTexture: () => texture }, root: new THREE.Group(), registry: new Set(), yaw: { value: 0 },
      inGrassAt: () => false,
      overlay: { createTag: () => ({ setName() {}, update() {}, dispose() {}, bubble() {} }) },
    } as unknown as ActorContext
    for (const kind of ['player', 'npc', 'remote'] as const) {
      const actor = createActorImpl(ctx, { sheet: 'hero_boy', kind })
      actor.setPosition(3.5, 4.5, 2)
      const entry = [...ctx.registry][0]
      for (const [dir, row] of [['down', 0], ['left', 1], ['right', 2], ['up', 3]] as const) {
        actor.setFacing(dir)
        actor.update(0)
        const expected = 2 + RENDER.actors.height * (64 - 12 - row - RENDER.actors.footInset) / 64
        assert.ok(Math.abs(entry.head(new THREE.Vector3()).y - expected) < 1e-6,
          `${kind}/${dir}: the tag must follow the opaque head, not the top of a 64px transparent card`)
      }
      actor.dispose()
    }
  } finally {
    globalThis.document = previous
  }
})

test('head pose matches the rendered billboard through pitch, yaw, scale, lift and compensation', () => {
  const mesh = new THREE.Mesh()
  mesh.position.set(4, 2.3, 5)
  mesh.rotation.y = 0.4
  mesh.scale.set(0.9, 1.15, 0.8)
  mesh.updateWorldMatrix(true, false)
  for (const pitch of [0, Math.PI / 6, Math.PI / 3]) {
    for (const lean of [0, 0.5, 1]) {
      for (const compensate of [0, 0.5, 1]) {
        const b = { lean, compensate }
        const y = 1.2 * (1 + (1 / Math.max(Math.cos(pitch * (1 - lean)), 0.05) - 1) * compensate)
        const expected = new THREE.Vector3(0, y * Math.cos(pitch * lean), -y * Math.sin(pitch * lean) * 1.15 / 0.8)
          .applyMatrix4(mesh.matrixWorld)
        const actual = billboardPointToWorld(new THREE.Vector3(0, 1.2, 0), mesh, pitch, b)
        assert.ok(actual.distanceTo(expected) < 1e-8)
      }
    }
  }
})

test('opaque-top cache reuses each atlas but invalidates on asynchronous resize or image replacement', () => {
  let reads = 0
  const image = {
    width: 8, height: 8,
    getContext: () => ({ getImageData: () => {
      reads++
      const data = new Uint8ClampedArray(image.width * image.height * 4)
      data[(2 * image.width + 1) * 4 + 3] = 255
      return { data }
    } }),
  }
  const texture = new THREE.Texture()
  texture.image = image
  assert.equal(spriteOpaqueTop(texture), 0.75)
  assert.equal(spriteOpaqueTop(texture), 0.75)
  assert.equal(reads, 1)
  image.height = 16
  assert.equal(spriteOpaqueTop(texture), 0.875)
  assert.equal(reads, 2)
  texture.image = { ...image }
  assert.equal(spriteOpaqueTop(texture), 0.875)
  assert.equal(reads, 3)
})
