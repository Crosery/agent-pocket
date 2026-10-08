// Trample map: grass remembers where actors walked. A small toroidal grid around the focus holds, per cell, the bend
// direction (away from the actor who passed) and a flatten amount. Actors stamp it every frame; the CPU decays it, so a
// walked path stays bent for a moment and springs back instead of snapping up the instant the actor leaves, and any
// number of actors can bend grass (a uniform array is capped). Grass tufts and ground sprigs sample it in their vertex
// shader (apTrample). Tunables: render.json grass.trample.
import * as THREE from 'three'
import { RENDER } from '../config.ts'

export interface Bender { x: number; y: number; z: number; r: number }

/** Shader uniforms read by `TRAMPLE_GLSL`, shared by every patched material. Until a field binds them the window
 * radius is 0, so nothing bends (battle dioramas, low quality). */
export const trampleUniforms = {
  uTrample: { value: emptyTexture() as THREE.Texture },
  uTrampleCfg: { value: new THREE.Vector4(1, 1, 0, 0) },
  uTrampleFocus: { value: new THREE.Vector2() },
}

function emptyTexture(): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Uint8Array([127, 127, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType)
  tex.needsUpdate = true
  return tex
}

export interface TrampleField {
  /**
   * Advances the decay by `dt`, slides the window to `focus` (tiles) and stamps `benders`. `accept` lets the caller
   * veto cells on another level than the bender (cliff tops next to an actor below).
   */
  update(dt: number, focusX: number, focusZ: number, benders: readonly Bender[], accept?: (x: number, z: number, y: number) => boolean): void
  /** Forgets every trail (map change). */
  clear(): void
  dispose(): void
}

/** GLSL: apTrample(xz) -> (bend x, bend z, flatten), each 0..1 (bend is a signed unit-or-shorter vector). */
export const TRAMPLE_GLSL = /* glsl */`
uniform sampler2D uTrample;
uniform vec4 uTrampleCfg;
uniform vec2 uTrampleFocus;
vec3 apTrample(vec2 xz) {
  vec4 t = texture2D(uTrample, xz * uTrampleCfg.x * uTrampleCfg.y);
  float inside = 1.0 - smoothstep(uTrampleCfg.z - uTrampleCfg.w, uTrampleCfg.z, length(xz - uTrampleFocus));
  return vec3((t.rg * 255.0 - 127.0) / 127.0, t.b) * inside;
}
`

const mod = (v: number, n: number) => ((v % n) + n) % n
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }

