import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT } from '../src/shared/content/index.ts'
import type { GameMap, TerrainDef, WeatherId } from '../src/shared/types.ts'
import type { WorldFx } from '../src/client/contracts.ts'
import { RENDER, propStyle, sampleLighting, sunState, validateRenderContent, type LightingState } from '../src/client/render/config.ts'
import { footprintCenter, footprintRect, stairsRamp, tileOf, walkHeight } from '../src/client/render/world/coords.ts'
import { buildChunk, createTerrainSampler } from '../src/client/render/world/terrain.ts'
import { createCameraRig } from '../src/client/render/world/camera.ts'
import { billboardAnchorScale, cameraPitch } from '../src/client/render/sprite-utils.ts'
import * as THREE from 'three'

test('render.json is consistent with CONTENT', () => {
  const errs = validateRenderContent()
  assert.deepEqual(errs, [], errs.join('\n'))
})

test('every prop has an explicit procedural style', () => {
  const missing = Object.keys(CONTENT.props).filter((k) => !RENDER.props.styles[k])
  assert.deepEqual(missing, [], `props without a render.json style: ${missing.join(', ')}`)
  for (const k of Object.keys(CONTENT.props)) assert.ok(propStyle(k))
})

test('every WorldFx kind and field weather has render data', () => {
  const fx: Record<WorldFx, true> = { exclaim: true, question: true, grass: true, dust: true, sparkle: true, splash: true, heart: true, warp: true, levelup: true, shiny: true }
  for (const k of Object.keys(fx)) assert.ok(RENDER.fx.kinds[k]?.length, `fx "${k}" missing`)
  const fieldKinds = ['clear', 'rain', 'snow', 'sand', 'fog', 'aurora', 'ash']
  for (const k of fieldKinds) assert.ok(RENDER.weather[k], `weather "${k}" missing`)
  for (const w of CONTENT.weathers) if (w.fieldWeather) assert.ok(RENDER.weather[w.fieldWeather as WeatherId])
})

test('time-of-day sampling is continuous and wraps midnight', () => {
  const lum = (s: LightingState) => s.sunIntensity + s.hemiIntensity
  let prev = lum(sampleLighting(0))
  for (let m = 1; m <= 1440; m++) {
    const cur = lum(sampleLighting(m))
    assert.ok(Math.abs(cur - prev) < 0.2, `jump at minute ${m}: ${prev} -> ${cur}`)
    prev = cur
  }
  const noon = sampleLighting(720), night = sampleLighting(0)
  assert.ok(noon.sunIntensity > night.sunIntensity)
  assert.ok(night.lamps > noon.lamps)
  assert.equal(sunState(720).moon, false)
  assert.equal(sunState(0).moon, true)
  assert.ok(sunState(720).dir[1] > sunState(RENDER.sun.sunrise + 1).dir[1])
})

function testMap(w: number, h: number, fill: (x: number, y: number) => { t: TerrainDef; e: number }): GameMap {
  const terrain = new Uint8Array(w * h), elevation = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = fill(x, y); terrain[y * w + x] = c.t.id; elevation[y * w + x] = c.e }
  return {
    id: 't', nameZh: 't', kind: 'overworld', width: w, height: h, terrain, elevation, region: new Uint8Array(w * h),
    regions: [{ id: 'r', nameZh: 'r', biome: CONTENT.biomes[0].id, music: '', encounters: [], encounterRate: 0, roamingDensity: 0 }],
    props: [], warps: [], npcs: [], signs: [], items: [], lights: [], spawn: { x: 0, y: 0, facing: 'down' }, outdoor: true, music: '',
  }
}

const ground = CONTENT.terrain.find((t) => t.walkable && !t.liquid && !t.stairs && !t.tallGrass && RENDER.terrain.surfaces[t.key]?.kind !== 'none')!
const stairs = CONTENT.terrain.find((t) => t.stairs)!
const liquid = CONTENT.terrain.find((t) => t.liquid && RENDER.terrain.surfaces[t.key]?.kind === 'water')!

test('stairs ramp between levels and walkHeight follows it', () => {
  const lh = CONTENT.config.world.levelHeight
  // rows 0..2 high (level 1), row 3 stairs (level 0), rows 4.. low (level 0): climbing north
  const map = testMap(5, 7, (_x, y) => (y < 3 ? { t: ground, e: 1 } : y === 3 ? { t: stairs, e: 0 } : { t: ground, e: 0 }))
  const r = stairsRamp(map, 2, 3)!
  assert.equal(r.axis, 'y')
  assert.equal(r.dir, -1)
  assert.equal(r.lowLevel, 0)
  assert.equal(r.highLevel, 1)
  assert.ok(Math.abs(walkHeight(map, 2.5, 3.99) - 0) < 0.05, 'south (low) edge')
  assert.ok(Math.abs(walkHeight(map, 2.5, 3.01) - lh) < 0.05, 'north (high) edge')
  assert.ok(Math.abs(walkHeight(map, 2.5, 3.5) - lh / 2) < 1e-6)
  assert.equal(walkHeight(map, 2.5, 1.5), lh)
  assert.equal(tileOf(2.99), 2)
  assert.equal(tileOf(3), 3)
})

