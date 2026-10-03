// The lit battle diorama: synthetic-map terrain (same chunk builder / atlas / liquids as the overworld), tall grass,
// biome props + their lamps, sky dome + sun/moon with shadows, the painted backdrop, biome ambience particles and
// battle weather (render.json field-weather grades and particles, tinted by the weather's own color).
import * as THREE from 'three'
import { CONTENT } from '../../../shared/content/index.ts'
import type { Settings, TimeOfDay, WeatherId } from '../../../shared/types.ts'
import type { AssetStore, PostParams } from '../../contracts.ts'
import {
  RENDER, dirFromAngles, hexToRgb, lerpHex, sampleLighting, sunState, type LightingState, type QualityPreset, type Vec3,
} from '../config.ts'
import { createTerrainAtlas, terrainAtlasKeys } from '../world/atlas.ts'
import { createGrassLayer, type GrassBender } from '../world/grass.ts'
import { createLightRig, type LightSource } from '../world/lights.ts'
import { createLiquidMaterials } from '../world/liquids.ts'
import { createAurora, createParticleField, type ParticleField } from '../world/particles.ts'
import { createPropLayer, lightKey } from '../world/props.ts'
import { createSkyRig } from '../world/sky.ts'
import { buildChunk, createTerrainSampler } from '../world/terrain.ts'
import { walkHeight } from '../world/coords.ts'
import { updateWind } from '../world/wind.ts'
import { createBackdrop, type Backdrop } from './backdrop.ts'
import { STAGE, minuteFor } from './config.ts'
import { buildDioramaMap, type DioramaLayout } from './layout.ts'

export interface EnvironmentOptions { biome: string; timeOfDay: TimeOfDay; indoor: boolean }

export interface EnvironmentFrame {
  dt: number
  time: number
  camera: THREE.PerspectiveCamera
  camDistance: number
  quality: QualityPreset
  settings: Settings
  pxPerUnit: number
  benders: GrassBender[]
  /** Exposure multiplier from dimming effects (1 = none). */
  dim: number
}

export interface Environment {
  readonly group: THREE.Group
  readonly layout: DioramaLayout
  /** World position of the stage origin (on the ground). */
  readonly origin: THREE.Vector3
  readonly ready: Promise<void>
  readonly backdrop: Backdrop
  /** Estimated scene light (for unlit effects). */
  readonly ambientLight: THREE.Color
  /** Ground height (world Y) at a stage-relative position. */
  groundAt(x: number, z: number): number
  setWeather(w: WeatherId | null, snap: boolean): void
  readonly weather: WeatherId | null
  setPointLightPool(n: number): void
  update(f: EnvironmentFrame): Partial<PostParams>
  dispose(): void
}

const srgb = (hex: string, out = new THREE.Color()) => out.setRGB(...hexToRgb(hex), THREE.SRGBColorSpace)