export function createTrampleField(): TrampleField {
  const G = RENDER.grass, T = G.trample
  const cpt = T.cellsPerTile
  const N = Math.max(8, Math.round(T.window * cpt))
  const bx = new Float32Array(N * N), bz = new Float32Array(N * N), sink = new Float32Array(N * N)
  // bend components are stored as round(v * 127) + 127, so 0 is exactly representable
  const bytes = new Uint8Array(N * N * 4)
  for (let k = 0; k < N * N; k++) { bytes[k * 4] = 127; bytes[k * 4 + 1] = 127; bytes[k * 4 + 3] = 255 }
  const texture = new THREE.DataTexture(bytes, N, N, THREE.RGBAFormat, THREE.UnsignedByteType)
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.magFilter = texture.minFilter = THREE.LinearFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true
  const empty = trampleUniforms.uTrample.value
  trampleUniforms.uTrample.value = texture
  trampleUniforms.uTrampleCfg.value.set(cpt, 1 / N, T.window / 2, T.edgeFade)
  // global cell coordinates of the window's minimum corner; texel (i, j) holds global cell (i mod N, j mod N)
  let ox = 0, oz = 0, placed = false, wasActive = false
  const tau = Math.max(0.05, T.recoverSec / 3)

  const wipe = () => { bx.fill(0); bz.fill(0); sink.fill(0) }

  function slide(nx: number, nz: number): void {
    if (!placed) { placed = true; ox = nx; oz = nz; wipe(); return }
    const dx = nx - ox, dz = nz - oz
    if (Math.abs(dx) >= N || Math.abs(dz) >= N) { wipe(); ox = nx; oz = nz; return }
    // columns / rows that leave the window are the ones the entering global cells land on
    for (let i = 0; i < Math.abs(dx); i++) {
      const col = mod(dx > 0 ? ox + i : ox - 1 - i, N)
      for (let j = 0; j < N; j++) { const k = j * N + col; bx[k] = 0; bz[k] = 0; sink[k] = 0 }
    }
    for (let j = 0; j < Math.abs(dz); j++) {
      const row = mod(dz > 0 ? oz + j : oz - 1 - j, N) * N
      for (let i = 0; i < N; i++) { const k = row + i; bx[k] = 0; bz[k] = 0; sink[k] = 0 }
    }
    ox = nx; oz = nz
  }

  return {
    update(dt, focusX, focusZ, benders, accept) {
      slide(Math.floor(focusX * cpt) - (N >> 1), Math.floor(focusZ * cpt) - (N >> 1))
      ;trampleUniforms.uTrampleFocus.value.set(focusX, focusZ)
      if (wasActive && dt > 0) {
        const keep = Math.exp(-dt / tau)
        for (let k = 0; k < bx.length; k++) {
          const s = sink[k]
          if (s === 0 && bx[k] === 0 && bz[k] === 0) continue
          sink[k] = s * keep < 0.01 ? 0 : s * keep
          bx[k] *= keep; bz[k] *= keep
          if (sink[k] === 0) { bx[k] = 0; bz[k] = 0 }
        }
      }
      let stamped = 0
      for (const b of benders) {
        if (stamped >= T.maxBenders) break
        const R = b.r * G.bendRadius
        if (Math.hypot(b.x - focusX, b.z - focusZ) > T.window / 2 - T.edgeFade) continue
        stamped++
        const g0x = Math.floor((b.x - R) * cpt), g1x = Math.floor((b.x + R) * cpt)
        const g0z = Math.floor((b.z - R) * cpt), g1z = Math.floor((b.z + R) * cpt)
        for (let gz = g0z; gz <= g1z; gz++) for (let gx = g0x; gx <= g1x; gx++) {
          const cx = (gx + 0.5) / cpt, cz = (gz + 0.5) / cpt
          const dx = cx - b.x, dz = cz - b.z
          const d = Math.hypot(dx, dz)
          if (d >= R) continue
          if (accept && !accept(cx, cz, b.y)) continue
          const f = 1 - smooth(R * G.bendCore, R, d)
          const k = mod(gz, N) * N + mod(gx, N)
          const tx = d > 1e-3 ? (dx / d) * f : 0, tz = d > 1e-3 ? (dz / d) * f : 0
          // the stronger bend wins, so a fresh step overrides a fading older one
          if (Math.hypot(tx, tz) >= Math.hypot(bx[k], bz[k])) { bx[k] = tx; bz[k] = tz }
          if (f > sink[k]) sink[k] = f
        }
      }
      if (!wasActive && stamped === 0) return
      let active = 0
      for (let k = 0; k < bx.length; k++) {
        const o = k * 4
        const s = sink[k]
        if (s === 0) { bytes[o] = 127; bytes[o + 1] = 127; bytes[o + 2] = 0; continue }
        active++
        bytes[o] = Math.round(bx[k] * 127) + 127
        bytes[o + 1] = Math.round(bz[k] * 127) + 127
        bytes[o + 2] = Math.round(s * 255)
      }
      if (active > 0 || wasActive) texture.needsUpdate = true
      wasActive = active > 0
    },
    clear() {
      wipe()
      for (let k = 0; k < N * N; k++) { bytes[k * 4] = 127; bytes[k * 4 + 1] = 127; bytes[k * 4 + 2] = 0 }
      texture.needsUpdate = true; wasActive = false; placed = false
    },
    dispose() {
      if (trampleUniforms.uTrample.value === texture) { trampleUniforms.uTrample.value = empty; trampleUniforms.uTrampleCfg.value.set(1, 1, 0, 0) }
      texture.dispose()
    },
  }
}

/**
 * Vertex-shader pieces that bend a swaying card away from trampled cells: `pars` and `body` go to applyWind's `extra`.
 * `heightExpr` is a GLSL float expression for the card height (local units); `strength` / `sink` are GLSL float
 * expressions too. The bend is a world-space push turned into the instance's own (rotated, scaled) frame.
 */
export function trampleShader(heightExpr: string, strength: string, sink: string): { pars: string; body: string } {
  return {
    pars: TRAMPLE_GLSL,
    body: `
  vec3 apTr = apTrample(apRoot.xz);
  float apTk = clamp(position.y / ${heightExpr}, 0.0, 1.0);
  vec2 apD = apTr.xy * ${strength} * apTk;
  #ifdef USE_INSTANCING
    mat3 apM3 = mat3(modelMatrix * instanceMatrix);
    vec3 apL = transpose(apM3) * vec3(apD.x, 0.0, apD.y) / max(length(apM3[0]), 1e-4);
    transformed.xz += apL.xz;
  #else
    transformed.xz += apD;
  #endif
  transformed.y *= 1.0 - apTr.z * ${sink} * apTk;`,
  }
}
