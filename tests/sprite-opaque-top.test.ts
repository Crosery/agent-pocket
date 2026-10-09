import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { spriteOpaqueTop } from '../src/client/render/sprite-utils.ts'

test('two actors cutting one atlas differently each read it once, not once per frame', () => {
  const data = new Uint8ClampedArray(64 * 16 * 4)
  for (let y = 4; y < 16; y++) for (let x = 0; x < 64; x++) data[(y * 64 + x) * 4 + 3] = 255
  let reads = 0
  const texture = new THREE.Texture()
  texture.image = { width: 64, height: 16, getContext: () => ({ getImageData: () => { reads++; return { data } } }) }
  for (let frame = 0; frame < 30; frame++) {
    assert.equal(spriteOpaqueTop(texture, 1, 0, 4, 1, 0.5), 1 - 4 / 16)
    assert.equal(spriteOpaqueTop(texture, 0, 0, 1, 1, 0.5), 1 - 4 / 16)
  }
  assert.equal(reads, 2, 'one read per measuring grid')
})