export function createEnvironment(scene: THREE.Scene, assets: AssetStore, opts: EnvironmentOptions): Environment {
  const S = STAGE
  const group = new THREE.Group()
  group.name = 'battle-diorama'
  scene.add(group)

  const layout = buildDioramaMap(opts.biome, opts.indoor)
  const map = layout.map
  const sampler = createTerrainSampler(map)
  const groundAtTile = (x: number, z: number) => walkHeight(map, x, z)
  const origin = new THREE.Vector3(layout.origin.x, groundAtTile(layout.origin.x, layout.origin.z), layout.origin.z)

  // --- terrain ---------------------------------------------------------------
  const atlas = createTerrainAtlas(assets, terrainAtlasKeys())
  const matte = new THREE.MeshLambertMaterial({ map: atlas.texture, vertexColors: true })
  const glossy = new THREE.MeshPhongMaterial({
    map: atlas.texture, vertexColors: true, shininess: RENDER.terrain.glossy.shininess,
    specular: srgb(RENDER.terrain.glossy.specular),
  })
  const liquids = createLiquidMaterials()
  const chunk = Math.max(map.width, map.height)
  const geo = buildChunk({ sampler, rect: (k) => atlas.rect(k) }, 0, 0, chunk)
  const terrainMeshes: THREE.Mesh[] = []
  if (geo.solid) {
    const m = new THREE.Mesh(geo.solid, [matte, glossy])
    m.castShadow = true
    m.receiveShadow = true
    terrainMeshes.push(m)
  }
  if (geo.water) { const w = new THREE.Mesh(geo.water, liquids.water); w.renderOrder = 2; terrainMeshes.push(w) }
  if (geo.lava) terrainMeshes.push(new THREE.Mesh(geo.lava, liquids.lava))
  for (const m of terrainMeshes) { m.name = 'battle-terrain'; group.add(m) }

  const grass = createGrassLayer(assets, atlas)
  group.add(grass.group)
  let grassPerTile = -1

  const props = createPropLayer(assets)
  group.add(props.group)
  const lights = createLightRig()
  group.add(lights.group)

  const sky = createSkyRig(scene)
  const aurora = createAurora()
  group.add(aurora.mesh)

  const biome = CONTENT.biomeById[opts.biome]
  const backdrop = createBackdrop(assets, opts.indoor ? null : biome?.battleBg ?? null, layout.silhouettes, origin)
  group.add(backdrop.mesh)
  // the overworld aurora draws over everything (top-down camera); in the diorama it is sky, behind the actors
  ;(aurora.mesh.material as THREE.Material).depthTest = true
  aurora.mesh.renderOrder = backdrop.mesh.renderOrder + 1

  const propsReady = props.load(map).then(() => {
    const mapLights: LightSource[] = map.lights.filter((l) => !props.lightCenters.has(lightKey(l.x, l.y))).map((l, i) => ({
      x: l.x, y: groundAtTile(l.x, l.y) + l.h, z: l.y,
      color: srgb(l.color), intensity: l.intensity, radius: l.radius, nightOnly: l.nightOnly, phase: i * S.lighting.lampPhaseStep,
    }))
    lights.setSources([...props.lights, ...mapLights])
  }).catch((err: unknown) => { console.warn('[battle] diorama props failed', err) })
  const ready = Promise.all([propsReady, backdrop.ready]).then(() => undefined)

  // --- particles -------------------------------------------------------------
  const fields = new Map<string, ParticleField>()
  let fieldScale = -1
  const mapSize = new THREE.Vector2(1, 1)
  function field(kind: string, scale: number): ParticleField | null {
    let f = fields.get(kind)
    if (f) return f
    const def = RENDER.particles[kind]
    if (!def) return null
    f = createParticleField(kind, def, null, mapSize, scale)
    f.target = 0
    fields.set(kind, f)
    group.add(f.points)
    return f
  }
  const clearFields = () => { for (const f of fields.values()) { f.points.removeFromParent(); f.dispose() } fields.clear() }

  // --- weather ---------------------------------------------------------------
  let weatherId: WeatherId | null = null
  const levels = new Map<string, number>()
  let snapWeather = true
  const weatherColor = new THREE.Color()
  let weatherTint = 0

  const fieldKindOf = (w: WeatherId | null) => {
    if (!w) return null
    const def = CONTENT.weatherById[w]
    return def?.fieldWeather && RENDER.weather[def.fieldWeather] ? def.fieldWeather : null
  }

  const minute = minuteFor(opts.timeOfDay)
  const staticLook = opts.indoor ? RENDER.interior : null
  const yaw = THREE.MathUtils.degToRad(S.lighting.sunYawDeg)
  const tod = opts.timeOfDay
  const tintBase = srgb(opts.indoor ? S.backdrop.indoorTint : S.backdrop.tint[tod])
  const _tint = new THREE.Color()
  const _fog = new THREE.Color()
  const windVec = new THREE.Vector2()
  let atlasT = 0
  let poolSize = -1
  let time = 0

  function lightState(): { s: LightingState; dir: Vec3; fade: number } {
    if (staticLook) return { s: { ...staticLook }, dir: dirFromAngles(staticLook.sunElevationDeg, staticLook.sunAzimuthDeg), fade: 1 }
    const sun = sunState(minute)
    const [x, y, z] = sun.dir
    const c = Math.cos(yaw), sn = Math.sin(yaw)
    return { s: sampleLighting(minute), dir: [x * c + z * sn, y, -x * sn + z * c], fade: sun.fade }
  }

  function applyWeather(s: LightingState): { sunMul: number; wind: number; aurora: number; ambient: number } {
    let sunMul = 1, wind = 1, auroraLevel = 0, ambient = 1
    for (const [kind, w] of levels) {
      const def = RENDER.weather[kind]
      if (!def || w <= 0.001) continue
      const g = def.grade
      const mix = (base: number, mul: number | undefined) => base * (1 + ((mul ?? 1) - 1) * w)
      s.exposure = mix(s.exposure, g.exposure)
      s.saturation = mix(s.saturation, g.saturation)
      s.contrast = mix(s.contrast, g.contrast)
      s.fogNear = mix(s.fogNear, g.fogNear)
      s.fogFar = mix(s.fogFar, g.fogFar)
      s.hemiIntensity = mix(s.hemiIntensity, g.hemi)
      s.bloomStrength = mix(s.bloomStrength, g.bloomStrength)
      if (g.warmth !== undefined) s.warmth += g.warmth * w
      if (g.vignette !== undefined) s.vignette += g.vignette * w
      if (g.lamps !== undefined) s.lamps = Math.max(s.lamps, g.lamps * w)
      if (g.tint && g.tintAmount) {
        const t = g.tintAmount * w
        s.fog = lerpHex(s.fog, g.tint, t)
        s.skyHorizon = lerpHex(s.skyHorizon, g.tint, t)
        s.skyBottom = lerpHex(s.skyBottom, g.tint, t)
        s.hemiSky = lerpHex(s.hemiSky, g.tint, t * S.weather.hemiShare)
      }
      sunMul *= 1 + ((g.sun ?? 1) - 1) * w
      wind = Math.max(wind, 1 + ((def.wind ?? 1) - 1) * w)
      if (def.aurora) auroraLevel = Math.max(auroraLevel, w)
      ambient *= 1 + ((def.ambientScale ?? 1) - 1) * w
    }
    // the battle weather's own color washes the sky / fog a little
    if (weatherTint > 0.001) {
      const hex = `#${weatherColor.getHexString(THREE.SRGBColorSpace)}`
      const t = S.weather.tintAmount * weatherTint
      s.fog = lerpHex(s.fog, hex, t)
      s.skyTop = lerpHex(s.skyTop, hex, t * S.weather.skyTopShare)
      s.skyHorizon = lerpHex(s.skyHorizon, hex, t)
      s.hemiSky = lerpHex(s.hemiSky, hex, t * S.weather.hemiShare)
    }
    return { sunMul, wind, aurora: auroraLevel, ambient }
  }

  const env: Environment = {
    group,
    layout,
    origin,
    ready,
    backdrop,
    ambientLight: sky.ambientLight,
    groundAt(x, z) { return groundAtTile(origin.x + x, origin.z + z) },
    get weather() { return weatherId },
    setWeather(w, snap) {
      weatherId = w && w !== 'none' && CONTENT.weatherById[w] ? w : null
      if (weatherId) srgb(CONTENT.weatherById[weatherId].color, weatherColor)
      if (snap) snapWeather = true
    },
    setPointLightPool(n) {
      if (n !== poolSize) { poolSize = n; lights.setPoolSize(n) }
    },
    update(f) {
      const dt = f.dt
      time = f.time
      const q = f.quality
      // grass density follows quality
      const per = Math.round(q.grassPerTile)
      if (per !== grassPerTile) { grassPerTile = per; grass.build(sampler, chunk, per) }
      if (q.particleScale !== fieldScale) { fieldScale = q.particleScale; clearFields() }

      // weather fade
      const snap = snapWeather
      snapWeather = false
      const k = snap ? 1 : 1 - Math.exp(-dt * S.weather.fadeRate / Math.max(1e-3, S.weather.fadeSeconds))
      const kind = opts.indoor ? null : fieldKindOf(weatherId)
      const kinds = new Set([...levels.keys(), ...(kind ? [kind] : [])])
      for (const kk of kinds) {
        const target = kk === kind ? 1 : 0
        const next = (levels.get(kk) ?? 0) + (target - (levels.get(kk) ?? 0)) * k
        if (next < 0.001 && target === 0) levels.delete(kk)
        else levels.set(kk, next)
      }
      const tintTarget = weatherId && !opts.indoor ? 1 : 0
      weatherTint += (tintTarget - weatherTint) * k

      const { s, dir, fade } = lightState()
      const boost = opts.indoor ? S.lighting.indoor : S.lighting.tod[tod]
      s.sunIntensity *= boost.sun
      s.hemiIntensity *= boost.hemi
      s.exposure *= boost.exposure
      const night = s.lamps
      const wx = applyWeather(s)
      const fs = S.lighting.fogScale
      s.fogNear *= fs
      s.fogFar *= fs
      sky.apply(s, dir, fade * wx.sunMul, origin, f.camera, f.camDistance, time)
      const shadowsOn = f.settings.shadows && q.shadows
      sky.setShadows(shadowsOn, Math.round(CONTENT.config.render.shadowMapSize * q.shadowMapScale), q.shadowRadius)
      props.setShadows(shadowsOn && q.propShadows)
      props.setLamps(s.lamps)
      lights.update(dt, time, origin, s.lamps, q.glowSprites, f.pxPerUnit)
      liquids.update(time, sky.ambientLight, q.waterSparkles)
      updateWind(time, wx.wind)
      grass.setBenders(f.benders)
      atlasT -= dt
      if (atlasT <= 0) { atlasT = S.lighting.atlasRefresh; if (atlas.refresh()) grass.refresh() }

      // backdrop: time-of-day tint, darkened with the scene exposure / weather, washed toward fog
      _tint.copy(tintBase).multiplyScalar(f.dim)
      if (weatherTint > 0.001) _tint.lerp(weatherColor, S.weather.tintAmount * weatherTint * S.weather.backdropShare)
      srgb(s.fog, _fog)
      const skyRep = opts.indoor ? 0 : S.backdrop.skyReplace[tod] ?? 0
      backdrop.update(_tint, _fog, S.backdrop.fogMix + S.weather.backdropFog * Math.max(...[0, ...levels.values()]), skyRep)

      // ambient + weather particles around the origin
      const wanted = new Map<string, number>()
      for (const a of layout.ambient) wanted.set(a, wx.ambient)
      for (const [kk, lvl] of levels) for (const p of RENDER.weather[kk]?.particles ?? []) wanted.set(p, Math.max(wanted.get(p) ?? 0, lvl * S.weather.particleScale))
      for (const kk of wanted.keys()) field(kk, fieldScale)
      windVec.set(...RENDER.wind.dir).normalize().multiplyScalar(wx.wind)
      for (const [kk, fl] of fields) {
        fl.target = wanted.get(kk) ?? 0
        if (snap) fl.level = fl.target
        const def = RENDER.particles[kk]
        const tf = def.time === 'night' ? night : def.time === 'day' ? 1 - night : 1
        fl.update(dt, time, origin, windVec, sky.ambientLight, tf, f.pxPerUnit)
        if (fl.target === 0 && fl.level < 0.002) { fl.points.removeFromParent(); fl.dispose(); fields.delete(kk) }
      }
      const auroraLevel = Math.max(wx.aurora * (RENDER.aurora.nightOnly ? night : 1), wx.aurora * S.weather.auroraDay)
      aurora.update(time, f.camera, auroraLevel)

      return {
        exposure: s.exposure * f.dim,
        saturation: s.saturation,
        contrast: s.contrast,
        warmth: s.warmth,
        bloomStrength: s.bloomStrength * S.post.bloomMul,
        vignette: s.vignette + S.post.vignetteAdd,
      }
    },
    dispose() {
      clearFields()
      for (const m of terrainMeshes) { m.removeFromParent(); m.geometry.dispose() }
      grass.dispose(); props.dispose(); lights.dispose(); aurora.dispose(); sky.dispose(); liquids.dispose()
      atlas.dispose(); matte.dispose(); glossy.dispose(); backdrop.dispose()
      group.removeFromParent()
      scene.fog = null
    },
  }
  return env
}
