// Character / creature shadows (render.json spriteShadow, sprite-shadow.ts): parameters, the foot anchor, the
// projection of the cast silhouette and the contact ellipse hugging stepped terrain.
import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import pipelineJson from '../assets_src/pipeline.json' with { type: 'json' }
import { CONTENT } from '../src/shared/content/index.ts'
import { RENDER, validateRenderContent } from '../src/client/render/config.ts'
import { createBillboardGeometry } from '../src/client/render/sprite-utils.ts'
import {
  castOffset, castStrength, createSpriteShadow, footprintsFromAlpha, shadowSlope, soleHeight, spriteShadowState, updateSpriteShadows,
} from '../src/client/render/sprite-shadow.ts'

const S = RENDER.spriteShadow
const A = RENDER.actors
const cell = CONTENT.config.sprites.sheetCell
const pipeline = pipelineJson as unknown as { sheet: { bottomMargin: number } }

const unit = (x: number, y: number, z: number): [number, number, number] => {
  const l = Math.hypot(x, y, z)
  return [x / l, y / l, z / l]
}

test('spriteShadow parameters validate and the lowest tier keeps only the contact ellipse', () => {
  const errs = validateRenderContent().filter((e) => e.startsWith('spriteShadow') || e.includes('spriteCast'))
  assert.deepEqual(errs, [])
  assert.equal(RENDER.lighting.quality.low.spriteCast, false)
  assert.ok(RENDER.lighting.quality.high.spriteCast)
  assert.ok(S.contact.minSpan <= S.contact.maxSpan)
  assert.ok(S.contact.opacity > 0 && S.cast.opacity > 0)
  // data moved out of the actors section: no second, stale blob shadow definition
  assert.equal('blob' in (A as unknown as Record<string, unknown>), false)
})

test('the card pivot puts the soles on the ground: footInset matches the sheet baseline margin', () => {
  assert.equal(A.footInset, pipeline.sheet.bottomMargin)
  // the pipeline test pins the lowest opaque row of every cell to cell - 1 - bottomMargin (row 61 of 64)
  const soleRow = cell - 1 - pipeline.sheet.bottomMargin
  assert.equal(soleRow, 61)
  assert.ok(Math.abs(soleHeight(A.height, cell, soleRow, A.footInset)) < 1e-9)
  const geo = createBillboardGeometry(A.width, A.height, A.normalTilt, (A.footInset * A.height) / cell, A.cardSegments)
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const ys = Array.from({ length: pos.count }, (_, i) => pos.getY(i))
  // the card bottom sits `footInset` texels below the soles line (local y = 0, the group origin the shadows are anchored to)
  assert.ok(Math.abs(Math.min(...ys) + (A.footInset * A.height) / cell) < 1e-6)
  assert.ok(Math.abs(Math.max(...ys) - (A.height - (A.footInset * A.height) / cell)) < 1e-6)
})

test('footprintsFromAlpha measures the lowest opaque rows of every cell', () => {
  const w = 16, h = 16, cols = 2, rows = 1
  const data = new Uint8Array(w * cols * h * rows * 4)
  const fill = (cx: number, x0: number, x1: number, y0: number, y1: number) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) data[(y * w * cols + cx * w + x) * 4 + 3] = 255
  }
  fill(0, 4, 7, 8, 13) // cell 0: feet on row 13, columns 4..7
  fill(1, 8, 11, 6, 11) // cell 1: lifted two rows, columns 8..11
  const [a, b] = footprintsFromAlpha(data, w * cols, h * rows, cols, rows, 0.5, 3)
  assert.ok(Math.abs(a.bottom - (1 - 14 / h)) < 1e-9)
  assert.ok(Math.abs(a.cx - ((5.5 + 0.5) / w - 0.5)) < 1e-9)
  assert.ok(Math.abs(a.span - 4 / w) < 1e-9)
  assert.ok(b.bottom > a.bottom, 'a lifted frame measures higher above the cell bottom')
  assert.ok(Math.abs(b.bottom - a.bottom - 2 / h) < 1e-9)
  assert.ok(b.cx > a.cx)
  // an empty cell reports "unknown" instead of a bogus anchor
  const [empty] = footprintsFromAlpha(new Uint8Array(w * h * 4), w, h, 1, 1, 0.5, 3)
  assert.equal(empty.bottom, -1)
})

