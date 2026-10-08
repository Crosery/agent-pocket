// Scene light: one shader patch shared by every lit overworld material plus the per-frame controller feeding it.
//  - light field: up to lights.field.max world-space lights (lamps, lit windows, fires, lava) evaluated right after the
//    three.js light loop. They replace the PointLight pool on quality tiers with lighting.quality.<tier>.fieldLights > 0:
//    nothing is compiled per light, and the loop is skipped entirely (uApLfCount = 0) while no lamp is on.
//  - cloud shadows: a tileable noise map scrolled along the wind dims the direct (sun) light of everything it touches.
//  - wet ground: rain darkens albedo and adds a puddle-patched sky sheen on up-facing surfaces.
// All numbers come from content/render.json (lights.field, lighting.*).
import * as THREE from 'three'
import { RENDER, lightingTier, type LightingState, type LightingTier, type QualityId } from '../config.ts'
import { hash01 } from '../noise.ts'
import type { LightSource } from './lights.ts'

const LF = RENDER.lights.field
const LC = RENDER.lighting.cloud
const LW = RENDER.lighting.wet

/** Tileable gradient-noise fbm in an R8 texture (one repeat = lighting.cloud.scale world units). */
export function createCloudTexture(size = LC.size, octaves = LC.octaves, seed = 7): THREE.DataTexture {
  const data = new Uint8Array(size * size)
  const oct = Math.max(1, Math.floor(octaves))
  const grids: { cells: number; gx: Float32Array; gy: Float32Array; amp: number }[] = []
  let amp = 1, norm = 0, cells = 4
  for (let o = 0; o < oct; o++) {
    const gx = new Float32Array(cells * cells), gy = new Float32Array(cells * cells)
    for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) {
      const a = hash01(i, j, seed * 131 + o * 17) * Math.PI * 2
      gx[j * cells + i] = Math.cos(a); gy[j * cells + i] = Math.sin(a)
    }
    grids.push({ cells, gx, gy, amp }); norm += amp; amp *= 0.5; cells *= 2
  }
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0
      for (const g of grids) {
        const fx = (x / size) * g.cells, fy = (y / size) * g.cells
        const ix = Math.floor(fx), iy = Math.floor(fy)
        const tx = fx - ix, ty = fy - iy
        const i0 = ix % g.cells, i1 = (ix + 1) % g.cells, j0 = iy % g.cells, j1 = (iy + 1) % g.cells
        const dot = (i: number, j: number, dx: number, dy: number) => g.gx[j * g.cells + i] * dx + g.gy[j * g.cells + i] * dy
        const u = fade(tx), w = fade(ty)
        const a = dot(i0, j0, tx, ty), b = dot(i1, j0, tx - 1, ty), c = dot(i0, j1, tx, ty - 1), d = dot(i1, j1, tx - 1, ty - 1)
        sum += g.amp * ((a + (b - a) * u) * (1 - w) + (c + (d - c) * u) * w)
      }
      // gradient noise is roughly in [-0.7, 0.7]: stretch so coverage thresholds act on the whole 0..1 range
      data[y * size + x] = Math.round(Math.min(1, Math.max(0, 0.5 + (sum / norm) * 1.15)) * 255)
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RedFormat, THREE.UnsignedByteType)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = tex.minFilter = THREE.LinearFilter
  tex.generateMipmaps = false
  tex.needsUpdate = true
  return tex
}

const vec4s = (n: number) => Array.from({ length: n }, () => new THREE.Vector4())
const vec3s = (n: number) => Array.from({ length: n }, () => new THREE.Vector3())