test('footprint convention: odd/even sizes and door in front of the facade', () => {
  const def = Object.values(CONTENT.props).find((p) => p.door && p.footprint[0] % 2 === 0) ?? Object.values(CONTENT.props).find((p) => p.door)!
  const r = footprintRect({ prop: def.key, x: 10, y: 10, rot: 0 }, def)
  assert.equal(r.w, def.footprint[0])
  assert.equal(r.d, def.footprint[1])
  assert.equal(r.x0, 10)
  assert.equal(r.y0 + Math.floor(def.footprint[1] / 2) + def.door![1], r.y0 + r.d, 'door tile is the row just south of the footprint')
  const c = footprintCenter({ prop: def.key, x: 10, y: 10, rot: 0 }, def)
  assert.equal(c.x, r.x0 + r.w / 2)
  const r1 = footprintRect({ prop: def.key, x: 10, y: 10, rot: 1 }, def)
  assert.equal(r1.w, def.footprint[1])
})

test('terrain chunk builds tops, cliffs and water with sane bounds', () => {
  const map = testMap(16, 16, (x, y) => (x < 4 ? { t: liquid, e: 0 } : x > 10 ? { t: ground, e: 2 } : { t: ground, e: 0 }))
  const sampler = createTerrainSampler(map)
  const rect = () => ({ u0: 0, v0: 0, u1: 1, v1: 1 })
  const g = buildChunk({ sampler, rect }, 0, 0, 16)
  assert.ok(g.solid && g.water)
  const pos = g.solid!.getAttribute('position')
  assert.ok(pos.count > 16 * 16 * 4, 'tops + cliff faces')
  assert.equal(g.solid!.groups.length > 0, true)
  const box = g.solid!.boundingBox!
  assert.ok(box.max.y >= 2 * CONTENT.config.world.levelHeight - 1e-6)
  assert.ok(box.min.y < 0, 'skirt / beds go below level 0')
  assert.equal(g.water!.getAttribute('aShore').count, 4 * 4 * 16)
})

test('billboard pose: a fully compensated sprite shows its art height whatever the lean', () => {
  const pitch = THREE.MathUtils.degToRad(CONTENT.config.camera.pitchDeg)
  assert.equal(billboardAnchorScale(pitch, { lean: 0, compensate: 0 }), 1, 'upright card keeps upright anchors')
  for (const lean of [0, 0.5, 1]) {
    // an upright point at height h * scale projects (orthographically) to h * scale * cos(pitch) = h
    const scale = billboardAnchorScale(pitch, { lean, compensate: 1 })
    assert.ok(Math.abs(scale * Math.cos(pitch) - 1) < 1e-9, `lean ${lean}`)
  }
  const half = billboardAnchorScale(pitch, { lean: 0, compensate: 0.5 })
  assert.ok(half > 1 && half < 1 / Math.cos(pitch))
})

test('camera rig: a room smaller than the view is centred on screen at the configured pitch', () => {
  const rig = createCameraRig()
  rig.camera.aspect = 16 / 9
  rig.camera.updateProjectionMatrix()
  const room = { minX: 0, maxX: 10, minZ: 0, maxZ: 8 }
  rig.setBounds(room, true)
  rig.snap(new THREE.Vector3(3, 0, 6))
  assert.ok(Math.abs(cameraPitch(rig.camera) - THREE.MathUtils.degToRad(CONTENT.config.camera.pitchDeg)) < 1e-6)
  const ny = new THREE.Vector3((room.minX + room.maxX) / 2, 0, room.minZ).project(rig.camera).y
  const sy = new THREE.Vector3((room.minX + room.maxX) / 2, 0, room.maxZ).project(rig.camera).y
  assert.ok(ny > 0 && sy < 0, 'room spans the screen centre')
  assert.ok(Math.abs(ny + sy) < 1e-3, `north edge ${ny.toFixed(4)} vs south edge ${sy.toFixed(4)}`)
})

test('camera rig: near map edges the focus stays inside the render.json focus-safe screen box', () => {
  const rig = createCameraRig()
  rig.camera.aspect = 16 / 9
  rig.camera.updateProjectionMatrix()
  rig.setBounds({ minX: 0, maxX: 52, minZ: 0, maxZ: 37 }, true)
  const safe = RENDER.camera.focusSafe
  for (const zoom of CONTENT.config.camera.zoomDistances.keys()) {
    rig.setZoom(zoom)
    for (const [x, z] of [[1.5, 23.5], [38.5, 7.5], [50.5, 0.5], [26, 36.5]]) {
      const focus = new THREE.Vector3(x, 0, z)
      rig.snap(focus)
      const p = focus.clone().project(rig.camera)
      assert.ok(Math.abs(p.x) <= safe.side + 0.02, `zoom ${zoom} focus ${x},${z}: x ${p.x.toFixed(3)}`)
      assert.ok(p.y <= safe.north + 1e-3 && p.y >= -safe.south - 1e-3, `zoom ${zoom} focus ${x},${z}: y ${p.y.toFixed(3)}`)
    }
  }
})