test('castOffset joins the soles whatever the light and runs away from it', () => {
  const o = { x: 0, z: 0 }
  for (const az of [0, 0.7, 1.9, 3.1, 4.4, 5.6]) {
    const lx = Math.sin(az), lz = Math.cos(az)
    castOffset(o, lx, lz, 1.3, 0, 0)
    assert.ok(Math.abs(o.x) < 1e-12 && Math.abs(o.z) < 1e-12, 'height 0 on the centre line is the soles')
    castOffset(o, lx, lz, 1.3, 0, 1)
    assert.ok(Math.abs(Math.hypot(o.x, o.z) - 1.3) < 1e-9, 'length = height x slope')
    assert.ok(o.x * lx + o.z * lz < 0, 'the shadow points away from the light')
    castOffset(o, lx, lz, 1.3, 0.4, 0)
    assert.ok(Math.abs(Math.hypot(o.x, o.z) - 0.4) < 1e-9, 'sideways extent is the card width')
    assert.ok(Math.abs(o.x * lx + o.z * lz) < 1e-9, 'and perpendicular to the light')
  }
})

test('shadow length follows the sun elevation and is capped; strength follows the light', () => {
  const at = (deg: number) => shadowSlope(Math.sin((deg * Math.PI) / 180))
  assert.ok(Math.abs(at(45) - Math.min(S.cast.maxSlope, S.cast.lengthMul)) < 1e-9)
  assert.ok(at(60) < at(30) || at(30) === S.cast.maxSlope)
  assert.equal(at(5), S.cast.maxSlope)
  for (const deg of [5, 11, 25, 60]) assert.ok(at(deg) <= S.cast.maxSlope + 1e-12)

  assert.equal(castStrength(S.light.min, false, true), 0)
  assert.equal(castStrength(0, false, true), 0)
  assert.ok(Math.abs(castStrength(S.light.full, false, true) - S.cast.opacity) < 1e-12)
  assert.ok(Math.abs(castStrength(S.light.full * 3, false, true) - S.cast.opacity) < 1e-12)
  const mid = castStrength((S.light.min + S.light.full) / 2, false, true)
  assert.ok(mid > 0 && mid < S.cast.opacity)
  assert.ok(Math.abs(castStrength(S.light.full, true, true) - S.cast.opacity * S.light.moon) < 1e-12)
  assert.ok(Math.abs(castStrength(S.light.full, false, false) - S.cast.opacity * S.light.indoor) < 1e-12)
})

test('updateSpriteShadows turns the cast off for low tiers and indoors, and tracks the light direction', () => {
  updateSpriteShadows({ dir: unit(0.6, 0.5, 0.62), light: 3, moon: false, outdoor: true, cast: true })
  assert.ok(spriteShadowState.cast > 0)
  assert.ok(Math.abs(Math.hypot(spriteShadowState.lx, spriteShadowState.lz) - 1) < 1e-9)
  const stamp = spriteShadowState.stamp
  updateSpriteShadows({ dir: unit(0.6, 0.5, 0.62), light: 3, moon: false, outdoor: true, cast: true })
  assert.equal(spriteShadowState.stamp, stamp, 'an unchanged light does not rebuild shadows')
  updateSpriteShadows({ dir: unit(-0.6, 0.5, 0.62), light: 3, moon: false, outdoor: true, cast: true })
  assert.ok(spriteShadowState.stamp > stamp)
  updateSpriteShadows({ dir: unit(0.6, 0.5, 0.62), light: 3, moon: false, outdoor: true, cast: false })
  assert.equal(spriteShadowState.cast, 0)
  updateSpriteShadows({ dir: unit(0.6, 0.5, 0.62), light: 3, moon: false, outdoor: false, cast: true })
  assert.equal(spriteShadowState.cast, castStrength(3, false, false))
})

function sprite(ground: (x: number, z: number) => number) {
  const geo = createBillboardGeometry(A.width, A.height, A.normalTilt, (A.footInset * A.height) / cell, A.cardSegments)
  const map = new THREE.Texture({ width: cell * CONTENT.config.sprites.sheetFrames * 4, height: cell * 4 } as unknown as HTMLCanvasElement)
  const shadow = createSpriteShadow({ geometry: geo, map: () => map, alphaTest: A.alphaTest, ground })
  const [contact, cast] = shadow.object.children as THREE.Mesh[]
  const verts = (m: THREE.Mesh) => m.geometry.getAttribute('position') as THREE.BufferAttribute
  return { geo, shadow, contact, cast, verts }
}