/** Shared uniforms (every patched material references these objects). */
export const sceneLightUniforms = {
  uApLfCount: { value: 0 },
  uApLfPos: { value: vec4s(LF.max) },
  uApLfCol: { value: vec3s(LF.max) },
  uApLfShape: { value: new THREE.Vector3(LF.wrap, LF.falloff, LF.core) },
  uApCloudMap: { value: null as THREE.Texture | null },
  /** x strength of the sun taken by a cloud (0 = off), y 1 / scale, z coverage, w edge softness. */
  uApCloud: { value: new THREE.Vector4(0, 1 / LC.scale, LC.coverage, LC.softness) },
  /** xy: uv scroll of the base layer, zw: of the detail layer. */
  uApCloudScroll: { value: new THREE.Vector4() },
  /** x share of the sky light a cloud takes, y detail weight, z detail scale. */
  uApCloudMix: { value: new THREE.Vector3(LC.ambient, LC.detail, LC.detailScale) },
  /** x wetness 0..1, y albedo darkening, z sheen strength. */
  uApWet: { value: new THREE.Vector4(0, LW.darken, LW.sheen, 0) },
  /** Sheen fresnel: x power, y reflectance facing the camera head-on, z share of the sheen on non-ground surfaces (props). */
  uApWetFres: { value: new THREE.Vector3(LW.sheenPower, LW.sheenBase, LW.propSheen) },
  /** x puddle scale (1 / world units), y coverage, z softness, w sky reflection strength. */
  uApWetShape: { value: new THREE.Vector4(LW.puddleScale, LW.puddleCoverage, LW.puddleSoftness, LW.reflect) },
  uApWetSky: { value: new THREE.Color(1, 1, 1) },
}

const PARS = /* glsl */`
#define AP_LF_MAX ${LF.max}
uniform int uApLfCount;
uniform vec4 uApLfPos[AP_LF_MAX];
uniform vec3 uApLfCol[AP_LF_MAX];
uniform vec3 uApLfShape;
uniform sampler2D uApCloudMap;
uniform vec4 uApCloud;
uniform vec4 uApCloudScroll;
uniform vec3 uApCloudMix;
uniform vec4 uApWet;
uniform vec4 uApWetShape;
uniform vec3 uApWetFres;
uniform vec3 uApWetSky;
float apCloudMask(vec2 p) {
  vec2 uv = p * uApCloud.y;
  float n = mix(texture2D(uApCloudMap, uv + uApCloudScroll.xy).r, texture2D(uApCloudMap, uv * uApCloudMix.z + uApCloudScroll.zw).r, uApCloudMix.y);
  return smoothstep(uApCloud.z - uApCloud.w, uApCloud.z + uApCloud.w, n);
}
`

/** After the albedo is final and before lighting reads it: wet ground darkens. Returns the puddle mask in apPuddle. */
const WET_ALBEDO = /* glsl */`
float apPuddle = 0.0;
float apUp = 0.0;
if (uApWet.x > 0.001) {
  vec3 apWw = cameraPosition - vViewPosition * mat3(viewMatrix);
  apUp = clamp(dot(normalize(normal), normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz)), 0.0, 1.0);
  apPuddle = smoothstep(uApWetShape.y - uApWetShape.z, uApWetShape.y + uApWetShape.z,
    mix(texture2D(uApCloudMap, apWw.xz * uApWetShape.x).r, texture2D(uApCloudMap, apWw.xz * uApWetShape.x * 2.7 + 0.31).r, 0.35));
  diffuseColor.rgb *= 1.0 - uApWet.x * uApWet.y * (0.45 + 0.55 * apPuddle) * smoothstep(0.2, 0.8, apUp + 0.35);
}
`

const LIGHT = /* glsl */`
{
  vec3 apW = cameraPosition - vViewPosition * mat3(viewMatrix);
  if (uApCloud.x > 0.001) {
    float apShade = uApCloud.x * apCloudMask(apW.xz);
    float apK = 1.0 - apShade;
    reflectedLight.directDiffuse *= apK;
    reflectedLight.directSpecular *= apK;
    reflectedLight.indirectDiffuse *= 1.0 - uApCloudMix.x * apShade;
  }
  if (uApWet.x > 0.001) {
    // sky sheen: grazing-angle reflection on up-facing wet surfaces, strongest inside puddles
    float apFr = uApWetFres.y + (1.0 - uApWetFres.y) * pow(1.0 - clamp(dot(geometryNormal, geometryViewDir), 0.0, 1.0), uApWetFres.x);
    // (Lambert never adds the specular accumulators to the output: the sheen goes through the diffuse one)
    #ifdef AP_GROUND
      // water pools on hard ground: green (grass) albedo soaks it up
      float apPatch = (0.1 + 0.9 * apPuddle) * (1.0 - 0.85 * smoothstep(0.0, 0.2, diffuseColor.g - max(diffuseColor.r, diffuseColor.b)));
    #else
      float apPatch = uApWetFres.z;
    #endif
    reflectedLight.indirectDiffuse += uApWetSky * uApWetShape.w * uApWet.x * uApWet.z * apFr * apUp * apPatch;
  }
  for (int i = 0; i < AP_LF_MAX; i++) {
    if (i >= uApLfCount) break;
    vec4 lp = uApLfPos[i];
    vec3 lv = (viewMatrix * vec4(lp.xyz, 1.0)).xyz - geometryPosition;
    float d2 = dot(lv, lv);
    if (d2 >= lp.w * lp.w) continue;
    float d = sqrt(d2);
    // flat core: no hot spot right at the source (it would blow out the lamp post / facade it hangs on)
    float att = pow(1.0 - max(d, lp.w * uApLfShape.z) / lp.w, uApLfShape.y);
    float ndl = dot(geometryNormal, lv / max(d, 1e-4));
    float lit = mix(max(ndl, 0.0), ndl * 0.5 + 0.5, uApLfShape.x);
    reflectedLight.directDiffuse += uApLfCol[i] * (att * lit) * BRDF_Lambert(diffuseColor.rgb);
  }
}
`

