// Sprite lighting for overworld characters and creatures: makes the billboards sit in the scene instead of looking
// pasted on. On top of the three.js Lambert light they get
//  - the scene light (cloud shadows, lamp / window light field, wet sheen) via applySceneLight,
//  - a back / rim light from the sun or moon: a one-pixel edge on the silhouette side facing the light, found by
//    sampling the sprite's own alpha a pixel toward the light (so it works for every sheet, flipped or not),
//  - a night fill: a cool ambient floor so characters stay readable when only the hemisphere light reaches them,
//  - the sun shadow sampled around the soles: a character under a tree or inside a building's shadow is dimmed.
// Strengths come from the time-of-day state (rim, spriteFill), the weather grade (rim) and render.json lighting.sprite.
import * as THREE from 'three'
import { RENDER, lightingTier, type LightingState, type QualityId, type Vec3 } from './config.ts'
import { applySceneLight } from './world/scene-light.ts'

const LS = RENDER.lighting.sprite

export const spriteLightUniforms = {
  /** Screen-space direction (view x right, y up) toward the light. */
  uApRimDir: { value: new THREE.Vector2(0, 1) },
  /** Rim colour (linear, already scaled by strength) and thickness in internal pixels. */
  uApRimCol: { value: new THREE.Color(0, 0, 0) },
  uApRimPx: { value: LS.rimPixels },
  /** Night fill (linear colour x intensity). */
  uApFill: { value: new THREE.Color(0, 0, 0) },
  /** World direction toward the shadow-casting light. */
  uApSunDir: { value: new THREE.Vector3(0, 1, 0) },
  /** x shadow-map uv per world unit, y soles lift, z strength (0 = off), w offset toward the light. */
  uApShadowCfg: { value: new THREE.Vector4(0, LS.shadowLift, 0, LS.shadowOffset) },
  /** x blur radius (world units). */
  uApShadowBlur: { value: new THREE.Vector2(LS.shadowRadius, 0) },
}

const VERT_PARS = /* glsl */`
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
uniform vec3 uApSunDir;
uniform vec4 uApShadowCfg;
varying vec4 vApFeetCoord;
#endif
`

const VERT_BODY = /* glsl */`
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
{
  // shadow lookup point: the soles, lifted off the ground and nudged toward the light (clear of the sprite's own caster)
  vec3 apFoot = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz + vec3(0.0, uApShadowCfg.y, 0.0) + uApSunDir * uApShadowCfg.w;
  vApFeetCoord = directionalShadowMatrix[0] * vec4(apFoot, 1.0);
}
#endif
`

const FRAG_PARS = /* glsl */`
uniform vec2 uApRimDir;
uniform vec3 uApRimCol;
uniform float uApRimPx;
uniform vec3 uApFill;
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
uniform vec4 uApShadowCfg;
uniform vec2 uApShadowBlur;
varying vec4 vApFeetCoord;
#endif
`

const FRAG_BODY = /* glsl */`
{
  #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
  if (uApShadowCfg.z > 0.0) {
    // 3x3 taps spread over the sprite's width: the soles' shadow fades in and out smoothly instead of popping
    float apS = 0.0;
    DirectionalLightShadow apDls = directionalLightShadows[0];
    float apR = uApShadowBlur.x * uApShadowCfg.x;
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      vec4 c = vApFeetCoord;
      c.xy += vec2(float(i), float(j)) * apR * c.w;
      apS += getShadow(directionalShadowMap[0], apDls.shadowMapSize, apDls.shadowIntensity, apDls.shadowBias, apDls.shadowRadius, c);
    }
    float apK = mix(1.0, apS / 9.0, uApShadowCfg.z);
    reflectedLight.directDiffuse *= apK;
    reflectedLight.directSpecular *= apK;
  }
  #endif
  reflectedLight.indirectDiffuse += diffuseColor.rgb * uApFill;
  #ifdef USE_MAP
  if (uApRimCol.r + uApRimCol.g + uApRimCol.b > 0.0) {
    // one screen pixel toward the light, expressed in the sprite's uv space (derivatives follow flips and scale)
    vec2 apD = (dFdx(vMapUv) * uApRimDir.x + dFdy(vMapUv) * uApRimDir.y) * uApRimPx;
    float apN = texture2D(map, vMapUv + apD).a;
    float apEdge = 1.0 - smoothstep(0.2, 0.6, apN);
    reflectedLight.directDiffuse += uApRimCol * apEdge;
  }
  #endif
}
`

