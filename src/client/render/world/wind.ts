// Shared wind field for foliage / grass vertex sway. One set of uniforms drives every patched material.
import * as THREE from 'three'
import { RENDER } from '../config.ts'

export const windUniforms = {
  uTime: { value: 0 },
  uWindDir: { value: new THREE.Vector2(...RENDER.wind.dir).normalize() },
  uWindStrength: { value: RENDER.wind.strength },
  uWindSpeed: { value: RENDER.wind.speed },
  uGust: { value: RENDER.wind.gust },
  uGustSpeed: { value: RENDER.wind.gustSpeed },
  uSwayHeight: { value: RENDER.wind.swayHeight },
}

export function updateWind(time: number, strengthMul: number): void {
  windUniforms.uTime.value = time
  windUniforms.uWindStrength.value = RENDER.wind.strength * strengthMul
}

/** GLSL computing a world-space sway offset for a vertex at local height `h` (0 = rooted). */
const SWAY_FN = /* glsl */`
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWindStrength, uWindSpeed, uGust, uGustSpeed, uSwayHeight;
vec2 apSway(vec3 root, float h) {
  float k = clamp(h / uSwayHeight, 0.0, 1.0);
  k *= k;
  float phase = dot(root.xz, vec2(0.37, 0.71));
  float gust = 1.0 + uGust * sin(uTime * uGustSpeed + root.x * 0.05 + root.z * 0.03);
  float s = sin(uTime * uWindSpeed + phase) * 0.7 + sin(uTime * uWindSpeed * 1.9 + phase * 1.7) * 0.3;
  return uWindDir * (s * gust * uWindStrength * k) + vec2(-uWindDir.y, uWindDir.x) * (cos(uTime * uWindSpeed * 1.3 + phase) * 0.25 * uWindStrength * k);
}
`

/**
 * Patches a material (main or depth) so vertices sway with the wind. Works for instanced and plain meshes;
 * the instance translation gives every copy its own phase.
 */
export function applyWind<T extends THREE.Material>(material: T, key: string, extra?: { pars?: string; body?: string; uniforms?: Record<string, THREE.IUniform> }): T {
  const prev = material.onBeforeCompile
  material.onBeforeCompile = (shader, renderer) => {
    prev.call(material, shader, renderer)
    Object.assign(shader.uniforms, windUniforms, extra?.uniforms ?? {})
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${SWAY_FN}\n${extra?.pars ?? ''}`)
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
  }
  const prevKey = material.customProgramCacheKey.bind(material)
  material.customProgramCacheKey = () => `${prevKey()}|wind:${key}`
  return material
}