/**
 * Patches a lit material (Lambert / Phong / Standard, instanced or not) with the scene light. Idempotent; chains any
 * existing onBeforeCompile. Must run before the material's first render.
 */
export function applySceneLight<T extends THREE.Material>(material: T, ground = false): T {
  if (material.userData.apSceneLight) return material
  material.userData.apSceneLight = true
  const prev = material.onBeforeCompile
  material.onBeforeCompile = (shader, renderer) => {
    prev.call(material, shader, renderer)
    Object.assign(shader.uniforms, sceneLightUniforms)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${ground ? '#define AP_GROUND\n' : ''}${PARS}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${WET_ALBEDO}`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${LIGHT}`)
  }
  const prevKey = material.customProgramCacheKey.bind(material)
  material.customProgramCacheKey = () => `${prevKey()}|apsl1${ground ? 'g' : ''}`
  return material
}

/** Patches every lit material of an object tree (chunk meshes, props...) that has not been patched yet; meshes named "terrain" count as ground. */
export function patchSceneLight(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if ((m as THREE.MeshLambertMaterial).isMeshLambertMaterial || (m as THREE.MeshPhongMaterial).isMeshPhongMaterial || (m as THREE.MeshStandardMaterial).isMeshStandardMaterial) applySceneLight(m, mesh.name === 'terrain')
    }
  })
}

// ---------------------------------------------------------------------------
// Light field controller
// ---------------------------------------------------------------------------

export interface SceneLightFrame {
  dt: number
  time: number
  focus: THREE.Vector3
  quality: QualityId
  /** Lighting look at the current time (weather already applied): lamps, cloud, ... */
  state: LightingState
  /** Ground wetness 0..1 (rain). */
  wet: number
  /** Wind multiplier of the weather (1 = calm) and the sky tint for wet sheen. */
  wind: number
  sky: THREE.Color
  /** False in interiors / caves: no clouds, no rain. */
  outdoor: boolean
}

export interface SceneLight {
  /** All light sources of the streamed chunks. */
  setSources(list: LightSource[]): void
  update(f: SceneLightFrame): void
  /** True when the light field handles the lamps (the PointLight pool must stay empty). */
  fieldActive(q: QualityId): boolean
  readonly tier: LightingTier
  /** Sources registered by the streamed chunks (diagnostics). */
  readonly sourceCount: number
  dispose(): void
}

/** Effective strength of a source for the given night factor: night-only lamps come on late (lampsPower), always-on
 * fires and crystals keep only dayShare of their light in full daylight. */
const effective = (s: LightSource, lamps: number) => s.intensity * (s.nightOnly ? lamps ** LF.lampsPower : LF.dayShare + (1 - LF.dayShare) * lamps)

/** Source ranking for the light field: nearest first among the active ones within `radius` of (x, z). Pure (tests). */
export function rankSources(list: readonly LightSource[], lamps: number, x: number, y: number, z: number, radius: number, n: number): LightSource[] {
  const r2 = radius * radius
  const ranked: { s: LightSource; d: number }[] = []
  for (const s of list) {
    if (effective(s, lamps) <= 0.01) continue
    const d = (s.x - x) ** 2 + (s.z - z) ** 2 + (s.y - y) ** 2
    if (d <= r2) ranked.push({ s, d })
  }
  ranked.sort((a, b) => a.d - b.d)
  return ranked.slice(0, Math.max(0, n)).map((r) => r.s)
}