/**
 * Patches a sprite material (see createSpriteMaterial) with the scene light, rim, night fill and soles shadow.
 * Run once after creating the material; chains any existing onBeforeCompile.
 */
export function applySpriteLighting<T extends THREE.MeshLambertMaterial>(material: T): T {
  if (material.userData.apSpriteLight) return material
  material.userData.apSpriteLight = true
  applySceneLight(material)
  const prev = material.onBeforeCompile
  material.onBeforeCompile = (shader, renderer) => {
    prev.call(material, shader, renderer)
    Object.assign(shader.uniforms, spriteLightUniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace('#include <shadowmap_vertex>', `#include <shadowmap_vertex>\n${VERT_BODY}`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${FRAG_BODY}`)
  }
  const prevKey = material.customProgramCacheKey.bind(material)
  material.customProgramCacheKey = () => `${prevKey()}|apspr1`
  return material
}

export interface SpriteLightFrame {
  /** Unit direction toward the light (world) and its colour (linear, sRGB-converted). */
  dir: Vec3
  sunColor: THREE.Color
  /** Light intensity factor (sun fade x weather) used to scale the rim. */
  sunMul: number
  state: LightingState
  /** Weather multiplier of the rim. */
  rim: number
  quality: QualityId
  camera: THREE.Camera
  /** Shadow-map uv per world unit (1 / frustum width) and whether the sun casts shadows. */
  shadowUv: number
  shadows: boolean
  /** False in interiors / caves: the soles shadow and rim still apply, fill follows the preset. */
  outdoor: boolean
}

const _d = new THREE.Vector3()
const _c = new THREE.Color()

/** Per-frame update of the shared sprite lighting uniforms. */
export function updateSpriteLighting(f: SpriteLightFrame): void {
  const U = spriteLightUniforms
  const tier = lightingTier(f.quality)
  U.uApSunDir.value.set(f.dir[0], f.dir[1], f.dir[2])
  // light direction in view space: x / y give the screen direction toward it, z < 0 means it shines from behind the sprite
  _d.set(f.dir[0], f.dir[1], f.dir[2]).transformDirection(f.camera.matrixWorldInverse)
  const lenXY = Math.hypot(_d.x, _d.y)
  if (lenXY > 1e-3) U.uApRimDir.value.set(_d.x / lenXY, _d.y / lenXY)
  const back = THREE.MathUtils.smoothstep(-_d.z, -0.15, 0.55)
  const k = tier.spriteRim ? LS.rimStrength * f.state.rim * f.rim * f.sunMul * (LS.rimMin + (1 - LS.rimMin) * back) : 0
  U.uApRimCol.value.copy(f.sunColor).multiplyScalar(k)
  U.uApRimPx.value = LS.rimPixels
  // fill: a cool floor under the hemisphere light, fades with the time-of-day key (night / dusk)
  _c.setRGB(0, 0, 0)
  if (tier.spriteRim) _c.set(f.state.spriteFill).multiplyScalar(f.state.spriteFillIntensity)
  U.uApFill.value.copy(_c)
  U.uApShadowCfg.value.set(f.shadowUv, LS.shadowLift, tier.spriteShadow && f.shadows ? LS.shadowStrength : 0, LS.shadowOffset)
  U.uApShadowBlur.value.x = LS.shadowRadius
}