test('the cast silhouette starts at the soles: its lowest card row lies on the foot point', () => {
  updateSpriteShadows({ dir: unit(0.7, 0.45, -0.3), light: 3, moon: false, outdoor: true, cast: true })
  const { shadow, cast, verts } = sprite(() => 0)
  const foot = { x: 12.5, y: 0, z: 40.5 }
  shadow.update({ ...foot, yaw: 0, scaleX: 1, scaleY: 1, lift: 0 })
  assert.ok(cast.visible)
  const pos = verts(cast), card = (cast.geometry.getAttribute('aH') as THREE.BufferAttribute)
  // card rows at or below the soles line (aH = 0): the two vertices of such a row straddle the foot point symmetrically
  const low: number[] = []
  for (let i = 0; i < pos.count; i++) if (card.getX(i) === 0) low.push(i)
  assert.ok(low.length >= 2)
  const mx = low.reduce((s, i) => s + pos.getX(i), 0) / low.length
  const mz = low.reduce((s, i) => s + pos.getZ(i), 0) / low.length
  assert.ok(Math.abs(mx) < 1e-9 && Math.abs(mz) < 1e-9, 'row midpoint is the foot (group origin)')
  // the head end is far along the light's shadow direction, not at the feet
  const top = pos.count - 1
  assert.ok(Math.hypot(pos.getX(top), pos.getZ(top)) > 0.5)
})

test('shadows hug stepped terrain and follow the body lift', () => {
  updateSpriteShadows({ dir: unit(0.3, 0.8, 0.5), light: 3, moon: false, outdoor: true, cast: true })
  // a stair step across x = 10: the ground rises 0.2 east of it
  const step = (x: number) => (x < 10 ? 0.75 : 0.95)
  const { shadow, contact, cast, verts } = sprite((x) => step(x))
  shadow.update({ x: 9.9, y: 0.75, z: 5.5, yaw: 0, scaleX: 1, scaleY: 1, lift: 0 })
  const ys = new Set<number>()
  const cv = verts(contact)
  for (let i = 0; i < cv.count; i++) ys.add(+cv.getY(i).toFixed(6))
  assert.ok(ys.has(+S.ground.lift.toFixed(6)), 'west of the step the ellipse lies just above the ground')
  assert.ok(ys.has(+(0.2 + S.ground.lift).toFixed(6)), 'east of the step it climbs onto the higher ground')
  const sv = verts(cast)
  let maxY = -Infinity
  for (let i = 0; i < sv.count; i++) maxY = Math.max(maxY, sv.getY(i))
  assert.ok(Math.abs(maxY - (0.2 + S.ground.lift)) < 1e-6, 'the silhouette climbs the step too')

  // lifting the body shrinks and fades the contact ellipse, never past the floors
  const flat = sprite(() => 0)
  flat.shadow.update({ x: 3, y: 0, z: 3, yaw: 0, scaleX: 1, scaleY: 1, lift: 0 })
  const op0 = (flat.contact.material as THREE.ShaderMaterial).uniforms.uOpacity.value as number
  const w0 = verts(flat.contact).getX(2) - verts(flat.contact).getX(0)
  flat.shadow.update({ x: 3, y: 0, z: 3, yaw: 0, scaleX: 1, scaleY: 1, lift: 0.34 })
  const op1 = (flat.contact.material as THREE.ShaderMaterial).uniforms.uOpacity.value as number
  const w1 = verts(flat.contact).getX(2) - verts(flat.contact).getX(0)
  assert.ok(op1 < op0 && op1 >= S.contact.opacity * S.contact.minOpacity - 1e-9)
  assert.ok(w1 < w0 && w1 >= w0 * S.contact.minScale - 1e-9)
  // a dissolving battle sprite fades both shadows
  flat.shadow.update({ x: 3, y: 0, z: 3, yaw: 0, scaleX: 1, scaleY: 1, lift: 0, fade: 0.5 })
  assert.ok(Math.abs((flat.contact.material as THREE.ShaderMaterial).uniforms.uOpacity.value - op0 * 0.5) < 1e-9)
})
