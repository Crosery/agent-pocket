import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT } from '../src/shared/content/index.ts'
import type { GameMap, TerrainDef, WeatherId } from '../src/shared/types.ts'
import type { WorldFx } from '../src/client/contracts.ts'
import { RENDER, lightingTier, propStyle, sampleLighting, sunState, validateRenderContent, type LightingState } from '../src/client/render/config.ts'
import { createCloudTexture, rankSources } from '../src/client/render/world/scene-light.ts'
import type { LightSource } from '../src/client/render/world/lights.ts'
import { doorOffsetX, footprintCenter, footprintRect, stairsRamp, tileOf, walkHeight } from '../src/client/render/world/coords.ts'
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

test('procedural doors centre on every entry lane, matching the double-door GLBs', () => {
  for (const key of ['lab', 'center', 'gym', 'datacenter', 'temple']) assert.equal(doorOffsetX(CONTENT.props[key]), 0, key)
  assert.equal(doorOffsetX(CONTENT.props.house_small), 0.5)
  assert.equal(doorOffsetX(CONTENT.props.shop), 0)
  assert.equal(doorOffsetX(CONTENT.props.tree_oak), null)
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

test('the moon travels across the night and the sun keeps a low-sun floor', () => {
  const S = RENDER.sun
  const night = (m: number) => sunState(m)
  const a = night(S.sunset + 30), b = night(S.sunset + (1440 - S.sunset + S.sunrise) / 2), c = night(S.sunrise - 30)
  for (const s of [a, b, c]) {
    assert.equal(s.moon, true)
    const el = Math.asin(s.dir[1]) * 180 / Math.PI
    assert.ok(el >= S.moonMinElevationDeg - 0.01 && el <= S.moonMaxElevationDeg + 0.01, `moon elevation ${el}`)
  }
  assert.ok(Math.abs(a.dir[0] - c.dir[0]) > 0.3, 'moon azimuth must sweep between dusk and dawn')
  assert.ok(b.dir[1] > a.dir[1] && b.dir[1] > c.dir[1], 'moon is highest mid-night')
  const noon = sunState(720)
  assert.ok(Math.asin(sunState(S.sunrise + 1).dir[1]) * 180 / Math.PI >= S.minElevationDeg - 0.01)
  assert.ok(noon.dir[1] > sunState(S.sunrise + 60).dir[1])
})

test('time-of-day keys carry the lighting extras and golden hour is warmer than noon', () => {
  const noon = sampleLighting(720), dusk = sampleLighting(1110), night = sampleLighting(0)
  assert.ok(dusk.warmth > noon.warmth)
  assert.ok(dusk.rim >= noon.rim && dusk.shaft > noon.shaft, 'rim light and shafts peak at dawn / dusk')
  assert.ok(night.cloud === 0, 'no cloud shadows at night')
  assert.ok(night.spriteFillIntensity > noon.spriteFillIntensity, 'sprites get a night fill')
  assert.ok(night.sun !== noon.sun)
})

test('lighting tiers: the lowest tier keeps every new effect off, higher tiers scale up', () => {
  const low = lightingTier('low'), high = lightingTier('high'), ultra = lightingTier('ultra')
  assert.deepEqual([low.fieldLights, low.shafts, low.cloudShadows, low.spriteRim, low.spriteShadow, low.wetGround, low.splitTone], [0, 0, false, false, false, false, false])
  assert.ok(high.fieldLights > 0 && high.shafts > 0 && high.cloudShadows)
  assert.ok(ultra.fieldLights >= high.fieldLights && ultra.fieldLights <= RENDER.lights.field.max)
})

test('light field picks the nearest active sources and drops night-only lamps by day', () => {
  const mk = (x: number, nightOnly: boolean, intensity = 1): LightSource => ({ x, y: 1, z: 0, color: null as never, intensity, radius: 4, nightOnly, phase: 0 })
  const list = [mk(30, false), mk(2, true), mk(5, false), mk(9, true), mk(100, false), mk(1, false, 0)]
  const day = rankSources(list, 0, 0, 0, 0, 40, 3)
  assert.deepEqual(day.map((s) => s.x), [5, 30], 'lamps are off at noon, the dead one never ranks, far ones fall outside the radius')
  const night = rankSources(list, 1, 0, 0, 0, 40, 3)
  assert.deepEqual(night.map((s) => s.x), [2, 5, 9], 'nearest three at night')
  assert.equal(rankSources(list, 1, 0, 0, 0, 40, 0).length, 0)
})

test('cloud texture tiles seamlessly and spans the coverage range', () => {
  const size = 64
  const tex = createCloudTexture(size, 3, 11)
  const d = tex.image.data as Uint8Array
  let lo = 255, hi = 0
  for (const v of d) { lo = Math.min(lo, v); hi = Math.max(hi, v) }
  assert.ok(lo < 90 && hi > 165, `texture range ${lo}..${hi} must cross the coverage threshold`)
  // neighbouring texels (also across the wrap seam) differ by little: the noise is continuous and periodic
  let worst = 0
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    worst = Math.max(worst, Math.abs(d[y * size + x] - d[y * size + (x + 1) % size]), Math.abs(d[y * size + x] - d[((y + 1) % size) * size + x]))
  }
  assert.ok(worst < 40, `max neighbour step ${worst}`)
  assert.ok(RENDER.lighting.cloud.coverage > lo / 255 && RENDER.lighting.cloud.coverage < hi / 255)
})