export function createSceneLight(): SceneLight {
  const U = sceneLightUniforms
  const cloudTex = createCloudTexture()
  U.uApCloudMap.value = cloudTex
  let sources: LightSource[] = []
  const levels = new Map<LightSource, number>()
  let chosen = new Set<LightSource>()
  let reassignT = 0
  let tier = lightingTier('high')
  const off = { x: 0, y: 0 }
  const windDir = new THREE.Vector2(...RENDER.wind.dir).normalize()

  return {
    get tier() { return tier },
    get sourceCount() { return sources.length },
    fieldActive: (q) => lightingTier(q).fieldLights > 0,
    setSources(list) {
      sources = list
      const alive = new Set(list)
      for (const s of levels.keys()) if (!alive.has(s)) levels.delete(s)
      for (const s of chosen) if (!alive.has(s)) chosen.delete(s)
      reassignT = 0
    },
    update(f) {
      tier = lightingTier(f.quality)
      const n = Math.min(LF.max, tier.fieldLights)
      const lamps = f.state.lamps

      // --- light field -------------------------------------------------------
      if (n > 0) {
        reassignT -= f.dt
        if (reassignT <= 0) {
          reassignT = LF.reassignSeconds
          chosen = new Set(rankSources(sources, lamps, f.focus.x, f.focus.y, f.focus.z, LF.selectRadius, n))
        }
        const k = 1 - Math.exp(-LF.fadeSpeed * f.dt)
        for (const s of chosen) if (!levels.has(s)) levels.set(s, 0)
        for (const [s, lvl] of levels) {
          const target = chosen.has(s) ? effective(s, lamps) : 0
          const next = lvl + (target - lvl) * k
          if (target === 0 && next < 0.004) levels.delete(s)
          else levels.set(s, next)
        }
      } else if (levels.size) levels.clear()
      let count = 0
      const flick = RENDER.lights.flicker
      const put = (s: LightSource, lvl: number) => {
        if (count >= LF.max || lvl <= 0.004) return
        const fl = flick[s.kind ?? 'default'] ?? flick.default
        const w = f.time * fl.speed + s.phase
        const m = lvl * LF.intensity * (1 + fl.amount * (Math.sin(w) * 0.6 + Math.sin(w * 2.7 + 1.3) * 0.4))
        U.uApLfPos.value[count].set(s.x, s.y, s.z, s.radius * LF.radiusMul)
        U.uApLfCol.value[count].set(s.color.r * m, s.color.g * m, s.color.b * m)
        count++
      }
      for (const [s, lvl] of levels) if (chosen.has(s)) put(s, lvl)
      for (const [s, lvl] of levels) if (!chosen.has(s)) put(s, lvl)
      U.uApLfCount.value = count
      U.uApLfShape.value.set(LF.wrap, LF.falloff, LF.core)

      // --- cloud shadows -----------------------------------------------------
      const cloudOn = tier.cloudShadows && f.outdoor
      const strength = cloudOn ? LC.strength * f.state.cloud : 0
      const coverage = LC.coverage + LC.drift * Math.sin((f.time * Math.PI * 2) / Math.max(1, LC.driftSeconds))
      U.uApCloud.value.set(strength, 1 / LC.scale, coverage, LC.softness)
      const step = (LC.speed * f.wind * f.dt) / LC.scale
      off.x += windDir.x * step
      off.y += windDir.y * step
      U.uApCloudScroll.value.set(off.x, off.y, off.x * 1.35 + 0.37, off.y * 1.35 + 0.11)
      U.uApCloudMix.value.set(LC.ambient, LC.detail, LC.detailScale)

      // --- wet ground --------------------------------------------------------
      U.uApWet.value.set(tier.wetGround && f.outdoor ? f.wet : 0, LW.darken, LW.sheen, 0)
      U.uApWetFres.value.set(LW.sheenPower, LW.sheenBase, LW.propSheen)
      U.uApWetSky.value.copy(f.sky)
    },
    dispose() {
      cloudTex.dispose()
      U.uApCloudMap.value = null
      U.uApLfCount.value = 0
    },
  }
}

