// Camera-occlusion cutaway: props standing between the camera and the player (tree crowns, roofs, rocks) are
// screen-door dithered inside an ellipse around the player so the character stays visible in dense forests and
// behind buildings. One set of shared uniforms drives every patched material; the world view switches it on only
// while its own scene renders (scene.onBeforeRender / onAfterRender), so battle dioramas sharing GLB materials are
// never affected. Shadows are untouched (depth materials are not patched). Tunables: render.json "occlusion".
import * as THREE from 'three'
import { RENDER } from '../config.ts'

export const occlusionUniforms = {
  uApOccOn: { value: 0 },
  /** Ellipse centre (the player's body centre, world). */
  uApOccFocus: { value: new THREE.Vector3() },
  uApOccCam: { value: new THREE.Vector3() },
  /** Half extents of the cut ellipse across the view ray (camera right, camera up), world units. */
  uApOccRadius: { value: new THREE.Vector2(1, 1) },
  /** x = soft edge (fraction of the radius), y = coverage kept at the centre (0 = fully cut). */
  uApOccShape: { value: new THREE.Vector2(0.4, 0) },
  /** x = only fragments at least this much closer to the camera than the focus (along the ray), y = fade length. */
  uApOccDepth: { value: new THREE.Vector2(0.4, 0.6) },
}

/** Sets the cut centre and camera for the next overworld render. */
export function setOcclusionView(focusX: number, focusY: number, focusZ: number, camera: THREE.Camera): void {
  const O = RENDER.occlusion
  occlusionUniforms.uApOccFocus.value.set(focusX, focusY + O.lift, focusZ)
  occlusionUniforms.uApOccCam.value.setFromMatrixPosition(camera.matrixWorld)
  occlusionUniforms.uApOccRadius.value.set(O.radius[0], O.radius[1])
  occlusionUniforms.uApOccShape.value.set(O.soft, O.keep)
  occlusionUniforms.uApOccDepth.value.set(O.near, O.fade)
}

/** Enables the cutaway for the duration of a scene's render (no-op when disabled in render.json). */
export function bindOcclusion(scene: THREE.Scene): void {
  scene.onBeforeRender = () => { occlusionUniforms.uApOccOn.value = RENDER.occlusion.enabled ? 1 : 0 }
  scene.onAfterRender = () => { occlusionUniforms.uApOccOn.value = 0 }
}

/** Patches a lit material with the dithered cutaway (idempotent). */
export function applyOcclusion<T extends THREE.Material>(material: T): T {
  if (material.userData.apOcc) return material
  material.userData.apOcc = true
  const prev = material.onBeforeCompile
  material.onBeforeCompile = (shader, renderer) => {
    prev.call(material, shader, renderer)
    Object.assign(shader.uniforms, occlusionUniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vApOccW;')
      .replace('#include <project_vertex>', `#include <project_vertex>
{
  #ifdef USE_INSTANCING
    vApOccW = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
  #else
    vApOccW = (modelMatrix * vec4(transformed, 1.0)).xyz;
  #endif
}`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uApOccOn;
uniform vec3 uApOccFocus, uApOccCam;
uniform vec2 uApOccRadius, uApOccShape, uApOccDepth;
varying vec3 vApOccW;
float apBayer4(vec2 p) {
  // 4x4 ordered dither = 2x2 Bayer of 2x2 Bayer ([[0,2],[3,1]] = mod(2x + 3y, 4))
  vec2 q = mod(floor(p), 4.0);
  vec2 h = mod(q, 2.0), l = floor(q * 0.5);
  return (4.0 * mod(2.0 * h.x + 3.0 * h.y, 4.0) + mod(2.0 * l.x + 3.0 * l.y, 4.0) + 0.5) / 16.0;
}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
if (uApOccOn > 0.5) {
  vec3 apRd = uApOccFocus - uApOccCam;
  float apL = length(apRd);
  apRd /= apL;
  vec3 apV = vApOccW - uApOccCam;
  float apT = dot(apV, apRd);
  float apAhead = 1.0 - smoothstep(apL - uApOccDepth.x - uApOccDepth.y, apL - uApOccDepth.x, apT);
  vec3 apOff = apV - apRd * apT;
  vec3 apRight = normalize(cross(apRd, vec3(0.0, 1.0, 0.0)));
  vec3 apUp = cross(apRight, apRd);
  float apR = length(vec2(dot(apOff, apRight), dot(apOff, apUp)) / uApOccRadius);
  float apCut = (1.0 - smoothstep(1.0 - uApOccShape.x, 1.0, apR)) * apAhead;
  float apKeep = 1.0 - apCut * (1.0 - uApOccShape.y);
  if (apKeep < 0.999 && apBayer4(gl_FragCoord.xy) > apKeep) discard;
}`)
  }
  const prevKey = material.customProgramCacheKey.bind(material)
  material.customProgramCacheKey = () => `${prevKey()}|occ`
  return material
}
