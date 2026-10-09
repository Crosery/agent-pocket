// Shared wind field. One definition (render.json "wind") drives vertex sway of grass / foliage, the drift of the GPU
// particle fields and the CPU-simulated particles (leaves, dust): gusts are fronts that travel across the map along
// the wind direction, so a gust bends the grass, shakes the canopy and shoves the leaves at the same moment and place.
// The GLSL below and gustAt() / windVelocity() are twins: change one, change the other.
import * as THREE from 'three'
import { RENDER } from '../config.ts'

const TAU = Math.PI * 2

export const windUniforms = {
  uTime: { value: 0 },
  uWindDir: { value: new THREE.Vector2(...RENDER.wind.dir).normalize() },
  uWindStrength: { value: RENDER.wind.strength },
  uWindSpeed: { value: RENDER.wind.speed },
  uGust: { value: RENDER.wind.gust },
  uSwayHeight: { value: RENDER.wind.swayHeight },
  uGustLean: { value: RENDER.wind.gustLean },
  /** x wavelength (tiles), y front speed (tiles/s), z sharpness, w front warp, as render.json wind.field. */
  uGustWave: { value: new THREE.Vector4(RENDER.wind.field.wavelength, RENDER.wind.field.speed, RENDER.wind.field.sharp, RENDER.wind.field.warp) },
  /** x calm floor of the slow envelope, y envelope rate (rad/s), z envelope spatial phase (rad/tile). */
  uGustEnv: { value: new THREE.Vector3(RENDER.wind.field.calm, RENDER.wind.field.envelopeRate, RENDER.wind.field.envelopeSpace) },
}

/** Weather multiplier on the base strength (storms blow harder); set by updateWind. */
export const windState = { time: 0, strengthMul: 1, dir: windUniforms.uWindDir.value }

export function updateWind(time: number, strengthMul: number): void {
  windState.time = time
  windState.strengthMul = strengthMul
  windUniforms.uTime.value = time
  windUniforms.uWindStrength.value = RENDER.wind.strength * strengthMul
}

/** Gust strength 0..1 at world (x, z) and time t (CPU twin of apGustAt). */
export function gustAt(x: number, z: number, t: number): number {
  const F = RENDER.wind.field, d = windUniforms.uWindDir.value
  const along = x * d.x + z * d.y, across = -x * d.y + z * d.x
  const phase = TAU * along / F.wavelength + F.warp * Math.sin(TAU * across / (F.wavelength * 2.3))
  const g = Math.pow(0.5 + 0.5 * Math.sin(phase - TAU * F.speed / F.wavelength * t), F.sharp)
  const env = F.calm + (1 - F.calm) * (0.5 + 0.5 * Math.sin(F.envelopeRate * t + F.envelopeSpace * along))
  return g * env
}

/**
 * Air velocity (tiles/s) at (x, z): the weather wind along `wind.dir`, pulsing between (1 - wind.drift.gust) and
 * (1 + wind.drift.gust) times with the gust fronts. `gain` is a per-user factor (particle windFactor).
 */
export function windVelocity(x: number, z: number, t: number, gain: number, out: { x: number; z: number }): { x: number; z: number } {
  const W = RENDER.wind, d = windUniforms.uWindDir.value
  const g = gustAt(x, z, t)
  const m = windState.strengthMul * W.drift.base * (1 - W.drift.gust + 2 * W.drift.gust * g) * gain
  out.x = d.x * m
  out.z = d.y * m
  return out
}

/** GLSL: uniforms, gust field and the sway offset for a vertex at local height `h` (0 = rooted). */
export const WIND_GLSL = /* glsl */`
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWindStrength, uWindSpeed, uGust, uSwayHeight, uGustLean;
uniform vec4 uGustWave;
uniform vec3 uGustEnv;
float apGustAt(vec2 xz) {
  vec2 perp = vec2(-uWindDir.y, uWindDir.x);
  float along = dot(xz, uWindDir), across = dot(xz, perp);
  float phase = 6.2831853 * along / uGustWave.x + uGustWave.w * sin(6.2831853 * across / (uGustWave.x * 2.3));
  float g = pow(0.5 + 0.5 * sin(phase - 6.2831853 * uGustWave.y / uGustWave.x * uTime), uGustWave.z);
  float env = uGustEnv.x + (1.0 - uGustEnv.x) * (0.5 + 0.5 * sin(uGustEnv.y * uTime + uGustEnv.z * along));
  return g * env;
}
vec2 apSway(vec3 root, float h) {
  float k = clamp(h / uSwayHeight, 0.0, 1.0);
  k *= k;
  float phase = dot(root.xz, vec2(0.37, 0.71));
  float g = apGustAt(root.xz);
  float gust = mix(1.0 - uGust, 1.0 + uGust * 1.6, g);
  float s = sin(uTime * uWindSpeed + phase) * 0.7 + sin(uTime * uWindSpeed * 1.9 + phase * 1.7) * 0.3;
  return uWindDir * (s * gust * uWindStrength * k + g * uGustLean * uWindStrength * k)
    + vec2(-uWindDir.y, uWindDir.x) * (cos(uTime * uWindSpeed * 1.3 + phase) * 0.25 * uWindStrength * k);
}
`

/** GLSL for particle shaders (which declare their own `uTime`): extra drift (tiles) a gust adds to a particle at xz
 * after t seconds, for a base wind `w` whose speed pulses +-gd with the fronts (integral of the pulse). */
export const WIND_DRIFT_GLSL = /* glsl */`
uniform vec2 uWindDir;
uniform vec4 uGustWave;
vec2 apGustDrift(vec2 xz, vec2 w, float t, float gd) {
  vec2 perp = vec2(-uWindDir.y, uWindDir.x);
  float along = dot(xz, uWindDir), across = dot(xz, perp);
  float phase = 6.2831853 * along / uGustWave.x + uGustWave.w * sin(6.2831853 * across / (uGustWave.x * 2.3));
  float om = 6.2831853 * uGustWave.y / uGustWave.x;
  return w * gd * cos(phase - om * t) / om;
}
`

/**
 * Patches a material (main or depth) so vertices sway with the wind. Works for instanced and plain meshes;
 * the instance translation gives every copy its own phase. `extra.body` runs after the sway with `apRoot`
 * (world position of the instance origin) and `transformed` in scope; `fragBody` runs after the colour with
 * `diffuseColor` in scope (varyings are declared in `pars` and `fragPars`).
 */
export function applyWind<T extends THREE.Material>(material: T, key: string, extra?: { pars?: string; body?: string; fragPars?: string; fragBody?: string; uniforms?: Record<string, THREE.IUniform> }): T {
  const prev = material.onBeforeCompile
  material.onBeforeCompile = (shader, renderer) => {
    prev.call(material, shader, renderer)
    Object.assign(shader.uniforms, windUniforms, extra?.uniforms ?? {})
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${WIND_GLSL}\n${extra?.pars ?? ''}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
{
  #ifdef USE_INSTANCING
    vec3 apRoot = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  #else
    vec3 apRoot = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  #endif
  vec2 apOff = apSway(apRoot, position.y);
  transformed.xz += apOff;
  ${extra?.body ?? ''}
}`)
    if (extra?.fragBody) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${extra.fragPars ?? ''}`)
        .replace('#include <color_fragment>', `#include <color_fragment>\n${extra.fragBody}`)
    }
  }
  const prevKey = material.customProgramCacheKey.bind(material)
  material.customProgramCacheKey = () => `${prevKey()}|wind:${key}`
  return material
}
